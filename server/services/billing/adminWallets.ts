import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { withBillingScope } from '../../tenancy/billingContext.js';
import { creditService } from '../CreditService.js';
import { SubscriptionError } from '../subscriptions/gateway.js';

export async function listOrganizationWallets(search = '') {
  const resultLimit = 100;
  const result=await db.execute(sql`SELECT o.id,o.name,o.owner_user_id,u.email owner_email,
    COALESCE(w.balance,0)::text balance,COALESCE(m.slug,s.slug) slug,
    COALESCE(mp.name,p.name) plan_name,COALESCE(m.version,s.version) version
    FROM billing_organizations o LEFT JOIN wallets w ON w.organization_id=o.id
    JOIN users u ON u.id=o.owner_user_id
    LEFT JOIN LATERAL (SELECT s.version,s.slug FROM subscription_charges c
      JOIN billing_subscriptions s ON s.id=c.subscription_id
      WHERE c.organization_id=o.id AND s.mode='live' AND c.refund_amount_paise=0
        AND c.period_start<=now() AND c.period_end>now()
      ORDER BY c.period_start DESC LIMIT 1) s ON true
    LEFT JOIN subscription_plans p ON p.version=s.version AND p.slug=s.slug
    LEFT JOIN LATERAL (SELECT version,slug FROM billing_admin_plan_terms
      WHERE organization_id=o.id AND cancelled_at IS NULL AND starts_at<=now() AND ends_at>now()
      ORDER BY starts_at DESC LIMIT 1) m ON true
    LEFT JOIN subscription_plans mp ON mp.version=m.version AND mp.slug=m.slug
    WHERE ${search}='' OR o.name ILIKE ${`%${search}%`} OR o.id::text=${search}
      OR u.email ILIKE ${`%${search}%`}
    ORDER BY o.id LIMIT ${resultLimit + 1}`);
  return {resultLimit,hasMore:result.rows.length>resultLimit,organizations:result.rows.slice(0,resultLimit).map((r:Record<string,unknown>)=>({id:Number(r.id),name:String(r.name),ownerUserId:Number(r.owner_user_id),
    ownerEmail:String(r.owner_email),balance:Number(r.balance),planName:r.plan_name??null,planSlug:r.slug??null,catalogVersion:r.version??null}))};
}
export async function adjustOrganizationCredits(adminId:number,organizationId:number,amount:number,reason:string) {
  const result=await db.execute(sql`SELECT owner_user_id FROM billing_organizations WHERE id=${organizationId}`);
  const ownerId=Number(result.rows[0]?.owner_user_id);
  if(!ownerId) throw new SubscriptionError('Organization not found.',404);
  const balance=await withBillingScope({organizationId,actorUserId:ownerId},()=>creditService.addBonusCredits(ownerId,amount,reason,{adminId,organizationId}));
  return {organizationId,balance};
}
