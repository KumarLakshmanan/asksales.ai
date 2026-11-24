import { withSystemScope } from '../tenancy/businessContext.js';
import { BillingOrganizationError } from '../services/billing/organizations.js';
/**
 * Wallet Routes Module
 * User wallet, billing, and recharge endpoints
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { validateBody } from '../middleware/validation.js';
import { createRechargeOrderSchema, verifyRechargePaymentSchema } from '../middleware/schemas.js';
import { apiRateLimiter } from '../middleware/rateLimiter.js';
import { requireActiveSubscriberForTopUp } from './subscriptions.routes.js';
import {
  getWallet,
  getTransactions,
  getUsageBreakdown,
  getEventLogs,
  createRechargeOrder,
  verifyRechargePayment,
  getRazorpayKey,
  getDailyUsage,
  getDailyTransactions,
  getDeductionSummary,
  getProviderUsage,
  getCategoryUsage,
  getEventLogsByType,
  getDrilldownReferences,
  getDrilldownProviders,
  getDrilldownDetails,
  getApifyRunDetails,
  getCampaignSpending,
} from '../controllers/walletController.js';

const router = Router();

// All routes require authentication
router.use(authenticateToken, requireModuleAccess('billing'));
// Aggregate ledger queries are constrained by the already-authorized organization.
// Business provider receipts retain their ordinary business RLS scope.
router.use(async(req,res,next)=>{
  if(req.method!=='GET'||req.path==='/drilldown/apify-details'||req.path==='/razorpay-key') return next();
  try {
    const summaryPaths=['/','/usage','/daily-usage','/daily-transactions','/deduction-summary','/provider-usage','/category-usage','/campaign-spending'];
    if(summaryPaths.includes(req.path)) return withSystemScope('Read authorized organization billing totals',next);
    return next();
  } catch(error) {
    if(error instanceof BillingOrganizationError) return res.status(error.status).json({error:error.message,code:error.code});
    return next(error);
  }
});

// Wallet balance
router.get('/', getWallet);

// Transaction history
router.get('/transactions', getTransactions);

// Credit usage breakdown
router.get('/usage', getUsageBreakdown);

// Event logs
router.get('/event-logs', getEventLogs);

// Daily credit usage (chart data from credit_event_logs)
router.get('/daily-usage', getDailyUsage);

// Daily transaction activity chart data (from wallet_transactions - shows recharges + deductions)
router.get('/daily-transactions', getDailyTransactions);

// Deduction totals by category (from wallet_transactions, for analytics page)
router.get('/deduction-summary', getDeductionSummary);

// Per-provider credit usage breakdown
router.get('/provider-usage', getProviderUsage);

// Per-category credit usage with drill-down data
router.get('/category-usage', getCategoryUsage);

// Campaign-wise spending (grouped by reference type)
router.get('/campaign-spending', getCampaignSpending);

// Drill-down: event logs by specific event type
router.get('/event-logs/:eventKey', getEventLogsByType);

// Drill-down transaction grouping
router.get('/drilldown/references', getDrilldownReferences);
router.get('/drilldown/providers', getDrilldownProviders);
router.get('/drilldown/details', getDrilldownDetails);
router.get('/drilldown/apify-details', getApifyRunDetails);

// Razorpay public key
router.get('/razorpay-key', getRazorpayKey);

// Recharge
router.post('/recharge/create-order', apiRateLimiter, requireActiveSubscriberForTopUp, validateBody(createRechargeOrderSchema), createRechargeOrder);
router.post('/recharge/verify', apiRateLimiter, validateBody(verifyRechargePaymentSchema), verifyRechargePayment);

export default router;
