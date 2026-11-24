import { sql } from "drizzle-orm";
import { db } from "../models/db.js";

/** Currency and daily/lifetime budgets are independent dimensions, never FX conversions. */
export async function dashboardMoney(userId: number, executor: Pick<typeof db, 'execute'> = db) {
  const result = await executor.execute(sql`
    SELECT COALESCE(NULLIF(UPPER(TRIM(currency)), ''), 'UNKNOWN') AS currency,
      budget_type, COALESCE(SUM(spent_amount), 0)::numeric AS spend,
      COALESCE(SUM(budget_amount), 0)::numeric AS budget
    FROM performance_ad_campaigns WHERE user_id = ${userId}
    GROUP BY 1, budget_type ORDER BY 1, budget_type
  `);
  const spendByCurrency: Record<string, number> = {};
  const budgetByCurrencyAndType: Array<{
    currency: string;
    type: string;
    amount: number;
  }> = [];
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const currency = String(row.currency);
    spendByCurrency[currency] =
      (spendByCurrency[currency] || 0) + Number(row.spend);
    budgetByCurrencyAndType.push({
      currency,
      type: String(row.budget_type || "unknown"),
      amount: Number(row.budget),
    });
  }
  const currencies = Object.keys(spendByCurrency);
  const currency =
    currencies.length === 1 && /^[A-Z]{3}$/.test(currencies[0])
      ? currencies[0]
      : null;
  return {
    spendByCurrency,
    budgetByCurrencyAndType,
    currency,
    totalSpent: currency ? spendByCurrency[currency] : null,
    totalBudget:
      currency && budgetByCurrencyAndType.length === 1
        ? budgetByCurrencyAndType[0].amount
        : null,
  };
}
