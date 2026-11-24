import { getCapacityReconciliation } from '../billing/entitlements.js';
import { sql } from 'drizzle-orm';
import { getAdminCredentialById, getAdminCredentialsByPlatform, recordAdminCredentialAudit, updateAdminCredential } from '../../models/adminApiCredentials/functions.js';
import { type BillingTerm } from '../../../shared/subscriptions.js';
import { SubscriptionError } from './gateway.js';
import { rows, subscriptions, type Executor } from './service.js';
import { getCatalog, provisionCatalog } from './catalog.js';

export async function latestVerifiedLiveWebhook(database: Executor, credentialId: number | null, notBefore: Date) {
  const [webhook] = await rows<{ received_at: Date }>(database, sql`SELECT e.received_at
    FROM subscription_webhook_events e JOIN billing_subscriptions s
      ON s.provider_id=e.provider_subscription_id AND s.credential_id=e.credential_id
    WHERE e.credential_id=${credentialId} AND s.mode='live' AND e.processed_at IS NOT NULL
      AND e.received_at>=${notBefore} ORDER BY e.received_at DESC LIMIT 1`);
  return webhook || null;
}

export async function subscriptionAdminState() {
  const db = subscriptions.database;
  const settings = await subscriptions.settings();
  const catalog = await getCatalog();
  const credentials = await getAdminCredentialsByPlatform('razorpay');
  const credential = credentials.find(c => c.id === settings.credential_id);
  const webhookUpdatedAt = (credential?.config as Record<string, unknown> | null)?.subscriptionWebhookUpdatedAt;
  const secretChangedAt = typeof webhookUpdatedAt === 'string' ? Date.parse(webhookUpdatedAt) : 0;
  // Rotating a key or changing its mode invalidates evidence gathered with the old credential.
  const webhookNotBefore = new Date(Math.max(credential?.updatedAt.getTime() || 0,
    Number.isFinite(secretChangedAt) ? secretChangedAt : 0));
  const plans = await rows<{ credential_id: number; version: number; slug: string; term: string; provider_plan_id: string }>(db, sql`SELECT credential_id,version,slug,term,provider_plan_id FROM subscription_provider_plans ORDER BY credential_id,slug,term`);
  const evidence = await rows<{ term: BillingTerm; count: string }>(db, sql`SELECT s.term,count(*) FROM subscription_charges c
    JOIN billing_subscriptions s ON s.id=c.subscription_id WHERE s.mode='test' GROUP BY s.term`);
  const webhook = await latestVerifiedLiveWebhook(db, settings.credential_id, webhookNotBefore);
  const [overdue] = await rows<{ count: string }>(db, sql`SELECT count(*) FROM subscription_credit_grants WHERE granted_at IS NULL AND cancelled_at IS NULL AND due_at<now()-interval '10 minutes'`);
  const issues = await rows(db, sql`SELECT id,user_id,mode,slug,term,status,sync_error,last_synced_at FROM billing_subscriptions
    WHERE sync_error IS NOT NULL OR (provider_id IS NULL AND created_at<now()-interval '5 minutes' AND status='creating') ORDER BY updated_at DESC LIMIT 100`);
  const [missing] = await rows<{ count: string }>(db, sql`SELECT count(*) FROM subscription_charges c JOIN billing_subscriptions s ON s.id=c.subscription_id
    WHERE (SELECT count(*) FROM subscription_credit_grants g WHERE g.payment_id=c.payment_id) != CASE WHEN s.term='yearly' THEN 12 ELSE 1 END`);
  const [unreconciledRefunds]=await rows<{count:string}>(db,sql`SELECT count(*) FROM subscription_charges c
    WHERE c.refund_amount_paise>0 AND EXISTS(SELECT 1 FROM subscription_credit_grants g
      WHERE g.payment_id=c.payment_id AND g.granted_at IS NULL AND g.cancelled_at IS NULL)`);
  const refunds=await rows<{payment_id:string;organization_id:number;subscription_id:string;amount_paise:number;refund_amount_paise:number;refund_observed_at:Date;cancelled_deposits:string;retained_credits:string}>(db,sql`
    SELECT c.payment_id,c.organization_id,c.subscription_id,c.amount_paise,c.refund_amount_paise,c.refund_observed_at,
      (SELECT count(*) FROM subscription_credit_grants g WHERE g.payment_id=c.payment_id AND g.cancelled_at IS NOT NULL) cancelled_deposits,
      (SELECT COALESCE(sum(g.credits),0) FROM subscription_credit_grants g WHERE g.payment_id=c.payment_id AND g.granted_at IS NOT NULL AND NOT g.simulated) retained_credits
    FROM subscription_charges c WHERE c.refund_amount_paise>0 ORDER BY c.refund_observed_at DESC LIMIT 100`);
  const monthlyTest = evidence.some(e => e.term === 'monthly' && Number(e.count) > 0);
  const yearlyTest = evidence.some(e => e.term === 'yearly' && Number(e.count) > 0);
  const live = credential?.apiKey.startsWith('rzp_live_') === true;
  const ready = monthlyTest && yearlyTest && live && credential?.isActive === true && !!webhook && !Number(overdue.count) && !Number(missing.count) && !Number(unreconciledRefunds.count) && issues.length === 0
    && plans.filter(p => p.credential_id === settings.credential_id && p.version === catalog.version).length === catalog.plans.length * 2;
  return {
    settings: { enforced: settings.enforced, capacityEnforced: settings.capacity_enforced, publishedCatalogVersion: catalog.version, launchedAt: settings.launched_at?.toISOString() || null, credentialId: settings.credential_id },
    credentials: credentials.map(c => ({ id: c.id, name: c.name, active: c.isActive, mode: c.apiKey.startsWith('rzp_live_') ? 'live' : 'test',
      webhookConfigured: !!(c.config as Record<string, unknown> | null)?.subscriptionWebhookSecret })),
    plans, readiness: { monthlyTest, yearlyTest, live, liveWebhookVerifiedAt: live ? webhook?.received_at.toISOString() || null : null,
      overdueGrants: Number(overdue.count), missingGrants: Number(missing.count), unreconciledRefunds:Number(unreconciledRefunds.count), ready }, issues,
    refunds:refunds.map(refund=>({paymentId:refund.payment_id,organizationId:refund.organization_id,subscriptionId:refund.subscription_id,
      amountPaise:refund.amount_paise,refundAmountPaise:refund.refund_amount_paise,observedAt:refund.refund_observed_at.toISOString(),
      cancelledDeposits:Number(refund.cancelled_deposits),retainedCredits:Number(refund.retained_credits)})),
    webhookPath: settings.credential_id ? `/api/webhooks/razorpay/subscriptions/${settings.credential_id}` : null,
  };
}

export async function configureSubscriptions(adminId: number | null, credentialId: number, webhookSecret?: string) {
  const credential = await getAdminCredentialById(credentialId);
  if (!credential || credential.platform !== 'razorpay' || !credential.isActive || !credential.apiSecret) throw new SubscriptionError('Choose an active Razorpay credential.');
  const settings = await subscriptions.settings();
  if (settings.enforced && (settings.credential_id !== credentialId || webhookSecret !== undefined)) throw new SubscriptionError('Disable enforcement before changing billing credentials or the webhook secret.',409);
  if (settings.enforced && !credential.apiKey.startsWith('rzp_live_')) throw new SubscriptionError('Enforcement requires live credentials.');
  if (webhookSecret !== undefined) {
    if (webhookSecret.length < 16 || webhookSecret.length > 255) throw new SubscriptionError('Use a webhook secret between 16 and 255 characters.');
    await updateAdminCredential(credentialId, { config: { ...(credential.config || {}), subscriptionWebhookSecret: webhookSecret, subscriptionWebhookUpdatedAt: new Date().toISOString() } });
    await recordAdminCredentialAudit({ credentialId, platform: 'razorpay', adminId, action: 'update', changedFields: ['subscriptionWebhookSecret'] });
  }
  await subscriptions.database.transaction(async tx => {
    await tx.execute(sql`UPDATE subscription_settings SET credential_id=${credentialId},updated_by=${adminId},updated_at=now() WHERE id=1`);
    await tx.execute(sql`INSERT INTO subscription_audit(admin_id,action,details) VALUES(${adminId},'configured',${JSON.stringify({ credentialId, webhookSecretChanged: webhookSecret !== undefined })}::jsonb)`);
  });
  return subscriptionAdminState();
}

export async function provisionSubscriptionPlans(adminId: number | null) {
  const settings = await subscriptions.settings();
  if (!settings.credential_id) throw new SubscriptionError('Select a Razorpay credential first.');
  const gateway = await subscriptions.gateway(settings.credential_id);
  const catalog = await getCatalog();
  await subscriptions.database.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73031,1)`);
    await provisionCatalog(tx,catalog.version,settings.credential_id!,gateway);
    await tx.execute(sql`INSERT INTO subscription_audit(admin_id,action,details) VALUES(${adminId},'plans_provisioned',${JSON.stringify({ credentialId: settings.credential_id, version: catalog.version })}::jsonb)`);
  });
  return subscriptionAdminState();
}

export async function setSubscriptionEnforcement(adminId: number, enabled: boolean) {
  await subscriptions.database.transaction(async tx => {
    // Credential CRUD takes this same row lock in its database trigger.
    await tx.execute(sql`SELECT id FROM subscription_settings WHERE id=1 FOR UPDATE`);
    const state = await subscriptionAdminState();
    if (enabled && !state.readiness.ready) throw new SubscriptionError('Complete monthly and yearly test purchases, verify live webhook delivery, provision all plans and resolve billing issues before enabling enforcement.', 409);
    await tx.execute(sql`UPDATE subscription_settings SET enforced=${enabled},
      launched_at=CASE WHEN ${enabled} THEN COALESCE(launched_at,now()) ELSE launched_at END,updated_at=now(),updated_by=${adminId} WHERE id=1`);
    await tx.execute(sql`INSERT INTO subscription_audit(admin_id,action,details) VALUES(${adminId},'enforcement_changed',${JSON.stringify({ enabled })}::jsonb)`);
  });
  return subscriptionAdminState();
}

export async function setCapacityEnforcement(adminId:number,enabled:boolean) {
  await subscriptions.database.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73032,0)`);
    if(enabled) {
      const organizations=await rows<{id:number}>(tx,sql`SELECT id FROM billing_organizations ORDER BY id`);
      for(const organization of organizations) {
        if((await getCapacityReconciliation(organization.id,tx)).length) throw new SubscriptionError('Capacity counts need reconciliation before limits can be enabled.',409,'CAPACITY_RECONCILIATION_REQUIRED');
      }
    }
    await tx.execute(sql`UPDATE subscription_settings SET capacity_enforced=${enabled},updated_by=${adminId},updated_at=now() WHERE id=1`);
    await tx.execute(sql`INSERT INTO subscription_audit(admin_id,action,details) VALUES(${adminId},'capacity_enforcement_changed',${JSON.stringify({enabled})}::jsonb)`);
  });
  return subscriptionAdminState();
}
