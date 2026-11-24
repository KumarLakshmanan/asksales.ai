/** Reporting periods for paid campaign analytics. Dates are inclusive UTC calendar days. */
export const PAID_ANALYTICS_PERIODS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'last_month', 'this_year'] as const;
export type PaidAnalyticsPeriod = typeof PAID_ANALYTICS_PERIODS[number];
export interface PaidAnalyticsDateRange { start: string; end: string; period?: PaidAnalyticsPeriod }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (date: Date) => date.toISOString().slice(0, 10);
const utcDate = (year: number, month: number, date: number) => new Date(Date.UTC(year, month, date));

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && day(parsed) === value;
}

/**
 * Resolve a named period or explicit dates. A named period wins over dates;
 * invalid or reversed dates are rejected rather than silently widened.
 * Returns null when no period was requested (lifetime totals).
 */
export function resolvePaidAnalyticsDateRange(
  filters: { period?: unknown; date_range?: { start?: unknown; end?: unknown } } | undefined,
  now: Date = new Date(),
): PaidAnalyticsDateRange | null {
  const period = filters?.period;
  if (typeof period === 'string' && (PAID_ANALYTICS_PERIODS as readonly string[]).includes(period)) {
    const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
    const today = utcDate(y, m, d);
    const back = (days: number) => utcDate(y, m, d - days);
    const range = (start: Date, end: Date) => ({ start: day(start), end: day(end), period: period as PaidAnalyticsPeriod });
    switch (period as PaidAnalyticsPeriod) {
      case 'today': return range(today, today);
      case 'yesterday': return range(back(1), back(1));
      case 'last_7_days': return range(back(6), today);
      case 'last_30_days': return range(back(29), today);
      case 'this_month': return range(utcDate(y, m, 1), today);
      case 'last_month': return range(utcDate(y, m - 1, 1), utcDate(y, m, 0));
      case 'this_year': return range(utcDate(y, 0, 1), today);
    }
  }
  const start = filters?.date_range?.start, end = filters?.date_range?.end;
  if (start === undefined && end === undefined) return null;
  if (!validIsoDate(start) || !validIsoDate(end)) throw new Error('Use real calendar dates in YYYY-MM-DD format for the reporting period.');
  if (start > end) throw new Error('The reporting period starts after it ends. Swap the start and end dates.');
  return { start, end };
}
