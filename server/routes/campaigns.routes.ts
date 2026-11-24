import creativeIntelligenceRoutes from './creativeIntelligence.routes.js';
import { getPaidAdAccounts, discoverAccounts, refreshAccount, getProviderGoogleDiagnostics, getManagedGoogleDiagnostics, getProviderMetaDiagnostics, getManagedMetaDiagnostics } from '../controllers/paidAdAccountsController.js';
/**
 * Campaign Routes Module
 * Handles campaign management, analytics, and performance marketing
 */

import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { requireCredits } from '../middleware/creditCheck.js';
import { validateBody, validateParams } from '../middleware/validation.js';
import {
  createCampaignSchema,
  saveCampaignPlanBodySchema,
  regenerateCampaignPlanBodySchema,
  aiCampaignPlanRequestSchema,
  budgetPlanSchema,
  campaignPerformanceGenerateSchema,
} from '../middleware/schemas.js';
import {
  getCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  archiveCampaign,
  saveCampaignPlan,
  regenerateCampaignPlan,
  requestAICampaignPlan,
} from '../controllers/campaignController.js';
import {
  getCampaignAnalytics,
  getCampaignPerformanceTrends,
  getTopHooksAndHashtags,
  compareCampaigns,
  startAnalyticsPolling,
  stopAnalyticsPolling,
  fetchMetricsNow,
  getAdSetMetrics,
  getAdsDashboard,
  getCampaignTrends,
  compareAdCampaigns,
} from '../controllers/campaignAnalyticsController.js';
import {
  generateBudgetPlan,
  generateCampaign as generatePMCampaign,
  getBudgetPlans,
  getCampaigns as getPMCampaigns,
  getCampaignById as getPMCampaignById,
  getMetaPages,
  getMetaCampaigns,
  getMetaCampaignAdsets,
  getMetaCampaignInsights,
  getMetaAccountInsights,
  getCachedCampaigns,
  getCachedAdsets,
  refreshPerformanceCache,
  clearPerformanceCache,
  pauseMetaCampaign,
  resumeMetaCampaign,
  deleteMetaCampaign,
  pauseMetaAdset,
  resumeMetaAdset,
  deleteMetaAdset,
  pauseMetaAd,
  resumeMetaAd,
  deleteMetaAd,
} from '../controllers/performanceMarketingController.js';
import {
  autonomousCampaignSchema,
  createAutonomousCampaign,
  createImprovedAdCampaign,
  getProviderCampaignAdPerformance,
  getAutonomousCampaign,
  getCampaignAdPerformance,
  getCampaignAutonomyPolicy,
  inferAdObjective,
  importProviderCampaign,
  listAutonomousCampaigns,
  resumeAdTarget,
  recommendationStatusSchema,
  campaignAutonomyPolicySchema,
  updateAdRecommendation,
  updateCampaignAutonomyPolicy,
} from '../controllers/autonomousAdsController.js';

const router = Router();

const databaseIdParams = z.object({ id: z.string().regex(/^\d+$/) });
const recommendationParams = databaseIdParams.extend({ recommendationId: z.string().regex(/^\d+$/) });
const targetResumeParams = databaseIdParams.extend({
  targetType: z.enum(['campaign', 'ad_set', 'ad_group', 'ad']),
  targetId: z.string().trim().min(1).max(255),
});
const targetResumeBody = z.object({ platform: z.enum(['meta', 'google']) }).strict();
const metaIdParams = z.object({ id: z.string().regex(/^\d{1,30}$/, 'Invalid Meta entity ID') });
const metaCampaignParams = z.object({ campaignId: z.string().regex(/^\d{1,30}$/, 'Invalid Meta campaign ID') });
const providerCampaignParams = z.object({
  platform: z.enum(['meta', 'google']),
  campaignId: z.string().regex(/^\d{1,30}$/, 'Invalid provider campaign ID'),
});
const providerCampaignImportSchema = z.object({
  platform: z.enum(['meta', 'google']),
  platformCampaignId: z.string().regex(/^\d{1,30}$/, 'Invalid provider campaign ID'),
  accountId: z.number().int().positive().optional(),
}).strict();
const cacheRefreshSchema = z.object({
  platform: z.literal('meta').optional(),
  datePreset: z.enum(['today', 'yesterday', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d', 'this_month', 'last_month', 'maximum']).optional(),
}).strict();
const compareCampaignsSchema = z.object({
  campaignIds: z.array(z.number().int().positive()).min(2).max(5)
    .refine((ids) => new Set(ids).size === ids.length, 'Campaign IDs must be unique'),
}).strict();
const compareAdCampaignsSchema = compareCampaignsSchema.extend({
  period: z.enum(['7d', '30d', '90d']).optional(),
}).strict();
const fetchMetricsSchema = z.object({
  dateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateStop: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict().refine((value) => Boolean(value.dateStart) === Boolean(value.dateStop), {
  message: 'dateStart and dateStop must be provided together',
});
const inferObjectiveSchema = z.object({
  brief: z.string().max(100_000).optional(),
  contentStudioContext: z.string().max(100_000).optional(),
  conversationContext: z.string().max(100_000).optional(),
}).strict().refine((value) => Object.values(value).some((item) => item?.trim()), {
  message: 'At least one campaign context source is required',
});

router.use(authenticateToken);
router.use('/creative-intelligence', requireModuleAccess('performance_marketing'), creativeIntelligenceRoutes);
router.use('/accounts', requireModuleAccess('performance_marketing'));
router.get('/accounts', getPaidAdAccounts);
router.post('/accounts/discover', validateBody(z.object({platform:z.enum(['meta','google'])}).strict()), discoverAccounts);
router.post('/accounts/:id/refresh', validateParams(databaseIdParams), refreshAccount);
router.get('/accounts/:id/google-diagnostics/:campaignId', validateParams(z.object({id:z.coerce.number().int().positive(),campaignId:z.string().regex(/^\d+$/)})), getProviderGoogleDiagnostics);
router.get('/accounts/:id/meta-diagnostics/:campaignId', validateParams(z.object({id:z.coerce.number().int().positive(),campaignId:z.string().regex(/^\d+$/)})), getProviderMetaDiagnostics);

// ─── Supported Autonomous Ads Workflow ─────────────────────────────────────────
// These routes precede /:id so "autonomous" cannot be captured as an ID.
router.use('/autonomous', requireModuleAccess('performance_marketing'));
router.post('/autonomous/infer-objective', validateBody(inferObjectiveSchema), inferAdObjective);
router.get('/autonomous', listAutonomousCampaigns);
router.post('/autonomous', validateBody(autonomousCampaignSchema), createAutonomousCampaign);
router.post('/autonomous/import-provider', validateBody(providerCampaignImportSchema), importProviderCampaign);
router.get('/autonomous/:id', validateParams(databaseIdParams), getAutonomousCampaign);
router.get('/autonomous/:id/policy', validateParams(databaseIdParams), getCampaignAutonomyPolicy);
router.put('/autonomous/:id/policy', validateParams(databaseIdParams), validateBody(campaignAutonomyPolicySchema), updateCampaignAutonomyPolicy);
router.get('/autonomous/:id/performance', validateParams(databaseIdParams), getCampaignAdPerformance);
router.get('/autonomous/:id/google-diagnostics', validateParams(databaseIdParams), getManagedGoogleDiagnostics);
router.get('/autonomous/:id/meta-diagnostics', validateParams(databaseIdParams), getManagedMetaDiagnostics);
router.patch('/autonomous/:id/recommendations/:recommendationId', validateParams(recommendationParams), validateBody(recommendationStatusSchema), updateAdRecommendation);
router.post('/autonomous/:id/improved-version', validateParams(databaseIdParams), createImprovedAdCampaign);
router.post('/autonomous/:id/targets/:targetType/:targetId/resume', validateParams(targetResumeParams), validateBody(targetResumeBody), resumeAdTarget);

router.use(
  ['/analytics', '/performance', '/meta'],
  requireModuleAccess('performance_marketing'),
);

// ─── Campaign Analytics ─────────────────────────────────────────────────────────
router.get('/analytics/dashboard', getAdsDashboard);
router.get('/analytics/provider/:platform/:campaignId', validateParams(providerCampaignParams), getProviderCampaignAdPerformance);
router.get('/analytics/:id', getCampaignAnalytics);
router.get('/analytics/:id/trends', getCampaignPerformanceTrends);
router.get('/analytics/:id/hooks', getTopHooksAndHashtags);
router.post('/analytics/compare', validateBody(compareCampaignsSchema), compareCampaigns);
router.post('/analytics/polling/start', startAnalyticsPolling);
router.post('/analytics/polling/stop', stopAnalyticsPolling);
router.post('/analytics/fetch-now', validateBody(fetchMetricsSchema), fetchMetricsNow);
router.get('/analytics/adsets/:campaignId', getAdSetMetrics);
router.get('/analytics/trends/:campaignId', getCampaignTrends);
router.post('/analytics/compare-ads', validateBody(compareAdCampaignsSchema), compareAdCampaigns);

// ─── Performance Marketing ──────────────────────────────────────────────────────
router.post('/performance/budget-plan', requireCredits, validateBody(budgetPlanSchema), generateBudgetPlan);
router.post('/performance/generate', requireCredits, validateBody(campaignPerformanceGenerateSchema), generatePMCampaign);
router.post('/performance/optimize', (_req, res) => {
  res.status(410).json({
    error: 'Direct optimization requests are retired. Ad Performance uses stored deterministic evaluations and reviewed recommendations.',
    code: 'STORED_AD_PERFORMANCE_ONLY',
  });
});
router.get('/performance/budget-plans', getBudgetPlans);
router.get('/performance/campaigns', getPMCampaigns);
router.get('/performance/campaigns/:id', validateParams(databaseIdParams), getPMCampaignById);
router.post('/performance/campaigns/:id/publish', validateParams(databaseIdParams), (_req, res) => {
  res.status(410).json({
    error: 'Direct Meta publishing is retired. Review and publish through POST /api/campaigns/autonomous.',
  });
});

// ─── Meta Ads ───────────────────────────────────────────────────────────────────
router.get('/meta/pages', getMetaPages);
router.get('/meta/campaigns', getMetaCampaigns);
router.get('/meta/campaigns/:campaignId/adsets', validateParams(metaCampaignParams), getMetaCampaignAdsets);
router.get('/meta/campaigns/:campaignId/insights', validateParams(metaCampaignParams), getMetaCampaignInsights);
router.get('/meta/account/insights', getMetaAccountInsights);
router.get('/meta/cache/campaigns', getCachedCampaigns);
router.get('/meta/cache/campaigns/:campaignId/adsets', validateParams(metaCampaignParams), getCachedAdsets);
router.post('/meta/cache/refresh', validateBody(cacheRefreshSchema), refreshPerformanceCache);
router.post('/meta/cache/clear', clearPerformanceCache);

// ─── Meta Campaign Controls ─────────────────────────────────────────────────────
router.post('/meta/campaigns/:id/pause', validateParams(metaIdParams), pauseMetaCampaign);
router.post('/meta/campaigns/:id/resume', validateParams(metaIdParams), resumeMetaCampaign);
router.delete('/meta/campaigns/:id', validateParams(metaIdParams), deleteMetaCampaign);
router.post('/meta/adsets/:id/pause', validateParams(metaIdParams), pauseMetaAdset);
router.post('/meta/adsets/:id/resume', validateParams(metaIdParams), resumeMetaAdset);
router.delete('/meta/adsets/:id', validateParams(metaIdParams), deleteMetaAdset);
router.post('/meta/ads/:id/pause', validateParams(metaIdParams), pauseMetaAd);
router.post('/meta/ads/:id/resume', validateParams(metaIdParams), resumeMetaAd);
router.delete('/meta/ads/:id', validateParams(metaIdParams), deleteMetaAd);

// ─── General Campaign CRUD ─────────────────────────────────────────────────────
// Keep the broad /:id route last so it cannot capture supported named routes.
router.use(requireModuleAccess('campaigns'));
router.get('/', getCampaigns);
router.get('/:id', validateParams(databaseIdParams), getCampaign);
router.post('/', requireCredits, validateBody(createCampaignSchema), createCampaign);
router.put('/:id', validateParams(databaseIdParams), validateBody(createCampaignSchema.partial()), updateCampaign);
router.patch('/:id', validateParams(databaseIdParams), validateBody(createCampaignSchema.partial()), updateCampaign);
router.delete('/:id', validateParams(databaseIdParams), archiveCampaign);
router.post('/:id/plan', validateParams(databaseIdParams), requireCredits, validateBody(saveCampaignPlanBodySchema), saveCampaignPlan);
router.post('/:id/regenerate-plan', validateParams(databaseIdParams), requireCredits, validateBody(regenerateCampaignPlanBodySchema), regenerateCampaignPlan);
router.post('/:id/ai-plan', validateParams(databaseIdParams), requireCredits, validateBody(aiCampaignPlanRequestSchema), requestAICampaignPlan);

export default router;
