/**
 * Background upkeep for WhatsApp platform billing. Runs hourly on the GENERAL
 * worker under a system database scope (it reads every business's charges).
 *
 *  - Sweeper: a charge still waiting for Meta's delivery report after 7 days
 *    becomes needs_review. The reservation is kept (Meta may still bill it).
 *  - Reconciliation (every 6 hours): Meta's pricing_analytics VOLUME of billable
 *    ("REGULAR") messages per WABA, day and category, beside our settled
 *    charges. Meta does not report COST for WABAs on a Solution Partner's
 *    credit line, so counts are compared and Meta's count is priced with our
 *    rate card for the variance report. Cost is stored when Meta returns it.
 *  - Spend alert: month-to-date Meta cost across platform WABAs against the
 *    admin-set monthly limit for the credit line.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { platformBillingEnabled, releaseCharge } from './WhatsAppBillingService.js';
import { alertAdmins, getCreditLineConfig } from './WhatsAppCreditLine.js';

const STALE_DAYS = 7;
const RECONCILE_EVERY_HOURS = 6;
const RECONCILE_LOOKBACK_DAYS = 3;

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) || [];
}

export async function sweepStaleWhatsAppCharges(): Promise<number> {
  const updated = rows<{ id: number }>(await db.execute(sql`
    UPDATE whatsapp_message_charges SET status = 'needs_review',
      review_reason = ${`No delivery report from Meta after ${STALE_DAYS} days`}, updated_at = now()
    WHERE status IN ('reserved','sent') AND created_at < now() - make_interval(days => ${STALE_DAYS})
    RETURNING id`));
  if (updated.length) {
    await alertAdmins('WhatsApp charges need review',
      `${updated.length} WhatsApp message charge(s) had no delivery report after ${STALE_DAYS} days. Review them on the WhatsApp billing page.`);
  }
  return updated.length;
}

export interface MetaVolumePoint { day: string; category: string; volume: number; cost: number | null }

/** Billable (REGULAR) data points from a pricing_analytics response, summed per day and category. */
export function billableVolumes(response: unknown): MetaVolumePoint[] {
  const data = (response as { pricing_analytics?: { data?: Array<{ data_points?: Array<Record<string, unknown>> }> } })?.pricing_analytics?.data || [];
  const totals = new Map<string, MetaVolumePoint>();
  for (const group of data) {
    for (const point of group.data_points || []) {
      if (String(point.pricing_type || '').toUpperCase() !== 'REGULAR') continue;
      const day = new Date(Number(point.start) * 1000).toISOString().slice(0, 10);
      const category = String(point.pricing_category || 'unknown').toLowerCase();
      const key = `${day}|${category}`;
      const entry = totals.get(key) ?? { day, category, volume: 0, cost: null };
      entry.volume += Number(point.volume) || 0;
      if (point.cost !== undefined && point.cost !== null) entry.cost = (entry.cost ?? 0) + (Number(point.cost) || 0);
      totals.set(key, entry);
    }
  }
  return [...totals.values()];
}

/** A day/category is out of line when the counts differ by more than 2 messages and 2%. */
export function isVariance(metaVolume: number, ledgerVolume: number): boolean {
  const diff = Math.abs(metaVolume - ledgerVolume);
  return diff > 2 && diff > Math.max(metaVolume, ledgerVolume) * 0.02;
}

async function lastReconciledAt(): Promise<Date | null> {
  const [row] = rows<{ at: Date | null }>(await db.execute(sql`SELECT max(fetched_at) AS at FROM whatsapp_billing_reconciliation`));
  return row?.at ? new Date(row.at) : null;
}

export async function reconcileWhatsAppBilling(options: { force?: boolean } = {}): Promise<{ wabas: number; variances: string[]; errors: string[] }> {
  const result = { wabas: 0, variances: [] as string[], errors: [] as string[] };
  const last = await lastReconciledAt();
  if (!options.force && last && Date.now() - last.getTime() < RECONCILE_EVERY_HOURS * 3600_000) return result;
  const config = await getCreditLineConfig();
  if (!config) return result;
  const accounts = rows<{ waba_id: string; currency: string }>(await db.execute(sql`
    SELECT waba_id, currency FROM whatsapp_billing_accounts WHERE billing_mode = 'platform'`));
  const startDay = new Date(Date.now() - RECONCILE_LOOKBACK_DAYS * 86400_000);
  startDay.setUTCHours(0, 0, 0, 0);
  const start = Math.floor(startDay.getTime() / 1000);
  const end = Math.floor(Date.now() / 1000);
  const settledBefore = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  for (const account of accounts) {
    result.wabas++;
    let points: MetaVolumePoint[];
    try {
      const url = new URL(`https://graph.facebook.com/${config.apiVersion}/${account.waba_id}`);
      url.searchParams.set('fields', `pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(PRICING_CATEGORY,PRICING_TYPE)`);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${config.systemToken}` }, signal: AbortSignal.timeout(20_000) });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok || body.error) throw new Error((body.error as { message?: string })?.message || `HTTP ${response.status}`);
      points = billableVolumes(body);
    } catch (error) {
      result.errors.push(`${account.waba_id}: ${(error as Error).message}`);
      continue;
    }
    const ledger = rows<{ day: string; category: string; volume: string; cost: string }>(await db.execute(sql`
      SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, lower(meta_category) AS category, COUNT(*) AS volume, COALESCE(SUM(settled_rate), 0) AS cost
      FROM whatsapp_message_charges
      WHERE waba_id = ${account.waba_id} AND meta_billable AND created_at >= ${startDay.toISOString()}::timestamptz
      GROUP BY 1, 2`));
    const keys = new Set([...points.map(p => `${p.day}|${p.category}`), ...ledger.map(l => `${l.day}|${l.category}`)]);
    for (const key of keys) {
      const [day, category] = key.split('|');
      const meta = points.find(p => p.day === day && p.category === category);
      const mine = ledger.find(l => l.day === day && l.category === category);
      const metaVolume = meta?.volume ?? 0;
      const ledgerVolume = Number(mine?.volume ?? 0);
      // Without Meta's cost, price Meta's count at the rate we settled at for that day.
      const ledgerCost = Number(mine?.cost ?? 0);
      const metaCost = meta?.cost ?? (ledgerVolume > 0 ? ledgerCost / ledgerVolume * metaVolume : 0);
      await db.execute(sql`
        INSERT INTO whatsapp_billing_reconciliation(waba_id, day, category, meta_volume, meta_cost, currency, ledger_volume, ledger_cost, fetched_at)
        VALUES (${account.waba_id}, ${day}::date, ${category}, ${metaVolume}, ${metaCost}, ${account.currency}, ${ledgerVolume}, ${ledgerCost}, now())
        ON CONFLICT (waba_id, day, category) DO UPDATE SET meta_volume = EXCLUDED.meta_volume, meta_cost = EXCLUDED.meta_cost,
          ledger_volume = EXCLUDED.ledger_volume, ledger_cost = EXCLUDED.ledger_cost, currency = EXCLUDED.currency, fetched_at = now()`);
      // Today's and yesterday's reports may still be arriving.
      if (day < settledBefore && isVariance(metaVolume, ledgerVolume)) {
        result.variances.push(`${account.waba_id} ${day} ${category}: Meta ${metaVolume}, ledger ${ledgerVolume}`);
      }
    }
  }
  if (result.variances.length) {
    await alertAdmins('WhatsApp billing does not match Meta',
      `${result.variances.length} day/category total(s) differ from Meta's delivered counts, for example ${result.variances.slice(0, 3).join('; ')}.`);
  }
  if (result.errors.length) logger.warn({ errors: result.errors }, '[WhatsAppBilling] Reconciliation could not read some WABAs');
  return result;
}

export async function checkCreditLineSpend(): Promise<{ spent: number; limit: number | null }> {
  const config = await getCreditLineConfig();
  const [row] = rows<{ spent: string | null }>(await db.execute(sql`
    SELECT COALESCE(SUM(settled_rate), 0) AS spent FROM whatsapp_message_charges
    WHERE meta_billable AND created_at >= date_trunc('month', now())`));
  const spent = Number(row?.spent || 0);
  if (config?.monthlyLimit && spent >= config.monthlyLimit * config.alertPercent / 100) {
    await alertAdmins('WhatsApp credit line spend is high',
      `Meta message cost this month is ${spent.toFixed(2)} ${config.currency}, ${Math.round(spent / config.monthlyLimit * 100)}% of the ${config.monthlyLimit} ${config.currency} limit set for the credit line.`);
  }
  return { spent, limit: config?.monthlyLimit ?? null };
}

/** First day of the next quarter (Meta changes rates only then), as YYYY-MM-DD. */
export function nextQuarterStart(now = new Date()): string {
  const month = Math.floor(now.getUTCMonth() / 3) * 3 + 3;
  return new Date(Date.UTC(now.getUTCFullYear() + (month >= 12 ? 1 : 0), month % 12, 1)).toISOString().slice(0, 10);
}

const QUARTER_REMINDER_DAYS = 21;

/** In the 3 weeks before a quarter starts, remind admins until the new rate card is imported. */
export async function checkNextRateCard(now = new Date()): Promise<boolean> {
  const quarter = nextQuarterStart(now);
  if (Date.parse(`${quarter}T00:00:00Z`) - now.getTime() > QUARTER_REMINDER_DAYS * 86400_000) return false;
  const config = await getCreditLineConfig();
  const currency = config?.currency ?? 'INR';
  const [row] = rows<{ count: string }>(await db.execute(sql`
    SELECT COUNT(*) AS count FROM whatsapp_rate_cards WHERE currency = ${currency} AND effective_from = ${quarter}::date`));
  if (Number(row?.count || 0) > 0) return false;
  await alertAdmins('Import the next WhatsApp rate card',
    `Meta's rates can change on ${quarter}. No ${currency} rate card takes effect on that date yet. Import Meta's new rate card on the WhatsApp billing page, even if the rates are unchanged.`);
  return true;
}

/** Hourly job entry point (cron-whatsapp-billing-maintenance). */
export async function runWhatsAppBillingMaintenance(): Promise<Record<string, unknown>> {
  if (!platformBillingEnabled()) return { skipped: 'disabled' };
  const swept = await sweepStaleWhatsAppCharges();
  const reconciliation = await reconcileWhatsAppBilling();
  const spend = await checkCreditLineSpend();
  const rateCardReminder = await checkNextRateCard();
  return { swept, reconciledWabas: reconciliation.wabas, variances: reconciliation.variances.length, spend, rateCardReminder };
}

/**
 * An administrator's decision on a charge flagged for review:
 *   refund  -> give the customer back everything reserved for it;
 *   charge  -> keep what was reserved as the final charge.
 */
export async function resolveWhatsAppCharge(chargeId: number, action: 'refund' | 'charge', adminId: number | null): Promise<{ status: string }> {
  const [charge] = rows<{ id: number; user_id: number; status: string; reservation_transaction_id: number | null; reserved_credits: string }>(
    await db.execute(sql`SELECT id, user_id, status, reservation_transaction_id, reserved_credits FROM whatsapp_message_charges WHERE id = ${chargeId}`));
  if (!charge) throw Object.assign(new Error('Charge not found.'), { status: 404 });
  if (charge.status !== 'needs_review') throw Object.assign(new Error('Only charges that need review can be resolved.'), { status: 409 });
  const note = `Resolved by administrator${adminId ? ` #${adminId}` : ''}`;
  if (action === 'refund') {
    await releaseCharge(Number(charge.id), Number(charge.user_id), `${note}: refunded`);
    return { status: 'refunded' };
  }
  if (charge.reservation_transaction_id) {
    const { creditService } = await import('../CreditService.js');
    const settled = await creditService.settleReservation({
      userId: Number(charge.user_id), transactionId: charge.reservation_transaction_id, actualCredits: Number(charge.reserved_credits),
      description: 'WhatsApp message charge confirmed by an administrator',
    });
    if (!settled.success && !settled.alreadyRefunded) throw new Error(settled.error || 'The charge could not be settled.');
  }
  await db.execute(sql`UPDATE whatsapp_message_charges SET status = 'settled', charged_credits = reserved_credits,
    review_reason = ${`${note}: charged as reserved`}, settled_at = now(), updated_at = now() WHERE id = ${chargeId} AND status = 'needs_review'`);
  return { status: 'settled' };
}
