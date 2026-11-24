/**
 * WhatsApp platform billing ("we pay Meta").
 *
 * For a WABA that runs on our shared Meta credit line, Meta bills us for every
 * delivered message. This service:
 *   1. prices each outgoing message at Meta's list rate for its category and
 *      the recipient's market, plus our margin, and reserves that from the
 *      customer's wallet before the message is sent;
 *   2. records the message id (wamid) Meta returns, or releases the reservation
 *      when Meta definitively rejected the send;
 *   3. settles the charge from the delivery webhook's `pricing` object: the real
 *      category when billable, nothing when Meta did not charge, a refund on failure.
 *
 * Off unless WHATSAPP_PLATFORM_BILLING_ENABLED=true AND the sending WABA has a
 * whatsapp_billing_accounts row with billing_mode='platform'. Every other
 * account behaves exactly as before. See docs/WHATSAPP_PLATFORM_BILLING_PLAN.md.
 *
 * Meta charges only on delivery, so a `sent` status never settles: settling is
 * one-shot (creditService.settleReservation), and a later `failed` must still
 * be able to refund.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';

export const WHATSAPP_CATEGORIES = ['marketing', 'utility', 'authentication', 'service'] as const;
export type WhatsAppCategory = typeof WHATSAPP_CATEGORIES[number];
/** Meta's volume tiers apply only to these categories. */
export const TIERED_WHATSAPP_CATEGORIES = ['utility', 'authentication'] as const;

/** Ledger event for the Meta message cost. Starts with "outreach" so it groups with outreach spend. */
export const WHATSAPP_META_EVENT_KEY = 'outreach_whatsapp_meta';
const CHARGE_REFERENCE = 'whatsapp_message_charge';
const TOPUP_REFERENCE = 'whatsapp_message_charge_topup';
/** Recorded for a support reply to a number whose country is not on the market list. */
export const UNKNOWN_MARKET = 'Unknown';

export function platformBillingEnabled(): boolean {
  return process.env.WHATSAPP_PLATFORM_BILLING_ENABLED === 'true';
}

/** A send refused before it reached Meta. Callers treat it as a definitive, non-retryable rejection. */
export class WhatsAppBillingError extends Error {
  readonly outcomeUncertain = false;
  readonly deliveryAttempted = false;
  readonly retryable = false;
  constructor(message: string, readonly code: string, readonly status = 402) {
    super(message);
    this.name = 'WhatsAppBillingError';
  }
}

// ── Pure helpers (unit tested) ─────────────────────────────────────────────

/** Meta template categories and webhook pricing categories to our rate-card category. */
export function normalizeCategory(raw: unknown): WhatsAppCategory | null {
  const value = String(raw ?? '').trim().toLowerCase();
  return (WHATSAPP_CATEGORIES as readonly string[]).includes(value) ? value as WhatsAppCategory : null;
}

/** What Meta will treat this payload as: a template, or a free-form reply ("service"). */
export function messageKindOf(payload: { type?: string; template?: { name?: string; language?: { code?: string } } }): {
  kind: 'template' | 'service'; templateName?: string; templateLanguage?: string;
} {
  if (payload?.type === 'template') {
    return { kind: 'template', templateName: payload.template?.name, templateLanguage: payload.template?.language?.code };
  }
  return { kind: 'service' };
}

/** Longest calling-code prefix wins ('1' vs '1242' Bahamas, '9' never matches before '91'). */
export function matchMarket(recipientDigits: string, markets: Array<{ callingCode: string; market: string }>): string | null {
  const digits = String(recipientDigits || '').replace(/\D/g, '');
  let best: { callingCode: string; market: string } | null = null;
  for (const entry of markets) {
    if (digits.startsWith(entry.callingCode) && (!best || entry.callingCode.length > best.callingCode.length)) best = entry;
  }
  return best?.market ?? null;
}

/**
 * Credits for one message: Meta rate in INR, plus margin, at the recharge
 * rate (credits per ₹1). Rounded to 0.01 credit like the ledger, never up to
 * whole credits, so cheap categories are not silently marked up.
 */
export function creditsForRate(input: {
  rate: number; currency: string; marginPercent: number; creditsPerInr: number; usdToInr: number;
}): number {
  const { rate, currency, marginPercent, creditsPerInr, usdToInr } = input;
  if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid WhatsApp rate');
  const inr = currency === 'INR' ? rate : currency === 'USD' ? rate * usdToInr : NaN;
  if (!Number.isFinite(inr)) throw new Error(`Unsupported WhatsApp billing currency ${currency}`);
  const margin = Number.isFinite(marginPercent) && marginPercent > 0 ? marginPercent : 0;
  return Math.round(inr * (1 + margin / 100) * creditsPerInr * 100) / 100;
}

/** Most expensive rate per category, used to quote a recipient whose market is unknown. */
export function worstCaseRate(rates: Array<{ category: string; rate: number }>, category: WhatsAppCategory): number | null {
  const matching = rates.filter(row => row.category === category).map(row => row.rate);
  return matching.length ? Math.max(...matching) : null;
}

// ── Database lookups ───────────────────────────────────────────────────────

interface BillingAccount { wabaId: string; currency: string; dailySpendCap: number | null }
interface ChargeRow {
  id: number; user_id: number; status: string; recipient_market: string; currency: string;
  reserved_credits: string; reservation_transaction_id: number | null; expected_category: string;
}

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) || [];
}

async function platformAccount(wabaId: string | undefined): Promise<BillingAccount | null> {
  if (!wabaId) return null;
  const [row] = rows<{ waba_id: string; currency: string; daily_spend_cap_credits: string | null }>(await db.execute(sql`
    SELECT waba_id, currency, daily_spend_cap_credits FROM whatsapp_billing_accounts WHERE waba_id = ${wabaId} AND billing_mode = 'platform'`));
  return row ? {
    wabaId: row.waba_id, currency: row.currency.trim(),
    dailySpendCap: row.daily_spend_cap_credits == null ? null : Number(row.daily_spend_cap_credits),
  } : null;
}

/** The WABA a user's WhatsApp account sends from, or null when it cannot be resolved. */
async function wabaForAccount(userId: number, phoneNumberId?: string): Promise<string | null> {
  const { whatsappApiService } = await import('../whatsappApiService.js');
  const creds = await whatsappApiService.resolveCreds(userId, phoneNumberId || undefined);
  return creds?.businessAccountId || null;
}

/** Whether this WhatsApp account's Meta spend is billed to our credit line. */
export async function isPlatformBilledAccount(userId: number, phoneNumberId?: string): Promise<boolean> {
  if (!platformBillingEnabled()) return false;
  return !!await platformAccount(await wabaForAccount(userId, phoneNumberId) ?? undefined);
}

/**
 * The flat per-message fee charged where WhatsApp outreach is charged today.
 * Platform-billed accounts use their own admin-set fee ("outreach_whatsapp_platform"),
 * charged on top of Meta's message cost; every other account keeps "outreach_whatsapp".
 */
export async function whatsappOutreachFeeKey(userId: number, phoneNumberId?: string): Promise<'outreach_whatsapp' | 'outreach_whatsapp_platform'> {
  try {
    return await isPlatformBilledAccount(userId, phoneNumberId) ? 'outreach_whatsapp_platform' : 'outreach_whatsapp';
  } catch (error) {
    // Unresolvable account: keep today's fee. The send path still bills Meta's cost.
    logger.warn({ err: error, userId }, '[WhatsAppBilling] Could not resolve the account billing mode for the outreach fee');
    return 'outreach_whatsapp';
  }
}

async function adminCredits(eventKey: string): Promise<number> {
  const { getPricingByKey } = await import('../../models/creditPricing/functions.js');
  const row = await getPricingByKey(eventKey);
  const value = row?.isActive ? Number(row.creditsPerUnit) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function spentToday(wabaId: string): Promise<number> {
  const [row] = rows<{ total: string | null }>(await db.execute(sql`
    SELECT COALESCE(SUM(COALESCE(charged_credits, reserved_credits)), 0) AS total FROM whatsapp_message_charges
    WHERE waba_id = ${wabaId} AND created_at >= date_trunc('day', now()) AND status <> 'refunded'`));
  return Number(row?.total || 0);
}

async function marketFor(recipient: string): Promise<string | null> {
  const digits = String(recipient || '').replace(/\D/g, '');
  if (!digits) return null;
  const [row] = rows<{ market: string }>(await db.execute(sql`
    SELECT market FROM whatsapp_rate_markets WHERE ${digits} LIKE calling_code || '%'
    ORDER BY length(calling_code) DESC LIMIT 1`));
  return row?.market ?? null;
}

async function rateFor(market: string, category: WhatsAppCategory, currency: string): Promise<number | null> {
  const [row] = rows<{ rate: string }>(await db.execute(sql`
    SELECT rate FROM whatsapp_rate_cards
    WHERE market = ${market} AND category = ${category} AND currency = ${currency} AND effective_from <= current_date
    ORDER BY effective_from DESC LIMIT 1`));
  return row ? Number(row.rate) : null;
}

export async function templateCategory(userId: number, name?: string, language?: string): Promise<WhatsAppCategory> {
  if (!name) return 'marketing';
  const [row] = rows<{ category: string }>(await db.execute(sql`
    SELECT category FROM whatsapp_templates
    WHERE user_id = ${userId} AND name = ${name} AND (${language ?? null}::text IS NULL OR language = ${language ?? null})
    ORDER BY id DESC LIMIT 1`));
  // Unknown templates reserve at the marketing rate (normally the highest);
  // the delivery webhook settles to the category Meta actually charged.
  return normalizeCategory(row?.category) ?? 'marketing';
}

async function creditsFor(rate: number, currency: string, category: WhatsAppCategory): Promise<number> {
  const [{ getPricingByKey, getRechargeRate }, { getUsdToInrRate }] = await Promise.all([
    import('../../models/creditPricing/functions.js'), import('../../utils/currency.js'),
  ]);
  const margin = await getPricingByKey(`whatsapp_margin_${category}`);
  return creditsForRate({
    rate, currency,
    marginPercent: margin?.isActive ? Number(margin.creditsPerUnit) : 0,
    creditsPerInr: await getRechargeRate(),
    usdToInr: getUsdToInrRate(),
  });
}

// ── Send lifecycle ─────────────────────────────────────────────────────────

export interface WhatsAppSendCharge { id: number; userId: number; credits: number }

/**
 * Called by whatsappApiService immediately before the Meta request. Returns
 * null when this send is not platform billed. Throws WhatsAppBillingError when
 * it is and the message cannot be priced or paid for; nothing is sent then.
 */
export async function reserveWhatsAppSend(input: {
  userId: number;
  wabaId?: string;
  phoneNumberId: string;
  payload: { to?: string; type?: string; template?: { name?: string; language?: { code?: string } } };
}): Promise<WhatsAppSendCharge | null> {
  if (!platformBillingEnabled()) return null;
  const account = await platformAccount(input.wabaId);
  if (!account) return null;

  const { kind, templateName, templateLanguage } = messageKindOf(input.payload);
  const category: WhatsAppCategory = kind === 'service' ? 'service' : await templateCategory(input.userId, templateName, templateLanguage);
  // A support reply (free-form, inside the 24-hour window) is never blocked by a
  // missing Service rate, an unknown country or an empty wallet: the first
  // 1,000 a month per number are free, and a customer waiting for an answer
  // matters more. It is reserved at 0 when it can't be priced or paid now;
  // settlement charges what Meta billed, or flags it for review.
  const supportReply = kind === 'service';
  const recipientDigits = String(input.payload.to || '').replace(/\D/g, '');
  const market = await marketFor(recipientDigits) ?? (supportReply && recipientDigits ? UNKNOWN_MARKET : null);
  if (!market) throw new WhatsAppBillingError('This recipient\'s country is not on the WhatsApp rate card yet. Ask an administrator to import Meta\'s market list.', 'WHATSAPP_RATE_MARKET_MISSING', 409);
  const rate = await rateFor(market, category, account.currency) ?? (supportReply ? 0 : null);
  if (rate === null) throw new WhatsAppBillingError(`No WhatsApp ${category} rate for ${market} in ${account.currency}. Ask an administrator to import Meta's rate card.`, 'WHATSAPP_RATE_MISSING', 409);
  const credits = await creditsFor(rate, account.currency, category);
  if (account.dailySpendCap !== null && await spentToday(account.wabaId) + credits > account.dailySpendCap) {
    throw new WhatsAppBillingError('This WhatsApp account reached its daily message spending limit. It resets at midnight, or an administrator can raise it.', 'WHATSAPP_DAILY_SPEND_CAP', 429);
  }

  const [charge] = rows<{ id: number }>(await db.execute(sql`
    INSERT INTO whatsapp_message_charges(user_id, waba_id, phone_number_id, message_kind, template_name, template_language,
      expected_category, recipient_market, currency, reserved_rate, reserved_credits)
    VALUES (${input.userId}, ${account.wabaId}, ${input.phoneNumberId}, ${kind}, ${templateName ?? null}, ${templateLanguage ?? null},
      ${category}, ${market}, ${account.currency}, ${rate}, ${credits})
    RETURNING id`));
  const chargeId = Number(charge.id);

  const { creditService } = await import('../CreditService.js');
  const reservation = await creditService.deductForEvent({
    userId: input.userId,
    eventKey: WHATSAPP_META_EVENT_KEY,
    description: `WhatsApp ${category} message (${market})`,
    service: 'WhatsAppBilling',
    apiProvider: 'meta_whatsapp',
    referenceType: CHARGE_REFERENCE,
    referenceId: String(chargeId),
    overrideAmount: credits,
    metadata: { channel: 'whatsapp', category, market, rate, currency: account.currency, reservation: true },
  });
  if (!reservation.success && supportReply) {
    // Send the reply unreserved: settlement takes whatever Meta actually
    // charged, or flags the message for review if the wallet still can't cover it.
    await db.execute(sql`UPDATE whatsapp_message_charges SET reserved_credits = 0,
      review_reason = 'Support reply sent while the wallet was empty', updated_at = now() WHERE id = ${chargeId}`);
    return { id: chargeId, userId: input.userId, credits: 0 };
  }
  if (!reservation.success) {
    await db.execute(sql`UPDATE whatsapp_message_charges SET status = 'refunded', charged_credits = 0,
      review_reason = 'Not sent: wallet could not cover the message', settled_at = now(), updated_at = now() WHERE id = ${chargeId}`);
    throw new WhatsAppBillingError(reservation.error || 'Insufficient credits. Recharge your wallet before sending WhatsApp messages.', 'INSUFFICIENT_CREDITS');
  }
  if (reservation.transactionId) {
    await db.execute(sql`UPDATE whatsapp_message_charges SET reservation_transaction_id = ${reservation.transactionId}, updated_at = now()
      WHERE id = ${chargeId}`);
  }
  return { id: chargeId, userId: input.userId, credits };
}

/** Meta accepted the message. Bind its wamid so the delivery webhook can settle it. */
export async function markWhatsAppSendAccepted(charge: WhatsAppSendCharge, wamid: string | undefined): Promise<void> {
  try {
    if (wamid) {
      await db.execute(sql`UPDATE whatsapp_message_charges SET wamid = ${wamid}, status = 'sent', updated_at = now()
        WHERE id = ${charge.id} AND status = 'reserved'`);
    } else {
      await db.execute(sql`UPDATE whatsapp_message_charges SET status = 'needs_review',
        review_reason = 'Meta accepted the message but returned no message id', updated_at = now() WHERE id = ${charge.id}`);
    }
  } catch (error) {
    // The message is already sent: never turn that into a send failure.
    logger.error({ err: error, chargeId: charge.id }, '[WhatsAppBilling] Could not record accepted message');
  }
}

/**
 * The Meta request failed. A definitive rejection releases the reservation; an
 * unknown outcome (timeout, 5xx without an error body) keeps it for review,
 * because Meta may still deliver and bill the message.
 */
export async function markWhatsAppSendFailed(charge: WhatsAppSendCharge, error: { outcomeUncertain?: boolean; code?: unknown; message?: string } | undefined): Promise<void> {
  try {
    await notePaymentProblem(charge.id, error?.code, error?.message);
    if (error?.outcomeUncertain === false) {
      await releaseCharge(charge.id, charge.userId, 'Meta rejected the message');
    } else {
      await db.execute(sql`UPDATE whatsapp_message_charges SET status = 'needs_review',
        review_reason = 'Send outcome unknown; Meta may have delivered it', updated_at = now()
        WHERE id = ${charge.id} AND status = 'reserved'`);
    }
  } catch (cause) {
    logger.error({ err: cause, chargeId: charge.id }, '[WhatsAppBilling] Could not record failed send');
  }
}

/**
 * Record which outreach batch sent this message, so wallet reports group
 * WhatsApp spend by outreach. Support replies have no batch. Never throws:
 * a missing link only affects reporting.
 */
async function attributeOutreachBatch(chargeId: number, userId: number, wamid: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE whatsapp_message_charges c SET outreach_batch_id = m.batch_id
      FROM (
        SELECT batch_id, user_id, direction FROM outreach_messages WHERE external_message_id = ${wamid}
        UNION ALL SELECT batch_id, user_id, direction FROM outreach_messages WHERE provider_message_id = ${wamid}
        UNION ALL SELECT batch_id, user_id, direction FROM outreach_messages WHERE waba_message_id = ${wamid}
      ) m
      WHERE c.id = ${chargeId} AND c.outreach_batch_id IS NULL AND m.user_id = ${userId} AND m.batch_id IS NOT NULL AND m.direction = 'outbound'`);
  } catch (error) {
    logger.warn({ err: error, chargeId }, '[WhatsAppBilling] Could not link the charge to its outreach');
  }
}

/** Meta's payment error on a billed message: flag the account and alert admins. */
async function notePaymentProblem(chargeId: number, code: unknown, message: string | undefined): Promise<void> {
  const { isWhatsAppPaymentError, recordWhatsAppPaymentIssue } = await import('./WhatsAppCreditLine.js');
  if (isWhatsAppPaymentError(code)) await recordWhatsAppPaymentIssue(chargeId, `Meta error ${code}${message ? `: ${message}` : ''}`);
}

export async function releaseCharge(chargeId: number, userId: number, reason: string): Promise<void> {
  const [row] = rows<{ reservation_transaction_id: number | null }>(await db.execute(sql`
    SELECT reservation_transaction_id FROM whatsapp_message_charges WHERE id = ${chargeId}`));
  if (row?.reservation_transaction_id) {
    const { creditService } = await import('../CreditService.js');
    const refund = await creditService.refundDeduction({ userId, transactionId: row.reservation_transaction_id, description: `WhatsApp message not charged: ${reason}` });
    if (!refund.success && !refund.alreadyRefunded) throw new Error(refund.error || 'WhatsApp reservation refund failed');
  }
  await db.execute(sql`UPDATE whatsapp_message_charges SET status = 'refunded', charged_credits = 0, review_reason = ${reason},
    settled_at = now(), updated_at = now() WHERE id = ${chargeId} AND status IN ('reserved','sent','needs_review')`);
}

// ── Delivery webhook settlement ────────────────────────────────────────────

export interface WhatsAppStatusPricing { billable?: boolean; pricing_model?: string; type?: string; category?: string }

/**
 * Settle a platform-billed message from a WhatsApp status webhook. Idempotent:
 * Meta repeats statuses and sends both `delivered` and `read`.
 *   delivered/read + billable   -> charge Meta's category rate (+margin); refund or top up the difference
 *   delivered/read + !billable  -> charge nothing (free tier, free entry point)
 *   failed                      -> refund
 *   sent, or no pricing yet     -> nothing (Meta bills on delivery only)
 */
export async function settleWhatsAppChargeFromStatus(input: {
  phoneNumberId: string; wamid: string; status: string; pricing?: WhatsAppStatusPricing | null;
  errors?: Array<{ code?: unknown; title?: string; message?: string }> | null;
}): Promise<'settled' | 'refunded' | 'needs_review' | 'skipped'> {
  if (!platformBillingEnabled() || !input.wamid || !input.phoneNumberId) return 'skipped';
  const [charge] = rows<ChargeRow>(await db.execute(sql`
    SELECT id, user_id, status, recipient_market, currency, reserved_credits, reservation_transaction_id, expected_category
    FROM whatsapp_message_charges WHERE phone_number_id = ${input.phoneNumberId} AND wamid = ${input.wamid}`));
  if (!charge || !['sent', 'needs_review'].includes(charge.status)) return 'skipped';
  const chargeId = Number(charge.id);
  const userId = Number(charge.user_id);

  if (input.status === 'failed') {
    const error = input.errors?.[0];
    // Linked too, so the refund nets out under the same outreach in wallet reports.
    await attributeOutreachBatch(chargeId, userId, input.wamid);
    await notePaymentProblem(chargeId, error?.code, error?.title || error?.message);
    await releaseCharge(chargeId, userId, 'Meta could not deliver the message');
    return 'refunded';
  }
  if (!['delivered', 'read'].includes(input.status) || !input.pricing || typeof input.pricing.billable !== 'boolean') return 'skipped';
  // Once per charge: a settled charge is skipped above on the next webhook.
  await attributeOutreachBatch(chargeId, userId, input.wamid);

  const pricing = input.pricing;
  const reserved = Number(charge.reserved_credits);
  let rate = 0;
  let actual = 0;
  const category = normalizeCategory(pricing.category);
  if (pricing.billable) {
    const found = category ? await rateFor(charge.recipient_market, category, charge.currency.trim()) : null;
    if (found === null) {
      // Keep what was reserved; an administrator prices it from the rate card.
      await db.execute(sql`UPDATE whatsapp_message_charges SET status = 'needs_review', meta_billable = true,
        meta_category = ${pricing.category ?? null}, meta_pricing_type = ${pricing.type ?? null}, pricing_raw = ${JSON.stringify(pricing)}::jsonb,
        review_reason = ${`No rate for Meta category ${pricing.category ?? 'unknown'} in ${charge.recipient_market}`}, updated_at = now()
        WHERE id = ${chargeId}`);
      return 'needs_review';
    }
    rate = found;
    actual = await creditsFor(rate, charge.currency.trim(), category!);
  } else {
    // Meta did not charge (free tier, free entry point): the admin-set fee, usually 0.
    actual = await adminCredits('whatsapp_free_message_fee');
  }

  const { creditService } = await import('../CreditService.js');
  if (charge.reservation_transaction_id) {
    const settled = await creditService.settleReservation({
      userId, transactionId: charge.reservation_transaction_id, actualCredits: Math.min(actual, reserved),
      description: pricing.billable ? `WhatsApp ${category} message settled at Meta's rate` : 'WhatsApp message Meta did not charge',
    });
    if (!settled.success && !settled.alreadyRefunded) throw new Error(settled.error || 'WhatsApp settlement failed');
  }

  let topupTransactionId: number | null = null;
  let reviewReason: string | null = null;
  const shortfall = Math.round((actual - (charge.reservation_transaction_id ? reserved : 0)) * 100) / 100;
  if (shortfall > 0) {
    // Meta charged more than we reserved (category changed, or a new rate).
    // The message is already delivered, so take the difference once.
    const topup = await creditService.deductOnceForResource({
      userId, eventKey: WHATSAPP_META_EVENT_KEY, overrideAmount: shortfall, service: 'WhatsAppBilling', apiProvider: 'meta_whatsapp',
      description: `WhatsApp ${category ?? 'free'} message: difference to the final charge`, referenceType: TOPUP_REFERENCE, referenceId: String(chargeId),
      metadata: { channel: 'whatsapp', category, market: charge.recipient_market, rate },
    });
    if (topup.success) topupTransactionId = topup.transactionId ?? null;
    else reviewReason = `Wallet could not cover ${shortfall} credits above the reservation`;
  }

  await db.execute(sql`UPDATE whatsapp_message_charges SET
      status = ${reviewReason ? 'needs_review' : 'settled'}, meta_billable = ${pricing.billable}, meta_category = ${pricing.category ?? null},
      meta_pricing_type = ${pricing.type ?? null}, settled_rate = ${rate}, charged_credits = ${actual},
      topup_transaction_id = COALESCE(${topupTransactionId}, topup_transaction_id), pricing_raw = ${JSON.stringify(pricing)}::jsonb,
      review_reason = ${reviewReason}, settled_at = now(), updated_at = now()
    WHERE id = ${chargeId} AND status IN ('sent','needs_review')`);
  if (pricing.billable) {
    const { clearWhatsAppPaymentIssue } = await import('./WhatsAppCreditLine.js');
    await clearWhatsAppPaymentIssue(chargeId);
  }
  return reviewReason ? 'needs_review' : 'settled';
}

// ── Quotes and customer summary ────────────────────────────────────────────

export interface WhatsAppBatchQuote {
  platformBilled: boolean;
  messages: number;
  /** Meta cost plus margin, in credits. */
  messageCredits: number;
  /** The admin-set flat fee per message ("outreach_whatsapp_platform"). */
  platformFeeCredits: number;
  totalCredits: number;
  byCategory: Record<string, { messages: number; credits: number }>;
  /** Recipients without a known market, quoted at the category's highest rate. */
  estimatedRecipients: number;
  missingRates: string[];
  /** Null when the account is not billed through us (nothing to check). */
  walletBalance: number | null;
  sufficient: boolean;
}

/**
 * Quote a batch before launch. Each item is a template (by name) or a free-form
 * message. Recipients with an unknown market are quoted at the highest rate for
 * their category so the check never under-reserves.
 */
export async function quoteWhatsAppBatch(input: {
  userId: number; phoneNumberId?: string;
  items: Array<{ recipient?: string; templateName?: string; templateLanguage?: string }>;
}): Promise<WhatsAppBatchQuote> {
  const empty: WhatsAppBatchQuote = {
    platformBilled: false, messages: input.items.length, messageCredits: 0, platformFeeCredits: 0, totalCredits: 0,
    byCategory: {}, estimatedRecipients: 0, missingRates: [], walletBalance: null, sufficient: true,
  };
  if (!platformBillingEnabled()) return empty;
  const account = await platformAccount(await wabaForAccount(input.userId, input.phoneNumberId) ?? undefined);
  if (!account) return empty;
  const { getBalance } = await import('../../models/wallets/functions.js');
  const walletBalance = Number(await getBalance(input.userId)) || 0;

  const allRates = rows<{ market: string; category: string; rate: string }>(await db.execute(sql`
    SELECT DISTINCT ON (market, category) market, category, rate FROM whatsapp_rate_cards
    WHERE currency = ${account.currency} AND effective_from <= current_date
    ORDER BY market, category, effective_from DESC`)).map(row => ({ market: row.market, category: row.category, rate: Number(row.rate) }));
  const markets = rows<{ calling_code: string; market: string }>(await db.execute(sql`SELECT calling_code, market FROM whatsapp_rate_markets`))
    .map(row => ({ callingCode: row.calling_code, market: row.market }));
  const categoryCache = new Map<string, WhatsAppCategory>();
  const creditCache = new Map<string, number>();
  const missing = new Set<string>();
  const quote = { ...empty, platformBilled: true, walletBalance };

  for (const item of input.items) {
    let category: WhatsAppCategory = 'service';
    if (item.templateName) {
      const key = `${item.templateName}:${item.templateLanguage ?? ''}`;
      if (!categoryCache.has(key)) categoryCache.set(key, await templateCategory(input.userId, item.templateName, item.templateLanguage));
      category = categoryCache.get(key)!;
    }
    const market = item.recipient ? matchMarket(item.recipient, markets) : null;
    const rate = market
      ? allRates.find(row => row.market === market && row.category === category)?.rate ?? null
      : worstCaseRate(allRates, category);
    const priced = rate;
    if (!market) quote.estimatedRecipients++;
    if (priced === null) { missing.add(`${category} / ${market ?? 'any market'}`); continue; }
    const cacheKey = `${category}:${priced}`;
    if (!creditCache.has(cacheKey)) creditCache.set(cacheKey, await creditsFor(priced, account.currency, category));
    const credits = creditCache.get(cacheKey)!;
    quote.messageCredits += credits;
    const bucket = quote.byCategory[category] ?? (quote.byCategory[category] = { messages: 0, credits: 0 });
    bucket.messages++;
    bucket.credits = Math.round((bucket.credits + credits) * 100) / 100;
  }
  quote.messageCredits = Math.round(quote.messageCredits * 100) / 100;
  quote.platformFeeCredits = Math.round(await adminCredits('outreach_whatsapp_platform') * input.items.length * 100) / 100;
  quote.totalCredits = Math.round((quote.messageCredits + quote.platformFeeCredits) * 100) / 100;
  quote.missingRates = [...missing];
  quote.sufficient = quote.missingRates.length === 0 && walletBalance >= quote.totalCredits;
  return quote;
}

export interface WhatsAppBillingSummary {
  platformBilled: boolean;
  enabled: boolean;
  monthStart: string;
  byCategory: Array<{ category: string; messages: number; credits: number }>;
  totalCredits: number;
  pendingMessages: number;
  reviewMessages: number;
  /** Service messages Meta delivered free this month, per sending number (1,000 free each). */
  freeServiceByNumber: Array<{ phoneNumberId: string; free: number; billable: number }>;
  dailySpendCap: number | null;
  spentToday: number;
}

/** Month-to-date WhatsApp message charges for the current business. */
export async function getWhatsAppBillingSummary(userId: number, phoneNumberId?: string): Promise<WhatsAppBillingSummary> {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
  const enabled = platformBillingEnabled();
  const base: WhatsAppBillingSummary = {
    platformBilled: false, enabled, monthStart, byCategory: [], totalCredits: 0, pendingMessages: 0, reviewMessages: 0,
    freeServiceByNumber: [], dailySpendCap: null, spentToday: 0,
  };
  if (!enabled) return base;
  const wabaId = await wabaForAccount(userId, phoneNumberId);
  const account = await platformAccount(wabaId ?? undefined);
  if (!account) return base;
  const byCategory = rows<{ category: string; messages: string; credits: string }>(await db.execute(sql`
    SELECT COALESCE(meta_category, expected_category) AS category, COUNT(*) AS messages,
      COALESCE(SUM(COALESCE(charged_credits, reserved_credits)), 0) AS credits
    FROM whatsapp_message_charges
    WHERE user_id = ${userId} AND waba_id = ${account.wabaId} AND created_at >= ${monthStart}::date AND status <> 'refunded'
    GROUP BY 1 ORDER BY 3 DESC`)).map(row => ({ category: row.category, messages: Number(row.messages), credits: Number(row.credits) }));
  const [counts] = rows<{ pending: string; review: string }>(await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE status IN ('reserved','sent')) AS pending, COUNT(*) FILTER (WHERE status = 'needs_review') AS review
    FROM whatsapp_message_charges WHERE user_id = ${userId} AND waba_id = ${account.wabaId} AND created_at >= ${monthStart}::date`));
  const freeService = rows<{ phone_number_id: string; free: string; billable: string }>(await db.execute(sql`
    SELECT phone_number_id,
      COUNT(*) FILTER (WHERE meta_pricing_type = 'free_customer_service') AS free,
      COUNT(*) FILTER (WHERE meta_category = 'service' AND meta_billable) AS billable
    FROM whatsapp_message_charges
    WHERE user_id = ${userId} AND waba_id = ${account.wabaId} AND created_at >= ${monthStart}::date AND message_kind = 'service'
    GROUP BY phone_number_id`)).map(row => ({ phoneNumberId: row.phone_number_id, free: Number(row.free), billable: Number(row.billable) }));
  return {
    ...base, platformBilled: true, byCategory,
    totalCredits: Math.round(byCategory.reduce((sum, row) => sum + row.credits, 0) * 100) / 100,
    pendingMessages: Number(counts?.pending || 0), reviewMessages: Number(counts?.review || 0),
    freeServiceByNumber: freeService, dailySpendCap: account.dailySpendCap, spentToday: await spentToday(account.wabaId),
  };
}
