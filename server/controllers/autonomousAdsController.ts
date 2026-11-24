import type { Request, Response } from 'express';
import { z } from 'zod';
import { autonomousAdsService } from '../services/ads/AutonomousAdsService.js';
import { inferCampaignObjective } from '../services/ads/AutonomousAdsDomain.js';
import { logger } from '../utils/logger.js';
import { ContentBrandContextError } from '../services/content/ContentBrandContextService.js';
import { adPerformanceService } from '../services/ads/AdPerformanceService.js';
import { ensureMetaCampaignPerformanceCache } from './performanceMarketingController.js';
import { businessOwnerIdOrNull as userIdFrom } from '../utils/businessOwnerId.js';

const locationSchema = z.object({
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  region: z.string().trim().max(160).optional(),
  city: z.string().trim().max(160).optional(),
  googleGeoTargetId: z.string().trim().regex(/^geoTargetConstants\/\d+$/).optional(),
  metaLocationKey: z.string().trim().max(100).optional(),
}).strict();

export const adSettingsSchema = z.object({
  defaultLifetimeBudget: z.number().finite().positive().max(10_000_000),
  currency: z.enum(['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'BRL', 'MXN', 'SGD', 'AED']),
  locations: z.array(locationSchema).max(100),
  autonomousOptimizationEnabled: z.boolean(),
  liveProviderMutationsEnabled: z.boolean().default(false),
  analyticsSyncMinutes: z.number().int().min(5).max(1440),
}).strict();

const performanceThresholdsSchema = z.object({
  targetCpl: z.number().finite().positive().optional(),
  targetCpa: z.number().finite().positive().optional(),
  targetRoas: z.number().finite().positive().optional(),
  targetCtr: z.number().finite().positive().optional(),
  targetCpc: z.number().finite().positive().optional(),
  targetCpm: z.number().finite().positive().optional(),
  targetCpe: z.number().finite().positive().optional(),
  targetEngagementRate: z.number().finite().positive().optional(),
  spendLimit: z.number().finite().positive().max(10_000_000).optional(),
}).strict();

export const adAutonomySettingsSchema = z.object({
  mode: z.enum(['off', 'shadow', 'advisory', 'live_pause']),
  notificationEmail: z.string().trim().email().max(320).nullable().optional(),
  defaultThresholds: performanceThresholdsSchema.optional(),
}).strict();

export const campaignAutonomyPolicySchema = z.object({
  enabled: z.boolean(),
  thresholds: performanceThresholdsSchema.optional(),
}).strict();

export const recommendationStatusSchema = z.object({
  status: z.enum(['open','accepted','dismissed','snoozed','implemented','outcome_measured']),
  dismissReason: z.string().trim().min(1).max(1000).optional(),
  snoozedUntil: z.string().datetime().optional(),
  implementationNote: z.string().trim().min(1).max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'dismissed' && !value.dismissReason) context.addIssue({ code: z.ZodIssueCode.custom, path: ['dismissReason'], message: 'Choose a dismissal reason.' });
  if (value.status === 'snoozed' && !value.snoozedUntil) context.addIssue({ code: z.ZodIssueCode.custom, path: ['snoozedUntil'], message: 'Choose when to show this recommendation again.' });
  if (value.status === 'implemented' && !value.implementationNote) context.addIssue({ code: z.ZodIssueCode.custom, path: ['implementationNote'], message: 'Describe the change you implemented.' });
});

const creativeSchema = z.record(z.string(), z.unknown());
const metaProviderConfigSchema = z.object({
  bidStrategy: z.enum([
    'LOWEST_COST_WITHOUT_CAP',
    'LOWEST_COST_WITH_BID_CAP',
    'COST_CAP',
    'LOWEST_COST_WITH_MIN_ROAS',
  ]),
  bidAmount: z.number().finite().positive().optional(),
  optimizationGoal: z.enum([
    'REACH',
    'IMPRESSIONS',
    'LINK_CLICKS',
    'LANDING_PAGE_VIEWS',
    'POST_ENGAGEMENT',
    'LEAD_GENERATION',
    'OFFSITE_CONVERSIONS',
    'APP_INSTALLS',
  ]),
  billingEvent: z.enum(['IMPRESSIONS', 'LINK_CLICKS', 'POST_ENGAGEMENT']),
  specialAdCategories: z.array(z.enum([
    'HOUSING',
    'EMPLOYMENT',
    'CREDIT',
    'ISSUES_ELECTIONS_POLITICS',
  ])).max(4),
  specialAdCategoryCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(100).optional(),
  ageMin: z.number().int().min(18).max(65),
  ageMax: z.number().int().min(18).max(65),
  genders: z.array(z.union([z.literal(1), z.literal(2)])).min(1).max(2),
  placements: z.array(z.enum([
    'facebook_feed',
    'facebook_marketplace',
    'facebook_video_feeds',
    'instagram_stream',
    'instagram_story',
    'instagram_reels',
    'audience_network',
    'messenger_inbox',
  ])).max(8),
  interests: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().max(255).optional(),
  }).strict()).max(100).optional(),
  customAudienceIds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  excludedCustomAudienceIds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  promotedObject: z.object({
    pixelId: z.string().trim().min(1).max(100).optional(),
    customConversionId: z.string().trim().min(1).max(100).optional(),
    applicationId: z.string().trim().min(1).max(100).optional(),
    objectStoreUrl: z.string().url().max(2000).optional(),
    pageId: z.string().trim().min(1).max(100).optional(),
  }).strict().optional(),
}).strict();
const googleProviderConfigSchema = z.object({
  budgetMode: z.enum(['CAMPAIGN_TOTAL', 'AVERAGE_DAILY']),
  biddingStrategy: z.enum([
    'MAXIMIZE_CONVERSIONS',
    'MAXIMIZE_CONVERSION_VALUE',
    'MAXIMIZE_CLICKS',
    'TARGET_CPA',
    'TARGET_ROAS',
    'MANUAL_CPC',
  ]),
  targetCpa: z.number().finite().positive().optional(),
  targetRoas: z.number().finite().positive().optional(),
  keywordMatchType: z.enum(['BROAD', 'PHRASE', 'EXACT']),
  negativeKeywords: z.array(z.string().trim().min(1).max(80)).max(1000),
  languageIds: z.array(z.string().regex(/^languageConstants\/\d+$/)).min(1).max(100),
  includeSearchNetwork: z.boolean(),
  includePartnerSearchNetwork: z.boolean(),
  trackingTemplate: z.string().trim().max(2048).optional(),
  finalUrlSuffix: z.string().trim().max(2048).optional(),
  path1: z.string().trim().max(15).optional(),
  path2: z.string().trim().max(15).optional(),
  containsEuPoliticalAdvertising: z.enum([
    'CONTAINS_EU_POLITICAL_ADVERTISING',
    'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  ]),
}).strict();
const allocationSchema = z.object({
  key: z.string().trim().min(1).max(160),
  platform: z.enum(['meta', 'google']),
  amount: z.number().finite().nonnegative(),
  spent: z.number().finite().nonnegative().optional(),
}).strict();

export const autonomousCampaignSchema = z.object({
  name: z.string().trim().min(3).max(255),
  description: z.string().max(10_000).optional(),
  brief: z.string().max(100_000).optional(),
  contentStudioContext: z.string().max(100_000).optional(),
  conversationContext: z.string().max(100_000).optional(),
  objective: z.enum(['awareness', 'traffic', 'engagement', 'leads', 'sales', 'app_promotion']).optional(),
  objectiveRationale: z.string().max(10_000).optional(),
  platforms: z.array(z.enum(['meta', 'google'])).min(1).max(2)
    .refine((items) => new Set(items).size === items.length, 'Platforms must be unique'),
  lifetimeBudget: z.number().finite().positive().max(10_000_000).optional(),
  currency: z.enum(['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'BRL', 'MXN', 'SGD', 'AED']).optional(),
  locations: z.array(locationSchema).max(100).optional(),
  landingPageUrl: z.union([z.string().url().max(2000), z.literal('')]),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional().nullable(),
  allocations: z.array(allocationSchema).max(100).optional(),
  creatives: z.object({
    meta: z.array(creativeSchema).max(50).optional(),
    google: z.array(creativeSchema).max(50).optional(),
  }).strict(),
  providerConfig: z.object({
    meta: metaProviderConfigSchema.optional(),
    google: googleProviderConfigSchema.optional(),
  }).strict().optional(),
  context: z.object({
    businessProfileId: z.number().int().positive().optional(),
    brandToolkitId: z.number().int().positive().optional(),
    icpId: z.number().int().positive().optional(),
    threadId: z.number().int().positive().optional(),
    providerAccountIds: z.object({
      meta: z.string().trim().min(1).optional(),
      google: z.string().trim().min(1).optional(),
    }).strict().optional(),
    creativeRevision: z.number().int().positive().optional(),
    creativeSources: z.array(z.object({
      sourceType: z.enum(['content_asset', 'content_template']),
      sourceId: z.number().int().positive(),
      sourceVersion: z.number().int().positive(),
      updatedAt: z.string().datetime().optional(),
    }).strict()).max(50).optional(),
    scheduleDates: z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).strict().optional(),
  }).strict().optional(),
  idempotencyKey: z.string().trim().min(8).max(160),
  autoActivate: z.boolean().optional().default(false),
  activationConfirmation: z.object({
    confirmedAt: z.coerce.date(),
    source: z.enum(['direct_review', 'conversation_approval']),
    scope: z.literal('live_activation_and_spend'),
    campaignName: z.string().trim().min(3).max(255),
    platforms: z.array(z.enum(['meta', 'google'])).min(1).max(2),
    lifetimeBudget: z.number().finite().positive().max(10_000_000),
    currency: z.enum(['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'BRL', 'MXN', 'SGD', 'AED']),
  }).strict().optional(),
  publish: z.boolean().optional().default(true),
  allowAiPause: z.boolean().optional().default(false),
}).strict();

export async function getAdSettings(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [settings, readiness] = await Promise.all([
      autonomousAdsService.getSettings(userId),
      // A provider check that fails must not hide the saved settings.
      autonomousAdsService.getAccountReadiness(userId, true).catch(error => {
        logger.warn({ err: error instanceof Error ? error.message : String(error), userId }, '[AutonomousAds] Account readiness check failed');
        const reason = 'Ad account status could not be checked. Reconnect the account in Integrations and try again.';
        return { meta: false, google: false, reasons: { meta: reason, google: reason }, currencies: {}, accounts: { capturedAt: new Date().toISOString() } };
      }),
    ]);
    return res.json({ success: true, settings, readiness, environmentMutationGate: process.env.AD_PROVIDER_MUTATIONS_ENABLED === 'true' });
  } catch (error) {
    logger.error({ err: error, userId }, '[AutonomousAds] Failed to get ad settings');
    return res.status(500).json({ error: 'Unable to load Ad Settings.' });
  }
}

export async function updateAdSettings(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const settings = await autonomousAdsService.updateSettings(userId, req.body);
    return res.json({ success: true, settings });
  } catch (error) {
    logger.error({ err: error, userId }, '[AutonomousAds] Failed to update ad settings');
    return res.status(500).json({ error: 'Unable to save Ad Settings.' });
  }
}

export function inferAdObjective(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const inference = inferCampaignObjective(req.body || {});
  return res.json({
    success: true,
    inference,
    requiresReview: inference === null,
    message: inference ? undefined : 'The campaign evidence is ambiguous. Select an objective before publishing.',
  });
}

export async function createAutonomousCampaign(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const campaign = await autonomousAdsService.createCampaign(userId, req.body);
    return res.status(campaign.idempotentReplay ? 200 : 201).json({ success: true, campaign });
  } catch (error) {
    logger.error({ err: error, userId }, '[AutonomousAds] Campaign creation failed');
    if (error instanceof ContentBrandContextError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: 'Unable to create the autonomous ad campaign.' });
  }
}

export async function listAutonomousCampaigns(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ success: true, campaigns: await autonomousAdsService.listCampaigns(userId) });
}

export async function getAutonomousCampaign(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const campaign = await autonomousAdsService.getCampaign(userId, Number(req.params.id));
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  return res.json({ success: true, campaign });
}

export async function optimizeAutonomousCampaign(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await adPerformanceService.evaluateCampaign(userId, Number(req.params.id));
    return res.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Optimization failed.';
    return res.status(message === 'Campaign not found.' ? 404 : 409).json({ error: message });
  }
}

export async function getAdAutonomySettings(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json({ success: true, settings: await adPerformanceService.getAutonomySettings(userId) });
  } catch (error) {
    logger.error({ err: error, userId }, '[AdPerformance] Failed to load autonomy settings');
    return res.status(500).json({ error: 'Unable to load AI autonomy settings.' });
  }
}

export async function updateAdAutonomySettings(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const settings = await adPerformanceService.updateAutonomySettings(userId, req.body);
    return res.json({ success: true, settings });
  } catch (error) {
    logger.error({ err: error, userId }, '[AdPerformance] Failed to update autonomy settings');
    return res.status(500).json({ error: 'Unable to save AI autonomy settings.' });
  }
}

export async function getCampaignAutonomyPolicy(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json({ success: true, policy: await adPerformanceService.getCampaignPolicy(userId, Number(req.params.id)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load campaign automation policy.';
    return res.status(message === 'Campaign not found.' ? 404 : message === 'Invalid reporting period.' ? 400 : 500).json({ error: message });
  }
}

export async function updateCampaignAutonomyPolicy(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const policy = await adPerformanceService.updateCampaignPolicy(userId, Number(req.params.id), req.body);
    return res.json({ success: true, policy });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update campaign automation policy.';
    return res.status(message === 'Campaign not found.' ? 404 : message === 'Invalid reporting period.' ? 400 : 500).json({ error: message });
  }
}

function requestedReportingDays(req: Request): number | undefined {
  if (!req.query.period) return 30;
  const period = String(req.query.period);
  if (!['7d','30d','90d'].includes(period)) throw new Error('Invalid reporting period.');
  return Number(period.slice(0,-1));
}

export async function getCampaignAdPerformance(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json({ success: true, ...(await adPerformanceService.performanceDetail(userId, Number(req.params.id), requestedReportingDays(req))) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load campaign performance.';
    return res.status(message === 'Campaign not found.' ? 404 : message === 'Invalid reporting period.' ? 400 : 500).json({ error: message });
  }
}

export async function getProviderCampaignAdPerformance(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const platform = req.params.platform as 'meta' | 'google';
  const campaignId = req.params.campaignId;
  try {
    let performance;
    try {
      performance = await adPerformanceService.providerPerformanceDetail(userId, platform, campaignId, requestedReportingDays(req), req.query.account ? Number(req.query.account) : undefined);
    } catch (error) {
      const cacheMiss = error instanceof Error && error.message === 'Provider campaign not found.';
      if (!cacheMiss || platform !== 'meta') throw error;
      await ensureMetaCampaignPerformanceCache(userId, campaignId);
      performance = await adPerformanceService.providerPerformanceDetail(userId, platform, campaignId, requestedReportingDays(req), req.query.account ? Number(req.query.account) : undefined);
    }
    return res.json({
      success: true,
      ...performance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load provider campaign performance.';
    if (message === 'Provider campaign not found.') {
      logger.warn({ userId, platform, campaignId }, '[AutonomousAds] Provider campaign detail is not in the current analytics snapshot');
      return res.status(404).json({
        error: 'This campaign is not in the latest analytics snapshot for the currently connected ads account.',
        code: 'PROVIDER_CAMPAIGN_NOT_AVAILABLE',
        platform,
        campaignId,
      });
    }
    return res.status(500).json({ error: message });
  }
}

export async function importProviderCampaign(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const campaign = await adPerformanceService.importProviderCampaign(
      userId,
      req.body.platform as 'meta' | 'google',
      req.body.platformCampaignId,
      req.body.accountId,
    );
    let evaluation = null;
    try {
      evaluation = await adPerformanceService.evaluateCampaign(userId, Number(campaign.id), { advisoryOnly: true });
    } catch (evaluationError) {
      logger.warn({ err: evaluationError, campaignId: campaign.id }, '[AutonomousAds] Imported campaign evaluation deferred');
    }
    const detail = await adPerformanceService.performanceDetail(userId, Number(campaign.id));
    return res.status(campaign.idempotentReplay ? 200 : 201).json({ success: true, campaign, evaluation, detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to import provider campaign.';
    return res.status(message === 'Provider campaign not found.' ? 404 : 500).json({ error: message });
  }
}

export async function updateAdRecommendation(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const recommendation = await adPerformanceService.recommendationStatus(
      userId,
      Number(req.params.id),
      Number(req.params.recommendationId),
      req.body.status,
      {dismissReason:req.body.dismissReason,snoozedUntil:req.body.snoozedUntil,implementationNote:req.body.implementationNote},
    );
    return res.json({ success: true, recommendation });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update recommendation.';
    return res.status(message === 'Recommendation not found.' ? 404 : 400).json({ error: message });
  }
}

export async function createImprovedAdCampaign(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const campaign = await adPerformanceService.createImprovedVersion(userId, Number(req.params.id));
    return res.status(201).json({ success: true, campaign });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create an improved campaign draft.';
    const status = message === 'Campaign not found.' ? 404 : message.startsWith('Accept at least') ? 409 : 500;
    return res.status(status).json({ error: message });
  }
}

export async function resumeAdTarget(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await adPerformanceService.manualResume(
      userId,
      Number(req.params.id),
      req.body.platform as 'meta' | 'google',
      req.params.targetType as 'campaign' | 'ad_set' | 'ad_group' | 'ad',
      req.params.targetId,
    );
    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to resume the ad target.';
    return res.status(message === 'Campaign not found.' ? 404 : 409).json({ error: message });
  }
}
