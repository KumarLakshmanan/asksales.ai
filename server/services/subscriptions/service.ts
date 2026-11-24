import crypto from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { currentBillingScope } from '../../tenancy/billingContext.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import {
  calculateSubscriptionAccess, creditDepositDates,
  type BillingTerm, type PlanSlug, type SubscriptionState, type SubscriptionCheckout, type SubscriptionSummary,
} from '../../../shared/subscriptions.js';
import { getCatalog } from './catalog.js';
import { resolveBillingOrganization, getBillingOrganization, requireBillingRole } from '../billing/organizations.js';
import { getOrganizationEntitlements } from '../billing/entitlements.js';
import { RazorpaySubscriptionGateway, SubscriptionError, verifyCharge, type ProviderInvoice, type ProviderSubscription } from './gateway.js';

export interface Executor { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>; }
export interface SubscriptionDatabase extends Executor { transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>; }
const dateColumns = new Set(['launched_at','created_at','updated_at','period_start','period_end','paid_at','paid_through','starts_at','ends_at','failure_at','due_at','received_at','processed_at','last_synced_at','billing_eligibility_at','refund_observed_at','cancelled_at']);
export async function rows<T>(tx: Executor, query: SQL): Promise<T[]> {
  // Drizzle's raw execute path deliberately returns timestamp fields as strings.
  // Normalize at the boundary before comparing dates or serializing the API.
  return (await tx.execute(query)).rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (dateColumns.has(key) && typeof value === 'string') {
      const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ','T')}Z` : value;
      return [key, new Date(iso)];
    }
    return [key, value];
  }))) as T[];
}
export type Settings = { enforced: boolean; launched_at: Date | null; credential_id: number | null; published_catalog_version: number; capacity_enforced: boolean };
export type SubscriptionRow = {
  id: string; user_id: number; organization_id: number; organization_bound: boolean; credential_id: number; mode: 'test' | 'live'; version: number; slug: PlanSlug;
  term: BillingTerm; provider_id: string | null; provider_plan_id: string; status: string;
  authorized: boolean; replaces_id: string | null; starts_at: Date | null; cancel_at_period_end: boolean;
  payment_method: string | null; failure_at: Date | null; created_at: Date; paid_through?: Date | null;
};
const terminal = ['cancelled', 'completed', 'expired', 'failed'];
const authorizeStatuses = ['authenticated', 'active', 'pending', 'halted', 'completed'];

export class SubscriptionService {
  constructor(
    readonly database: SubscriptionDatabase = db,
    readonly gateway = RazorpaySubscriptionGateway.forCredential,
    readonly now = () => new Date(),
  ) {}

  async settings(tx: Executor = this.database): Promise<Settings> {
    const [settings] = await rows<Settings>(tx, sql`SELECT enforced,launched_at,credential_id,published_catalog_version,capacity_enforced FROM subscription_settings WHERE id=1`);
    if (!settings) throw new SubscriptionError('Subscription settings are unavailable.', 503);
    return settings;
  }
  private async lock(tx: Executor, userId: number) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73028,${userId})`);
  }
  private async user(tx: Executor, userId: number) {
    const [user] = await rows<{ id: number; created_at: Date; is_approved: boolean; is_setup_complete: boolean; is_verified: boolean }>(tx,
      sql`SELECT id,created_at,is_approved,is_setup_complete,is_verified FROM users WHERE id=${userId} AND deleted_at IS NULL`);
    if (!user) throw new SubscriptionError('Account unavailable.', 404);
    return user;
  }
  private async billingEligible(tx: Executor, userId: number) {
    const actor = await this.user(tx, userId);
    const ownerId = currentBusinessScope()?.userId ?? currentBillingScope()?.businessOwnerUserId ?? userId;
    const owner = ownerId === userId ? actor : await this.user(tx, ownerId);
    return actor.is_verified && owner.is_approved && owner.is_setup_complete;
  }
  private async owned(tx: Executor, organizationId: number, id: string) {
    const [sub] = await rows<SubscriptionRow>(tx, sql`SELECT s.*,
      (SELECT max(period_end) FROM subscription_charges WHERE subscription_id=s.id AND refund_amount_paise=0) paid_through
      FROM billing_subscriptions s WHERE s.organization_id=${organizationId} AND s.id=${id}::uuid`);
    if (!sub) throw new SubscriptionError('Subscription not found.', 404);
    return sub;
  }
  async access(userId: number) {
    const organizationId = await resolveBillingOrganization(userId, this.database);
    const user = await this.user(this.database, currentBusinessScope()?.userId ?? currentBillingScope()?.businessOwnerUserId ?? userId);
    if (!user.is_approved) return { allowed: false, reason: 'approval_required' as const, accessUntil: null, canTopUp: false };
    const [adminTerm] = await rows<{ ends_at: Date }>(this.database, sql`SELECT ends_at FROM billing_admin_plan_terms
      WHERE organization_id=${organizationId} AND cancelled_at IS NULL AND starts_at<=${this.now()} AND ends_at>${this.now()}
      ORDER BY starts_at DESC LIMIT 1`);
    if (adminTerm) return { allowed: true, reason: 'admin_grant' as const, accessUntil: adminTerm.ends_at.toISOString(), canTopUp: true };
    const [organization] = await rows<{billing_eligibility_at:Date}>(this.database,sql`SELECT billing_eligibility_at FROM billing_organizations WHERE id=${organizationId}`);
    const settings = await this.settings();
    const [charge] = await rows<{ period_start: Date; period_end: Date; failure_at: Date | null; cancel_at_period_end: boolean; status: string; failed_replacement: boolean }>(this.database,
      sql`SELECT c.period_start,c.period_end,s.failure_at,s.cancel_at_period_end,s.status,
        EXISTS(SELECT 1 FROM billing_subscriptions r WHERE r.replaces_id=s.id AND r.organization_id=s.organization_id
          AND r.mode='live' AND r.authorized AND NOT r.cancel_at_period_end
          AND r.status IN('pending','halted') AND r.starts_at=c.period_end AND r.starts_at<=${this.now()}) failed_replacement
        FROM subscription_charges c JOIN billing_subscriptions s ON s.id=c.subscription_id
        WHERE c.organization_id=${organizationId} AND s.mode='live' AND c.refund_amount_paise=0 AND c.period_start<=${this.now()}
        ORDER BY c.period_end DESC LIMIT 1`);
    return calculateSubscriptionAccess({
      enforced: settings.enforced, launchedAt: settings.launched_at, userCreatedAt: organization?.billing_eligibility_at || user.created_at,
      paidFrom: charge?.period_start, paidThrough: charge?.period_end,
      failedRenewal: !!charge?.failed_replacement || !!charge?.failure_at || ['pending', 'halted'].includes(charge?.status || ''),
      // A scheduled change ends the old mandate. Its failed replacement still
      // receives recovery time anchored to the last paid term, without credits.
      cancelled: !charge?.failed_replacement && (!!charge?.cancel_at_period_end || ['cancelled', 'completed', 'expired'].includes(charge?.status || '')),
    }, this.now());
  }

  async state(userId: number): Promise<SubscriptionState> {
    const organizationId = await resolveBillingOrganization(userId, this.database);
    const organization = await getBillingOrganization(userId, organizationId, this.database);
    const entitlements = await getOrganizationEntitlements(organizationId, this.database);
    const catalog = await getCatalog(undefined, this.database);
    const [access, eligible, settings] = await Promise.all([this.access(userId), this.billingEligible(this.database, userId), this.settings()]);
    const all = await rows<SubscriptionRow>(this.database, sql`SELECT s.*,
      (SELECT max(period_end) FROM subscription_charges WHERE subscription_id=s.id AND refund_amount_paise=0) paid_through
      FROM billing_subscriptions s WHERE s.organization_id=${organizationId} ORDER BY s.created_at DESC`);
    const [account] = await rows<{ current_subscription_id: string }>(this.database,
      sql`SELECT current_subscription_id FROM subscription_accounts WHERE organization_id=${organizationId}`);
    const current = all.find(sub => sub.id === account?.current_subscription_id);
    const pending = all.find(sub => sub.replaces_id === current?.id && !terminal.includes(sub.status));
    const planNames = await rows<{version:number;slug:string;name:string}>(this.database,sql`SELECT version,slug,name FROM subscription_plans`);
    const adminTerms = await rows<{id:string;version:number;slug:PlanSlug;term:BillingTerm;starts_at:Date;ends_at:Date}>(this.database,
      sql`SELECT id,version,slug,term,starts_at,ends_at FROM billing_admin_plan_terms
        WHERE organization_id=${organizationId} AND cancelled_at IS NULL AND ends_at>${this.now()} ORDER BY starts_at DESC`);
    const activeAdmin = adminTerms.find(term => term.starts_at <= this.now());
    const scheduledAdmin = adminTerms.find(term => term.starts_at > this.now());
    const summary = (sub: SubscriptionRow | undefined): SubscriptionSummary | null => sub ? {
      id: sub.id, version: sub.version, name: planNames.find(p=>p.version===sub.version&&p.slug===sub.slug)?.name || sub.slug, plan: sub.slug, term: sub.term, mode: sub.mode, status: sub.status,
      paidThrough: sub.paid_through?.toISOString() || null, cancelAtPeriodEnd: sub.cancel_at_period_end,
      paymentMethod: sub.payment_method, source: 'razorpay',
    } : null;
    const adminSummary = (term: typeof activeAdmin): SubscriptionSummary | null => term ? {
      id: term.id, version: term.version, name: planNames.find(p=>p.version===term.version&&p.slug===term.slug)?.name || term.slug,
      plan: term.slug, term: term.term, mode: 'live', status: term.starts_at > this.now() ? 'scheduled' : 'active',
      paidThrough: term.ends_at.toISOString(), cancelAtPeriodEnd: true, paymentMethod: null, source: 'admin',
    } : null;
    const [deposit] = await rows<{ due_at: Date }>(this.database, sql`SELECT due_at FROM subscription_credit_grants
      WHERE organization_id=${organizationId} AND granted_at IS NULL AND cancelled_at IS NULL ORDER BY due_at LIMIT 1`);
    const [adminDeposit] = await rows<{due_at:Date}>(this.database,sql`SELECT g.due_at FROM billing_admin_plan_credit_grants g
      JOIN billing_admin_plan_terms t ON t.id=g.term_id
      WHERE t.organization_id=${organizationId} AND t.cancelled_at IS NULL AND t.ends_at>${this.now()}
        AND g.granted_at IS NULL AND g.cancelled_at IS NULL ORDER BY g.due_at LIMIT 1`);
    const charges = await rows<{ payment_id: string; amount_paise: number; tax_paise: number | null; term: BillingTerm; slug: PlanSlug;
      paid_at: Date; period_start: Date; period_end: Date; invoice_url: string | null; refund_amount_paise:number; refund_observed_at:Date|null }>(this.database,
      sql`SELECT c.*,s.term,s.slug FROM subscription_charges c JOIN billing_subscriptions s ON s.id=c.subscription_id
        WHERE c.organization_id=${organizationId} ORDER BY c.paid_at DESC LIMIT 24`);
    let checkoutAvailable = false;
    let mode: 'test' | 'live' | null = null;
    if (settings.credential_id) {
      const gateway = await this.gateway(settings.credential_id);
      mode = gateway.mode;
      const [count] = await rows<{ count: string }>(this.database, sql`SELECT count(*) FROM subscription_provider_plans
        WHERE credential_id=${settings.credential_id} AND version=${catalog.version}`);
      checkoutAvailable = gateway.active && gateway.hasWebhookSecret && Number(count?.count) === catalog.plans.length * 2;
    }
    return { organization, entitlements, access, approved: eligible, checkoutAvailable, mode,
      subscription: adminSummary(activeAdmin) || summary(current),
      pendingChange: adminSummary(scheduledAdmin) || summary(pending),
      nextDepositAt: (activeAdmin ? adminDeposit?.due_at : [deposit?.due_at,adminDeposit?.due_at].filter((date): date is Date => !!date).sort((a,b)=>a.getTime()-b.getTime())[0])?.toISOString() || null,
      charges: (organization.canManageBilling ? charges : []).map(c => ({ id: c.payment_id, amountPaise: c.amount_paise, taxPaise: c.tax_paise, term: c.term,
        plan: c.slug, paidAt: c.paid_at.toISOString(), periodStart: c.period_start.toISOString(), periodEnd: c.period_end.toISOString(), invoiceUrl: c.invoice_url,
        refundAmountPaise:c.refund_amount_paise,refundObservedAt:c.refund_observed_at?.toISOString()||null })) };
  }

  async start(userId: number, slug: PlanSlug, term: BillingTerm, catalogVersion?: number): Promise<SubscriptionCheckout> {
    const organizationId = await resolveBillingOrganization(userId, this.database);
    await requireBillingRole(userId, organizationId, this.database);
    if (!['monthly', 'yearly'].includes(term)) throw new SubscriptionError('Choose a valid billing term.');
    const intent = await this.database.transaction(async tx => {
      await this.lock(tx, organizationId);
      await tx.execute(sql`SELECT id FROM billing_organizations WHERE id=${organizationId} FOR UPDATE`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(73031,1)`);
      const [adminTerm] = await rows(tx,sql`SELECT id FROM billing_admin_plan_terms
        WHERE organization_id=${organizationId} AND cancelled_at IS NULL AND ends_at>${this.now()} LIMIT 1`);
      if (adminTerm) throw new SubscriptionError('An administrator-assigned plan is active or scheduled. Contact support before starting payment checkout.',409,'ADMIN_PLAN_ACTIVE');
      const catalog = await getCatalog(undefined, tx);
      if(catalogVersion !== undefined && catalogVersion !== catalog.version) throw new SubscriptionError('Prices changed. Review the current catalog before checkout.',409,'CATALOG_CHANGED');
      if(!catalog.plans.some(p=>p.slug===slug)) throw new SubscriptionError('Choose a published plan.');
      if (!await this.billingEligible(tx, userId)) throw new SubscriptionError('Verify your account and complete the business owner’s setup and approval before subscribing.', 403, 'BILLING_APPROVAL_REQUIRED');
      const settings = await this.settings(tx);
      if (!settings.credential_id) throw new SubscriptionError('Subscription checkout is not available yet.', 503);
      const gateway = await this.gateway(settings.credential_id);
      if (!gateway.active || !gateway.hasWebhookSecret || (settings.enforced && gateway.mode !== 'live')) throw new SubscriptionError('Subscription checkout needs administrator setup.', 503);
      const [mapping] = await rows<{ provider_plan_id: string }>(tx, sql`SELECT provider_plan_id FROM subscription_provider_plans
        WHERE credential_id=${settings.credential_id} AND version=${catalog.version} AND slug=${slug} AND term=${term}`);
      if (!mapping) throw new SubscriptionError('This plan is not ready for checkout.', 503);
      await tx.execute(sql`INSERT INTO subscription_accounts(user_id,organization_id) VALUES(${userId},${organizationId}) ON CONFLICT DO NOTHING`);
      const [account] = await rows<{ current_subscription_id: string | null }>(tx, sql`SELECT current_subscription_id FROM subscription_accounts WHERE organization_id=${organizationId}`);
      const current = account.current_subscription_id ? await this.owned(tx, organizationId, account.current_subscription_id) : null;
      const paid = current?.mode === gateway.mode && current?.paid_through && current.paid_through > this.now();
      if (current && !terminal.includes(current.status) && current.credential_id !== settings.credential_id) {
        throw new SubscriptionError('Cancel the existing payment mandate before switching payment environments.', 409);
      }
      let existing = current && !paid && !terminal.includes(current.status) ? current : null;
      if (current && paid) {
        if (current.version === catalog.version && current.slug === slug && current.term === term && !current.cancel_at_period_end) throw new SubscriptionError('You already have this plan.', 409);
        const pending = await rows<SubscriptionRow>(tx, sql`SELECT * FROM billing_subscriptions WHERE replaces_id=${current.id}::uuid
          AND status NOT IN('cancelled','completed','expired','failed')`);
        existing = pending[0] || null;
      }
      if (existing) {
        if (existing.version !== catalog.version || existing.slug !== slug || existing.term !== term) throw new SubscriptionError('Cancel the pending checkout or plan change before selecting another plan.', 409);
        return { sub: existing, gateway, created: false };
      }
      // A lapsed but still charging mandate must be cancelled before creating another one.
      if (current && !paid && !terminal.includes(current.status)) throw new SubscriptionError('Resolve the current subscription before starting another.', 409);
      const startsAt = paid ? current!.paid_through! : null;
      if (startsAt && startsAt.getTime() - this.now().getTime() < 3600000) {
        throw new SubscriptionError('Renewal is less than an hour away. Change plans after this renewal settles.', 409);
      }
      const id = crypto.randomUUID();
      const [sub] = await rows<SubscriptionRow>(tx, sql`INSERT INTO billing_subscriptions
        (id,user_id,organization_id,organization_bound,credential_id,mode,version,slug,term,provider_plan_id,replaces_id,starts_at)
        VALUES(${id}::uuid,${userId},${organizationId},true,${settings.credential_id},${gateway.mode},${catalog.version},${slug},${term},${mapping.provider_plan_id},${paid ? current!.id : null}::uuid,${startsAt}) RETURNING *`);
      if (!paid) await tx.execute(sql`UPDATE subscription_accounts SET current_subscription_id=${id}::uuid WHERE organization_id=${organizationId}`);
      await tx.execute(sql`INSERT INTO subscription_audit(user_id,organization_id,action,details) VALUES(${userId},${organizationId},'checkout_created',${JSON.stringify({ id, version: catalog.version, slug, term, replaces: sub.replaces_id })}::jsonb)`);
      return { sub, gateway, created: true };
    });
    let sub = intent.sub;
    if (intent.created) {
      try {
        const provider = await intent.gateway.createSubscription(sub.id, userId, sub.provider_plan_id, term, sub.starts_at, sub.organization_id);
        const [saved] = await rows<SubscriptionRow>(this.database, sql`UPDATE billing_subscriptions SET provider_id=${provider.id},status=${provider.status},updated_at=now()
          WHERE id=${sub.id}::uuid RETURNING *`);
        sub = saved;
      } catch (error) {
        if (error instanceof SubscriptionError && error.code === 'PROVIDER_REJECTED') {
          await this.database.execute(sql`UPDATE billing_subscriptions SET status='failed',sync_error='Provider rejected creation',updated_at=now() WHERE id=${sub.id}::uuid`);
        }
        // On an uncertain network response the durable intent is recovered by notes. Do not create a second mandate.
        throw error;
      }
    }
    if (!sub.provider_id) throw new SubscriptionError('Checkout creation is being reconciled. Refresh billing shortly.', 409, 'CHECKOUT_PENDING');
    return { subscriptionId: sub.provider_id, keyId: intent.gateway.keyId, mode: intent.gateway.mode,
      startsAt: sub.starts_at?.toISOString() || null, replacement: !!sub.replaces_id };
  }

  async verify(userId: number, providerId: string, paymentId: string, signature: string) {
    const organizationId = await resolveBillingOrganization(userId, this.database);
    await requireBillingRole(userId, organizationId, this.database);
    const [sub] = await rows<SubscriptionRow>(this.database, sql`SELECT * FROM billing_subscriptions WHERE organization_id=${organizationId} AND provider_id=${providerId}`);
    if (!sub?.provider_id) throw new SubscriptionError('Subscription not found.', 404);
    const gateway = await this.gateway(sub.credential_id);
    if (!gateway.verifyCheckout(paymentId, sub.provider_id, signature)) throw new SubscriptionError('Invalid checkout signature.', 400, 'INVALID_SIGNATURE');
    // A checkout callback can represent a nominal mandate authorization. Reconcile paid plan invoices separately.
    await this.reconcile(sub.id, paymentId);
    return this.state(userId);
  }

  private async recordCharge(tx: Executor, sub: SubscriptionRow, gateway: RazorpaySubscriptionGateway, provider: ProviderSubscription, invoice: ProviderInvoice) {
    if (invoice.status !== 'paid' || !invoice.payment_id) return;
    const existing = await rows<{subscription_id:string}>(tx, sql`SELECT subscription_id FROM subscription_charges WHERE payment_id=${invoice.payment_id}`);
    if (existing.length && existing[0].subscription_id !== sub.id) throw new SubscriptionError('Payment belongs to another subscription.',409,'CHARGE_MISMATCH');
    const [plan] = await rows<{ monthly_amount_paise: number; yearly_amount_paise: number; monthly_credits: number }>(tx,
      sql`SELECT * FROM subscription_plans WHERE version=${sub.version} AND slug=${sub.slug}`);
    if (!plan) throw new SubscriptionError('Published plan version is unavailable.', 503);
    const payment = await gateway.getPayment(invoice.payment_id);
    const period = verifyCharge({ subscription: provider, invoice, payment, localId: sub.id, userId: sub.user_id, organizationId: sub.organization_bound ? sub.organization_id : undefined,
      providerId: sub.provider_id!, providerPlanId: sub.provider_plan_id, term: sub.term,
      amountPaise: sub.term === 'yearly' ? plan.yearly_amount_paise : plan.monthly_amount_paise,allowRefundedPayment:true });
    if (sub.starts_at && period.start.getTime() < sub.starts_at.getTime() - 60 * 1000) {
      throw new SubscriptionError('Replacement was charged before the agreed renewal date.', 409, 'CHARGE_MISMATCH');
    }
    if (existing.length) {
      if (payment.amount_refunded > 0) await this.recordRefund(tx,sub,payment.id,payment.amount_refunded);
      return;
    }
    const invoiceUrl = invoice.short_url && /^https:\/\/(?:rzp\.io|razorpay\.com)\//.test(invoice.short_url) ? invoice.short_url : null;
    const inserted = await rows(tx, sql`INSERT INTO subscription_charges
      (payment_id,invoice_id,subscription_id,user_id,organization_id,amount_paise,tax_paise,monthly_credits,period_start,period_end,paid_at,invoice_url)
      VALUES(${payment.id},${invoice.id},${sub.id}::uuid,${sub.user_id},${sub.organization_id},${payment.amount},${Number.isSafeInteger(invoice.tax_amount) ? invoice.tax_amount : null},${plan.monthly_credits},${period.start},${period.end},${period.paidAt},${invoiceUrl})
      ON CONFLICT(payment_id) DO NOTHING RETURNING payment_id`);
    if (!inserted.length) return;
    const dates = creditDepositDates(period.start, period.end, sub.term);
    for (const [index, dueAt] of dates.entries()) {
      await tx.execute(sql`INSERT INTO subscription_credit_grants(payment_id,month_index,user_id,organization_id,due_at,credits)
        VALUES(${payment.id},${index},${sub.user_id},${sub.organization_id},${dueAt},${plan.monthly_credits}) ON CONFLICT DO NOTHING`);
    }
    if (payment.amount_refunded > 0) {
      await this.recordRefund(tx,sub,payment.id,payment.amount_refunded);
      return;
    }
    await tx.execute(sql`UPDATE billing_subscriptions SET authorized=true,payment_method=${payment.method},failure_at=NULL WHERE id=${sub.id}::uuid`);
    if (period.start <= this.now()) {
      // Delayed historical webhooks cannot move an account back from its successor.
      await tx.execute(sql`UPDATE subscription_accounts SET current_subscription_id=${sub.id}::uuid
        WHERE organization_id=${sub.organization_id} AND (current_subscription_id=${sub.id}::uuid OR current_subscription_id=${sub.replaces_id}::uuid)`);
    }
  }

  private async recordRefund(tx:Executor,sub:SubscriptionRow,paymentId:string,amountPaise:number) {
    // Serialize with grant workers before publishing refund evidence. A grant
    // already in flight finishes first; every still-unissued month is retained
    // in the ledger as cancelled. Deposited wallet funds are never reversed.
    await tx.execute(sql`SELECT month_index FROM subscription_credit_grants
      WHERE payment_id=${paymentId} AND granted_at IS NULL ORDER BY month_index FOR UPDATE`);
    const updated=await rows<{refund_amount_paise:number}>(tx,sql`UPDATE subscription_charges
      SET refund_amount_paise=${amountPaise},refund_observed_at=COALESCE(refund_observed_at,${this.now()})
      WHERE payment_id=${paymentId} AND subscription_id=${sub.id}::uuid AND organization_id=${sub.organization_id}
        AND refund_amount_paise<${amountPaise} RETURNING refund_amount_paise`);
    const cancelled=await tx.execute(sql`UPDATE subscription_credit_grants
      SET cancelled_at=${this.now()},cancellation_reason='provider_refund'
      WHERE payment_id=${paymentId} AND granted_at IS NULL AND cancelled_at IS NULL RETURNING month_index`);
    if(updated.length) await tx.execute(sql`INSERT INTO subscription_audit(user_id,organization_id,action,details)
      VALUES(${sub.user_id},${sub.organization_id},'subscription_refund_reconciled',${JSON.stringify({subscriptionId:sub.id,paymentId,refundAmountPaise:amountPaise,cancelledDeposits:cancelled.rows.length,depositedCreditsRetained:true})}::jsonb)`);
  }

  async reconcile(id: string, checkoutPaymentId?: string) {
    return (await this.reconcileAttempt(id,checkoutPaymentId)).grants;
  }

  private async reconcileAttempt(id: string, checkoutPaymentId?: string) {
    const [initial] = await rows<SubscriptionRow>(this.database, sql`SELECT * FROM billing_subscriptions WHERE id=${id}::uuid`);
    if (!initial) throw new SubscriptionError('Subscription not found.', 404);
    const reconciled = await this.database.transaction(async tx => {
      await this.lock(tx, initial.organization_id);
      let sub = await this.owned(tx, initial.organization_id, id);
      const gateway = await this.gateway(sub.credential_id);
      if (!sub.provider_id) {
        const recovered = await gateway.recoverCreation(sub.id, sub.created_at);
        if (!recovered) {
          // An unknown create remains reviewable; it is not a failed mandate.
          // Record the attempt so NULL-first cron batches can reach other accounts.
          await tx.execute(sql`UPDATE billing_subscriptions SET last_synced_at=now(),
            sync_error='CREATION_RECOVERY_PENDING' WHERE id=${id}::uuid`);
          return false;
        }
        [sub] = await rows<SubscriptionRow>(tx, sql`UPDATE billing_subscriptions SET provider_id=${recovered.id},status=${recovered.status} WHERE id=${id}::uuid RETURNING *`);
      }
      const provider = await gateway.getSubscription(sub.provider_id!);
      if (provider.notes?.asksales_subscription_id !== sub.id || provider.notes?.asksales_user_id !== String(sub.user_id) || provider.plan_id !== sub.provider_plan_id || (sub.organization_bound && provider.notes?.asksales_organization_id !== String(sub.organization_id))) {
        throw new SubscriptionError('Provider subscription identity does not match.', 409, 'CHARGE_MISMATCH');
      }
      if (sub.starts_at && (!provider.start_at || Math.abs(provider.start_at * 1000 - sub.starts_at.getTime()) > 60000)) {
        throw new SubscriptionError('The replacement mandate has an unexpected start date.',409,'CHARGE_MISMATCH');
      }
      if (checkoutPaymentId) {
        const payment = await gateway.getPayment(checkoutPaymentId);
        if (payment.invoice_id) {
          const invoice = await gateway.getInvoice(payment.invoice_id);
          // Authorization invoices have no complete billing period and are never treated as a plan deposit.
          if (invoice.billing_start && invoice.billing_end && invoice.line_items?.some(item => item.type === 'plan')) {
            await this.recordCharge(tx, sub, gateway, provider, invoice);
          }
        }
      }
      const invoices = await gateway.invoices(provider.id);
      for (const invoice of invoices) {
        if (invoice.billing_start && invoice.billing_end && invoice.line_items?.some(item => item.type === 'plan')) {
          await this.recordCharge(tx, sub, gateway, provider, invoice);
        }
      }
      const authorized = authorizeStatuses.includes(provider.status);
      if (authorized && sub.replaces_id && !terminal.includes(provider.status)) {
        const old = await this.owned(tx, sub.organization_id, sub.replaces_id);
        if (!old.cancel_at_period_end && !terminal.includes(old.status)) {
          const oldGateway = await this.gateway(old.credential_id);
          const oldProvider = await oldGateway.getSubscription(old.provider_id!);
          const alreadyEnding = oldProvider.end_at && old.paid_through && oldProvider.end_at * 1000 <= old.paid_through.getTime();
          if (!terminal.includes(oldProvider.status) && !alreadyEnding) await oldGateway.cancel(old.provider_id!, true);
          await tx.execute(sql`UPDATE billing_subscriptions SET cancel_at_period_end=true,updated_at=now() WHERE id=${old.id}::uuid`);
        }
      }
      await tx.execute(sql`UPDATE billing_subscriptions SET status=${provider.status},authorized=authorized OR ${authorized},
        payment_method=COALESCE(${provider.payment_method || null},payment_method),
        failure_at=CASE WHEN ${['pending', 'halted'].includes(provider.status)} THEN COALESCE(failure_at,now()) ELSE NULL END,
        last_synced_at=now(),sync_error=NULL,
        updated_at=CASE WHEN status IS DISTINCT FROM ${provider.status} THEN now() ELSE updated_at END WHERE id=${id}::uuid`);
      return true;
    });
    return {reconciled,grants:reconciled ? await this.grantReconciledCredits(initial.organization_id, initial.id) : 0};
  }

  /** Every public catch-up path first refreshes each originating payment. A
   * sibling's successful reconciliation is never evidence for another grant. */
  async grantDueCredits(organizationId?: number) {
    const subscriptions = await rows<{ id: string }>(this.database, sql`SELECT DISTINCT s.id
      FROM subscription_credit_grants g JOIN subscription_charges c ON c.payment_id=g.payment_id
      JOIN billing_subscriptions s ON s.id=c.subscription_id
      WHERE g.granted_at IS NULL AND g.cancelled_at IS NULL AND g.due_at<=${this.now()}
        ${organizationId ? sql`AND g.organization_id=${organizationId}` : sql``} LIMIT 500`);
    let count = 0;
    for (const sub of subscriptions) count += await this.reconcile(sub.id);
    return count;
  }

  private async grantReconciledCredits(organizationId: number, subscriptionId: string) {
    return this.database.transaction(async tx => {
      await this.lock(tx, organizationId);
      const due = await rows<{ payment_id: string; month_index: number; user_id: number; organization_id: number; credits: number; mode: string; slug: string; term: string }>(tx,
        sql`SELECT g.*,s.mode,s.slug,s.term FROM subscription_credit_grants g
          JOIN subscription_charges c ON c.payment_id=g.payment_id JOIN billing_subscriptions s ON s.id=c.subscription_id
          WHERE g.granted_at IS NULL AND g.cancelled_at IS NULL AND c.refund_amount_paise=0 AND g.due_at<=${this.now()}
            AND g.organization_id=${organizationId} AND c.subscription_id=${subscriptionId}::uuid
          ORDER BY g.organization_id,g.due_at LIMIT 500 FOR UPDATE OF g SKIP LOCKED`);
      for (const grant of due) {
        if (grant.mode === 'test') {
          await tx.execute(sql`UPDATE subscription_credit_grants SET granted_at=now(),simulated=true
            WHERE payment_id=${grant.payment_id} AND month_index=${grant.month_index}`);
          continue;
        }
        await tx.execute(sql`INSERT INTO wallets(user_id,organization_id) SELECT owner_user_id,id FROM billing_organizations WHERE id=${grant.organization_id} ON CONFLICT(organization_id) DO NOTHING`);
        const [wallet] = await rows<{ balance: string }>(tx, sql`UPDATE wallets SET balance=balance+${grant.credits},
          total_credits_added=total_credits_added+${grant.credits},updated_at=now() WHERE organization_id=${grant.organization_id} RETURNING balance`);
        const [transaction] = await rows<{ id: number }>(tx, sql`INSERT INTO wallet_transactions
          (user_id,organization_id,type,amount,balance_after,description,category,reference_type,reference_id,payment_provider,payment_id,currency,metadata)
          VALUES(${grant.user_id},${grant.organization_id},'subscription',${grant.credits},${wallet.balance},${`${grant.slug} monthly credit deposit`},'subscription','subscription_grant',${`${grant.payment_id}:${grant.month_index}`},'razorpay',${grant.payment_id},'INR',${JSON.stringify({ monthIndex: grant.month_index, term: grant.term })}::jsonb) RETURNING id`);
        await tx.execute(sql`UPDATE subscription_credit_grants SET granted_at=now(),wallet_transaction_id=${transaction.id}
          WHERE payment_id=${grant.payment_id} AND month_index=${grant.month_index}`);
      }
      // Providers can capture shortly before an anniversary. Promote a paid replacement
      // only when its billing period actually starts, including after a delayed worker run.
      await tx.execute(sql`UPDATE subscription_accounts a SET current_subscription_id=s.id
        FROM billing_subscriptions s JOIN subscription_charges c ON c.subscription_id=s.id
        WHERE s.replaces_id=a.current_subscription_id AND s.organization_id=a.organization_id
          AND s.organization_id=${organizationId} AND s.id=${subscriptionId}::uuid
          AND c.refund_amount_paise=0 AND c.period_start<=${this.now()} AND c.period_end>${this.now()}`);
      return due.length;
    });
  }

  /** Grant complimentary plan credits once per due month, under the same billing account lock used by admin changes. */
  async grantAdminDueCredits(organizationId?: number) {
    const dueOrganizations = organizationId
      ? [{ organization_id: organizationId }]
      : await rows<{ organization_id: number }>(this.database, sql`SELECT DISTINCT t.organization_id
          FROM billing_admin_plan_credit_grants g JOIN billing_admin_plan_terms t ON t.id=g.term_id
          WHERE t.starts_at<=${this.now()} AND g.due_at<=${this.now()}
            AND (t.cancelled_at IS NULL OR g.due_at<=t.cancelled_at)
            AND g.granted_at IS NULL AND g.cancelled_at IS NULL
          ORDER BY t.organization_id LIMIT 500`);
    let granted = 0;
    for (const organization of dueOrganizations) {
      granted += await this.database.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM billing_organizations WHERE id=${organization.organization_id} FOR UPDATE`);
        const due = await rows<{term_id:string;month_index:number;credits:number;slug:string;term:BillingTerm;owner_user_id:number}>(tx,
          sql`SELECT g.term_id,g.month_index,g.credits,t.slug,t.term,o.owner_user_id
            FROM billing_admin_plan_credit_grants g
            JOIN billing_admin_plan_terms t ON t.id=g.term_id
            JOIN billing_organizations o ON o.id=t.organization_id
            WHERE t.organization_id=${organization.organization_id} AND t.starts_at<=${this.now()}
              AND g.due_at<=${this.now()} AND (t.cancelled_at IS NULL OR g.due_at<=t.cancelled_at)
              AND g.granted_at IS NULL AND g.cancelled_at IS NULL
            ORDER BY g.due_at LIMIT 12 FOR UPDATE OF g SKIP LOCKED`);
        for (const grant of due) {
          await tx.execute(sql`INSERT INTO wallets(user_id,organization_id) VALUES(${grant.owner_user_id},${organization.organization_id})
            ON CONFLICT(organization_id) DO NOTHING`);
          const [wallet] = await rows<{balance:string}>(tx,sql`UPDATE wallets SET balance=balance+${grant.credits},
            total_credits_added=total_credits_added+${grant.credits},updated_at=now()
            WHERE organization_id=${organization.organization_id} RETURNING balance`);
          const [transaction] = await rows<{id:number}>(tx,sql`INSERT INTO wallet_transactions
            (user_id,organization_id,type,amount,balance_after,description,category,reference_type,reference_id,payment_provider,currency,metadata)
            VALUES(${grant.owner_user_id},${organization.organization_id},'subscription',${grant.credits},${wallet.balance},
              ${`${grant.slug} administrator plan credit deposit`},'subscription','admin_plan_grant',
              ${`${grant.term_id}:${grant.month_index}`},'admin','INR',
              ${JSON.stringify({monthIndex:grant.month_index,term:grant.term,source:'admin'})}::jsonb) RETURNING id`);
          await tx.execute(sql`UPDATE billing_admin_plan_credit_grants SET granted_at=${this.now()},wallet_transaction_id=${transaction.id}
            WHERE term_id=${grant.term_id}::uuid AND month_index=${grant.month_index}`);
        }
        return due.length;
      });
    }
    return granted;
  }

  async cancel(userId: number, scope: 'renewal' | 'pending' = 'renewal') {
    const organizationId = await resolveBillingOrganization(userId, this.database);
    await requireBillingRole(userId, organizationId, this.database);
    await this.database.transaction(async tx => {
      await this.lock(tx, organizationId);
      const [account] = await rows<{ current_subscription_id: string }>(tx, sql`SELECT current_subscription_id FROM subscription_accounts WHERE organization_id=${organizationId}`);
      if (!account?.current_subscription_id) throw new SubscriptionError('No subscription to cancel.', 404);
      const current = await this.owned(tx, organizationId, account.current_subscription_id);
      const pending = await rows<SubscriptionRow>(tx, sql`SELECT * FROM billing_subscriptions WHERE replaces_id=${current.id}::uuid AND status NOT IN('cancelled','completed','expired','failed')`);
      const selected = scope === 'pending' ? pending : [...pending, current];
      if (!selected.length) throw new SubscriptionError('No pending plan change.', 404);
      for (const sub of selected) {
        if (terminal.includes(sub.status) || sub.cancel_at_period_end) continue;
        if (!sub.provider_id) throw new SubscriptionError('Checkout is still being reconciled. Try again shortly.', 409);
        const gateway = await this.gateway(sub.credential_id);
        const fresh = await gateway.getSubscription(sub.provider_id);
        const paidTerm = sub.mode === 'live' && sub.id === current.id && !!current.paid_through && current.paid_through > this.now();
        const alreadyEnding = paidTerm && fresh.end_at && current.paid_through && fresh.end_at * 1000 <= current.paid_through.getTime();
        if (!terminal.includes(fresh.status) && !alreadyEnding) await gateway.cancel(sub.provider_id, paidTerm);
        await tx.execute(sql`UPDATE billing_subscriptions SET cancel_at_period_end=true,
          status=CASE WHEN ${paidTerm} THEN status ELSE 'cancelled' END,updated_at=now() WHERE id=${sub.id}::uuid`);
      }
      await tx.execute(sql`INSERT INTO subscription_audit(user_id,organization_id,action,details) VALUES(${userId},${organizationId},'cancel_requested',${JSON.stringify({ scope })}::jsonb)`);
    });
    return this.state(userId);
  }

  async webhook(credentialId: number, raw: Buffer, signature: string, eventId: string) {
    const gateway = await this.gateway(credentialId);
    if (!gateway.verifyWebhook(raw, signature)) throw new SubscriptionError('Invalid webhook signature.', 400, 'INVALID_SIGNATURE');
    if (!eventId || eventId.length > 255) throw new SubscriptionError('Webhook event ID is required.');
    const event = JSON.parse(raw.toString('utf8')) as { event: string; payload?: { subscription?: { entity?: ProviderSubscription }; payment?: { entity?: { id: string } }; refund?: {entity?:{payment_id?:string}} } };
    if (typeof event.event !== 'string' || !/^(subscription|payment|refund)\./.test(event.event)) return;
    const entity = event.payload?.subscription?.entity;
    const paymentEntityId=event.payload?.payment?.entity?.id;
    const refundPaymentId=event.payload?.refund?.entity?.payment_id;
    if(paymentEntityId && refundPaymentId && paymentEntityId!==refundPaymentId) throw new SubscriptionError('Refund payment identity does not match.',409,'CHARGE_MISMATCH');
    const paymentId=paymentEntityId||refundPaymentId;
    if(paymentId && (typeof paymentId!=='string'||!/^pay_[a-zA-Z0-9]+$/.test(paymentId))) throw new SubscriptionError('Invalid webhook payment identity.');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await this.database.execute(sql`INSERT INTO subscription_webhook_events(credential_id,event_id,event_type,body_hash,provider_subscription_id)
      VALUES(${credentialId},${eventId},${event.event},${hash},${entity?.id || null}) ON CONFLICT DO NOTHING`);
    const [saved] = await rows<{ body_hash: string; processed_at: Date | null }>(this.database,
      sql`SELECT body_hash,processed_at FROM subscription_webhook_events WHERE credential_id=${credentialId} AND event_id=${eventId}`);
    if (saved.body_hash !== hash) throw new SubscriptionError('Webhook event ID was reused with a different body.', 409);
    if (saved.processed_at) return;
    let [sub] = entity ? await rows<SubscriptionRow>(this.database, sql`SELECT * FROM billing_subscriptions WHERE credential_id=${credentialId}
      AND (provider_id=${entity.id} OR (provider_id IS NULL AND id::text=${entity.notes?.asksales_subscription_id || ''}))`) : [];
    if(!sub && paymentId) {
      // Refund webhooks often contain no subscription entity. First recover the
      // immutable local association; an early event can recover through the
      // gateway-owned invoice before a charge has been recorded locally.
      [sub]=await rows<SubscriptionRow>(this.database,sql`SELECT s.* FROM billing_subscriptions s
        JOIN subscription_charges c ON c.subscription_id=s.id
        WHERE s.credential_id=${credentialId} AND c.payment_id=${paymentId}`);
      if(!sub) {
        const payment=await gateway.getPayment(paymentId);
        if(payment.id!==paymentId) throw new SubscriptionError('Provider payment identity does not match.',409,'CHARGE_MISMATCH');
        if(payment.invoice_id) {
          const invoice=await gateway.getInvoice(payment.invoice_id);
          if(invoice.payment_id!==paymentId || invoice.id!==payment.invoice_id) throw new SubscriptionError('Provider invoice identity does not match.',409,'CHARGE_MISMATCH');
          [sub]=await rows<SubscriptionRow>(this.database,sql`SELECT * FROM billing_subscriptions
            WHERE credential_id=${credentialId} AND provider_id=${invoice.subscription_id}`);
        }
      }
    }
    if (sub) {
      await this.database.execute(sql`UPDATE subscription_webhook_events SET provider_subscription_id=${sub.provider_id||entity?.id||null}
        WHERE credential_id=${credentialId} AND event_id=${eventId}`);
      try {
        if(paymentId && ['refund.processed','payment.refunded'].includes(event.event)) {
          const payment=await gateway.getPayment(paymentId);
          if(payment.id!==paymentId) throw new SubscriptionError('Provider payment identity does not match.',409,'CHARGE_MISMATCH');
          if(!Number.isSafeInteger(payment.amount_refunded)||payment.amount_refunded<=0) {
            throw new SubscriptionError('The provider refund is still being confirmed.',503,'REFUND_CONFIRMATION_PENDING');
          }
        }
        await this.reconcile(sub.id,paymentId);
      } catch(error) {
        const code=error instanceof SubscriptionError?error.code:'RECONCILIATION_ERROR';
        await this.database.execute(sql`UPDATE billing_subscriptions SET sync_error=${code} WHERE id=${sub.id}::uuid`);
        throw error;
      }
    }
    // Only events for our managed subscriptions count as verified delivery for rollout.
    await this.database.execute(sql`UPDATE subscription_webhook_events SET processed_at=now(),provider_subscription_id=${sub ? sub.provider_id||entity?.id||null : null}
      WHERE credential_id=${credentialId} AND event_id=${eventId}`);
  }

  async refresh(userId: number) {
    const organizationId = await resolveBillingOrganization(userId, this.database);
    const pending = await rows<{ id: string }>(this.database, sql`SELECT s.id FROM billing_subscriptions s
      JOIN subscription_accounts a ON a.organization_id=s.organization_id WHERE s.organization_id=${organizationId}
      AND (s.id=a.current_subscription_id OR s.replaces_id=a.current_subscription_id)
      ORDER BY s.created_at DESC LIMIT 2`);
    for (const sub of pending) await this.reconcile(sub.id);
    return this.state(userId);
  }

  async runScheduled() {
    // Re-fetch provider payments before granting due credits. A cancelled
    // yearly mandate still needs refund checks for each outstanding deposit.
    const candidates = await rows<{ id: string }>(this.database, sql`SELECT s.id FROM billing_subscriptions s
      WHERE ((s.status NOT IN('cancelled','completed','expired','failed') OR s.updated_at>now()-interval '14 days')
        AND (s.last_synced_at IS NULL OR s.last_synced_at<now()-interval '15 minutes'))
      OR EXISTS(SELECT 1 FROM subscription_credit_grants g JOIN subscription_charges c ON c.payment_id=g.payment_id
        WHERE c.subscription_id=s.id AND g.granted_at IS NULL AND g.cancelled_at IS NULL AND g.due_at<=${this.now()})
      ORDER BY s.last_synced_at NULLS FIRST,s.created_at,s.id LIMIT 30`);
    let errors = 0,reconciled=0,pending=0;
    for (const sub of candidates) {
      try {
        const result=await this.reconcileAttempt(sub.id);
        if(result.reconciled)reconciled++;else pending++;
      }
      catch (error) {
        errors++;
        const code = error instanceof SubscriptionError ? error.code : 'RECONCILIATION_ERROR';
        await this.database.execute(sql`UPDATE billing_subscriptions SET sync_error=${code},last_synced_at=now() WHERE id=${sub.id}::uuid`);
        logger.error({ subscriptionId: sub.id, code }, '[Subscriptions] Reconciliation needs attention');
      }
    }
    const adminGrants = await this.grantAdminDueCredits();
    const [mismatch] = await rows<{ count: string }>(this.database, sql`SELECT count(*) FROM subscription_credit_grants
      WHERE granted_at IS NULL AND cancelled_at IS NULL AND due_at<now()-interval '10 minutes'`);
    const [adminMismatch] = await rows<{count:string}>(this.database,sql`SELECT count(*) FROM billing_admin_plan_credit_grants g
      JOIN billing_admin_plan_terms t ON t.id=g.term_id
      WHERE g.granted_at IS NULL AND g.cancelled_at IS NULL
        AND (t.cancelled_at IS NULL OR g.due_at<=t.cancelled_at)
        AND t.starts_at<=now() AND g.due_at<now()-interval '10 minutes'`);
    const overdueGrants = Number(mismatch.count) + Number(adminMismatch.count);
    if (overdueGrants) logger.error({ overdueGrants }, '[Subscriptions] Credit deposits overdue');
    return { attempted:candidates.length,reconciled,pending,errors,adminGrants,overdueGrants };
  }
}

export const subscriptions = new SubscriptionService();

export async function requireSubscriptionForOperation(userId: number) {
  const access = await subscriptions.access(userId);
  if (access.reason === 'approval_required') throw new SubscriptionError('This business is awaiting account approval. Contact its owner or support.', 403, 'BUSINESS_APPROVAL_REQUIRED');
  if (!access.allowed) throw new SubscriptionError('Choose a subscription to continue. Your wallet credits are retained.', 402, 'SUBSCRIPTION_REQUIRED');
  return access;
}
