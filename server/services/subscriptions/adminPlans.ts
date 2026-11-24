import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { withBillingScope } from '../../tenancy/billingContext.js';
import { addCalendarMonths, creditDepositDates, type BillingTerm } from '../../../shared/subscriptions.js';
import { SubscriptionError } from './gateway.js';
import { getCatalog } from './catalog.js';
import { rows, subscriptions, type Executor, type SubscriptionDatabase, type SubscriptionService } from './service.js';

type Term = {
  id:string; organization_id:number; version:number; slug:string; term:BillingTerm;
  starts_at:Date; ends_at:Date; cancelled_at:Date|null; reason:string; admin_id:number;
};
type Assignment = { catalogVersion:number; plan:string; term:BillingTerm; timing:'now'|'at_term_end'; reason:string };

async function organization(organizationId:number,database:Executor=db) {
  const [owner]=await rows<{id:number;name:string;owner_user_id:number;email:string}>(database,sql`
    SELECT o.id,o.name,o.owner_user_id,u.email FROM billing_organizations o
    JOIN users u ON u.id=o.owner_user_id AND u.deleted_at IS NULL WHERE o.id=${organizationId}`);
  if (!owner) throw new SubscriptionError('Billing account not found.',404,'ORGANIZATION_NOT_FOUND');
  return owner;
}

export async function adminPlanOverview(
  organizationId:number,database:SubscriptionDatabase=db,subscriptionService:SubscriptionService=subscriptions,
) {
  const owner=await organization(organizationId,database);
  const state=await withBillingScope({organizationId,actorUserId:owner.owner_user_id},
    ()=>subscriptionService.state(owner.owner_user_id));
  const now=subscriptionService.now();
  const terms=await rows<Term>(database,sql`SELECT * FROM billing_admin_plan_terms
    WHERE organization_id=${organizationId} AND cancelled_at IS NULL AND ends_at>${now}
    ORDER BY starts_at DESC`);
  return {
    organization:{id:owner.id,name:owner.name,ownerUserId:owner.owner_user_id,ownerEmail:owner.email},
    current:state.subscription,pending:state.pendingChange,access:state.access,
    nextDepositAt:state.nextDepositAt,entitlements:state.entitlements,
    adminTerms:terms.map(term=>({id:term.id,version:term.version,slug:term.slug,term:term.term,
      startsAt:term.starts_at.toISOString(),endsAt:term.ends_at.toISOString(),reason:term.reason,
      status:term.starts_at>now?'scheduled':'active'})),
    catalog:await getCatalog(undefined,database),
  };
}

/** Paid mandates end at their verified paid-through date before a complimentary assignment begins. */
export async function assignAdminPlan(
  adminId:number,organizationId:number,input:Assignment,
  database:SubscriptionDatabase=db,subscriptionService:SubscriptionService=subscriptions,
) {
  const owner=await organization(organizationId,database);
  const catalog=await getCatalog(undefined,database);
  if(catalog.version!==input.catalogVersion) throw new SubscriptionError('The published plan catalog changed. Reload before assigning a plan.',409,'CATALOG_CHANGED');
  if(!catalog.plans.some(plan=>plan.slug===input.plan)) throw new SubscriptionError('Choose a published plan.',400,'INVALID_PLAN');
  const now=subscriptionService.now();
  const [paidTerm]=await rows<{paid_through:Date|null}>(database,sql`SELECT max(c.period_end) paid_through
    FROM subscription_charges c JOIN billing_subscriptions s ON s.id=c.subscription_id
    WHERE c.organization_id=${organizationId} AND s.mode='live' AND c.refund_amount_paise=0
      AND c.period_start<=${now} AND c.period_end>${now}`);
  const [manualTerm]=await rows<{ends_at:Date}>(database,sql`SELECT ends_at FROM billing_admin_plan_terms
    WHERE organization_id=${organizationId} AND cancelled_at IS NULL AND starts_at<=${now} AND ends_at>${now}
    ORDER BY starts_at DESC LIMIT 1`);
  if(paidTerm?.paid_through && input.timing==='now')
    throw new SubscriptionError('The existing paid term must finish before an administrator plan begins. Choose “At term end”.',409,'PAID_TERM_ACTIVE');
  if(input.timing==='at_term_end' && !paidTerm?.paid_through && !manualTerm)
    throw new SubscriptionError('There is no active term to schedule after. Choose “Now”.',400,'NO_CURRENT_TERM');

  // Cancel provider renewal before scheduling a grant, never label an unpaid
  // administrator action as a Razorpay charge or create an invoice for it.
  const [mandate]=await rows<{id:string;status:string;cancel_at_period_end:boolean;pending_active:boolean}>(database,sql`
    SELECT s.id,s.status,s.cancel_at_period_end,
      EXISTS(SELECT 1 FROM billing_subscriptions r WHERE r.replaces_id=s.id AND r.organization_id=a.organization_id
        AND r.status NOT IN('cancelled','completed','expired','failed') AND NOT r.cancel_at_period_end) pending_active
    FROM subscription_accounts a
    JOIN billing_subscriptions s ON s.id=a.current_subscription_id
    WHERE a.organization_id=${organizationId}`);
  if(mandate && (mandate.pending_active ||
      (!mandate.cancel_at_period_end && !['cancelled','completed','expired','failed'].includes(mandate.status)))) {
    await withBillingScope({organizationId,actorUserId:owner.owner_user_id},
      ()=>subscriptionService.cancel(owner.owner_user_id,'renewal'));
  }

  const result=await database.transaction(async (tx:Executor)=>{
    await tx.execute(sql`SELECT id FROM billing_organizations WHERE id=${organizationId} FOR UPDATE`);
    const [uncancelled]=await rows<{id:string}>(tx,sql`SELECT id FROM billing_subscriptions
      WHERE organization_id=${organizationId} AND status NOT IN('cancelled','completed','expired','failed')
        AND cancel_at_period_end=false LIMIT 1`);
    if(uncancelled) throw new SubscriptionError(
      'A payment checkout or renewal is still active. Retry after it is cancelled.',409,'PAYMENT_MANDATE_ACTIVE');
    const published=await getCatalog(undefined,tx);
    if(published.version!==input.catalogVersion) throw new SubscriptionError('The published plan catalog changed. Reload before assigning a plan.',409,'CATALOG_CHANGED');
    const plan=published.plans.find(candidate=>candidate.slug===input.plan);
    if(!plan) throw new SubscriptionError('Choose a published plan.',400,'INVALID_PLAN');
    const now=subscriptionService.now();
    const [paid]=await rows<{paid_through:Date|null}>(tx,sql`SELECT max(c.period_end) paid_through
      FROM subscription_charges c JOIN billing_subscriptions s ON s.id=c.subscription_id
      WHERE c.organization_id=${organizationId} AND s.mode='live' AND c.refund_amount_paise=0
        AND c.period_start<=${now} AND c.period_end>${now}`);
    const paidThrough=paid?.paid_through && paid.paid_through>now ? paid.paid_through : null;
    const existing=await rows<Term>(tx,sql`SELECT * FROM billing_admin_plan_terms
      WHERE organization_id=${organizationId} AND cancelled_at IS NULL AND ends_at>${now}
      ORDER BY starts_at FOR UPDATE`);
    const active=existing.find(term=>term.starts_at<=now);
    const scheduled=existing.find(term=>term.starts_at>now);
    if(paidThrough && input.timing==='now')
      throw new SubscriptionError('The existing paid term must finish before an administrator plan begins. Choose “At term end”.',409,'PAID_TERM_ACTIVE');
    const startsAt=input.timing==='at_term_end'
      ? active?.ends_at || paidThrough || null : now;
    if(!startsAt) throw new SubscriptionError('There is no active term to schedule after. Choose “Now”.',400,'NO_CURRENT_TERM');
    if(active && input.timing==='now' && active.version===plan.version && active.slug===plan.slug && active.term===input.term)
      throw new SubscriptionError('This administrator plan is already active.',409,'PLAN_ALREADY_ASSIGNED');
    if(scheduled && input.timing==='at_term_end' && scheduled.version===plan.version && scheduled.slug===plan.slug && scheduled.term===input.term)
      throw new SubscriptionError('This administrator plan is already scheduled.',409,'PLAN_ALREADY_ASSIGNED');
    const endsAt=addCalendarMonths(startsAt,input.term==='yearly'?12:1);
    const replaced=existing.filter(term=>term.starts_at>=startsAt || input.timing==='now');
    for(const term of replaced) {
      await tx.execute(sql`UPDATE billing_admin_plan_terms SET cancelled_at=${now} WHERE id=${term.id}::uuid`);
      await tx.execute(sql`UPDATE billing_admin_plan_credit_grants SET cancelled_at=${now}
        WHERE term_id=${term.id}::uuid AND granted_at IS NULL AND cancelled_at IS NULL AND due_at>${now}`);
    }
    const id=crypto.randomUUID();
    await tx.execute(sql`INSERT INTO billing_admin_plan_terms
      (id,organization_id,admin_id,version,slug,term,starts_at,ends_at,reason)
      VALUES(${id}::uuid,${organizationId},${adminId},${plan.version},${plan.slug},${input.term},${startsAt},${endsAt},${input.reason})`);
    for(const [index,dueAt] of creditDepositDates(startsAt,endsAt,input.term).entries()) {
      await tx.execute(sql`INSERT INTO billing_admin_plan_credit_grants(term_id,month_index,due_at,credits)
        VALUES(${id}::uuid,${index},${dueAt},${plan.monthlyCredits})`);
    }
    await tx.execute(sql`INSERT INTO subscription_audit(admin_id,user_id,organization_id,action,details)
      VALUES(${adminId},${owner.owner_user_id},${organizationId},'admin_plan_assigned',
        ${JSON.stringify({termId:id,version:plan.version,slug:plan.slug,term:input.term,
          startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),replaced:replaced.map(term=>term.id),
          reason:input.reason,noCharge:true})}::jsonb)`);
    return {id,startsAt,endsAt,credits:plan.monthlyCredits};
  });
  let depositPending=false;
  if(result.startsAt<=subscriptionService.now()) {
    try { await subscriptionService.grantAdminDueCredits(organizationId); }
    catch(error) {
      depositPending=true;
      logger.error({organizationId,termId:result.id,error},'Administrator plan credit deposit will retry');
    }
  }
  return {...await adminPlanOverview(organizationId,database,subscriptionService),depositPending};
}

export async function revokeAdminPlan(
  adminId:number,organizationId:number,scope:'scheduled'|'active',reason:string,
  database:SubscriptionDatabase=db,subscriptionService:SubscriptionService=subscriptions,
) {
  const owner=await organization(organizationId,database);
  await database.transaction(async (tx:Executor)=>{
    await tx.execute(sql`SELECT id FROM billing_organizations WHERE id=${organizationId} FOR UPDATE`);
    const now=subscriptionService.now();
    const terms=await rows<Term>(tx,sql`SELECT * FROM billing_admin_plan_terms
      WHERE organization_id=${organizationId} AND cancelled_at IS NULL AND ends_at>${now} FOR UPDATE`);
    const affected=scope==='scheduled' ? terms.filter(term=>term.starts_at>now) : terms;
    if(!affected.length) throw new SubscriptionError('No administrator plan to end.',404,'ADMIN_PLAN_NOT_FOUND');
    for(const term of affected) {
      await tx.execute(sql`UPDATE billing_admin_plan_terms SET cancelled_at=${now} WHERE id=${term.id}::uuid`);
      await tx.execute(sql`UPDATE billing_admin_plan_credit_grants SET cancelled_at=${now}
        WHERE term_id=${term.id}::uuid AND granted_at IS NULL AND cancelled_at IS NULL AND due_at>${now}`);
    }
    await tx.execute(sql`INSERT INTO subscription_audit(admin_id,user_id,organization_id,action,details)
      VALUES(${adminId},${owner.owner_user_id},${organizationId},'admin_plan_ended',
        ${JSON.stringify({scope,terms:affected.map(term=>term.id),reason,retainedCredits:true})}::jsonb)`);
  });
  return adminPlanOverview(organizationId,database,subscriptionService);
}
