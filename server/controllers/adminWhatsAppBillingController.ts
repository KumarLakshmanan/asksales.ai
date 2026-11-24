/**
 * Admin API for WhatsApp platform billing ("we pay Meta"): rate cards, the
 * calling-code -> market map, which WABAs are billed through our credit line,
 * credit-line settings, charges needing review and reconciliation with Meta.
 * Mounted under /api/admin/whatsapp-billing. Reads need an admin token; every
 * change needs a super admin. All SQL runs in a system scope because charges
 * belong to many businesses.
 */
import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { logger } from '../utils/logger.js';
import { withSystemScope } from '../tenancy/businessContext.js';
import { WHATSAPP_CATEGORIES } from '../services/whatsapp/WhatsAppBillingService.js';
import { parseMarketsCsv, parseRateCardCsv, parseRateTiersCsv } from '../services/whatsapp/WhatsAppRateCardImport.js';
import { buildWhatsAppStatement, saveWhatsAppInvoice } from '../services/whatsapp/WhatsAppBillingStatement.js';
import {
  attachCreditLine, CreditLineSettingsError, getCreditLineSettings, revokeCreditLine, saveCreditLineSettings, testCreditLineSettings,
} from '../services/whatsapp/WhatsAppCreditLine.js';
import { reconcileWhatsAppBilling, resolveWhatsAppCharge } from '../services/whatsapp/WhatsAppBillingMaintenance.js';

// Credits are converted from INR or USD only (see creditsForRate).
const CURRENCIES = ['INR', 'USD'];
const MAX_CSV = 1_000_000;

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) || [];
}
const adminId = (req: Request) => Number((req as { user?: { id?: unknown } }).user?.id) || null;
const system = <T>(reason: string, work: () => Promise<T>) => withSystemScope(`WhatsApp billing admin: ${reason}`, work);

function fail(res: Response, error: unknown, fallback: string) {
  const status = Number((error as { status?: number })?.status);
  if (error instanceof CreditLineSettingsError) return res.status(400).json({ error: error.message });
  if (status >= 400 && status < 500) return res.status(status).json({ error: (error as Error).message });
  logger.error({ err: error }, `[AdminWhatsAppBilling] ${fallback}`);
  return res.status(500).json({ error: fallback });
}

const validDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

// ── Overview ───────────────────────────────────────────────────────────────

export async function getWhatsAppBillingOverview(_req: Request, res: Response) {
  try {
    const data = await system('overview', async () => {
      const [counts] = rows<Record<string, string>>(await db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM whatsapp_billing_accounts WHERE billing_mode = 'platform') AS platform_accounts,
          (SELECT COUNT(*) FROM whatsapp_message_charges WHERE status = 'needs_review') AS needs_review,
          (SELECT COUNT(*) FROM whatsapp_message_charges WHERE status IN ('reserved','sent')) AS awaiting_delivery,
          (SELECT COUNT(*) FROM whatsapp_rate_markets) AS markets,
          (SELECT COALESCE(SUM(charged_credits), 0) FROM whatsapp_message_charges WHERE status = 'settled' AND created_at >= date_trunc('month', now())) AS credits_month,
          (SELECT max(fetched_at) FROM whatsapp_billing_reconciliation) AS last_reconciled_at`));
      const versions = rows<{ currency: string; effective_from: string; rates: string; markets: string; categories: string }>(await db.execute(sql`
        SELECT currency, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, COUNT(*) AS rates, COUNT(DISTINCT market) AS markets,
          COUNT(DISTINCT category) AS categories
        FROM whatsapp_rate_cards GROUP BY currency, effective_from ORDER BY effective_from DESC, currency`));
      // Meta's rates are in the account's currency: never add INR and USD together.
      const metaCost = rows<{ currency: string; cost: string }>(await db.execute(sql`
        SELECT currency, COALESCE(SUM(settled_rate), 0) AS cost FROM whatsapp_message_charges
        WHERE meta_billable AND created_at >= date_trunc('month', now()) GROUP BY currency ORDER BY currency`));
      const paymentIssues = rows<{ waba_id: string; user_id: number | null; payment_issue_at: string; payment_issue_detail: string | null; business_name: string | null }>(await db.execute(sql`
        SELECT a.waba_id, a.user_id, a.payment_issue_at, a.payment_issue_detail, COALESCE(cs.business_name, cs.company_name) AS business_name
        FROM whatsapp_billing_accounts a LEFT JOIN company_settings cs ON cs.id = a.business_profile_id
        WHERE a.payment_issue_at IS NOT NULL ORDER BY a.payment_issue_at DESC`));
      const [fees] = rows<{ margins_set: string; platform_fee: string | null }>(await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE event_key LIKE 'whatsapp_margin_%' AND credits_per_unit > 0) AS margins_set,
          MAX(credits_per_unit) FILTER (WHERE event_key = 'outreach_whatsapp_platform') AS platform_fee
        FROM credit_pricing WHERE is_active`));
      const tierVersions = rows<{ currency: string; effective_from: string }>(await db.execute(sql`
        SELECT currency, to_char(max(effective_from), 'YYYY-MM-DD') AS effective_from FROM whatsapp_rate_tiers
        WHERE effective_from <= current_date GROUP BY currency`));
      return { counts, versions, metaCost, paymentIssues, fees, tierVersions };
    });
    const settings = await getCreditLineSettings();
    return res.json({
      settings,
      counts: {
        platformAccounts: Number(data.counts?.platform_accounts || 0), needsReview: Number(data.counts?.needs_review || 0),
        awaitingDelivery: Number(data.counts?.awaiting_delivery || 0), markets: Number(data.counts?.markets || 0),
        creditsThisMonth: Number(data.counts?.credits_month || 0),
        lastReconciledAt: data.counts?.last_reconciled_at || null,
      },
      metaCostThisMonth: data.metaCost.map(row => ({ currency: row.currency.trim(), cost: Number(row.cost) })),
      paymentIssues: data.paymentIssues.map(row => ({
        wabaId: row.waba_id, userId: row.user_id, businessName: row.business_name, since: row.payment_issue_at, detail: row.payment_issue_detail,
      })),
      fees: { marginsSet: Number(data.fees?.margins_set || 0), platformFee: data.fees?.platform_fee == null ? null : Number(data.fees.platform_fee) },
      tierVersions: data.tierVersions.map(row => ({ currency: row.currency.trim(), effectiveFrom: row.effective_from })),
      rateCardVersions: data.versions.map(v => ({
        currency: v.currency.trim(), effectiveFrom: v.effective_from, rates: Number(v.rates), markets: Number(v.markets),
        complete: Number(v.categories) >= WHATSAPP_CATEGORIES.length,
      })),
    });
  } catch (error) { return fail(res, error, 'WhatsApp billing overview is unavailable.'); }
}

// ── Rate cards ─────────────────────────────────────────────────────────────

export async function listWhatsAppRateCards(req: Request, res: Response) {
  try {
    const currency = String(req.query.currency || 'INR');
    const effectiveFrom = req.query.effectiveFrom;
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Choose a supported currency.' });
    if (effectiveFrom !== undefined && !validDate(effectiveFrom)) return res.status(400).json({ error: 'Use a YYYY-MM-DD date.' });
    const data = await system('list rate cards', async () => rows<Record<string, unknown>>(await db.execute(effectiveFrom
      ? sql`SELECT id, market, category, currency, rate, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, source
          FROM whatsapp_rate_cards WHERE currency = ${currency} AND effective_from = ${String(effectiveFrom)}::date ORDER BY market, category`
      : sql`SELECT DISTINCT ON (market, category) id, market, category, currency, rate, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, source
          FROM whatsapp_rate_cards WHERE currency = ${currency} AND effective_from <= current_date
          ORDER BY market, category, effective_from DESC`)));
    return res.json({ rates: data.map(row => ({ ...row, currency: String(row.currency).trim(), rate: Number(row.rate) })) });
  } catch (error) { return fail(res, error, 'Rate cards could not be loaded.'); }
}

export async function previewWhatsAppRateCard(req: Request, res: Response) {
  const csv = String(req.body?.csv || '');
  if (!csv.trim() || csv.length > MAX_CSV) return res.status(400).json({ error: 'Paste or upload a CSV of up to 1 MB.' });
  return res.json(parseRateCardCsv(csv));
}

export async function saveWhatsAppRateCard(req: Request, res: Response) {
  try {
    const { currency, effectiveFrom, source } = req.body || {};
    const input = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Choose a supported currency.' });
    if (!validDate(effectiveFrom)) return res.status(400).json({ error: 'Choose the date these rates take effect.' });
    if (!input?.length || input.length > 2000) return res.status(400).json({ error: 'Add between 1 and 2,000 rates.' });
    const clean: Array<{ market: string; category: string; rate: number }> = [];
    for (const row of input) {
      const market = String(row?.market || '').trim();
      const rate = Number(row?.rate);
      if (!market || market.length > 80 || !(WHATSAPP_CATEGORIES as readonly string[]).includes(row?.category) || !Number.isFinite(rate) || rate < 0 || rate > 100000) {
        return res.status(400).json({ error: `Check the rate for "${market || 'a market'}": each needs a market, a category and a non-negative rate.` });
      }
      clean.push({ market, category: row.category, rate });
    }
    const saved = await system('save rate card', async () => db.transaction(async (tx: typeof db) => {
      for (const row of clean) {
        await tx.execute(sql`
          INSERT INTO whatsapp_rate_cards(market, category, currency, rate, effective_from, source)
          VALUES (${row.market}, ${row.category}, ${currency}, ${row.rate}, ${effectiveFrom}::date, ${String(source || 'Admin upload').slice(0, 200)})
          ON CONFLICT (market, category, currency, effective_from) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source`);
      }
      return clean.length;
    }));
    logger.info({ adminId: adminId(req), currency, effectiveFrom, rates: saved }, '[AdminWhatsAppBilling] Rate card saved');
    return res.json({ saved });
  } catch (error) { return fail(res, error, 'The rate card could not be saved.'); }
}

export async function updateWhatsAppRate(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    const rate = Number(req.body?.rate);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Choose a rate.' });
    if (!Number.isFinite(rate) || rate < 0 || rate > 100000) return res.status(400).json({ error: 'Enter a non-negative rate.' });
    const updated = await system('update rate', async () => rows(await db.execute(sql`
      UPDATE whatsapp_rate_cards SET rate = ${rate}, source = 'Edited by administrator' WHERE id = ${id} RETURNING id`)).length);
    return updated ? res.json({ updated: true }) : res.status(404).json({ error: 'Rate not found.' });
  } catch (error) { return fail(res, error, 'The rate could not be updated.'); }
}

export async function deleteWhatsAppRateCardVersion(req: Request, res: Response) {
  try {
    const { currency, effectiveFrom } = req.body || {};
    if (!CURRENCIES.includes(currency) || !validDate(effectiveFrom)) return res.status(400).json({ error: 'Choose a rate card version.' });
    const deleted = await system('delete rate card version', async () => rows(await db.execute(sql`
      DELETE FROM whatsapp_rate_cards WHERE currency = ${currency} AND effective_from = ${effectiveFrom}::date RETURNING id`)).length);
    return res.json({ deleted });
  } catch (error) { return fail(res, error, 'The rate card version could not be deleted.'); }
}

// ── Volume tiers (utility and authentication) ──────────────────────────────

export async function listWhatsAppRateTiers(req: Request, res: Response) {
  try {
    const currency = String(req.query.currency || 'INR');
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Choose a supported currency.' });
    const requested = typeof req.query.effectiveFrom === 'string' && validDate(req.query.effectiveFrom) ? req.query.effectiveFrom : null;
    const data = await system('list tiers', async () => {
      const versions = rows<{ effective_from: string; tiers: string; markets: string }>(await db.execute(sql`
        SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from, COUNT(*) AS tiers, COUNT(DISTINCT market) AS markets
        FROM whatsapp_rate_tiers WHERE currency = ${currency} GROUP BY effective_from ORDER BY effective_from DESC`));
      const current = requested ?? rows<{ effective_from: string | null }>(await db.execute(sql`
        SELECT to_char(max(effective_from), 'YYYY-MM-DD') AS effective_from FROM whatsapp_rate_tiers
        WHERE currency = ${currency} AND effective_from <= current_date`))[0]?.effective_from ?? null;
      const tiers = current ? rows<Record<string, unknown>>(await db.execute(sql`
        SELECT id, market, category, volume_from, volume_to, rate FROM whatsapp_rate_tiers
        WHERE currency = ${currency} AND effective_from = ${current}::date ORDER BY market, category, volume_from`)) : [];
      return { versions, current, tiers };
    });
    return res.json({
      effectiveFrom: data.current,
      versions: data.versions.map(v => ({ effectiveFrom: v.effective_from, tiers: Number(v.tiers), markets: Number(v.markets) })),
      tiers: data.tiers.map(t => ({ id: Number(t.id), market: t.market, category: t.category, volumeFrom: Number(t.volume_from),
        volumeTo: t.volume_to === null ? null : Number(t.volume_to), rate: Number(t.rate) })),
    });
  } catch (error) { return fail(res, error, 'Volume tiers could not be loaded.'); }
}

export async function previewWhatsAppRateTiers(req: Request, res: Response) {
  const csv = String(req.body?.csv || '');
  if (!csv.trim() || csv.length > MAX_CSV) return res.status(400).json({ error: 'Paste or upload a CSV of up to 1 MB.' });
  return res.json(parseRateTiersCsv(csv));
}

export async function saveWhatsAppRateTiers(req: Request, res: Response) {
  try {
    const { currency, effectiveFrom, source } = req.body || {};
    const input = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Choose a supported currency.' });
    if (!validDate(effectiveFrom)) return res.status(400).json({ error: 'Choose the date these tiers take effect.' });
    if (!input?.length || input.length > 2000) return res.status(400).json({ error: 'Add between 1 and 2,000 tiers.' });
    const clean: Array<{ market: string; category: string; volumeFrom: number; volumeTo: number | null; rate: number }> = [];
    for (const row of input) {
      const market = String(row?.market || '').trim();
      const volumeFrom = Number(row?.volumeFrom);
      const volumeTo = row?.volumeTo === null || row?.volumeTo === undefined || row?.volumeTo === '' ? null : Number(row.volumeTo);
      const rate = Number(row?.rate);
      if (!market || market.length > 80 || !['utility', 'authentication'].includes(row?.category)
        || !Number.isSafeInteger(volumeFrom) || volumeFrom < 0 || (volumeTo !== null && (!Number.isSafeInteger(volumeTo) || volumeTo < volumeFrom))
        || !Number.isFinite(rate) || rate < 0 || rate > 100000) {
        return res.status(400).json({ error: `Check the tier for "${market || 'a market'}": it needs a market, utility or authentication, a volume range and a non-negative rate.` });
      }
      clean.push({ market, category: row.category, volumeFrom, volumeTo, rate });
    }
    // A version replaces the whole set for its date, so a re-upload never leaves stale tiers behind.
    const saved = await system('save tiers', async () => db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`DELETE FROM whatsapp_rate_tiers WHERE currency = ${currency} AND effective_from = ${effectiveFrom}::date`);
      for (const row of clean) {
        await tx.execute(sql`
          INSERT INTO whatsapp_rate_tiers(market, category, currency, effective_from, volume_from, volume_to, rate, source)
          VALUES (${row.market}, ${row.category}, ${currency}, ${effectiveFrom}::date, ${row.volumeFrom}, ${row.volumeTo}, ${row.rate},
            ${String(source || 'Admin upload').slice(0, 200)})
          ON CONFLICT (market, category, currency, effective_from, volume_from) DO UPDATE SET volume_to = EXCLUDED.volume_to, rate = EXCLUDED.rate`);
      }
      return clean.length;
    }));
    logger.info({ adminId: adminId(req), currency, effectiveFrom, tiers: saved }, '[AdminWhatsAppBilling] Volume tiers saved');
    return res.json({ saved });
  } catch (error) { return fail(res, error, 'The volume tiers could not be saved.'); }
}

export async function deleteWhatsAppRateTierVersion(req: Request, res: Response) {
  try {
    const { currency, effectiveFrom } = req.body || {};
    if (!CURRENCIES.includes(currency) || !validDate(effectiveFrom)) return res.status(400).json({ error: 'Choose a tier version.' });
    const deleted = await system('delete tier version', async () => rows(await db.execute(sql`
      DELETE FROM whatsapp_rate_tiers WHERE currency = ${currency} AND effective_from = ${effectiveFrom}::date RETURNING id`)).length);
    return res.json({ deleted });
  } catch (error) { return fail(res, error, 'The tier version could not be deleted.'); }
}

// ── Monthly statement and Meta's invoice ───────────────────────────────────

const currentMonth = () => new Date().toISOString().slice(0, 7);

export async function getWhatsAppStatement(req: Request, res: Response) {
  try {
    const month = String(req.query.month || currentMonth());
    const currency = String(req.query.currency || 'INR');
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Choose a supported currency.' });
    return res.json(await system('statement', () => buildWhatsAppStatement(month, currency)));
  } catch (error) { return fail(res, error, 'The monthly statement could not be built.'); }
}

export async function saveWhatsAppInvoiceHandler(req: Request, res: Response) {
  try {
    const { month, currency, amount, reference, note } = req.body || {};
    const value = Number(amount);
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Choose a supported currency.' });
    if (amount === '' || amount === null || !Number.isFinite(value) || value < 0 || value > 1e11) {
      return res.status(400).json({ error: 'Enter the invoice total as a non-negative amount.' });
    }
    await system('save invoice', () => saveWhatsAppInvoice({
      month: String(month || ''), currency, amount: Math.round(value * 100) / 100,
      reference: typeof reference === 'string' ? reference.trim() : undefined, note: typeof note === 'string' ? note.trim() : undefined, adminId: adminId(req),
    }));
    logger.info({ adminId: adminId(req), month, currency }, '[AdminWhatsAppBilling] Meta invoice total saved');
    return res.json({ saved: true });
  } catch (error) { return fail(res, error, 'The invoice total could not be saved.'); }
}

// ── Markets ────────────────────────────────────────────────────────────────

export async function listWhatsAppMarkets(_req: Request, res: Response) {
  try {
    const markets = await system('list markets', async () => rows<{ calling_code: string; market: string }>(await db.execute(sql`
      SELECT calling_code, market FROM whatsapp_rate_markets ORDER BY market, calling_code`)));
    return res.json({ markets: markets.map(m => ({ callingCode: m.calling_code, market: m.market })) });
  } catch (error) { return fail(res, error, 'Markets could not be loaded.'); }
}

export async function previewWhatsAppMarkets(req: Request, res: Response) {
  const csv = String(req.body?.csv || '');
  if (!csv.trim() || csv.length > MAX_CSV) return res.status(400).json({ error: 'Paste or upload a CSV of up to 1 MB.' });
  return res.json(parseMarketsCsv(csv));
}

export async function saveWhatsAppMarkets(req: Request, res: Response) {
  try {
    const input = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!input?.length || input.length > 1000) return res.status(400).json({ error: 'Add between 1 and 1,000 calling codes.' });
    const clean = input.map((row: { callingCode?: unknown; market?: unknown }) => ({
      callingCode: String(row?.callingCode || '').replace(/\D/g, ''), market: String(row?.market || '').trim(),
    }));
    if (clean.some((row: { callingCode: string; market: string }) => !row.callingCode || row.callingCode.length > 8 || !row.market || row.market.length > 80)) {
      return res.status(400).json({ error: 'Each row needs a calling code of up to 8 digits and a market name.' });
    }
    const saved = await system('save markets', async () => db.transaction(async (tx: typeof db) => {
      if (req.body?.replace === true) await tx.execute(sql`DELETE FROM whatsapp_rate_markets`);
      for (const row of clean) {
        await tx.execute(sql`INSERT INTO whatsapp_rate_markets(calling_code, market) VALUES (${row.callingCode}, ${row.market})
          ON CONFLICT (calling_code) DO UPDATE SET market = EXCLUDED.market, updated_at = now()`);
      }
      return clean.length;
    }));
    return res.json({ saved });
  } catch (error) { return fail(res, error, 'Markets could not be saved.'); }
}

export async function deleteWhatsAppMarket(req: Request, res: Response) {
  try {
    const code = String(req.params.callingCode || '').replace(/\D/g, '');
    if (!code) return res.status(400).json({ error: 'Choose a calling code.' });
    const deleted = await system('delete market', async () => rows(await db.execute(sql`
      DELETE FROM whatsapp_rate_markets WHERE calling_code = ${code} RETURNING calling_code`)).length);
    return deleted ? res.json({ deleted: true }) : res.status(404).json({ error: 'Calling code not found.' });
  } catch (error) { return fail(res, error, 'The calling code could not be deleted.'); }
}

// ── Billing accounts ───────────────────────────────────────────────────────

export async function listWhatsAppBillingAccounts(_req: Request, res: Response) {
  try {
    const accounts = await system('list accounts', async () => rows<Record<string, unknown>>(await db.execute(sql`
      SELECT a.waba_id, a.billing_mode, a.currency, a.daily_spend_cap_credits, a.allocation_config_id, a.credit_line_status,
        a.credit_line_error, a.attached_at, a.revoked_at, a.user_id, a.business_profile_id, a.note, a.updated_at,
        a.payment_issue_at, a.payment_issue_detail, u.email AS owner_email, COALESCE(cs.business_name, cs.company_name) AS business_name,
        (SELECT COALESCE(SUM(COALESCE(c.charged_credits, c.reserved_credits)), 0) FROM whatsapp_message_charges c
          WHERE c.waba_id = a.waba_id AND c.status <> 'refunded' AND c.created_at >= date_trunc('month', now())) AS credits_month,
        (SELECT COUNT(*) FROM whatsapp_message_charges c WHERE c.waba_id = a.waba_id AND c.status = 'needs_review') AS needs_review
      FROM whatsapp_billing_accounts a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN company_settings cs ON cs.id = a.business_profile_id
      ORDER BY a.updated_at DESC`)));
    return res.json({ accounts: accounts.map(a => ({
      wabaId: a.waba_id, billingMode: a.billing_mode, currency: String(a.currency).trim(),
      dailySpendCapCredits: a.daily_spend_cap_credits == null ? null : Number(a.daily_spend_cap_credits),
      allocationConfigId: a.allocation_config_id, creditLineStatus: a.credit_line_status, creditLineError: a.credit_line_error,
      attachedAt: a.attached_at, revokedAt: a.revoked_at, userId: a.user_id, businessProfileId: a.business_profile_id,
      ownerEmail: a.owner_email, businessName: a.business_name, note: a.note, updatedAt: a.updated_at,
      creditsThisMonth: Number(a.credits_month || 0), needsReview: Number(a.needs_review || 0),
      paymentIssueAt: a.payment_issue_at ?? null, paymentIssueDetail: a.payment_issue_detail ?? null,
    })) });
  } catch (error) { return fail(res, error, 'WhatsApp billing accounts could not be loaded.'); }
}

export async function saveWhatsAppBillingAccount(req: Request, res: Response) {
  try {
    const wabaId = String(req.params.wabaId || '').trim();
    if (!/^\d{5,30}$/.test(wabaId)) return res.status(400).json({ error: 'Enter the WhatsApp Business Account ID.' });
    const { billingMode, currency, dailySpendCapCredits, note, force } = req.body || {};
    if (!['platform', 'customer_own'].includes(billingMode)) return res.status(400).json({ error: 'Choose who pays Meta for this account.' });
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Choose the account\'s Meta billing currency.' });
    const cap = dailySpendCapCredits === null || dailySpendCapCredits === '' || dailySpendCapCredits === undefined ? null : Number(dailySpendCapCredits);
    if (cap !== null && !(Number.isFinite(cap) && cap >= 0)) return res.status(400).json({ error: 'The daily limit must be a non-negative number of credits, or empty for no limit.' });
    const result = await system('save account', async () => {
      if (billingMode === 'platform' && force !== true) {
        const [rates] = rows<{ count: string }>(await db.execute(sql`
          SELECT COUNT(DISTINCT category) AS count FROM whatsapp_rate_cards WHERE currency = ${currency} AND effective_from <= current_date`));
        if (Number(rates?.count || 0) < WHATSAPP_CATEGORIES.length) {
          return { conflict: `There is no complete ${currency} rate card yet. Every message on this account would be blocked. Import Meta's rates first.` };
        }
      }
      await db.execute(sql`
        INSERT INTO whatsapp_billing_accounts(waba_id, billing_mode, currency, daily_spend_cap_credits, note)
        VALUES (${wabaId}, ${billingMode}, ${currency}, ${cap}, ${note ? String(note).slice(0, 500) : null})
        ON CONFLICT (waba_id) DO UPDATE SET billing_mode = EXCLUDED.billing_mode, currency = EXCLUDED.currency,
          daily_spend_cap_credits = EXCLUDED.daily_spend_cap_credits, note = EXCLUDED.note, updated_at = now()`);
      return { saved: true };
    });
    if ('conflict' in result) return res.status(409).json({ error: result.conflict, code: 'WHATSAPP_RATE_CARD_INCOMPLETE' });
    logger.info({ adminId: adminId(req), wabaId, billingMode, cap }, '[AdminWhatsAppBilling] Billing account saved');
    return res.json(result);
  } catch (error) { return fail(res, error, 'The billing account could not be saved.'); }
}

export async function attachWhatsAppCreditLine(req: Request, res: Response) {
  try {
    const wabaId = String(req.params.wabaId || '').trim();
    if (!/^\d{5,30}$/.test(wabaId)) return res.status(400).json({ error: 'Enter the WhatsApp Business Account ID.' });
    const result = await system('attach credit line', () => attachCreditLine({ wabaId, reason: 'admin' }));
    return res.status(result.status === 'attached' ? 200 : result.status === 'skipped' ? 409 : 502).json(result);
  } catch (error) { return fail(res, error, 'The credit line could not be attached.'); }
}

export async function revokeWhatsAppCreditLine(req: Request, res: Response) {
  try {
    const wabaId = String(req.params.wabaId || '').trim();
    if (!/^\d{5,30}$/.test(wabaId)) return res.status(400).json({ error: 'Enter the WhatsApp Business Account ID.' });
    const result = await system('revoke credit line', () => revokeCreditLine(wabaId, `administrator #${adminId(req) ?? '?'}`));
    return res.status(result.status === 'failed' ? 502 : 200).json(result);
  } catch (error) { return fail(res, error, 'The credit line could not be revoked.'); }
}

// ── Charges and reconciliation ─────────────────────────────────────────────

export async function listWhatsAppCharges(req: Request, res: Response) {
  try {
    const status = String(req.query.status || 'needs_review');
    if (!['needs_review', 'reserved', 'sent', 'settled', 'refunded', 'all'].includes(status)) return res.status(400).json({ error: 'Choose a status.' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const charges = await system('list charges', async () => rows<Record<string, unknown>>(await db.execute(sql`
      SELECT c.id, c.user_id, c.business_profile_id, c.waba_id, c.phone_number_id, c.wamid, c.message_kind, c.template_name,
        c.expected_category, c.meta_category, c.meta_pricing_type, c.meta_billable, c.recipient_market, c.currency, c.reserved_rate,
        c.reserved_credits, c.settled_rate, c.charged_credits, c.status, c.review_reason, c.created_at, c.settled_at, u.email AS owner_email
      FROM whatsapp_message_charges c LEFT JOIN users u ON u.id = c.user_id
      WHERE (${status} = 'all' OR c.status = ${status})
      ORDER BY c.created_at DESC LIMIT ${limit}`)));
    return res.json({ charges: charges.map(c => ({
      id: Number(c.id), userId: c.user_id, businessProfileId: c.business_profile_id, ownerEmail: c.owner_email, wabaId: c.waba_id,
      phoneNumberId: c.phone_number_id, wamid: c.wamid, messageKind: c.message_kind, templateName: c.template_name,
      expectedCategory: c.expected_category, metaCategory: c.meta_category, metaPricingType: c.meta_pricing_type, metaBillable: c.meta_billable,
      market: c.recipient_market, currency: String(c.currency).trim(), reservedRate: Number(c.reserved_rate), reservedCredits: Number(c.reserved_credits),
      settledRate: c.settled_rate == null ? null : Number(c.settled_rate), chargedCredits: c.charged_credits == null ? null : Number(c.charged_credits),
      status: c.status, reviewReason: c.review_reason, createdAt: c.created_at, settledAt: c.settled_at,
    })) });
  } catch (error) { return fail(res, error, 'WhatsApp charges could not be loaded.'); }
}

export async function resolveWhatsAppChargeHandler(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    const action = req.body?.action;
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Choose a charge.' });
    if (!['refund', 'charge'].includes(action)) return res.status(400).json({ error: 'Choose to refund or to charge the reserved amount.' });
    const result = await system('resolve charge', () => resolveWhatsAppCharge(id, action, adminId(req)));
    logger.info({ adminId: adminId(req), chargeId: id, action }, '[AdminWhatsAppBilling] Charge resolved');
    return res.json(result);
  } catch (error) { return fail(res, error, 'The charge could not be resolved.'); }
}

export async function listWhatsAppReconciliation(req: Request, res: Response) {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 120);
    const data = await system('list reconciliation', async () => rows<Record<string, unknown>>(await db.execute(sql`
      SELECT waba_id, to_char(day, 'YYYY-MM-DD') AS day, category, meta_volume, meta_cost, currency, ledger_volume, ledger_cost, fetched_at
      FROM whatsapp_billing_reconciliation WHERE day >= current_date - make_interval(days => ${days})
      ORDER BY day DESC, waba_id, category`)));
    return res.json({ rows: data.map(r => ({
      wabaId: r.waba_id, day: r.day, category: r.category, metaVolume: Number(r.meta_volume), metaCost: Number(r.meta_cost),
      currency: String(r.currency).trim(), ledgerVolume: Number(r.ledger_volume), ledgerCost: Number(r.ledger_cost), fetchedAt: r.fetched_at,
    })) });
  } catch (error) { return fail(res, error, 'Reconciliation could not be loaded.'); }
}

export async function runWhatsAppReconciliation(_req: Request, res: Response) {
  try {
    const result = await system('run reconciliation', () => reconcileWhatsAppBilling({ force: true }));
    return res.json(result);
  } catch (error) { return fail(res, error, 'Reconciliation could not run.'); }
}

// ── Credit line settings ───────────────────────────────────────────────────

export async function getWhatsAppCreditLineSettings(_req: Request, res: Response) {
  try { return res.json(await getCreditLineSettings()); }
  catch (error) { return fail(res, error, 'Credit line settings could not be loaded.'); }
}

export async function saveWhatsAppCreditLineSettings(req: Request, res: Response) {
  try {
    const body = req.body || {};
    const allowed = new Set(['creditLineId', 'systemToken', 'attachOnSignup', 'currency', 'monthlyLimit', 'alertPercent']);
    if (Object.keys(body).some(key => !allowed.has(key))) return res.status(400).json({ error: 'The settings contain unsupported fields.' });
    return res.json(await saveCreditLineSettings(adminId(req), {
      creditLineId: body.creditLineId, systemToken: body.systemToken,
      attachOnSignup: typeof body.attachOnSignup === 'boolean' ? body.attachOnSignup : undefined,
      currency: body.currency, alertPercent: body.alertPercent === undefined ? undefined : Number(body.alertPercent),
      monthlyLimit: body.monthlyLimit === undefined ? undefined : body.monthlyLimit === null || body.monthlyLimit === '' ? null : Number(body.monthlyLimit),
    }));
  } catch (error) { return fail(res, error, 'Credit line settings could not be saved.'); }
}

export async function testWhatsAppCreditLineSettings(req: Request, res: Response) {
  try { return res.json(await testCreditLineSettings(String(req.body?.businessId || '').trim())); }
  catch (error) { return fail(res, error, 'The credit line could not be checked.'); }
}
