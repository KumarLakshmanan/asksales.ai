/**
 * Monthly WhatsApp statement: what Meta should bill us for a month, beside
 * what we charged customers and the invoice total an administrator entered.
 *
 * Customers are charged Meta's list rate. Meta charges us less for utility and
 * authentication once a business portfolio passes a volume tier in a market
 * that month (incremental: only messages past a tier's start get its rate).
 * We count per WhatsApp account, because each customer's account normally sits
 * in its own portfolio; a customer with several accounts in one portfolio
 * reaches tiers sooner than this shows.
 *
 * Meta does not report cost for accounts on a partner's credit line, only
 * message counts, so the expected cost here is our own calculation.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { TIERED_WHATSAPP_CATEGORIES } from './WhatsAppBillingService.js';

export interface RateTier { volumeFrom: number; volumeTo: number | null; rate: number }

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) || [];
}
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Cost of `count` messages in one month, market and category with incremental
 * tiers: messages volumeFrom+1 .. volumeTo are charged that tier's rate. Any
 * volume beyond the last closed tier stays at that tier's rate.
 */
export function tieredCost(count: number, tiers: RateTier[]): number {
  if (count <= 0 || !tiers.length) return 0;
  const sorted = [...tiers].sort((a, b) => a.volumeFrom - b.volumeFrom);
  let cost = 0;
  sorted.forEach((tier, index) => {
    const next = sorted[index + 1];
    const end = next ? Math.min(tier.volumeTo ?? next.volumeFrom, next.volumeFrom) : Infinity;
    const inTier = Math.max(0, Math.min(count, end) - tier.volumeFrom);
    cost += inTier * tier.rate;
  });
  return cost;
}

export interface StatementLine {
  wabaId: string;
  userId: number | null;
  market: string;
  category: string;
  messages: number;
  listCost: number;
  expectedCost: number;
  tiered: boolean;
  chargedCredits: number;
}

export interface WhatsAppStatement {
  month: string;
  currency: string;
  lines: StatementLine[];
  accounts: Array<{ wabaId: string; userId: number | null; messages: number; listCost: number; expectedCost: number; chargedCredits: number; metaMessages: number | null }>;
  totals: { messages: number; listCost: number; expectedCost: number; tierSavings: number; chargedCredits: number; metaMessages: number | null };
  invoice: { amount: number; reference: string | null; note: string | null; updatedAt: string } | null;
  /** Invoice minus our expected cost; null until an invoice is entered. */
  difference: number | null;
  tierVersion: string | null;
}

/** "2026-11" -> first day, first day of next month. */
export function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error('Choose a month as YYYY-MM.'), { status: 400 });
  const [year, mon] = month.split('-').map(Number);
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
  return { start: `${month}-01`, end: `${next}-01` };
}

export async function buildWhatsAppStatement(month: string, currency: string): Promise<WhatsAppStatement> {
  const { start, end } = monthBounds(month);
  const ledger = rows<{ waba_id: string; user_id: number | null; market: string; category: string; messages: string; list_cost: string; credits: string }>(await db.execute(sql`
    SELECT c.waba_id, a.user_id, c.recipient_market AS market, lower(c.meta_category) AS category, COUNT(*) AS messages,
      COALESCE(SUM(c.settled_rate), 0) AS list_cost, COALESCE(SUM(c.charged_credits), 0) AS credits
    FROM whatsapp_message_charges c
    LEFT JOIN whatsapp_billing_accounts a ON a.waba_id = c.waba_id
    WHERE c.meta_billable AND c.currency = ${currency} AND c.status IN ('settled', 'needs_review')
      AND c.created_at >= ${start}::date AND c.created_at < ${end}::date
    GROUP BY 1, 2, 3, 4 ORDER BY 1, 3, 4`));

  // The tier version in force on the 1st (Meta changes rates only on a quarter's first day).
  const [version] = rows<{ effective_from: string | null }>(await db.execute(sql`
    SELECT to_char(max(effective_from), 'YYYY-MM-DD') AS effective_from FROM whatsapp_rate_tiers
    WHERE currency = ${currency} AND effective_from <= ${start}::date`));
  const tierVersion = version?.effective_from ?? null;
  const tierRows = tierVersion ? rows<{ market: string; category: string; volume_from: number; volume_to: number | null; rate: string }>(await db.execute(sql`
    SELECT market, category, volume_from, volume_to, rate FROM whatsapp_rate_tiers
    WHERE currency = ${currency} AND effective_from = ${tierVersion}::date`)) : [];
  const tiersFor = (market: string, category: string): RateTier[] => tierRows
    .filter(row => row.market.toLowerCase() === market.toLowerCase() && row.category === category)
    .map(row => ({ volumeFrom: Number(row.volume_from), volumeTo: row.volume_to === null ? null : Number(row.volume_to), rate: Number(row.rate) }));

  const lines: StatementLine[] = ledger.map(row => {
    const messages = Number(row.messages);
    const listCost = Number(row.list_cost);
    const tiers = (TIERED_WHATSAPP_CATEGORIES as readonly string[]).includes(row.category) ? tiersFor(row.market, row.category) : [];
    const expectedCost = tiers.length ? tieredCost(messages, tiers) : listCost;
    return {
      wabaId: row.waba_id, userId: row.user_id === null ? null : Number(row.user_id), market: row.market, category: row.category,
      messages, listCost: round(listCost, 4), expectedCost: round(expectedCost, 4), tiered: tiers.length > 0, chargedCredits: Number(row.credits),
    };
  });

  const metaCounts = rows<{ waba_id: string; volume: string }>(await db.execute(sql`
    SELECT waba_id, SUM(meta_volume) AS volume FROM whatsapp_billing_reconciliation
    WHERE currency = ${currency} AND day >= ${start}::date AND day < ${end}::date GROUP BY 1`));
  const metaByWaba = new Map(metaCounts.map(row => [row.waba_id, Number(row.volume)]));

  const accounts = new Map<string, WhatsAppStatement['accounts'][number]>();
  for (const line of lines) {
    const account = accounts.get(line.wabaId) ?? {
      wabaId: line.wabaId, userId: line.userId, messages: 0, listCost: 0, expectedCost: 0, chargedCredits: 0, metaMessages: metaByWaba.get(line.wabaId) ?? null,
    };
    account.messages += line.messages;
    account.listCost = round(account.listCost + line.listCost, 4);
    account.expectedCost = round(account.expectedCost + line.expectedCost, 4);
    account.chargedCredits = round(account.chargedCredits + line.chargedCredits);
    accounts.set(line.wabaId, account);
  }
  for (const [wabaId, volume] of metaByWaba) {
    if (!accounts.has(wabaId)) accounts.set(wabaId, { wabaId, userId: null, messages: 0, listCost: 0, expectedCost: 0, chargedCredits: 0, metaMessages: volume });
  }

  const list = [...accounts.values()];
  const listCost = round(list.reduce((sum, a) => sum + a.listCost, 0), 4);
  const expectedCost = round(list.reduce((sum, a) => sum + a.expectedCost, 0), 4);
  const [invoiceRow] = rows<{ amount: string; reference: string | null; note: string | null; updated_at: string }>(await db.execute(sql`
    SELECT amount, reference, note, updated_at FROM whatsapp_billing_invoices WHERE month = ${start}::date AND currency = ${currency}`));
  const invoice = invoiceRow ? { amount: Number(invoiceRow.amount), reference: invoiceRow.reference, note: invoiceRow.note, updatedAt: String(invoiceRow.updated_at) } : null;

  return {
    month, currency, lines, accounts: list, tierVersion,
    totals: {
      messages: list.reduce((sum, a) => sum + a.messages, 0),
      listCost, expectedCost, tierSavings: round(listCost - expectedCost, 4),
      chargedCredits: round(list.reduce((sum, a) => sum + a.chargedCredits, 0)),
      metaMessages: metaByWaba.size ? [...metaByWaba.values()].reduce((sum, v) => sum + v, 0) : null,
    },
    invoice,
    difference: invoice ? round(invoice.amount - expectedCost) : null,
  };
}

export async function saveWhatsAppInvoice(input: { month: string; currency: string; amount: number; reference?: string; note?: string; adminId: number | null }): Promise<void> {
  const { start } = monthBounds(input.month);
  await db.execute(sql`
    INSERT INTO whatsapp_billing_invoices(month, currency, amount, reference, note, entered_by, updated_at)
    VALUES (${start}::date, ${input.currency}, ${input.amount}, ${input.reference?.slice(0, 120) || null}, ${input.note?.slice(0, 2000) || null}, ${input.adminId}, now())
    ON CONFLICT (month, currency) DO UPDATE SET amount = EXCLUDED.amount, reference = EXCLUDED.reference, note = EXCLUDED.note,
      entered_by = EXCLUDED.entered_by, updated_at = now()`);
}
