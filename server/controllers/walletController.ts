import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { BillingOrganizationError, getBillingOrganization, requireBillingRole } from '../services/billing/organizations.js';
/**
 * Wallet Controller
 * Handles wallet balance, recharge, and transactions for users
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getOrCreateWallet } from '../models/wallets/functions.js';
import { getTransactionsByUserId, getTransactionSummary, getDailyTransactionSummary, getDeductionSumByCategory } from '../models/walletTransactions/functions.js';
import {
  getCreditEventLogsByUser,
  getCreditUsageSummary,
  getDailyCreditUsage,
  getProviderCreditSummary,
  getCategoryCreditSummary,
  getCreditEventsByReference,
  getCreditEventProviderBreakdown,
  getCreditEventDetails,
  getCampaignWiseSpending,
} from '../models/creditEventLogs/functions.js';
import { getRechargeRate, getAllPricing } from '../models/creditPricing/functions.js';
import { creditService, PaymentClaimError } from '../services/CreditService.js';
import { razorpayService } from '../services/RazorpayService.js';
import { RechargeOriginError } from '../services/walletRechargeOrigins.js';
import { NotificationService } from '../services/NotificationService.js';

// GET /api/wallet - Get wallet balance and summary
export async function getWallet(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const wallet = await getOrCreateWallet(userId);
    const rechargeRate = await getRechargeRate();
    const summary = await getTransactionSummary(userId);
    const organization = await getBillingOrganization(userId, wallet.organizationId);

    return res.json({
      success: true,
      data: {
        organization,
        balance: parseFloat(wallet.balance as string),
        totalCreditsAdded: parseFloat(wallet.totalCreditsAdded as string),
        totalCreditsUsed: parseFloat(wallet.totalCreditsUsed as string),
        rechargeRate,
        summary,
      },
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get wallet');
    return res.status(500).json({ error: "Unable to retrieve your wallet. Please try again." });
  }
}

// GET /api/wallet/transactions - Paginated transaction history
export async function getTransactions(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { limit = '50', offset = '0', type, category, startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    
    const result = await getTransactionsByUserId(userId, {
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      type: type as string | undefined,
      category: category as string | undefined,
      startDate: start,
      endDate: end,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get transactions');
    return res.status(500).json({ error: "Unable to retrieve your transactions. Please try again." });
  }
}

// GET /api/wallet/usage - Credit usage breakdown
export async function getUsageBreakdown(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const usageSummary = await getCreditUsageSummary(userId, start, end);
    const pricing = await getAllPricing();

    return res.json({
      success: true,
      data: {
        usage: usageSummary,
        // Only prices that are charged today; disabled rows would mislead.
        // WhatsApp margins are internal pricing inputs, not customer prices.
        pricing: pricing.filter(p => p.isActive && p.category !== 'whatsapp_margin').map(p => ({
          eventKey: p.eventKey,
          name: p.name,
          category: p.category,
          creditsPerUnit: parseFloat(p.creditsPerUnit as string),
          unitLabel: p.unitLabel,
        })),
      },
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get usage breakdown');
    return res.status(500).json({ error: "Unable to retrieve your usage breakdown. Please try again." });
  }
}

// GET /api/wallet/event-logs - Detailed event logs
export async function getEventLogs(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { limit = '50', offset = '0', eventKey, apiProvider, startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    
    const result = await getCreditEventLogsByUser(userId, {
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      eventKey: eventKey as string | undefined,
      apiProvider: apiProvider as string | undefined,
      startDate: start,
      endDate: end,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get event logs');
    return res.status(500).json({ error: "Unable to retrieve your event logs. Please try again." });
  }
}

// POST /api/wallet/recharge/create-order - Create Razorpay order
export async function createRechargeOrder(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const organization = await requireBillingRole(userId);
    const { amount } = req.body;
    const normalizedAmount = Math.round(Number(amount) * 100) / 100;
    
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 1 || normalizedAmount > 100000) {
      return res.status(400).json({ error: "Invalid recharge amount" });
    }

    const rechargeRate = await getRechargeRate();
    if (!Number.isFinite(rechargeRate) || rechargeRate <= 0) {
      logger.error({ userId, rechargeRate }, 'Recharge pricing is not configured');
      return res.status(503).json({ error: 'Recharge pricing is unavailable. Please contact admin.' });
    }
    const creditsToReceive = Math.round(normalizedAmount * rechargeRate * 100) / 100;

    const order = await razorpayService.createOrder({
      amount: normalizedAmount,
      recharge: { userId, organizationId: organization.id, credits: creditsToReceive, rechargeRate },
      receipt: `wallet_${userId}_${Date.now()}`,
      notes: {
        userId: userId.toString(),
        organizationId: String(organization.id),
        credits: creditsToReceive.toString(),
        rechargeRate: rechargeRate.toString(),
        type: 'wallet_recharge',
      },
    });

    if (!order) {
      return res.status(500).json({ error: "Unable to create the payment order. Please try again." });
    }

    return res.json({
      success: true,
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: order.keyId,
        creditsToReceive,
        rechargeRate,
      },
    });
  } catch (error) {
    if (error instanceof RechargeOriginError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof BillingOrganizationError) return res.status(error.status).json({ error: error.message, code: error.code });
    logger.error({ err: error, userId }, 'Failed to create recharge order');
    return res.status(500).json({ error: "Unable to create the payment order. Please try again." });
  }
}

// POST /api/wallet/recharge/verify - Verify payment and add credits
export async function verifyRechargePayment(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const organization = await requireBillingRole(userId);
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every(value => typeof value === 'string' && value.length > 0)) {
      return res.status(400).json({ error: "Missing payment verification data" });
    }

    // Capture once. A known order never falls back to a newly selected key.
    const context = await razorpayService.getRechargeVerificationContext(razorpay_order_id, userId, organization.id);
    const isValid = context.verifyPayment(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!isValid) {
      logger.warn({ userId, orderId: razorpay_order_id }, 'Invalid payment signature');
      return res.status(400).json({ error: "Payment verification failed" });
    }

    // The browser is not a source of truth for money. Fetch the signed order
    // and captured payment directly from Razorpay and bind both to this user.
    const [payment, order] = await Promise.all([
      context.getPaymentDetails(razorpay_payment_id),
      context.getOrderDetails(razorpay_order_id),
    ]);
    if (!payment || !order) {
      return res.status(502).json({ error: 'Unable to confirm payment details with Razorpay' });
    }
    const amountINR = order.amount / 100;
    const quotedCredits = Number(order.notes?.credits);
    const quotedRate = Number(order.notes?.rechargeRate) || (amountINR > 0 ? quotedCredits / amountINR : 0);
    const paymentMatchesOrder = order.id === razorpay_order_id && payment.id === razorpay_payment_id
      && payment.order_id === order.id
      && payment.amount === order.amount
      && payment.currency === order.currency
      && payment.currency === 'INR';
    const paymentIsSettled = payment.captured === true
      && payment.status === 'captured'
      && order.status === 'paid'
      && order.amount_due === 0;
    const quotedOrganizationId = order.notes?.organizationId ? Number(order.notes.organizationId) : Number((await db.execute(sql`SELECT id FROM billing_organizations WHERE default_for_user_id=${userId}`)).rows[0]?.id);
    const orderBelongsToUser = quotedOrganizationId === organization.id && order.notes?.type === 'wallet_recharge'
      && order.notes?.userId === String(userId)
      && typeof order.receipt === 'string'
      && order.receipt.startsWith(`wallet_${userId}_`);
    const quoteIsValid = Number.isFinite(amountINR) && amountINR >= 1 && amountINR <= 100000
      && Number.isFinite(quotedCredits) && quotedCredits > 0
      && Number.isFinite(quotedRate) && quotedRate > 0
      && Math.abs(quotedCredits - (amountINR * quotedRate)) < 0.01;
    const originMatchesQuote = !context.origin || (context.origin.amountPaise === order.amount
      && context.origin.currency === order.currency && context.origin.credits === quotedCredits
      && context.origin.rechargeRate === quotedRate);
    if (!paymentMatchesOrder || !orderBelongsToUser || !quoteIsValid || !originMatchesQuote) {
      logger.warn({ userId, orderId: razorpay_order_id, paymentId: razorpay_payment_id }, 'Recharge payment details did not match the server quote');
      return res.status(400).json({ error: 'Payment details do not match this recharge order' });
    }
    if (!paymentIsSettled) {
      logger.info({ userId, orderId: razorpay_order_id, paymentId: razorpay_payment_id, paymentStatus: payment.status, orderStatus: order.status }, 'Recharge payment is awaiting capture');
      return res.status(409).json({ error: 'Payment is awaiting capture. Retry verification in a moment.' });
    }

    const result = await creditService.rechargeCredits(userId, {
      amountINR,
      paymentId: razorpay_payment_id,
      paymentOrderId: razorpay_order_id,
      rechargeRate: quotedRate,
      creditsToAdd: quotedCredits,
      currency: payment.currency,
    });

    // Save in-app notification (non-blocking)
    if (!result.alreadyProcessed) {
      void NotificationService.creditsAdded(userId, result.creditsAdded, result.newBalance);
    }

    return res.json({
      success: true,
      data: {
        creditsAdded: result.creditsAdded,
        newBalance: result.newBalance,
        paymentId: razorpay_payment_id,
        alreadyProcessed: result.alreadyProcessed,
      },
    });
  } catch (error) {
    if (error instanceof RechargeOriginError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof BillingOrganizationError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof PaymentClaimError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.error({ err: error, userId }, 'Failed to verify recharge payment');
    return res.status(500).json({ error: "Unable to verify the payment. Please try again." });
  }
}

// GET /api/wallet/razorpay-key - Get Razorpay public key
export async function getRazorpayKey(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const keyId = await razorpayService.getPublicKey();
    const isConfigured = await razorpayService.isConfigured();

    return res.json({
      success: true,
      data: { keyId, isConfigured },
    });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error) {
    return res.status(500).json({ error: "Unable to retrieve payment configuration. Please try again." });
  }
}

// GET /api/wallet/deduction-summary - Credit deduction totals by category (from wallet_transactions)
export async function getDeductionSummary(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const data = await getDeductionSumByCategory(userId, start, end);
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get deduction summary');
    return res.status(500).json({ error: "Unable to retrieve your spending summary. Please try again." });
  }
}

// GET /api/wallet/daily-transactions - Daily transaction chart data (recharges + deductions from wallet_transactions)
export async function getDailyTransactions(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { days = '30' } = req.query;
    const data = await getDailyTransactionSummary(userId, parseInt(days as string));
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get daily transaction summary');
    return res.status(500).json({ error: "Unable to retrieve your daily transaction data. Please try again." });
  }
}

// GET /api/wallet/daily-usage - Daily credit usage chart data
export async function getDailyUsage(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { days = '30' } = req.query;
    const data = await getDailyCreditUsage(userId, parseInt(days as string));
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get daily credit usage');
    return res.status(500).json({ error: "Unable to retrieve your daily usage data. Please try again." });
  }
}

// GET /api/wallet/provider-usage - Credit usage by API provider
export async function getProviderUsage(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const data = await getProviderCreditSummary(userId, start, end);
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get provider usage');
    return res.status(500).json({ error: "Unable to retrieve your provider usage data. Please try again." });
  }
}

// GET /api/wallet/category-usage - Detailed credit usage by category with drill-down
export async function getCategoryUsage(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const data = await getCategoryCreditSummary(userId, start, end);
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get category usage');
    return res.status(500).json({ error: "Unable to retrieve your category usage data. Please try again." });
  }
}

// GET /api/wallet/event-logs/:eventKey - Drill-down: specific event type logs
export async function getEventLogsByType(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { eventKey } = req.params;
    const { limit = '50', offset = '0', startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const result = await getCreditEventLogsByUser(userId, {
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      eventKey,
      startDate: start,
      endDate: end,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get event logs by type');
    return res.status(500).json({ error: "Unable to retrieve your event logs. Please try again." });
  }
}

// GET /api/wallet/drilldown/references - Level 1: Group transactions by reference (chat/thread/lead)
export async function getDrilldownReferences(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { limit = '50', offset = '0', startDate, endDate, apiProvider, referenceType } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const data = await getCreditEventsByReference(userId, {
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      startDate: start,
      endDate: end,
      apiProvider: apiProvider as string | undefined,
      referenceType: referenceType as string | undefined,
    });

    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get drilldown references');
    return res.status(500).json({ error: "Unable to retrieve grouped transactions." });
  }
}

// GET /api/wallet/drilldown/providers - Level 2: Provider breakdown for a reference
export async function getDrilldownProviders(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { referenceType, referenceId, startDate, endDate } = req.query;
    if (!referenceType || !referenceId) {
      return res.status(400).json({ error: "referenceType and referenceId are required" });
    }
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const data = await getCreditEventProviderBreakdown(
      userId,
      referenceType as string,
      referenceId as string,
      { startDate: start, endDate: end }
    );

    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get drilldown providers');
    return res.status(500).json({ error: "Unable to retrieve provider breakdown." });
  }
}

// GET /api/wallet/drilldown/details - Level 3: Individual event logs for reference + provider
export async function getDrilldownDetails(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { referenceType, referenceId, apiProvider, limit = '50', offset = '0' } = req.query;
    if (!referenceType || !referenceId) {
      return res.status(400).json({ error: "referenceType and referenceId are required" });
    }

    const data = await getCreditEventDetails(
      userId,
      referenceType as string,
      referenceId as string,
      apiProvider as string | undefined,
      {
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      }
    );

    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get drilldown details');
    return res.status(500).json({ error: "Unable to retrieve event details." });
  }
}

// GET /api/wallet/drilldown/apify-details - Apify run details from apify_usages table
export async function getApifyRunDetails(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { runId, referenceId, referenceType } = req.query;

    const { getApifyUsagesByRunId, getApifyUsagesByThreadId } = await import('../models/apifyUsages/functions.js');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let usages: any[] = [];
    if (runId) {
      usages = await getApifyUsagesByRunId(userId, runId as string);
    } else if (referenceType === 'apify_run' && referenceId) {
      usages = await getApifyUsagesByRunId(userId, referenceId as string);
    } else if (referenceType === 'chat_thread' && referenceId) {
      usages = await getApifyUsagesByThreadId(userId, parseInt(referenceId as string));
    }

    return res.json({ success: true, data: usages });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get Apify run details');
    return res.status(500).json({ error: "Unable to retrieve Apify details." });
  }
}

// GET /api/wallet/campaign-spending - Spending grouped by campaign/reference type
export async function getCampaignSpending(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const data = await getCampaignWiseSpending(userId, { startDate: start, endDate: end });
    return res.json({ success: true, data });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get campaign spending');
    return res.status(500).json({ error: "Unable to retrieve campaign spending data." });
  }
}
