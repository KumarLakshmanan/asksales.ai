/**
 * Our Meta credit line for WhatsApp ("we pay Meta"), as a Solution Partner.
 *
 * Settings live on the platform's Meta app credential (admin_api_credentials,
 * platform 'meta_app'), in config keys prefixed "whatsappBilling". The system
 * user token's key ends in "Token", so it is encrypted at rest like other
 * integration secrets and never returned to the browser.
 *
 * Meta endpoints used (developers.facebook.com, "Managing credit lines", 2026-05-21):
 *   POST /{credit_line_id}/whatsapp_credit_sharing_and_attach?waba_currency=&waba_id=  -> allocation_config_id
 *   GET  /{allocation_config_id}?fields=receiving_credential   (system token)
 *   GET  /{waba_id}?fields=primary_funding_id                   (customer token)  -> must match
 *   DELETE /{allocation_config_id}                              (system token)    -> revoke
 * Note: Meta applies a revoke to every WABA of that customer's business shared with us.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { WHATSAPP_CATEGORIES, platformBillingEnabled } from './WhatsAppBillingService.js';

export interface CreditLineConfig {
  creditLineId: string;
  systemToken: string;
  attachOnSignup: boolean;
  currency: string;
  apiVersion: string;
  /** Our own monthly spend alert threshold, in the credit-line currency (Meta does not expose usage per WABA). */
  monthlyLimit: number | null;
  alertPercent: number;
}

export interface CreditLineSettingsView {
  creditLineId: string;
  systemTokenConfigured: boolean;
  attachOnSignup: boolean;
  currency: string;
  monthlyLimit: number | null;
  alertPercent: number;
  metaAppConfigured: boolean;
  featureEnabled: boolean;
}

// Credits are converted from INR or USD only (see creditsForRate).
const CURRENCIES = ['INR', 'USD'];

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) || [];
}

async function metaAppCredential() {
  const { getActiveAdminCredential, getAdminCredentialsByPlatform } = await import('../../models/adminApiCredentials/functions.js');
  return await getActiveAdminCredential('meta_app') || (await getAdminCredentialsByPlatform('meta_app'))[0] || null;
}

export async function getCreditLineConfig(): Promise<CreditLineConfig | null> {
  const credential = await metaAppCredential();
  const config = (credential?.config || {}) as Record<string, unknown>;
  const creditLineId = String(config.whatsappBillingCreditLineId || '').trim();
  const systemToken = String(config.whatsappBillingSystemToken || '').trim();
  if (!credential || !creditLineId || !systemToken) return null;
  const limit = Number(config.whatsappBillingMonthlyLimit);
  const alert = Number(config.whatsappBillingAlertPercent);
  return {
    creditLineId, systemToken,
    attachOnSignup: config.whatsappBillingAttachOnSignup === true,
    currency: CURRENCIES.includes(String(config.whatsappBillingCurrency)) ? String(config.whatsappBillingCurrency) : 'INR',
    apiVersion: /^v\d{1,3}\.\d{1,2}$/.test(String(config.apiVersion)) ? String(config.apiVersion) : 'v25.0',
    monthlyLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
    alertPercent: Number.isFinite(alert) && alert > 0 && alert <= 100 ? alert : 80,
  };
}

export async function getCreditLineSettings(): Promise<CreditLineSettingsView> {
  const credential = await metaAppCredential();
  const config = (credential?.config || {}) as Record<string, unknown>;
  const limit = Number(config.whatsappBillingMonthlyLimit);
  const alert = Number(config.whatsappBillingAlertPercent);
  return {
    creditLineId: String(config.whatsappBillingCreditLineId || ''),
    systemTokenConfigured: !!config.whatsappBillingSystemToken,
    attachOnSignup: config.whatsappBillingAttachOnSignup === true,
    currency: CURRENCIES.includes(String(config.whatsappBillingCurrency)) ? String(config.whatsappBillingCurrency) : 'INR',
    monthlyLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
    alertPercent: Number.isFinite(alert) && alert > 0 && alert <= 100 ? alert : 80,
    metaAppConfigured: !!credential,
    featureEnabled: platformBillingEnabled(),
  };
}

export class CreditLineSettingsError extends Error {}

export async function saveCreditLineSettings(adminId: number | null, input: {
  creditLineId?: string; systemToken?: string; attachOnSignup?: boolean; currency?: string; monthlyLimit?: number | null; alertPercent?: number;
}): Promise<CreditLineSettingsView> {
  const credential = await metaAppCredential();
  if (!credential) throw new CreditLineSettingsError('Save the Meta app (App ID and secret) on the Meta integration page first.');
  const incoming: Record<string, unknown> = {};
  if (input.creditLineId !== undefined) {
    const id = String(input.creditLineId).trim();
    if (id && !/^\d{5,30}$/.test(id)) throw new CreditLineSettingsError('The credit line ID is the number Meta returns from /extendedcredits.');
    incoming.whatsappBillingCreditLineId = id;
  }
  if (input.systemToken !== undefined && String(input.systemToken).trim()) {
    const token = String(input.systemToken).trim();
    if (token.length < 20 || token.length > 1000 || /\s/.test(token)) throw new CreditLineSettingsError('The system user token does not look valid.');
    incoming.whatsappBillingSystemToken = token;
  }
  if (input.attachOnSignup !== undefined) incoming.whatsappBillingAttachOnSignup = input.attachOnSignup === true;
  if (input.currency !== undefined) {
    if (!CURRENCIES.includes(input.currency)) throw new CreditLineSettingsError(`Currency must be one of ${CURRENCIES.join(', ')}.`);
    incoming.whatsappBillingCurrency = input.currency;
  }
  if (input.monthlyLimit !== undefined) {
    if (input.monthlyLimit !== null && !(Number(input.monthlyLimit) > 0)) throw new CreditLineSettingsError('The monthly limit must be a positive amount, or empty.');
    incoming.whatsappBillingMonthlyLimit = input.monthlyLimit === null ? '' : Number(input.monthlyLimit);
  }
  if (input.alertPercent !== undefined) {
    if (!(Number(input.alertPercent) > 0 && Number(input.alertPercent) <= 100)) throw new CreditLineSettingsError('The alert threshold must be between 1 and 100 percent.');
    incoming.whatsappBillingAlertPercent = Number(input.alertPercent);
  }
  const { updateAdminCredential, recordAdminCredentialAudit } = await import('../../models/adminApiCredentials/functions.js');
  const { mergeIntegrationCredentialConfig } = await import('../../utils/integrationSecrets.js');
  await updateAdminCredential(credential.id, { config: mergeIntegrationCredentialConfig(credential.config, incoming) as never });
  await recordAdminCredentialAudit({
    credentialId: credential.id, platform: 'meta_app', action: incoming.whatsappBillingSystemToken ? 'rotate' : 'update',
    adminId, changedFields: Object.keys(incoming).map(key => `config.${key}`),
  });
  return getCreditLineSettings();
}

// ── Graph calls ────────────────────────────────────────────────────────────

export class MetaGraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) { super(message); }
}

async function graph(config: Pick<CreditLineConfig, 'apiVersion'>, method: 'GET' | 'POST' | 'DELETE', path: string,
  token: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const url = new URL(`https://graph.facebook.com/${config.apiVersion}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  let data: Record<string, unknown> = {};
  try { data = await response.json() as Record<string, unknown>; } catch { /* empty body */ }
  if (!response.ok || data.error) {
    const error = (data.error || {}) as { message?: string; code?: number };
    throw new MetaGraphError(error.message || `Meta returned HTTP ${response.status}`, response.status, error.code);
  }
  return data;
}

/** Read the credit line IDs this system token can see, to check the settings. */
export async function testCreditLineSettings(businessId: string): Promise<{ ok: boolean; creditLines: string[]; error?: string }> {
  const config = await getCreditLineConfig();
  if (!config) return { ok: false, creditLines: [], error: 'Save the credit line ID and system user token first.' };
  if (!/^\d{5,30}$/.test(businessId)) return { ok: false, creditLines: [], error: 'Enter your business portfolio ID.' };
  try {
    const data = await graph(config, 'GET', `${businessId}/extendedcredits`, config.systemToken, { fields: 'id,legal_entity_name' });
    const creditLines = ((data.data as Array<{ id?: string }>) || []).map(line => String(line.id || '')).filter(Boolean);
    return creditLines.includes(config.creditLineId)
      ? { ok: true, creditLines }
      : { ok: false, creditLines, error: 'The token works, but the saved credit line ID is not one of this business portfolio\'s credit lines.' };
  } catch (error) {
    return { ok: false, creditLines: [], error: (error as Error).message };
  }
}

// ── Attach / revoke ────────────────────────────────────────────────────────

async function upsertAccount(wabaId: string, values: {
  billingMode?: 'platform' | 'customer_own'; currency?: string; allocationConfigId?: string | null; status: string;
  error?: string | null; userId?: number; businessProfileId?: number;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO whatsapp_billing_accounts(waba_id, billing_mode, currency, allocation_config_id, credit_line_status, credit_line_error,
      attached_at, revoked_at, user_id, business_profile_id)
    VALUES (${wabaId}, ${values.billingMode ?? 'customer_own'}, ${values.currency ?? 'INR'}, ${values.allocationConfigId ?? null}, ${values.status},
      ${values.error ?? null}, ${values.status === 'attached' ? sql`now()` : null}, ${values.status === 'revoked' ? sql`now()` : null},
      ${values.userId ?? null}, ${values.businessProfileId ?? null})
    ON CONFLICT (waba_id) DO UPDATE SET
      billing_mode = COALESCE(${values.billingMode ?? null}, whatsapp_billing_accounts.billing_mode),
      currency = COALESCE(${values.currency ?? null}, whatsapp_billing_accounts.currency),
      allocation_config_id = COALESCE(${values.allocationConfigId ?? null}, whatsapp_billing_accounts.allocation_config_id),
      credit_line_status = ${values.status},
      credit_line_error = ${values.error ?? null},
      attached_at = CASE WHEN ${values.status} = 'attached' THEN now() ELSE whatsapp_billing_accounts.attached_at END,
      revoked_at = CASE WHEN ${values.status} = 'revoked' THEN now() ELSE whatsapp_billing_accounts.revoked_at END,
      user_id = COALESCE(${values.userId ?? null}, whatsapp_billing_accounts.user_id),
      business_profile_id = COALESCE(${values.businessProfileId ?? null}, whatsapp_billing_accounts.business_profile_id),
      updated_at = now()`);
}

export interface AttachResult { status: 'attached' | 'failed' | 'skipped'; allocationConfigId?: string; error?: string; verified?: boolean }

/**
 * Share and attach our credit line to a customer's WABA and switch it to
 * platform billing. On failure the WABA stays customer_own (the customer pays
 * Meta) and administrators are alerted. A credit line cannot be swapped after
 * attaching, so this never runs for a WABA that already has an allocation.
 */
export async function attachCreditLine(input: {
  wabaId: string; userId?: number; businessProfileId?: number; customerToken?: string; reason: 'signup' | 'admin';
}): Promise<AttachResult> {
  // With the flag off nothing charges wallets, so Meta must not bill us either.
  if (!platformBillingEnabled()) return { status: 'skipped', error: 'Platform billing is switched off on this server (WHATSAPP_PLATFORM_BILLING_ENABLED).' };
  const config = await getCreditLineConfig();
  if (!config) return { status: 'skipped', error: 'The credit line is not configured.' };
  const [existing] = rows<{ allocation_config_id: string | null; credit_line_status: string }>(await db.execute(sql`
    SELECT allocation_config_id, credit_line_status FROM whatsapp_billing_accounts WHERE waba_id = ${input.wabaId}`));
  if (existing?.credit_line_status === 'attached') return { status: 'attached', allocationConfigId: existing.allocation_config_id ?? undefined };
  // Attaching switches the WABA to platform billing; without every category's
  // rate in its currency each send would be refused.
  const [rates] = rows<{ count: string }>(await db.execute(sql`
    SELECT COUNT(DISTINCT category) AS count FROM whatsapp_rate_cards WHERE currency = ${config.currency} AND effective_from <= current_date
`));
  if (Number(rates?.count || 0) < WHATSAPP_CATEGORIES.length) {
    const error = `There is no complete ${config.currency} rate card yet, so the credit line was not attached. Import Meta's rates first.`;
    if (input.reason === 'signup') await alertAdmins('WhatsApp credit line not attached at signup', `WABA ${input.wabaId}: ${error}`);
    return { status: 'skipped', error };
  }
  try {
    const data = await graph(config, 'POST', `${config.creditLineId}/whatsapp_credit_sharing_and_attach`, config.systemToken,
      { waba_currency: config.currency, waba_id: input.wabaId });
    const allocationConfigId = String(data.allocation_config_id || '');
    if (!allocationConfigId) throw new MetaGraphError('Meta did not return an allocation_config_id.', 502);
    let verified: boolean | undefined;
    if (input.customerToken) {
      try {
        const [allocation, waba] = await Promise.all([
          graph(config, 'GET', allocationConfigId, config.systemToken, { fields: 'receiving_credential' }),
          graph(config, 'GET', input.wabaId, input.customerToken, { fields: 'primary_funding_id' }),
        ]);
        verified = String((allocation.receiving_credential as { id?: string })?.id || '') === String(waba.primary_funding_id || '');
      } catch (error) {
        logger.warn({ err: error, wabaId: input.wabaId }, '[WhatsAppCreditLine] Could not verify the attached credit line');
      }
    }
    await upsertAccount(input.wabaId, {
      billingMode: 'platform', currency: config.currency, allocationConfigId, status: 'attached',
      error: verified === false ? 'Meta accepted the credit line, but the WABA\'s funding source does not match it yet.' : null,
      userId: input.userId, businessProfileId: input.businessProfileId,
    });
    logger.info({ wabaId: input.wabaId, reason: input.reason, verified }, '[WhatsAppCreditLine] Credit line attached');
    return { status: 'attached', allocationConfigId, verified };
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    await upsertAccount(input.wabaId, { status: 'failed', error: message, userId: input.userId, businessProfileId: input.businessProfileId });
    logger.error({ err: error, wabaId: input.wabaId }, '[WhatsAppCreditLine] Credit line attach failed');
    await alertAdmins('WhatsApp credit line could not be attached',
      `WABA ${input.wabaId}: ${message}. The customer stays on their own Meta billing until an administrator retries.`);
    return { status: 'failed', error: message };
  }
}

/** Called after a customer completes Embedded Signup. Never fails the signup. */
export async function attachCreditLineOnSignup(input: { wabaId: string; userId: number; businessProfileId?: number; customerToken: string }): Promise<AttachResult> {
  try {
    if (!platformBillingEnabled()) return { status: 'skipped' };
    const config = await getCreditLineConfig();
    if (!config?.attachOnSignup) return { status: 'skipped' };
    return await attachCreditLine({ ...input, reason: 'signup' });
  } catch (error) {
    logger.error({ err: error, wabaId: input.wabaId }, '[WhatsAppCreditLine] Signup credit line step failed');
    return { status: 'failed', error: (error as Error).message };
  }
}

/** Remove our credit line from a WABA and return it to customer billing. */
export async function revokeCreditLine(wabaId: string, reason: string): Promise<{ status: 'revoked' | 'skipped' | 'failed'; error?: string }> {
  const [account] = rows<{ allocation_config_id: string | null; credit_line_status: string; user_id: number | null }>(await db.execute(sql`
    SELECT allocation_config_id, credit_line_status, user_id FROM whatsapp_billing_accounts WHERE waba_id = ${wabaId}`));
  if (!account?.allocation_config_id || account.credit_line_status !== 'attached') {
    await db.execute(sql`UPDATE whatsapp_billing_accounts SET billing_mode = 'customer_own', updated_at = now() WHERE waba_id = ${wabaId}`);
    return { status: 'skipped' };
  }
  const config = await getCreditLineConfig();
  if (!config) return { status: 'failed', error: 'The credit line is not configured, so it cannot be revoked here.' };
  try {
    await graph(config, 'DELETE', account.allocation_config_id, config.systemToken);
    await upsertAccount(wabaId, { billingMode: 'customer_own', status: 'revoked', error: null });
    logger.info({ wabaId, reason }, '[WhatsAppCreditLine] Credit line revoked');
    // Meta applies a revoke to every WABA of that customer shared with us, so
    // the owner's other attached accounts stop being funded too.
    if (account.user_id) {
      const others = rows<{ waba_id: string }>(await db.execute(sql`
        UPDATE whatsapp_billing_accounts SET billing_mode = 'customer_own', credit_line_status = 'revoked', revoked_at = now(),
          credit_line_error = ${`Revoked together with WABA ${wabaId}: Meta revokes all of a customer's shared WABAs`}, updated_at = now()
        WHERE user_id = ${account.user_id} AND waba_id <> ${wabaId} AND credit_line_status = 'attached'
        RETURNING waba_id`));
      if (others.length) {
        await alertAdmins('WhatsApp credit line revoked on more than one account',
          `Revoking WABA ${wabaId} (${reason}) also removed our credit line from ${others.map(o => o.waba_id).join(', ')}. Re-attach them if they should stay on our billing.`);
      }
    }
    return { status: 'revoked' };
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    // Stop billing this WABA through us either way; Meta may still need a manual revoke.
    await db.execute(sql`UPDATE whatsapp_billing_accounts SET billing_mode = 'customer_own', credit_line_error = ${`Revoke failed: ${message}`},
      updated_at = now() WHERE waba_id = ${wabaId}`);
    await alertAdmins('WhatsApp credit line could not be revoked', `WABA ${wabaId} (${reason}): ${message}. Revoke it in Meta Business Suite.`);
    return { status: 'failed', error: message };
  }
}

/** After a customer disconnects WhatsApp: revoke our credit line from the WABAs they connected. */
export async function revokeCreditLinesForUser(userId: number, wabaIds: string[]): Promise<void> {
  for (const wabaId of [...new Set(wabaIds.filter(Boolean))]) {
    try { await revokeCreditLine(wabaId, `user ${userId} disconnected WhatsApp`); }
    catch (error) { logger.error({ err: error, wabaId }, '[WhatsAppCreditLine] Revoke after disconnect failed'); }
  }
}

/** Meta's "Business eligibility payment issue": the credit line can't pay for the message. */
export const WHATSAPP_PAYMENT_ERROR_CODES: ReadonlySet<number> = new Set([131042]);

export function isWhatsAppPaymentError(code: unknown): boolean {
  return WHATSAPP_PAYMENT_ERROR_CODES.has(Number(code));
}

/**
 * Meta refused a platform-billed message because of a payment problem on our
 * credit line. Mark the account and alert admins, at most once every 6 hours
 * per account while the problem lasts. Never throws.
 */
export async function recordWhatsAppPaymentIssue(chargeId: number, detail: string): Promise<void> {
  try {
    const flagged = rows<{ waba_id: string; user_id: number | null }>(await db.execute(sql`
      UPDATE whatsapp_billing_accounts a SET payment_issue_at = now(), payment_issue_detail = ${detail.slice(0, 500)}, updated_at = now()
      FROM whatsapp_message_charges c
      WHERE c.id = ${chargeId} AND a.waba_id = c.waba_id AND a.billing_mode = 'platform'
        AND (a.payment_issue_at IS NULL OR a.payment_issue_at < now() - interval '6 hours')
      RETURNING a.waba_id, a.user_id`));
    for (const account of flagged) {
      await alertAdmins('WhatsApp credit line payment problem',
        `Meta refused a message on WABA ${account.waba_id}${account.user_id ? ` (user ${account.user_id})` : ''} because of a payment issue: ${detail}. `
        + 'Check the credit line in Meta Business Settings; messages on this account will keep failing until it is fixed.');
    }
  } catch (error) {
    logger.error({ err: error, chargeId }, '[WhatsAppBilling] Could not record a payment problem');
  }
}

/** A billed message was delivered again: the payment problem is over. Never throws. */
export async function clearWhatsAppPaymentIssue(chargeId: number): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE whatsapp_billing_accounts a SET payment_issue_at = NULL, payment_issue_detail = NULL, updated_at = now()
      FROM whatsapp_message_charges c
      WHERE c.id = ${chargeId} AND a.waba_id = c.waba_id AND a.payment_issue_at IS NOT NULL`);
  } catch (error) {
    logger.error({ err: error, chargeId }, '[WhatsAppBilling] Could not clear a payment problem');
  }
}

export async function alertAdmins(title: string, message: string): Promise<void> {
  try {
    const { notifyAllAdmins } = await import('../../models/adminNotifications/functions.js');
    await notifyAllAdmins({ title, message, type: 'warning', category: 'pricing' });
  } catch (error) {
    logger.error({ err: error, title }, '[WhatsAppBilling] Admin alert could not be sent');
  }
}
