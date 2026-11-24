export interface ProviderUsage {
  apiProvider: string;
  totalCredits: number;
  totalApiCostCents: number;
  eventCount: number;
}
export interface DailyTransaction {
  date: string;
  credits: number;
  debits: number;
  net: number;
  transactionCount: number;
}
export function billingWindowStart(days: number, now = new Date()): string {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start.toISOString();
}
/** A date-only end filter includes that entire UTC day. */
export function billingDateRange(startDate = "", endDate = "") {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    ? `${startDate}T00:00:00.000Z`
    : startDate;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    ? `${endDate}T23:59:59.999Z`
    : endDate;
  const params = new URLSearchParams();
  if (start) params.set("startDate", start);
  if (end) params.set("endDate", end);
  return { start, end, query: params.toString() };
}
export function averageActiveDaySpend(rows: DailyTransaction[] = []): number {
  const active = rows.filter((row) => Number(row.debits) > 0);
  return active.length
    ? active.reduce((sum, row) => sum + Number(row.debits), 0) / active.length
    : 0;
}

/** Wallet balance and totals from the billing wallet endpoint. */
export interface WalletData {
  balance: number;
  totalCreditsAdded: number;
  totalCreditsUsed: number;
  rechargeRate: number;
  summary: {
    totalRecharges: number;
    totalDeductions: number;
    totalRefunds: number;
    transactionCount: number;
  };
}
