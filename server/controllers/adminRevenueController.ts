import { Request, Response } from "express";
import { logger } from "../utils/logger.js";
import {
  getRevenueSummary,
  getDailyRevenue,
  getRevenueByEventKey,
  getRevenueTransactions,
  storedPurchaseRate,
} from "../models/creditEventLogs/functions.js";
import { getCashAndComplimentaryTotals } from "../models/walletTransactions/functions.js";
import { getRechargeRate } from "../models/creditPricing/functions.js";
import { creditsToInr, getUsdToInrRate, roundCurrency, usdCentsToInr } from "../utils/currency.js";

interface RawFinancialRow {
  totalCreditsCharged: number;
  totalApiCostCents: number;
  /** Credit value already computed per row at the purchase rate of the time. */
  grossRevenueINR?: number;
}

function parseOptionalDate(value: unknown, field: string): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${field} must be a valid date`);
  return date;
}

function parseDays(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(365, Math.max(1, Math.floor(parsed))) : 30;
}

function addFinancials<T extends RawFinancialRow>(row: T, rechargeRate: number, usdToInrRate: number) {
  // Usage rows net refunds (reversal rows are negative), so a fully refunded
  // charge contributes nothing. Rows without a stored rate use today's rate.
  const grossRevenueINR = roundCurrency(row.grossRevenueINR ?? creditsToInr(row.totalCreditsCharged, rechargeRate));
  const totalApiCostINR = roundCurrency(usdCentsToInr(row.totalApiCostCents, usdToInrRate));
  return {
    ...row,
    grossRevenueINR,
    totalApiCostINR,
    netRevenueINR: roundCurrency(grossRevenueINR - totalApiCostINR),
  };
}

function badRequest(error: unknown): error is RangeError {
  return error instanceof RangeError;
}

// GET /api/admin/revenue/summary - Revenue summary by provider
export async function getRevenueSummaryEndpoint(req: Request, res: Response) {
  try {
    const { startDate, endDate } = req.query;
    const start = parseOptionalDate(startDate, "startDate");
    const end = parseOptionalDate(endDate, "endDate");
    if (start && end && start > end) throw new RangeError("startDate must be before endDate");

    const rechargeRate = await getRechargeRate();
    const [rawProviders, cash] = await Promise.all([
      getRevenueSummary({ startDate: start, endDate: end, currentRechargeRate: rechargeRate }),
      getCashAndComplimentaryTotals({ startDate: start, endDate: end }),
    ]);
    const usdToInrRate = getUsdToInrRate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providers = rawProviders.map((row: any) => addFinancials(row, rechargeRate, usdToInrRate));

    const totalCreditsCharged = providers.reduce((s: number, r: { totalCreditsCharged: number }) => s + r.totalCreditsCharged, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalGrossRevenueINR = providers.reduce((s: any, r: any) => s + r.grossRevenueINR, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalApiCostINR = providers.reduce((s: any, r: any) => s + r.totalApiCostINR, 0);
    const totalEvents = providers.reduce((s: number, r: { eventCount: number }) => s + r.eventCount, 0);

    return res.json({
      success: true,
      data: {
        providers,
        totals: {
          totalCreditsCharged,
          totalGrossRevenueINR: roundCurrency(totalGrossRevenueINR),
          totalApiCostINR: roundCurrency(totalApiCostINR),
          totalNetRevenueINR: roundCurrency(totalGrossRevenueINR - totalApiCostINR),
          totalEvents,
          rechargeRate,
          usdToInrRate,
          ...cash,
        },
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to get revenue summary");
    return res.status(badRequest(error) ? 400 : 500).json({ success: false, error: badRequest(error) ? error.message : "Unable to retrieve revenue summary." });
  }
}

// GET /api/admin/revenue/daily - Daily revenue chart data
export async function getDailyRevenueEndpoint(req: Request, res: Response) {
  try {
    const { days = "30" } = req.query;
    const rechargeRate = await getRechargeRate();
    const rawData = await getDailyRevenue(parseDays(days), rechargeRate);
    const usdToInrRate = getUsdToInrRate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = rawData.map((row: any) => addFinancials(row, rechargeRate, usdToInrRate));
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error }, "Failed to get daily revenue");
    return res.status(500).json({ error: "Unable to retrieve daily revenue data." });
  }
}

// GET /api/admin/revenue/drill-down - Revenue by event key (optionally filtered by provider)
export async function getRevenueDrillDown(req: Request, res: Response) {
  try {
    const { apiProvider, startDate, endDate } = req.query;
    const start = parseOptionalDate(startDate, "startDate");
    const end = parseOptionalDate(endDate, "endDate");
    if (start && end && start > end) throw new RangeError("startDate must be before endDate");

    const rechargeRate = await getRechargeRate();
    const rawData = await getRevenueByEventKey({
      apiProvider: typeof apiProvider === "string" ? apiProvider : undefined,
      startDate: start,
      endDate: end,
      currentRechargeRate: rechargeRate,
    });
    const usdToInrRate = getUsdToInrRate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = rawData.map((row: any) => addFinancials(row, rechargeRate, usdToInrRate));
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error }, "Failed to get revenue drill-down");
    return res.status(badRequest(error) ? 400 : 500).json({ success: false, error: badRequest(error) ? error.message : "Unable to retrieve revenue drill-down." });
  }
}

// GET /api/admin/revenue/transactions - Individual transactions for drill-down
export async function getRevenueTransactionsEndpoint(req: Request, res: Response) {
  try {
    const { apiProvider, eventKey, startDate, endDate, limit = "50", offset = "0" } = req.query;
    const start = parseOptionalDate(startDate, "startDate");
    const end = parseOptionalDate(endDate, "endDate");
    if (start && end && start > end) throw new RangeError("startDate must be before endDate");

    const [data, rechargeRate] = await Promise.all([
      getRevenueTransactions({
        apiProvider: typeof apiProvider === "string" ? apiProvider : undefined,
        eventKey: typeof eventKey === "string" ? eventKey : undefined,
        startDate: start,
        endDate: end,
        limit: Number(limit),
        offset: Number(offset),
      }),
      getRechargeRate(),
    ]);
    const usdToInrRate = getUsdToInrRate();

    return res.json({
      success: true,
      data: data.logs.map((log) => {
        const creditsUsed = Number(log.creditsUsed);
        const apiCostCents = log.apiCostCents ?? 0;
        const rate = storedPurchaseRate(log.metadata) ?? rechargeRate;
        const financials = addFinancials({ totalCreditsCharged: creditsUsed, totalApiCostCents: apiCostCents,
          grossRevenueINR: rate > 0 ? creditsUsed / rate : 0 }, rechargeRate, usdToInrRate);
        return {
          id: log.id,
          userId: log.userId,
          eventKey: log.eventKey,
          creditsUsed,
          grossRevenueINR: financials.grossRevenueINR,
          apiCostINR: financials.totalApiCostINR,
          netRevenueINR: financials.netRevenueINR,
          apiProvider: log.apiProvider,
          service: log.service,
          description: log.description,
          createdAt: log.createdAt,
        };
      }),
      total: data.total,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to get revenue transactions");
    return res.status(badRequest(error) ? 400 : 500).json({ success: false, error: badRequest(error) ? error.message : "Unable to retrieve revenue transactions." });
  }
}
