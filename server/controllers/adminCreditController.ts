/**
 * Admin Credit Pricing Controller
 * Thin wrappers around `adminUserService` credit / wallet functions.
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getUsdToInrRate, roundCurrency, usdCentsToInr } from '../utils/currency.js';
import {
  getAllPricing,
  updatePricing,
  bulkUpdatePricing,
  seedDefaultPricing,
} from '../models/creditPricing/functions.js';
import {
  getGlobalCreditSummary,
  getGlobalDailyCreditUsage,
  getGlobalProviderCreditSummary,
  getUserCreditAnalyticsForAdmin,
} from '../models/creditEventLogs/functions.js';
import {
  addCreditsToUser,
  getEnrichedCreditEventLogs,
  getRazorpayIntegration,
  getUserWalletDetail,
  listAllWallets,
  listTopCreditUsers,
  runService,
  saveRazorpayIntegration,
  testRazorpayConnection,
} from '../services/adminUserService.js';
import { parseCreditPricingUpdates } from '../utils/pricingValidation.js';
import { adminActorId as getAdminActorId } from '../utils/requestUserIds.js';

// GET /api/admin/credit-pricing
export async function getCreditPricing(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const pricing = await getAllPricing();
    return { success: true, data: pricing };
  });
  return res.status(status).json(body);
}

// PUT /api/admin/credit-pricing/:id
export async function updateCreditPricing(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseInt(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      const err = new Error('Invalid ID') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      const err = new Error('A pricing object is required') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const { creditsPerUnit, isActive, name, description } = req.body;
    if (Object.keys(req.body).some((key) => !['creditsPerUnit', 'isActive', 'name', 'description'].includes(key))) {
      const err = new Error('The request contains unsupported pricing fields') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    if (creditsPerUnit !== undefined && (!Number.isFinite(Number(creditsPerUnit)) || Number(creditsPerUnit) < 0 || Number(creditsPerUnit) > 100_000_000)) {
      const err = new Error('Credits per unit must be between 0 and 100,000,000') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      const err = new Error('isActive must be a boolean') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 255)) {
      const err = new Error('Name must contain between 1 and 255 characters') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 2_000)) {
      const err = new Error('Description must contain at most 2,000 characters') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    if ([creditsPerUnit, isActive, name, description].every((value) => value === undefined)) {
      const err = new Error('At least one pricing field is required') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const updated = await updatePricing(id, {
      ...(creditsPerUnit !== undefined ? { creditsPerUnit: Number(creditsPerUnit).toFixed(2) } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(description !== undefined ? { description: typeof description === 'string' ? description.trim() || null : null } : {}),
    }, getAdminActorId(req));
    if (!updated) {
      const err = new Error('Pricing record not found') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return { success: true, data: updated };
  });
  return res.status(status).json(body);
}

// PUT /api/admin/credit-pricing/bulk
export async function bulkUpdateCreditPricing(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      const err = new Error('A pricing update object is required') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const { updates } = req.body;
    let validated: ReturnType<typeof parseCreditPricingUpdates>;
    try {
      validated = parseCreditPricingUpdates(updates);
    } catch (validationError) {
      const err = new Error(validationError instanceof Error ? validationError.message : 'Invalid pricing updates') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    await bulkUpdatePricing(validated, getAdminActorId(req));
    const pricing = await getAllPricing();
    return { success: true, data: pricing };
  });
  return res.status(status).json(body);
}

// POST /api/admin/credit-pricing/seed
export async function seedPricing(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    await seedDefaultPricing(getAdminActorId(req));
    const pricing = await getAllPricing();
    return { success: true, data: pricing };
  });
  return res.status(status).json(body);
}

// GET /api/admin/wallets
export async function getAllWallets(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const data = await listAllWallets({
      page: Number(req.query.page),
      pageSize: Number(req.query.pageSize),
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    return { success: true, data };
  });
  return res.status(status).json(body);
}

// GET /api/admin/wallets/:userId
export async function getUserWallet(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      const err = new Error('Invalid user ID') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const data = await getUserWalletDetail(userId);
    return { success: true, data };
  });
  return res.status(status).json(body);
}

// POST /api/admin/wallets/:userId/add-credits
export async function adminAddCredits(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      const err = new Error('Invalid user ID') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const { amount, reason } = req.body;
    const parsedAmount = parseFloat(amount);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      const err = new Error('Invalid amount') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const admin = req.user && 'role' in req.user && (req.user.role === 'admin' || req.user.role === 'super_admin')
      ? { id: req.user.id, email: req.user.email }
      : undefined;
    const newBalance = await addCreditsToUser(userId, parsedAmount, reason, admin);
    return { success: true, data: { newBalance } };
  });
  return res.status(status).json(body);
}

// GET /api/admin/credit-events
export async function getAdminCreditEvents(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { limit = '50', offset = '0', userId, eventKey, service, apiProvider } = req.query;
    const data = await getEnrichedCreditEventLogs({
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      userId: userId ? parseInt(userId as string) : undefined,
      eventKey: eventKey as string | undefined,
      service: service as string | undefined,
      apiProvider: apiProvider as string | undefined,
    });
    return { success: true, data };
  });
  return res.status(status).json(body);
}

// GET /api/admin/integrations/razorpay
export async function getRazorpayConfig(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const data = await getRazorpayIntegration();
    return { success: true, data };
  });
  return res.status(status).json(body);
}

// PUT /api/admin/integrations/razorpay
export async function saveRazorpayConfig(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { keyId, keySecret } = req.body;
    await saveRazorpayIntegration(keyId, keySecret);
    return { success: true, message: 'Razorpay configuration saved' };
  });
  return res.status(status).json(body);
}

// POST /api/admin/integrations/razorpay/test
export async function testRazorpayConfig(req: Request, res: Response) {
  try {
    const result = await testRazorpayConnection();
    return res.json({
      success: true,
      message: result.message,
      data: { keyId: result.publicKey },
    });
  } catch (err) {
    logger.warn({ err }, 'testRazorpayConfig failed');
    return res.status(502).json({
      success: false,
      message: 'Unable to connect to Razorpay. Please verify your API credentials.',
    });
  }
}

// GET /api/admin/credit-analytics/summary
export async function getGlobalCreditAnalytics(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const summary = await getGlobalCreditSummary({ startDate: start, endDate: end });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalCredits = summary.reduce((s: any, r: any) => s + r.totalCredits, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalEvents = summary.reduce((s: any, r: any) => s + r.eventCount, 0);
    const usdToInrRate = getUsdToInrRate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summaryWithCosts = summary.map((item: any) => ({
      ...item,
      totalApiCostINR: roundCurrency(usdCentsToInr(item.totalApiCostCents, usdToInrRate)),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalApiCostINR = summaryWithCosts.reduce((s: any, r: any) => s + r.totalApiCostINR, 0);
    return {
      success: true,
      data: {
        summary: summaryWithCosts,
        totals: { totalCredits, totalEvents, totalApiCostINR: roundCurrency(totalApiCostINR) },
      },
    };
  });
  return res.status(status).json(body);
}

// GET /api/admin/credit-analytics/daily
export async function getGlobalDailyCredits(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { days = '30' } = req.query;
    const data = await getGlobalDailyCreditUsage(parseInt(days as string));
    return { success: true, data };
  });
  return res.status(status).json(body);
}

// GET /api/admin/credit-analytics/top-users
export async function getTopCreditUsers(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { limit = '20' } = req.query;
    const data = await listTopCreditUsers(parseInt(limit as string));
    return { success: true, data };
  });
  return res.status(status).json(body);
}

// GET /api/admin/credit-analytics/providers
export async function getGlobalProviderAnalytics(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const data = await getGlobalProviderCreditSummary({ startDate: start, endDate: end });
    const usdToInrRate = getUsdToInrRate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { success: true, data: data.map((item: any) => ({
      ...item,
      totalApiCostINR: roundCurrency(usdCentsToInr(item.totalApiCostCents, usdToInrRate)),
    })) };
  });
  return res.status(status).json(body);
}

// GET /api/admin/credit-analytics/user/:userId
export async function getAdminUserCreditAnalytics(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      const err = new Error('Invalid user ID') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const { days = '30' } = req.query;
    const data = await getUserCreditAnalyticsForAdmin(userId, parseInt(days as string));
    const usdToInrRate = getUsdToInrRate();
    return { success: true, data: {
      ...data,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      providers: data.providers.map((item: any) => ({
        ...item,
        totalApiCostINR: roundCurrency(usdCentsToInr(item.totalApiCostCents, usdToInrRate)),
      })),
      totals: {
        ...data.totals,
        totalApiCostINR: roundCurrency(usdCentsToInr(data.totals.totalApiCostCents, usdToInrRate)),
      },
    } };
  });
  return res.status(status).json(body);
}
