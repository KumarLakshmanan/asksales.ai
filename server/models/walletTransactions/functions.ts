import { resolveBillingOrganization } from '../../services/billing/organizations.js';
/**
 * Wallet Transactions Functions
 * CRUD operations for wallet transactions
 */

import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { db } from "../db.js";
import { walletTransactionsTable, type WalletTransactionRecord, type InsertWalletTransaction } from "./schema.js";

// Create a new transaction
export async function createTransaction(data: InsertWalletTransaction): Promise<WalletTransactionRecord> {
  const [tx] = await db.insert(walletTransactionsTable).values({...data,organizationId:data.organizationId??await resolveBillingOrganization(data.userId)}).returning();
  return tx;
}

// Get transactions by user ID with pagination
export async function getTransactionsByUserId(
  userId: number,
  options?: {
    limit?: number;
    offset?: number;
    type?: string;
    category?: string;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<{ transactions: WalletTransactionRecord[]; total: number }> {
  const conditions = [eq(walletTransactionsTable.organizationId, await resolveBillingOrganization(userId))];

  if (options?.type) {
    conditions.push(eq(walletTransactionsTable.type, options.type));
  }
  if (options?.category) {
    conditions.push(eq(walletTransactionsTable.category, options.category));
  }
  if (options?.startDate) {
    conditions.push(gte(walletTransactionsTable.createdAt, options.startDate));
  }
  if (options?.endDate) {
    conditions.push(lte(walletTransactionsTable.createdAt, options.endDate));
  }

  const whereClause = and(...conditions);
  const limit = Math.min(Math.max(Number(options?.limit) || 50, 1), 200);
  const offset = Math.min(Math.max(Number(options?.offset) || 0, 0), 100_000);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletTransactionsTable)
    .where(whereClause);

  const transactions = await db
    .select()
    .from(walletTransactionsTable)
    .where(whereClause)
    .orderBy(desc(walletTransactionsTable.createdAt), desc(walletTransactionsTable.id))
    .limit(limit)
    .offset(offset);

  return { transactions: transactions.map((transaction: WalletTransactionRecord) => transaction.userId === userId ? transaction : {
    ...transaction, description: `${transaction.category || 'Organization'} credit ${transaction.type}`,
    referenceId: null, referenceType: null, metadata: null,
  }), total: countResult?.count || 0 };
}

// Get transaction summary
export async function getTransactionSummary(userId: number, startDate?: Date, endDate?: Date) {
  const conditions = [eq(walletTransactionsTable.organizationId, await resolveBillingOrganization(userId))];
  if (startDate) conditions.push(gte(walletTransactionsTable.createdAt, startDate));
  if (endDate) conditions.push(lte(walletTransactionsTable.createdAt, endDate));

  const [result] = await db
    .select({
      totalRecharges: sql<string>`COALESCE(SUM(CASE WHEN type = 'recharge' THEN amount ELSE 0 END), 0)`,
      totalDeductions: sql<string>`COALESCE(SUM(CASE WHEN type = 'deduction' THEN ABS(amount) ELSE 0 END), 0)`,
      totalRefunds: sql<string>`COALESCE(SUM(CASE WHEN type = 'refund' THEN amount ELSE 0 END), 0)`,
      transactionCount: sql<number>`count(*)::int`,
    })
    .from(walletTransactionsTable)
    .where(and(...conditions));

  return {
    totalRecharges: parseFloat(result?.totalRecharges || "0"),
    totalDeductions: parseFloat(result?.totalDeductions || "0"),
    totalRefunds: parseFloat(result?.totalRefunds || "0"),
    transactionCount: result?.transactionCount || 0,
  };
}

/**
 * Admin revenue context: money actually received, and credits handed out
 * without a payment, across all organizations. Credit value on the revenue page
 * treats every spent credit as if it were bought at the recharge rate; these
 * totals show how much of that was real cash.
 */
export async function getCashAndComplimentaryTotals(options?: { startDate?: Date; endDate?: Date }) {
  const start = options?.startDate ?? null, end = options?.endDate ?? null;
  const [ledger] = (await db.execute(sql`
    SELECT
      COALESCE(SUM(amount_paid) FILTER (WHERE type = 'recharge'), 0) AS recharge_cash_inr,
      COALESCE(SUM(amount) FILTER (WHERE type = 'recharge'), 0) AS recharge_credits,
      COALESCE(SUM(amount) FILTER (WHERE type = 'subscription' AND reference_type = 'subscription_grant'), 0) AS plan_credits,
      COALESCE(SUM(amount) FILTER (WHERE type = 'bonus'), 0) AS bonus_credits,
      COALESCE(SUM(amount) FILTER (WHERE type = 'subscription' AND reference_type = 'admin_plan_grant'), 0) AS admin_plan_credits
    FROM wallet_transactions
    WHERE (${start}::timestamp IS NULL OR created_at >= ${start}::timestamp)
      AND (${end}::timestamp IS NULL OR created_at <= ${end}::timestamp)`)).rows as Record<string, string>[];
  const [charges] = (await db.execute(sql`
    SELECT COALESCE(SUM(amount_paise - COALESCE(refund_amount_paise, 0)), 0) / 100.0 AS subscription_cash_inr
    FROM subscription_charges
    WHERE (${start}::timestamptz IS NULL OR paid_at >= ${start}::timestamptz)
      AND (${end}::timestamptz IS NULL OR paid_at <= ${end}::timestamptz)`)).rows as Record<string, string>[];
  const n = (value: unknown) => Number(value) || 0;
  const rechargeCashINR = n(ledger?.recharge_cash_inr), subscriptionCashINR = n(charges?.subscription_cash_inr);
  return {
    cashCollectedINR: Math.round((rechargeCashINR + subscriptionCashINR) * 100) / 100,
    rechargeCashINR, subscriptionCashINR,
    paidCreditsIssued: n(ledger?.recharge_credits) + n(ledger?.plan_credits),
    complimentaryCreditsIssued: n(ledger?.bonus_credits) + n(ledger?.admin_plan_credits),
  };
}

// Get daily transaction breakdown for chart (recharges + deductions per day)
export async function getDailyTransactionSummary(userId: number, days: number = 30): Promise<{
  date: string;
  credits: number;
  debits: number;
  net: number;
  transactionCount: number;
}[]> {
  const boundedDays = Math.min(Math.max(Number(days) || 30, 1), 365);
  const startDate = new Date();
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - (boundedDays - 1));

  const results = await db
    .select({
      date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
      credits: sql<string>`COALESCE(SUM(CASE WHEN type IN ('recharge', 'bonus', 'refund', 'subscription') THEN amount ELSE 0 END), 0)`,
      debits: sql<string>`COALESCE(SUM(CASE WHEN type = 'deduction' THEN ABS(amount) ELSE 0 END), 0)`,
      transactionCount: sql<number>`count(*)::int`,
    })
    .from(walletTransactionsTable)
    .where(and(
      eq(walletTransactionsTable.organizationId, await resolveBillingOrganization(userId)),
      gte(walletTransactionsTable.createdAt, startDate)
    ))
    .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`);

  return results.map((r: { date: string; credits: string; debits: string; transactionCount: number }) => ({
    date: r.date,
    credits: parseFloat(r.credits || "0"),
    debits: parseFloat(r.debits || "0"),
    net: parseFloat(r.credits || "0") - parseFloat(r.debits || "0"),
    transactionCount: r.transactionCount,
  }));
}

// Get deduction totals grouped by category (for analytics page)
export async function getDeductionSumByCategory(userId: number, startDate?: Date, endDate?: Date): Promise<{
  category: string;
  totalCredits: number;
  transactionCount: number;
}[]> {
  const conditions = [
    eq(walletTransactionsTable.organizationId, await resolveBillingOrganization(userId)),
    eq(walletTransactionsTable.type, 'deduction'),
  ];
  if (startDate) conditions.push(gte(walletTransactionsTable.createdAt, startDate));
  if (endDate) conditions.push(lte(walletTransactionsTable.createdAt, endDate));

  const results = await db
    .select({
      category: walletTransactionsTable.category,
      totalCredits: sql<string>`COALESCE(SUM(ABS(amount)), 0)`,
      transactionCount: sql<number>`count(*)::int`,
    })
    .from(walletTransactionsTable)
    .where(and(...conditions))
    .groupBy(walletTransactionsTable.category)
    .orderBy(sql`SUM(ABS(amount)) DESC`);

  return results.map((r: { category: string | null; totalCredits: string; transactionCount: number }) => ({
    category: r.category || 'general',
    totalCredits: parseFloat(r.totalCredits || "0"),
    transactionCount: r.transactionCount,
  }));
}
