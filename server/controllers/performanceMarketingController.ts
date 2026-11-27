import { allowManualAdMutation } from '../services/ads/ManualAdMutationGate.js';
import { metaActionValue, metaConversionValue } from '../services/ads/MetaInsightMetrics.js';
import { type AdCreativePreview as MetaAdCreativePreview } from '../../shared/adCreativePreview.js';
import { trimmedTextOrUndefined as optionalString } from '../utils/optionalText.js';
export type { MetaAdCreativePreview };
export { metaConversionValue } from '../services/ads/MetaInsightMetrics.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
/**
 * Performance Marketing Controller
 * Handles performance marketing operations
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { respondToGenerationFailure } from '../services/content/ContentTextGenerationError.js';
import { PerformanceMarketingAgent, loadPlanningIcp } from '../services/agents/PerformanceMarketingAgent';
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { getMetaAdsCreds } from '../models/metaPageConnections/functions';
import { CampaignPerformanceCacheModel } from '../models/campaignPerformanceCache';
import { NotificationService } from '../services/NotificationService.js';
import { aggregateProviderReportingWindow, providerReportingWindow } from '../services/ads/ProviderReportingWindow.js';
import { DEFAULT_BUSINESS_TIMEZONE } from '../utils/timezone.js';
import { groupMetaReportingRows, readMetaReportingRows, readMetaReportingSnapshot, type MetaReportingIssue } from '../services/ads/MetaReportingReader.js';

const performanceMarketingAgent = new PerformanceMarketingAgent();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializePerformanceCampaign(row: any) {
  const settings = row.settings || {};
  const adSets = (row.ad_sets || row.ad_creatives || []).map((adSet: Record<string, unknown>) => ({
    ...adSet,
    ad_set_name: adSet.ad_set_name || adSet.name,
    strategy: adSet.strategy || adSet.bidding_strategy,
  }));
  return {
    ...row,
    campaign_name: row.campaign_name || row.name,
    platform: row.platform || row.ad_platform,
    campaign_type: row.campaign_type || row.objective,
    budget: Number(row.budget ?? row.budget_amount ?? 0),
    spent: Number(row.spent ?? row.spent_amount ?? 0),
    ad_sets: adSets,
    kpis: row.kpis || settings.kpis || {},
  };
}

/**
 * Helper function to get Meta credentials for the current user
 */
async function getUserMetaCredentials(userId: number) {
  const creds = await getMetaAdsCreds(userId);
  if (!creds) {
    return null;
  }
  return {
    accessToken: creds.accessToken,
    adAccountId: creds.adAccountId,
    pageId: creds.pageId,
    apiVersion: creds.apiVersion,
    adAccountName: creds.adAccountName,
    adAccountCurrency: creds.adAccountCurrency,
    adAccountTimezone: creds.adAccountTimezone,
    pageName: creds.pageName,
    instagramAccountId: creds.instagramAccountId,
    instagramUsername: creds.instagramUsername,
  };
}

function normalizeMetaAdAccountId(adAccountId: string): string {
  return adAccountId.replace(/^act_/, '');
}

async function fetchMetaGraph(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<globalThis.Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

export function describeMetaGraphFailure(
  httpStatus: number,
  providerError: unknown,
  entity: string,
): string {
  const details = providerError && typeof providerError === 'object'
    ? providerError as Record<string, unknown>
    : {};
  const codeValue = details.code;
  const subcodeValue = details.error_subcode;
  const code = (typeof codeValue === 'number' || (typeof codeValue === 'string' && codeValue.trim() !== ''))
    && Number.isFinite(Number(codeValue)) ? Number(codeValue) : null;
  const subcode = (typeof subcodeValue === 'number' || (typeof subcodeValue === 'string' && subcodeValue.trim() !== ''))
    && Number.isFinite(Number(subcodeValue)) ? Number(subcodeValue) : null;

  if (code === 100 && subcode === 33) {
    return `Meta cannot access these ${entity}. Check that they still exist and reconnect the Meta account that owns them. (Meta code 100, subcode 33)`;
  }
  if (code === 190 || httpStatus === 401) {
    return `Meta authorization needs to be renewed before refreshing ${entity}. Reconnect the Meta Ads account${code === 190 ? ' (Meta code 190)' : ''}.`;
  }
  if (code === 10 || httpStatus === 403) {
    return `Meta denied access while refreshing ${entity}. Check Ads Management permissions and reconnect the account with access${code === 10 ? ' (Meta code 10)' : ''}.`;
  }

  const providerDetails = [
    `HTTP ${Number.isFinite(httpStatus) ? httpStatus : 'unknown'}`,
    ...(code !== null ? [`Meta code ${code}`] : []),
    ...(subcode !== null ? [`subcode ${subcode}`] : []),
  ];
  return `Meta rejected the ${entity} request (${providerDetails.join(', ')}).`;
}

export async function fetchMetaInsightRows<T = MetaInsightRow>(url: string, accessToken: string): Promise<T[]> {
  return readMetaReportingRows<T>(url, accessToken);
}

export async function metaEntityBelongsToAccount(
  entityId: string,
  creds: {
    accessToken: string;
    adAccountId: string;
    apiVersion: string;
    pageId?: string;
    adAccountName?: string | null;
    adAccountCurrency?: string | null;
    adAccountTimezone?: string | null;
  },
  entityType: 'campaign' | 'adset' | 'ad' = 'campaign',
): Promise<boolean> {
  // Some Meta campaign generations do not expose account_id on the direct
  // object endpoint even though they are returned by the connected account.
  // Use the account-scoped collection as the authoritative ownership check.
  const edge = entityType === 'campaign' ? 'campaigns' : entityType === 'adset' ? 'adsets' : 'ads';
  const adAccountId = normalizeMetaAdAccountId(creds.adAccountId || '');
  if (!adAccountId) return false;
  const params = new URLSearchParams({ fields: 'account_id' });
  const response = await fetchMetaGraph(
    `https://graph.facebook.com/${creds.apiVersion}/${encodeURIComponent(entityId)}?${params.toString()}`,
    creds.accessToken,
  );
  const data = await response.json() as { account_id?: string; error?: { message?: string } };
  if (response.ok && !data.error && normalizeMetaAdAccountId(data.account_id || '') === adAccountId) return true;

  let next: string | null = `https://graph.facebook.com/${creds.apiVersion}/act_${adAccountId}/${edge}?fields=id&limit=500`;
  for (let page = 0; next && page < 20; page += 1) {
    const parsed = new URL(next);
    if (parsed.hostname !== 'graph.facebook.com') return false;
    const collectionResponse = await fetchMetaGraph(parsed.toString(), creds.accessToken);
    const collection = await collectionResponse.json() as {
      data?: Array<{ id?: string }>;
      paging?: { next?: string };
      error?: { message?: string };
    };
    if (!collectionResponse.ok || collection.error) return false;
    if ((collection.data || []).some(entity => String(entity.id || '') === entityId)) return true;
    next = typeof collection.paging?.next === 'string' ? collection.paging.next : null;
  }
  return false;
}

type MetaInsightRow = {
  ad_id?: string;
  adset_id?: string;
  date_start?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  spend?: string;
  cpc?: string;
  cpm?: string;
  ctr?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  action_values?: Array<{ action_type?: string; value?: string }>;
};

const META_AD_CREATIVE_FIELDS = [
  'id',
  'name',
  'title',
  'body',
  'image_url',
  'thumbnail_url',
  'effective_object_story_id',
  'call_to_action_type',
  'object_story_spec',
  'asset_feed_spec',
].join(',');

function firstTextEntry(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const text = optionalString((entry as Record<string, unknown>).text);
    if (text) return text;
  }
  return undefined;
}

function firstObjectEntry(value: unknown) {
  return Array.isArray(value) && value[0] && typeof value[0] === 'object'
    ? value[0] as Record<string, unknown>
    : {};
}

/**
 * Reduce Meta's placement-specific creative payload to a stable, read-only
 * preview contract. Dynamic creatives keep their first provider-ranked asset;
 * the UI labels the result as an approximation rather than a delivery claim.
 */
export function normalizeMetaAdCreative(value: unknown): MetaAdCreativePreview | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const creative = value as Record<string, unknown>;
  const story = creative.object_story_spec && typeof creative.object_story_spec === 'object'
    ? creative.object_story_spec as Record<string, unknown>
    : {};
  const linkData = story.link_data && typeof story.link_data === 'object'
    ? story.link_data as Record<string, unknown>
    : story.template_data && typeof story.template_data === 'object'
      ? story.template_data as Record<string, unknown>
      : {};
  const videoData = story.video_data && typeof story.video_data === 'object'
    ? story.video_data as Record<string, unknown>
    : {};
  const photoData = story.photo_data && typeof story.photo_data === 'object'
    ? story.photo_data as Record<string, unknown>
    : {};
  const assetFeed = creative.asset_feed_spec && typeof creative.asset_feed_spec === 'object'
    ? creative.asset_feed_spec as Record<string, unknown>
    : {};
  const imageAsset = firstObjectEntry(assetFeed.images);
  const videoAsset = firstObjectEntry(assetFeed.videos);
  const linkAsset = firstObjectEntry(assetFeed.link_urls);
  const storyCta = linkData.call_to_action && typeof linkData.call_to_action === 'object'
    ? linkData.call_to_action as Record<string, unknown>
    : videoData.call_to_action && typeof videoData.call_to_action === 'object'
      ? videoData.call_to_action as Record<string, unknown>
      : {};
  const ctaValue = storyCta.value && typeof storyCta.value === 'object'
    ? storyCta.value as Record<string, unknown>
    : {};

  const normalized: MetaAdCreativePreview = {
    facebookPageId: optionalString(story.page_id),
    instagramAccountId: optionalString(story.instagram_actor_id),
    id: optionalString(creative.id),
    name: optionalString(creative.name),
    primaryText: optionalString(linkData.message)
      || optionalString(videoData.message)
      || optionalString(photoData.caption)
      || firstTextEntry(assetFeed.bodies)
      || optionalString(creative.body),
    headline: optionalString(linkData.name)
      || optionalString(videoData.title)
      || firstTextEntry(assetFeed.titles)
      || optionalString(creative.title),
    description: optionalString(linkData.description)
      || firstTextEntry(assetFeed.descriptions),
    imageUrl: optionalString(linkData.picture)
      || optionalString(videoData.image_url)
      || optionalString(imageAsset.url)
      || optionalString(creative.image_url),
    thumbnailUrl: optionalString(videoAsset.thumbnail_url)
      || optionalString(creative.thumbnail_url),
    destinationUrl: optionalString(linkData.link)
      || optionalString(ctaValue.link)
      || optionalString(linkAsset.website_url),
    callToActionType: optionalString(storyCta.type)
      || (Array.isArray(assetFeed.call_to_action_types) ? optionalString(assetFeed.call_to_action_types[0]) : undefined)
      || optionalString(creative.call_to_action_type),
  };

  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

export function normalizeMetaDailyInsight(row: MetaInsightRow & {date_start?:string}, objective?:string) {
  return {date:row.date_start, impressions:Number(row.impressions)||0,reach:Number(row.reach)||0,clicks:Number(row.clicks)||0,spend:Number(row.spend)||0,
    conversions:metaConversionValue(row.actions,objective),leads:metaConversionValue(row.actions,'OUTCOME_LEADS'),
    conversionValue:metaActionValue(row.action_values,['purchase','omni_purchase']),engagements:metaActionValue(row.actions,['post_engagement'])};
}

export function aggregateMetaInsightRows(rows: MetaInsightRow[], objective?: string) {
  const totals = rows.reduce((result, row) => ({
    impressions: result.impressions + (Number(row.impressions) || 0),
    reach: result.reach + (Number(row.reach) || 0),
    clicks: result.clicks + (Number(row.clicks) || 0),
    spend: result.spend + (Number(row.spend) || 0),
    conversions: result.conversions + metaConversionValue(row.actions, objective),
    leads: result.leads + metaConversionValue(row.actions, 'OUTCOME_LEADS'),
    conversionValue: result.conversionValue + metaActionValue(row.action_values, ['purchase', 'omni_purchase']),
    engagements: result.engagements + metaActionValue(row.actions, ['post_engagement']),
    installs: result.installs + metaActionValue(row.actions, ['mobile_app_install', 'app_install']),
  }), { impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, leads: 0, conversionValue: 0, engagements: 0, installs: 0 });
  return {
    ...totals,
    ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    cpm: totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0,
  };
}

/**
 * POST /api/performance-marketing/generate-budget-plan
 * Generate budget allocation plan
 */
export async function generateBudgetPlan(req: Request, res: Response) {
  try {
    const { icp_id, total_budget, duration_days = 30, currency = 'USD' } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id || !total_budget) {
      return res.status(400).json({ error: 'icp_id and total_budget are required' });
    }

    if (total_budget <= 0) {
      return res.status(400).json({ error: 'total_budget must be greater than 0' });
    }

    // Fetch ICP from database
    const icp = await loadPlanningIcp(icp_id, userId);
    if (!icp) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // Generate budget plan
    const budgetPlan = await performanceMarketingAgent.generateBudgetPlan(icp, total_budget, duration_days, currency);

    // Save to database
    const planId = await performanceMarketingAgent.saveBudgetPlan(budgetPlan);

    res.json({
      success: true,
      plan_id: planId,
      budget_plan: budgetPlan,
      message: `Generated budget plan for ${duration_days} days with ${currency} ${total_budget}`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error generating budget plan');
    res.status(500).json({ error: 'Unable to generate the budget plan. Please try again.' });
  }
}

/**
 * POST /api/performance-marketing/generate-campaign
 * Generate ad campaign for platform
 */
export async function generateCampaign(req: Request, res: Response) {
  try {
    const { icp_id, platform, budget, duration_days = 30, currency = 'USD' } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id || !platform || !budget) {
      return res.status(400).json({ error: 'icp_id, platform, and budget are required' });
    }

    const validPlatforms = ['google', 'facebook', 'linkedin', 'twitter', 'instagram'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}`,
      });
    }

    // Fetch ICP from database
    const icp = await loadPlanningIcp(icp_id, userId);
    if (!icp) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // Generate ad campaign
    const adCampaign = await performanceMarketingAgent.generateAdCampaign(icp, platform, budget, duration_days, currency);

    // Save to database
    const campaignId = await performanceMarketingAgent.saveAdCampaign(adCampaign, userId);
    const serializedCampaign = serializePerformanceCampaign({
      ...adCampaign,
      id: campaignId,
      status: 'draft',
      created_at: new Date().toISOString(),
      campaign_type: adCampaign.campaign_objective,
    });

    res.json({
      success: true,
      campaign_id: campaignId,
      ad_campaign: adCampaign,
      campaign: serializedCampaign,
      message: `Generated ${platform} campaign with ${adCampaign.ad_sets.length} ad sets`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToGenerationFailure(res, error, 'a campaign', logger, 'PerformanceMarketingController')) return;
    logger.error({ err: error }, '[PerformanceMarketingController] Error generating campaign');
    res.status(500).json({ success: false, code: 'CAMPAIGN_GENERATION_FAILED', error: 'The campaign could not be generated. Your settings are kept; please try again.' });
  }
}

/**
 * POST /api/performance-marketing/optimize-campaign
 * Generate optimization recommendations
 */
export async function optimizeCampaign(req: Request, res: Response) {
  try {
    const { campaign_id, current_metrics } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!campaign_id || !current_metrics) {
      return res.status(400).json({ error: 'campaign_id and current_metrics are required' });
    }

    // Verify campaign ownership
    const campaignResult = await db.execute(sql`
      SELECT pac.*
      FROM performance_ad_campaigns pac
      WHERE pac.id = ${campaign_id} AND pac.user_id = ${userId}
    `);

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Generate optimization recommendations
    const optimization = await performanceMarketingAgent.optimizeCampaign(campaign_id, current_metrics);

    res.json({
      success: true,
      optimization,
      message: `Generated ${optimization.recommendations.length} optimization recommendations`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error optimizing campaign');
    res.status(500).json({ error: 'Unable to optimize the campaign. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/budget-plans
 * Get all budget plans for user
 */
export async function getBudgetPlans(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { icp_id } = req.query;

    let query = sql`
      SELECT pbp.*, ip.campaign_name, ip.target_audience
      FROM performance_budget_plans pbp
      JOIN icp_profiles ip ON pbp.icp_id = ip.id
      WHERE ip.user_id = ${userId}
    `;

    if (icp_id) {
      query = sql`${query} AND pbp.icp_id = ${icp_id}`;
    }

    query = sql`${query} ORDER BY pbp.created_at DESC LIMIT 50`;

    const result = await db.execute(query);

    res.json({
      success: true,
      budget_plans: result.rows,
      count: result.rows.length,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error fetching budget plans');
    res.status(500).json({ error: 'Unable to retrieve budget plans. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/campaigns
 * Get all ad campaigns for user
 * Optional query params: platform, status, icp_id, thread_id
 */
export async function getCampaigns(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { platform, status, icp_id, thread_id } = req.query;

    let query = sql`
      SELECT pac.*
      FROM performance_ad_campaigns pac
      WHERE pac.user_id = ${userId}
    `;

    if (platform) {
      query = sql`${query} AND pac.ad_platform = ${platform}`;
    }

    if (status) {
      query = sql`${query} AND pac.status = ${status}`;
    }

    if (icp_id) {
      query = sql`${query} AND pac.settings->>'icpId' = ${String(icp_id)}`;
    }

    if (thread_id) {
      query = sql`${query} AND pac.settings->>'threadId' = ${String(thread_id)}`;
    }

    query = sql`${query} ORDER BY pac.created_at DESC LIMIT 50`;

    const result = await db.execute(query);

    res.json({
      success: true,
      campaigns: result.rows.map(serializePerformanceCampaign),
      count: result.rows.length,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error fetching campaigns');
    res.status(500).json({ error: 'Unable to retrieve campaigns. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/campaigns/:id
 * Get campaign by ID
 */
export async function getCampaignById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const result = await db.execute(sql`
      SELECT pac.*
      FROM performance_ad_campaigns pac
      WHERE pac.id = ${id} AND pac.user_id = ${userId}
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.json({
      success: true,
      campaign: serializePerformanceCampaign(result.rows[0]),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error fetching campaign');
    res.status(500).json({ error: 'Unable to retrieve the campaign. Please try again.' });
  }
}

/**
 * POST /api/performance-marketing/campaigns/:id/publish-to-meta
 * Publish a campaign to Meta (Facebook/Instagram)
 */
export async function publishCampaignToMeta(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { pageId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!id) {
      return res.status(400).json({ error: 'Campaign ID is required' });
    }

    if (!pageId) {
      return res.status(400).json({ error: 'Facebook Page ID is required' });
    }

    // Verify campaign exists and belongs to user
    const campaignResult = await db.execute(sql`
      SELECT pac.*
      FROM performance_ad_campaigns pac
      WHERE pac.id = ${parseInt(id)} AND pac.user_id = ${userId}
    `);

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingCampaign = campaignResult.rows[0] as any;
    if (existingCampaign.platform_campaign_id && existingCampaign.status !== 'publish_failed') {
      return res.json({
        success: true,
        duplicate: true,
        metaCampaignId: existingCampaign.platform_campaign_id,
        message: 'Campaign was already published to Meta',
      });
    }
    if (existingCampaign.platform_campaign_id && existingCampaign.status === 'publish_failed') {
      return res.status(409).json({
        success: false,
        error: 'A partial Meta campaign already exists. Remove or reconcile it in Meta Ads Manager before retrying.',
        partialExternalCampaignId: existingCampaign.platform_campaign_id,
      });
    }

    // Get Meta credentials using api_credentials table
    const metaCredentials = await getUserMetaCredentials(userId);
    
    if (!metaCredentials) {
      return res.status(400).json({
        error: 'Meta credentials not found. Please connect your Meta Ads account in the Integrations tab.',
        requiresConnection: true,
      });
    }

    const creds = metaCredentials;

    // Atomically claim the publish transition. Concurrent submissions cannot
    // both cross this boundary and create duplicate external campaigns.
    const publishClaim = await db.execute(sql`
      UPDATE performance_ad_campaigns
      SET status = 'publishing', updated_at = NOW(), version = version + 1
      WHERE id = ${parseInt(id)}
        AND user_id = ${userId}
        AND platform_campaign_id IS NULL
        AND status NOT IN ('publishing', 'published')
      RETURNING id
    `);
    if (publishClaim.rows.length === 0) {
      return res.status(409).json({
        success: false,
        error: 'This campaign is already being published. Refresh to see its latest status.',
      });
    }
    
    // Use accessToken directly (not base64 encoded from api_credentials)
    const accessToken = creds.accessToken;

    const metaCredsForAgent = {
      accessToken,
      adAccountId: normalizeMetaAdAccountId(creds.adAccountId || ''),
      expiresAt: undefined,
    };

    // Publish to Meta
    const result = await performanceMarketingAgent.publishToMeta(
      parseInt(id),
      userId,
      metaCredsForAgent,
      pageId
    );

    if (!result.success) {
      await db.execute(sql`
        UPDATE performance_ad_campaigns
        SET status = ${result.metaCampaignId ? 'publish_failed' : 'draft'},
            platform_campaign_id = COALESCE(${result.metaCampaignId || null}, platform_campaign_id),
            updated_at = NOW(),
            version = version + 1
        WHERE id = ${parseInt(id)} AND user_id = ${userId}
      `);
      return res.status(502).json({
        success: false,
        error: result.error || 'Unable to publish the campaign to Meta. Please try again.',
        partialExternalCampaignId: result.metaCampaignId || null,
      });
    }

    // Update campaign status in database
    await db.execute(sql`
      UPDATE performance_ad_campaigns 
      SET 
        status = 'published',
        ad_platform = 'meta',
        platform_campaign_id = ${result.metaCampaignId},
        is_active = true,
        launched_at = COALESCE(launched_at, NOW()),
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${parseInt(id)} AND user_id = ${userId}
    `);

    // Save in-app notification
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const campRow = (campaignResult.rows[0] as any);
    NotificationService.adCampaignPublished(userId, campRow?.name || 'Ad Campaign', ['Meta']);

    res.json({
      success: true,
      metaCampaignId: result.metaCampaignId,
      message: 'Campaign successfully published to Meta (Facebook/Instagram)',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error publishing campaign to Meta');
    res.status(500).json({ error: 'Unable to publish the campaign to Meta. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/meta/pages
 * Get user's Facebook pages for publishing
 */
export async function getMetaPages(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    // Get Meta credentials using api_credentials table
    const creds = await getUserMetaCredentials(userId);
    
    if (!creds) {
      return res.status(400).json({
        error: 'Meta credentials not found. Please connect your Meta Ads account.',
        requiresConnection: true,
        pages: [],
      });
    }

    const accessToken = creds.accessToken;

    // Fetch pages from Meta API
    const pagesUrl = `https://graph.facebook.com/${creds.apiVersion}/me/accounts?` +
      'fields=id,name,category,picture';

    const response = await fetchMetaGraph(pagesUrl, accessToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error?.message || 'Failed to fetch pages');
    }

    res.json({
      success: true,
      pages: data.data || [],
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error fetching Meta pages');
    res.status(500).json({ error: 'Unable to retrieve Meta pages. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/meta/campaigns
 * Get all campaigns from Meta Ads account with insights
 */
export async function getMetaCampaigns(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { datePreset = 'last_30d', status } = req.query;

    // Get Meta credentials using api_credentials table
    const creds = await getUserMetaCredentials(userId);
    
    if (!creds) {
      return res.status(400).json({
        error: 'Meta credentials not found',
        requiresConnection: true,
        campaigns: [],
      });
    }

    const accessToken = creds.accessToken || '';
    const adAccountId = normalizeMetaAdAccountId(creds.adAccountId || '');

    if (!adAccountId) {
      return res.status(400).json({
        error: 'Ad Account ID not found',
        campaigns: [],
      });
    }

    // Build fields for campaigns query
    const campaignFields = [
      'id', 'name', 'status', 'effective_status', 'objective', 'created_time', 'updated_time',
      'start_time', 'stop_time', 'daily_budget', 'lifetime_budget', 'budget_remaining'
    ].join(',');

    // Build insights fields
    const insightFields = [
      'impressions', 'reach', 'clicks', 'cpc', 'cpm', 'ctr', 'spend',
      'actions', 'cost_per_action_type', 'frequency'
    ].join(',');

    // Build status filter
    let statusFilter = '';
    if (status && status !== 'all') {
      statusFilter = `&filtering=[{"field":"effective_status","operator":"IN","value":["${status.toString().toUpperCase()}"]}]`;
    }

    // Fetch campaigns from Meta API
    const campaignsUrl = `https://graph.facebook.com/${creds.apiVersion}/act_${adAccountId}/campaigns?` +
      `fields=${campaignFields}&limit=100${statusFilter}`;

    const campaignsResponse = await fetchMetaGraph(campaignsUrl, accessToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const campaignsData: any = await campaignsResponse.json();

    if (campaignsData.error) {
      throw new Error('Failed to fetch campaigns');
    }

    // Fetch insights for each campaign
    const campaignsWithInsights = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [...(campaignsData.data || []), ...(campaignsData.paging?.next ? await fetchMetaInsightRows<Record<string, unknown>>(campaignsData.paging.next, accessToken) : [])].map(async (campaign: any) => {
        try {
          const insightsUrl = `https://graph.facebook.com/${creds.apiVersion}/${campaign.id}/insights?` +
            `fields=${insightFields}&date_preset=${datePreset}`;
          
          const insightsResponse = await fetchMetaGraph(insightsUrl, accessToken);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const insightsData: any = await insightsResponse.json();
          
          if (!insightsResponse.ok || insightsData.error) throw new Error('Provider metrics unavailable');
          const insightsRaw = insightsData.data?.[0] || {};
          
          // Parse actions for conversions
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const conversions = metaConversionValue(insightsRaw.actions, campaign.objective);

          // Return with both flat metrics AND nested insights for frontend compatibility
          return {
            id: campaign.id,
            metricsAvailable: true,
            last_refreshed_at: new Date().toISOString(),
            name: campaign.name,
            status: campaign.status?.toUpperCase() || 'UNKNOWN',
            effective_status: String(campaign.effective_status || campaign.status || 'UNKNOWN').toUpperCase(),
            objective: campaign.objective,
            created_time: campaign.created_time,
            updated_time: campaign.updated_time,
            start_time: campaign.start_time,
            stop_time: campaign.stop_time,
            daily_budget: campaign.daily_budget,
            lifetime_budget: campaign.lifetime_budget,
            budget_remaining: campaign.budget_remaining ? parseInt(campaign.budget_remaining) / 100 : null,
            // Nested insights for frontend compatibility
            insights: {
              impressions: insightsRaw.impressions || '0',
              reach: insightsRaw.reach || '0',
              clicks: insightsRaw.clicks || '0',
              spend: insightsRaw.spend || '0',
              cpc: insightsRaw.cpc || '0',
              cpm: insightsRaw.cpm || '0',
              ctr: insightsRaw.ctr || '0',
              frequency: insightsRaw.frequency || '0',
              conversions: String(conversions),
              actions: insightsRaw.actions || [],
              cost_per_action_type: insightsRaw.cost_per_action_type || [],
            },
            // Flat metrics for backward compatibility
            impressions: parseInt(insightsRaw.impressions || '0'),
            reach: parseInt(insightsRaw.reach || '0'),
            clicks: parseInt(insightsRaw.clicks || '0'),
            spend: parseFloat(insightsRaw.spend || '0'),
            cpc: parseFloat(insightsRaw.cpc || '0'),
            cpm: parseFloat(insightsRaw.cpm || '0'),
            ctr: parseFloat(insightsRaw.ctr || '0'),
            frequency: parseFloat(insightsRaw.frequency || '0'),
            conversions: Math.round(Number(conversions)),
            results: Math.round(Number(conversions)),
            roas: 0, // Would need purchase value data
          };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e) {
          return {
            id: campaign.id,
            metricsAvailable: false,
            name: campaign.name,
            status: campaign.status?.toUpperCase() || 'UNKNOWN',
            effective_status: String(campaign.effective_status || campaign.status || 'UNKNOWN').toUpperCase(),
            objective: campaign.objective,
            created_time: campaign.created_time,
            updated_time: campaign.updated_time,
            start_time: campaign.start_time,
            stop_time: campaign.stop_time,
            daily_budget: campaign.daily_budget,
            lifetime_budget: campaign.lifetime_budget,
            budget_remaining: campaign.budget_remaining,
            insights: {
              impressions: '0', reach: '0', clicks: '0', spend: '0',
              cpc: '0', cpm: '0', ctr: '0', frequency: '0', actions: [], cost_per_action_type: []
            },
            impressions: 0, reach: 0, clicks: 0, spend: 0,
            cpc: 0, cpm: 0, ctr: 0, frequency: 0, conversions: 0, roas: 0
          };
        }
      })
    );

    res.json({
      success: true,
      campaigns: campaignsWithInsights,
      count: campaignsWithInsights.length,
      datePreset,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error fetching Meta campaigns');
    res.status(500).json({ error: 'Unable to retrieve Meta campaigns. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/meta/campaigns/:id/adsets
 * Get ad sets for a specific Meta campaign with insights
 */
export async function getMetaCampaignAdsets(req: Request, res: Response) {
  try {
    const { campaignId } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { datePreset = 'last_30d' } = req.query;

    // Get Meta credentials using api_credentials table
    const creds = await getUserMetaCredentials(userId);
    
    if (!creds) {
      return res.status(400).json({
        error: 'Meta credentials not found',
        requiresConnection: true,
      });
    }

    if (!(await metaEntityBelongsToAccount(campaignId, creds))) {
      return res.status(404).json({ error: 'Campaign not found in the connected Meta ad account' });
    }

    const accessToken = creds.accessToken || '';

    // Build fields for adsets query
    const adsetFields = [
      'id', 'name', 'status', 'effective_status', 'targeting', 'optimization_goal', 'billing_event',
      'daily_budget', 'lifetime_budget', 'start_time', 'end_time', 'bid_strategy'
    ].join(',');

    // Build insights fields
    const insightFields = [
      'impressions', 'reach', 'clicks', 'cpc', 'cpm', 'ctr', 'spend', 'frequency', 'actions'
    ].join(',');

    // Fetch adsets from Meta API
    const adsetsUrl = `https://graph.facebook.com/${creds.apiVersion}/${campaignId}/adsets?` +
      `fields=${adsetFields}&limit=100`;

    const adsetsResponse = await fetchMetaGraph(adsetsUrl, accessToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adsetsData: any = await adsetsResponse.json();

    if (adsetsData.error) {
      throw new Error('Failed to fetch ad sets');
    }

    // Fetch insights for each adset
    const adsetsWithInsights = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [...(adsetsData.data || []), ...(adsetsData.paging?.next ? await fetchMetaInsightRows<Record<string, unknown>>(adsetsData.paging.next, accessToken) : [])].map(async (adset: any) => {
        try {
          const insightsUrl = `https://graph.facebook.com/${creds.apiVersion}/${adset.id}/insights?` +
            `fields=${insightFields}&date_preset=${datePreset}`;
          
          const insightsResponse = await fetchMetaGraph(insightsUrl, accessToken);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const insightsData: any = await insightsResponse.json();
          
          if (!insightsResponse.ok || insightsData.error) throw new Error('Provider metrics unavailable');
          const insightsRaw = insightsData.data?.[0] || {};
          const conversions = metaActionValue(insightsRaw.actions, ['lead', 'onsite_conversion.lead_grouped', 'purchase', 'complete_registration']);

          return {
            id: adset.id,
            name: adset.name,
            status: adset.status?.toUpperCase() || 'UNKNOWN',
            effective_status: String(adset.effective_status || adset.status || 'UNKNOWN').toUpperCase(),
            optimization_goal: adset.optimization_goal,
            billing_event: adset.billing_event,
            bid_strategy: adset.bid_strategy,
            daily_budget: adset.daily_budget,
            lifetime_budget: adset.lifetime_budget,
            start_time: adset.start_time,
            end_time: adset.end_time,
            targeting: adset.targeting,
            // Nested insights for frontend compatibility
            insights: {
              impressions: insightsRaw.impressions || '0',
              reach: insightsRaw.reach || '0',
              clicks: insightsRaw.clicks || '0',
              spend: insightsRaw.spend || '0',
              cpc: insightsRaw.cpc || '0',
              cpm: insightsRaw.cpm || '0',
              ctr: insightsRaw.ctr || '0',
              conversions: String(conversions),
              actions: insightsRaw.actions || [],
            },
            // Flat metrics for backward compatibility
            impressions: parseInt(insightsRaw.impressions || '0'),
            reach: parseInt(insightsRaw.reach || '0'),
            clicks: parseInt(insightsRaw.clicks || '0'),
            spend: parseFloat(insightsRaw.spend || '0'),
            cpc: parseFloat(insightsRaw.cpc || '0'),
            cpm: parseFloat(insightsRaw.cpm || '0'),
            ctr: parseFloat(insightsRaw.ctr || '0'),
            frequency: parseFloat(insightsRaw.frequency || '0'),
          };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e) {
          return {
            id: adset.id,
            name: adset.name,
            status: adset.status?.toUpperCase() || 'UNKNOWN',
            effective_status: String(adset.effective_status || adset.status || 'UNKNOWN').toUpperCase(),
            optimization_goal: adset.optimization_goal,
            billing_event: adset.billing_event,
            daily_budget: adset.daily_budget,
            lifetime_budget: adset.lifetime_budget,
            insights: {
              impressions: '0', reach: '0', clicks: '0', spend: '0',
              cpc: '0', cpm: '0', ctr: '0'
            },
            impressions: 0, reach: 0, clicks: 0, spend: 0,
            cpc: 0, cpm: 0, ctr: 0, frequency: 0
          };
        }
      })
    );

    // Return the complete campaign hierarchy in the same read so the Campaigns
    // tab can behave like Ads Manager even before a background cache refresh.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let adsWithInsights: any[] = [];
    let adsError: string | null = null;
    try {
      const adFields = ['id', 'name', 'status', 'effective_status', 'adset_id', `creative{${META_AD_CREATIVE_FIELDS}}`].join(',');
      const adsResponse = await fetchMetaGraph(
        `https://graph.facebook.com/${creds.apiVersion}/${campaignId}/ads?fields=${adFields}&limit=500`,
        accessToken,
      );
      const adsData = await adsResponse.json() as { data?: Array<Record<string, unknown>>; paging?: { next?: string }; error?: { message?: string } };
      if (!adsResponse.ok || adsData.error) throw new Error(adsData.error?.message || 'Failed to fetch ads');

      const adInsightFields = ['ad_id', 'adset_id', insightFields].join(',');
      const adInsightRows = await fetchMetaInsightRows(
        `https://graph.facebook.com/${creds.apiVersion}/${campaignId}/insights?level=ad&fields=${adInsightFields}&date_preset=${datePreset}&limit=500`,
        accessToken,
      );
      const insightsByAd = new Map(adInsightRows.map(row => [String(row.ad_id || ''), row]));
      adsWithInsights = [...(adsData.data || []), ...(adsData.paging?.next ? await fetchMetaInsightRows<Record<string, unknown>>(adsData.paging.next, accessToken) : [])].map((ad) => {
        const insight = insightsByAd.get(String(ad.id || ''));
        const aggregate = aggregateMetaInsightRows(insight ? [insight] : []);
        return {
          id: String(ad.id || ''),
          name: String(ad.name || 'Unnamed ad'),
          status: String(ad.status || 'UNKNOWN').toUpperCase(),
          effective_status: String(ad.effective_status || ad.status || 'UNKNOWN').toUpperCase(),
          adset_id: String(ad.adset_id || insight?.adset_id || ''),
          creative: normalizeMetaAdCreative(ad.creative),
          insights: {
            impressions: String(aggregate.impressions),
            reach: String(aggregate.reach),
            clicks: String(aggregate.clicks),
            spend: String(aggregate.spend),
            cpc: String(aggregate.cpc),
            cpm: String(aggregate.cpm),
            ctr: String(aggregate.ctr),
            conversions: String(aggregate.conversions),
            actions: insight?.actions || [],
          },
        };
      });
    } catch (error) {
      adsError = error instanceof Error ? error.message : 'Individual ads could not be loaded';
      logger.warn({ err: error, campaignId }, '[PerformanceMarketingController] Partial Meta hierarchy: ads unavailable');
    }

    res.json({
      success: true,
      adsets: adsetsWithInsights,
      ads: adsWithInsights,
      count: adsetsWithInsights.length,
      adCount: adsWithInsights.length,
      partialSuccess: Boolean(adsError),
      adsError,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error fetching adsets');
    res.status(500).json({ error: 'Unable to retrieve ad sets. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/meta/campaigns/:campaignId/insights
 * Get detailed insights for a specific campaign
 */
export async function getMetaCampaignInsights(req: Request, res: Response) {
  try {
    const { campaignId } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { datePreset = 'last_30d', breakdown } = req.query;

    // Get Meta credentials using api_credentials table
    const creds = await getUserMetaCredentials(userId);
    
    if (!creds) {
      return res.status(400).json({
        error: 'Meta credentials not found',
        requiresConnection: true,
      });
    }

    if (!(await metaEntityBelongsToAccount(campaignId, creds))) {
      return res.status(404).json({ error: 'Campaign not found in the connected Meta ad account' });
    }

    const accessToken = creds.accessToken || '';

    // Build insights fields
    const insightFields = [
      'impressions', 'reach', 'clicks', 'unique_clicks', 'cpc', 'cpm', 'ctr',
      'spend', 'actions', 'cost_per_action_type', 'frequency', 'unique_link_clicks_ctr',
      'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions',
      'video_p75_watched_actions', 'video_p100_watched_actions'
    ].join(',');

    // Build breakdown parameter
    let breakdownParam = '';
    if (breakdown === 'age' || breakdown === 'gender' || breakdown === 'placement' || breakdown === 'device_platform') {
      breakdownParam = `&breakdowns=${breakdown}`;
    } else if (breakdown === 'day') {
      breakdownParam = '&time_increment=1';
    }

    // Fetch insights from Meta API
    const insightsUrl = `https://graph.facebook.com/${creds.apiVersion}/${campaignId}/insights?` +
      `fields=${insightFields}&date_preset=${datePreset}${breakdownParam}`;

    const insightsResponse = await fetchMetaGraph(insightsUrl, accessToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insightsData: any = await insightsResponse.json();

    if (insightsData.error) {
      throw new Error('Failed to fetch insights');
    }

    // Process insights data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insights = (insightsData.data || []).map((row: any) => {
      // Parse actions
      const actions: Record<string, number> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (row.actions || []).forEach((action: any) => {
        actions[action.action_type] = parseInt(action.value || '0');
      });

      // Parse cost per action
      const costPerAction: Record<string, number> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (row.cost_per_action_type || []).forEach((cpa: any) => {
        costPerAction[cpa.action_type] = parseFloat(cpa.value || '0');
      });

      return {
        date_start: row.date_start,
        date_stop: row.date_stop,
        // Breakdown dimensions
        age: row.age,
        gender: row.gender,
        placement: row.placement,
        device_platform: row.device_platform,
        // Core metrics
        impressions: parseInt(row.impressions || '0'),
        reach: parseInt(row.reach || '0'),
        clicks: parseInt(row.clicks || '0'),
        unique_clicks: parseInt(row.unique_clicks || '0'),
        spend: parseFloat(row.spend || '0'),
        cpc: parseFloat(row.cpc || '0'),
        cpm: parseFloat(row.cpm || '0'),
        ctr: parseFloat(row.ctr || '0'),
        frequency: parseFloat(row.frequency || '0'),
        // Actions
        actions,
        cost_per_action: costPerAction,
        link_clicks: actions.link_click || 0,
        leads: actions.lead || 0,
        purchases: actions.purchase || 0,
        add_to_cart: actions.add_to_cart || 0,
        // Video metrics
        video_plays: parseInt(row.video_play_actions?.[0]?.value || '0'),
        video_25p_watched: parseInt(row.video_p25_watched_actions?.[0]?.value || '0'),
        video_50p_watched: parseInt(row.video_p50_watched_actions?.[0]?.value || '0'),
        video_75p_watched: parseInt(row.video_p75_watched_actions?.[0]?.value || '0'),
        video_100p_watched: parseInt(row.video_p100_watched_actions?.[0]?.value || '0'),
      };
    });

    // Calculate totals if multiple rows
    const totals = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      impressions: insights.reduce((sum: number, r: any) => sum + r.impressions, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reach: insights.reduce((sum: number, r: any) => sum + r.reach, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clicks: insights.reduce((sum: number, r: any) => sum + r.clicks, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spend: insights.reduce((sum: number, r: any) => sum + r.spend, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      link_clicks: insights.reduce((sum: number, r: any) => sum + r.link_clicks, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      leads: insights.reduce((sum: number, r: any) => sum + r.leads, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      purchases: insights.reduce((sum: number, r: any) => sum + r.purchases, 0),
    };

    // Calculate derived metrics
    if (totals.impressions > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (totals as any).ctr = (totals.clicks / totals.impressions) * 100;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (totals as any).cpm = (totals.spend / totals.impressions) * 1000;
    }
    if (totals.clicks > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (totals as any).cpc = totals.spend / totals.clicks;
    }

    res.json({
      success: true,
      insights: breakdown ? insights : (insights[0] || null),
      breakdown: breakdown || null,
      totals,
      datePreset,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error fetching campaign insights');
    res.status(500).json({ error: 'Unable to retrieve campaign insights. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/meta/account-insights
 * Get overall account-level insights
 */
export async function getMetaAccountInsights(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { datePreset = 'last_30d' } = req.query;

    // Get Meta credentials using api_credentials table
    const creds = await getUserMetaCredentials(userId);
    
    if (!creds) {
      return res.status(400).json({
        error: 'Meta credentials not found',
        requiresConnection: true,
      });
    }

    const accessToken = creds.accessToken || '';
    const adAccountId = normalizeMetaAdAccountId(creds.adAccountId || '');

    // Build insights fields
    const insightFields = [
      'impressions', 'reach', 'clicks', 'cpc', 'cpm', 'ctr', 'spend',
      'actions', 'cost_per_action_type', 'frequency'
    ].join(',');

    // Fetch account insights
    const insightsUrl = `https://graph.facebook.com/${creds.apiVersion}/act_${adAccountId}/insights?` +
      `fields=${insightFields}&date_preset=${datePreset}&time_increment=1`;

    const insightsResponse = await fetchMetaGraph(insightsUrl, accessToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insightsData: any = await insightsResponse.json();

    if (insightsData.error) {
      throw new Error('Failed to fetch account insights');
    }

    // Process daily data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dailyData = (insightsData.data || []).map((row: any) => {
      const conversions = (row.actions || []).reduce((sum: number, action: { action_type?: string; value?: string }) => (
        ['purchase', 'lead', 'complete_registration', 'add_to_cart'].includes(action.action_type || '')
          ? sum + parseInt(action.value || '0')
          : sum
      ), 0);
      return {
        date: row.date_start,
        impressions: parseInt(row.impressions || '0'),
        reach: parseInt(row.reach || '0'),
        clicks: parseInt(row.clicks || '0'),
        spend: parseFloat(row.spend || '0'),
        cpc: parseFloat(row.cpc || '0'),
        cpm: parseFloat(row.cpm || '0'),
        ctr: parseFloat(row.ctr || '0'),
        conversions,
      };
    });

    // Calculate totals
    const totals = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      impressions: dailyData.reduce((sum: number, r: any) => sum + r.impressions, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reach: dailyData.reduce((sum: number, r: any) => sum + r.reach, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clicks: dailyData.reduce((sum: number, r: any) => sum + r.clicks, 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spend: dailyData.reduce((sum: number, r: any) => sum + r.spend, 0),
      conversions: dailyData.reduce((sum: number, r: any) => sum + r.conversions, 0),
    };

    // Calculate derived metrics
    const derived = {
      ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
      cpm: totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0,
      cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    };

    res.json({
      success: true,
      accountId: adAccountId,
      accountName: creds.adAccountName || 'Meta Ads Account',
      currency: creds.adAccountCurrency || 'USD',
      timezone: creds.adAccountTimezone || DEFAULT_BUSINESS_TIMEZONE,
      totals: { ...totals, ...derived },
      dailyData,
      datePreset,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error fetching account insights');
    res.status(500).json({ error: 'Unable to retrieve account insights. Please try again.' });
  }
}

// Backwards-compatible alias exports used in tests
export const generateBudgetPlanHandler = generateBudgetPlan;
export const generateCampaignHandler = generateCampaign;
export const optimizeCampaignHandler = optimizeCampaign;
export const getCampaignsHandler = getCampaigns;
export const publishCampaignToMetaHandler = publishCampaignToMeta;
export const getMetaPagesHandler = getMetaPages;
export const getMetaCampaignsHandler = getMetaCampaigns;
export const getMetaCampaignAdsetsHandler = getMetaCampaignAdsets;
export const getMetaCampaignInsightsHandler = getMetaCampaignInsights;
export const getMetaAccountInsightsHandler = getMetaAccountInsights;

/**
 * GET /api/performance-marketing/cache/campaigns
 * Get cached campaign performance data
 */
export async function getCachedCampaigns(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { platform = 'meta' } = req.query;

    const cached = await CampaignPerformanceCacheModel.getCachedCampaigns(userId, platform as string);
    const window = providerReportingWindow(String(req.query.datePreset || 'last_30d'));
    const campaigns = cached.map(campaign => {
      const raw = campaign.rawData && typeof campaign.rawData === 'object' ? campaign.rawData as Record<string, unknown> : {};
      return Array.isArray(raw.dailyInsights) ? { ...campaign, ...aggregateProviderReportingWindow(raw, window.start, window.end) } : campaign;
    });
    const lastRefreshed = await CampaignPerformanceCacheModel.getLastRefreshTime(userId, platform as string);

    res.json({
      success: true,
      campaigns,
      count: campaigns.length,
      lastRefreshedAt: lastRefreshed,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error getting cached campaigns');
    res.status(500).json({ error: 'Unable to retrieve cached campaigns. Please try again.' });
  }
}

/**
 * GET /api/performance-marketing/cache/campaigns/:campaignId/adsets
 * Get cached adsets for a campaign
 */
export async function getCachedAdsets(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { campaignId } = req.params;
    const { platform = 'meta' } = req.query;

    const [adsets, ads, creds] = await Promise.all([
      CampaignPerformanceCacheModel.getCachedAdsets(userId, campaignId, platform as string),
      CampaignPerformanceCacheModel.getCachedAds(userId, campaignId, platform as string),
      platform === 'meta' ? getUserMetaCredentials(userId) : Promise.resolve(null),
    ]);

    res.json({
      success: true,
      adsets,
      ads,
      count: adsets.length,
      adCount: ads.length,
      accountIdentity: creds ? {
        platform: 'meta',
        adAccountName: creds.adAccountName || null,
        facebookPageName: creds.pageName || null,
        facebookPageId: creds.pageId || null,
        instagramAccountId: creds.instagramAccountId || null,
        instagramUsername: creds.instagramUsername || null,
      } : { platform },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error getting cached adsets');
    res.status(500).json({ error: 'Unable to retrieve cached ad sets. Please try again.' });
  }
}

interface MetaPerformanceCacheRefreshResult {
  cachedCampaigns: number;
  cachedAdsets: number;
  cachedAds: number;
  lastRefreshedAt: Date | null;
  errors: MetaReportingIssue[];
}

export async function refreshMetaPerformanceCacheForUser(
  userId: number,
  datePreset: string,
  targetCampaignId?: string,
  reportingAccountId?: number,
): Promise<MetaPerformanceCacheRefreshResult> {
    const platform = 'meta';
    const cacheWindow = providerReportingWindow(datePreset === 'maximum' ? 'maximum' : 'last_90d');
    const reportingQuery = `time_range=${encodeURIComponent(JSON.stringify({ since: cacheWindow.start, until: cacheWindow.end }))}`;
    const creds = reportingAccountId
      ? await (await import('../services/ads/PaidAdAccountsService.js')).resolveMetaReportingAccount(userId, reportingAccountId)
      : await getUserMetaCredentials(userId);
    if (!creds) throw new Error('Meta credentials not found');

    const accessToken = creds.accessToken || '';
    const adAccountId = normalizeMetaAdAccountId(creds.adAccountId || '');
    if (!adAccountId) throw new Error('Ad Account ID not found');

    const campaignFields = [
      'id', 'name', 'status', 'effective_status', 'objective', 'created_time', 'daily_budget', 'lifetime_budget'
    ].join(',');

    const insightFields = [
      'impressions', 'reach', 'clicks', 'cpc', 'cpm', 'ctr', 'spend', 'actions', 'action_values'
    ].join(',');

    if (targetCampaignId && !(await metaEntityBelongsToAccount(targetCampaignId, creds))) {
      throw new Error('Provider campaign not found.');
    }

    const campaignsUrl = targetCampaignId
      ? `https://graph.facebook.com/${creds.apiVersion}/${encodeURIComponent(targetCampaignId)}?fields=${campaignFields}`
      : `https://graph.facebook.com/${creds.apiVersion}/act_${adAccountId}/campaigns?fields=${campaignFields}&limit=100`;

    // Full account reports are fetched once per level, including pagination.
    // This avoids issuing separate insight requests for every campaign/ad set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let campaigns: any[];
    if (targetCampaignId) {
      const response = await fetchMetaGraph(campaignsUrl, accessToken);
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok || data.error) throw new Error(describeMetaGraphFailure(response.status, data.error, 'campaign'));
      campaigns = [data];
    } else campaigns = await readMetaReportingRows(campaignsUrl, accessToken);
    const reports: Awaited<ReturnType<typeof readMetaReportingSnapshot>> = campaigns.length ? await readMetaReportingSnapshot({
      root: targetCampaignId || `act_${adAccountId}`, apiVersion: creds.apiVersion, accessToken, reportingQuery, insightFields,
      adsetFields: 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget',
      adFields: ['id', 'name', 'status', 'effective_status', 'campaign_id', 'adset_id', `creative{${META_AD_CREATIVE_FIELDS}}`].join(','),
    }) : { errors: [] };
    const dailyByCampaign = groupMetaReportingRows(reports.campaignDaily, 'campaign_id');
    const adsetsByCampaign = groupMetaReportingRows(reports.adsets, 'campaign_id');
    const dailyByAdset = groupMetaReportingRows(reports.adsetDaily, 'adset_id');
    const adsByCampaign = groupMetaReportingRows(reports.ads, 'campaign_id');
    const insightByAd = groupMetaReportingRows(reports.adDaily, 'ad_id');
    let cachedCampaigns = 0;
    let cachedAdsets = 0;
    let cachedAds = 0;
    const refreshErrors: MetaReportingIssue[] = [...reports.errors];

    // Process each campaign
    for (const campaign of campaigns) {
      if (!reports.campaignDaily) continue;
      // Fetch campaign insights
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let insights: any = {};
      try {
        const dailyInsights = (dailyByCampaign.get(String(campaign.id)) || []) as MetaInsightRow[];
        insights = aggregateMetaInsightRows(dailyInsights, campaign.objective);
        insights.actions = dailyInsights.flatMap(row => row.actions || []);
        insights.dailyInsights = dailyInsights.map(row => normalizeMetaDailyInsight(row, campaign.objective)).filter(row => Boolean(row.date));
      } catch {
        refreshErrors.push({ entityType: 'campaign', entityId: campaign.id, message: 'Campaign insights could not be refreshed; previous evidence was preserved.' });
        continue;
      }

      // Cache campaign
      await CampaignPerformanceCacheModel.upsertPerformance({
        userId,
        platform,
        adAccountId,
        entityType: 'campaign',
        platformEntityId: campaign.id,
        name: campaign.name,
        status: String(campaign.effective_status || campaign.status || 'unknown').toLowerCase(),
        parentEntityId: null,
        impressions: parseInt(insights.impressions || '0'),
        clicks: parseInt(insights.clicks || '0'),
        spend: insights.spend || '0',
        reach: parseInt(insights.reach || '0'),
        ctr: insights.ctr || '0',
        cpc: insights.cpc || '0',
        cpm: insights.cpm || '0',
        conversions: Math.round(Number(insights.conversions) || 0),
        conversionValue: String(Number(insights.conversionValue) || 0),
        rawData: { accountIdentity: { adAccountId, adAccountName: creds.adAccountName, currency: creds.adAccountCurrency, facebookPageId: creds.pageId || null, facebookPageName: creds.pageName || null, instagramAccountId: creds.instagramAccountId || null, instagramUsername: creds.instagramUsername || null, identitySource: "connection" }, campaign, insights, reportingWindow: cacheWindow, dailyInsights: insights.dailyInsights || [] },
      });
      cachedCampaigns++;

      // Fetch and cache adsets
      try {
        const adsets = reports.adsetDaily ? adsetsByCampaign.get(String(campaign.id)) || [] : [];
        for (const adset of adsets) {
          // Fetch adset insights
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let adsetInsights: any = {};
          try {
            const daily = (dailyByAdset.get(String(adset.id)) || []) as MetaInsightRow[];
            adsetInsights = {...aggregateMetaInsightRows(daily,campaign.objective),dailyInsights:daily.map(row=>normalizeMetaDailyInsight(row,campaign.objective))};
          } catch {
            refreshErrors.push({ entityType: 'adset', entityId: String(adset.id), message: 'Ad set insights could not be refreshed; previous evidence was preserved.' });
            continue;
          }

          // Cache adset
          await CampaignPerformanceCacheModel.upsertPerformance({
            userId,
            platform,
            adAccountId,
            entityType: 'adset',
            platformEntityId: String(adset.id),
            name: String(adset.name || 'Unnamed ad set'),
            status: String(adset.effective_status || adset.status || 'unknown').toLowerCase(),
            parentEntityId: campaign.id,
            impressions: parseInt(adsetInsights.impressions || '0'),
            clicks: parseInt(adsetInsights.clicks || '0'),
            spend: adsetInsights.spend || '0',
            reach: parseInt(adsetInsights.reach || '0'),
            ctr: adsetInsights.ctr || '0',
            cpc: adsetInsights.cpc || '0',
            cpm: adsetInsights.cpm || '0',
            conversions: Number(adsetInsights.conversions || 0),
            conversionValue: String(adsetInsights.conversionValue || 0),
            rawData: { adset, insights: adsetInsights, dailyInsights: adsetInsights.dailyInsights, reportingWindow: cacheWindow },
          });
          cachedAdsets++;
        }
      } catch (e) {
        const diagnostic = e instanceof Error && e.message.startsWith('Meta ')
          ? e.message
          : 'Campaign ad sets could not be refreshed; previous cached evidence was preserved.';
        logger.error({ campaignId: campaign.id, errorType: e instanceof Error ? e.name : typeof e, diagnostic }, '[refreshPerformanceCache] Error caching adsets for campaign');
        refreshErrors.push({ entityType: 'campaign', entityId: campaign.id, message: diagnostic });
      }

      // Fetch and cache individual ads in one hierarchy request plus one
      // campaign-level insight request. This keeps the provider cache granular
      // enough for ad-first performance decisions without issuing one metric
      // request per ad.
      try {
        for (const ad of reports.adDaily ? adsByCampaign.get(String(campaign.id)) || [] : []) {
          const rawInsight = insightByAd.get(String(ad.id)) as MetaInsightRow[] | undefined;
          const adInsights = aggregateMetaInsightRows(rawInsight || [], campaign.objective);
          await CampaignPerformanceCacheModel.upsertPerformance({
            userId,
            platform,
            adAccountId,
            entityType: 'ad',
            platformEntityId: String(ad.id),
            name: String(ad.name || 'Unnamed ad'),
            status: String(ad.effective_status || ad.status || 'unknown').toLowerCase(),
            parentEntityId: ad.adset_id ? String(ad.adset_id) : null,
            impressions: Math.round(Number(adInsights.impressions) || 0),
            clicks: Math.round(Number(adInsights.clicks) || 0),
            spend: String(Number(adInsights.spend) || 0),
            reach: Math.round(Number(adInsights.reach) || 0),
            ctr: String(Number(adInsights.ctr) || 0),
            cpc: String(Number(adInsights.cpc) || 0),
            cpm: String(Number(adInsights.cpm) || 0),
            conversions: Math.round(Number(adInsights.conversions) || 0),
            conversionValue: String(Number(adInsights.conversionValue) || 0),
            rawData: { ad, creative: normalizeMetaAdCreative(ad.creative), insights: adInsights, dailyInsights: (rawInsight || []).map(row=>normalizeMetaDailyInsight(row,campaign.objective)), reportingWindow: cacheWindow },
          });
          cachedAds++;
        }
      } catch (e) {
        logger.error({ err: e, campaignId: campaign.id }, '[refreshPerformanceCache] Error caching ads for campaign');
        refreshErrors.push({ entityType: 'campaign', entityId: campaign.id, message: 'Individual ads could not be refreshed' });
      }
    }

    return {
      cachedCampaigns,
      cachedAdsets,
      cachedAds,
      lastRefreshedAt: await CampaignPerformanceCacheModel.getLastRefreshTime(userId, platform),
      errors: refreshErrors,
    };
}

/**
 * Populate a missing report-only Meta campaign on demand. The account ownership
 * check above prevents a shared provider ID from crossing account boundaries.
 */
export async function ensureMetaCampaignPerformanceCache(
  userId: number,
  campaignId: string,
  datePreset = 'last_30d',
) {
  const result = await refreshMetaPerformanceCacheForUser(userId, datePreset, campaignId);
  if (result.cachedCampaigns !== 1) throw new Error('Provider campaign not found.');
  return result;
}

/**
 * POST /api/performance-marketing/cache/refresh
 * Refresh campaign performance cache from Meta API
 */
export async function refreshPerformanceCache(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { datePreset = 'last_30d' } = req.body;
    const result = await refreshMetaPerformanceCacheForUser(userId, datePreset);
    res.json({
      success: true,
      message: `Cached ${result.cachedCampaigns} campaigns, ${result.cachedAdsets} ad sets, and ${result.cachedAds} ads`,
      ...result,
      partialSuccess: result.errors.length > 0,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error refreshing performance cache');
    const missingCredentials = error instanceof Error && ['Meta credentials not found', 'Ad Account ID not found'].includes(error.message);
    res.status(missingCredentials ? 400 : 500).json({
      error: missingCredentials ? error.message : 'Unable to refresh the performance cache. Please try again.',
      ...(error instanceof Error && error.message === 'Meta credentials not found' ? { requiresConnection: true } : {}),
    });
  }
}

/**
 * DELETE /api/performance-marketing/cache
 * Clear performance cache for user
 */
export async function clearPerformanceCache(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { platform } = req.query;

    await CampaignPerformanceCacheModel.clearUserCache(userId, platform as string);

    res.json({
      success: true,
      message: 'Performance cache cleared',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[PerformanceMarketingController] Error clearing performance cache');
    res.status(500).json({ error: 'Unable to clear the performance cache. Please try again.' });
  }
}

// Cache endpoint exports
export const getCachedCampaignsHandler = getCachedCampaigns;
export const getCachedAdsetsHandler = getCachedAdsets;
export const refreshPerformanceCacheHandler = refreshPerformanceCache;
export const clearPerformanceCacheHandler = clearPerformanceCache;

/**
 * POST /api/performance-marketing/meta/campaigns/:id/pause
 * Pause a Meta campaign
 */
export async function pauseMetaCampaign(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds))) {
      return res.status(404).json({ error: 'Campaign not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const { autonomousAdsService } = await import('../services/ads/AutonomousAdsService.js');
    const managedIds = await autonomousAdsService.revokeManagedMetaLaunch(userId, id, creds.adAccountId);
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'PAUSED',
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[pauseMetaCampaign] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to pause the campaign. Please try again.' 
      });
    }

    await autonomousAdsService.recordManagedMetaPause(userId, managedIds, id, creds.adAccountId);

    // Update cache
    await CampaignPerformanceCacheModel.updateStatus(userId, id, 'paused');

    res.json({
      success: true,
      message: 'Campaign paused successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[pauseMetaCampaign] Error');
    res.status(500).json({ error: 'Unable to pause the campaign. Please try again.' });
  }
}

/**
 * POST /api/performance-marketing/meta/campaigns/:id/resume
 * Resume a paused Meta campaign
 */
export async function resumeMetaCampaign(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds))) {
      return res.status(404).json({ error: 'Campaign not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'ACTIVE',
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[resumeMetaCampaign] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to resume the campaign. Please try again.' 
      });
    }

    // Update cache
    await CampaignPerformanceCacheModel.updateStatus(userId, id, 'active');

    res.json({
      success: true,
      message: 'Campaign resumed successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[resumeMetaCampaign] Error');
    res.status(500).json({ error: 'Unable to resume the campaign. Please try again.' });
  }
}

/**
 * DELETE /api/performance-marketing/meta/campaigns/:id
 * Delete a Meta campaign
 */
export async function deleteMetaCampaign(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds))) {
      return res.status(404).json({ error: 'Campaign not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'DELETE',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[deleteMetaCampaign] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to delete the campaign. Please try again.' 
      });
    }

    // Remove from cache
    await CampaignPerformanceCacheModel.deleteByEntityId(userId, id);

    res.json({
      success: true,
      message: 'Campaign deleted successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[deleteMetaCampaign] Error');
    res.status(500).json({ error: 'Unable to delete the campaign. Please try again.' });
  }
}

/**
 * POST /api/performance-marketing/meta/adsets/:id/pause
 * Pause a Meta ad set
 */
export async function pauseMetaAdset(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds, 'adset'))) {
      return res.status(404).json({ error: 'Ad set not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'PAUSED',
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[pauseMetaAdset] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to pause the ad set. Please try again.' 
      });
    }

    // Update cache
    await CampaignPerformanceCacheModel.updateStatus(userId, id, 'paused');

    res.json({
      success: true,
      message: 'Ad set paused successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[pauseMetaAdset] Error');
    res.status(500).json({ error: 'Unable to pause the ad set. Please try again.' });
  }
}

/**
 * POST /api/performance-marketing/meta/adsets/:id/resume
 * Resume a paused Meta ad set
 */
export async function resumeMetaAdset(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds, 'adset'))) {
      return res.status(404).json({ error: 'Ad set not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'ACTIVE',
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[resumeMetaAdset] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to resume the ad set. Please try again.' 
      });
    }

    // Update cache
    await CampaignPerformanceCacheModel.updateStatus(userId, id, 'active');

    res.json({
      success: true,
      message: 'Ad set resumed successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[resumeMetaAdset] Error');
    res.status(500).json({ error: 'Unable to resume the ad set. Please try again.' });
  }
}

/**
 * DELETE /api/performance-marketing/meta/adsets/:id
 * Delete a Meta ad set
 */
export async function deleteMetaAdset(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds, 'adset'))) {
      return res.status(404).json({ error: 'Ad set not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'DELETE',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[deleteMetaAdset] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to delete the ad set. Please try again.' 
      });
    }

    // Remove from cache
    await CampaignPerformanceCacheModel.deleteByEntityId(userId, id);

    res.json({
      success: true,
      message: 'Ad set deleted successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[deleteMetaAdset] Error');
    res.status(500).json({ error: 'Unable to delete the ad set. Please try again.' });
  }
}

/**
 * POST /api/performance-marketing/meta/ads/:id/pause
 * Pause a Meta ad
 */
export async function pauseMetaAd(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds, 'ad'))) {
      return res.status(404).json({ error: 'Ad not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'PAUSED',
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[pauseMetaAd] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to pause the ad. Please try again.' 
      });
    }

    res.json({
      success: true,
      message: 'Ad paused successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[pauseMetaAd] Error');
    res.status(500).json({ error: 'Unable to pause the ad. Please try again.' });
  }
}

/**
 * POST /api/performance-marketing/meta/ads/:id/resume
 * Resume a paused Meta ad
 */
export async function resumeMetaAd(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds, 'ad'))) {
      return res.status(404).json({ error: 'Ad not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'ACTIVE',
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[resumeMetaAd] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to resume the ad. Please try again.' 
      });
    }

    res.json({
      success: true,
      message: 'Ad resumed successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[resumeMetaAd] Error');
    res.status(500).json({ error: 'Unable to resume the ad. Please try again.' });
  }
}

/**
 * DELETE /api/performance-marketing/meta/ads/:id
 * Delete a Meta ad
 */
export async function deleteMetaAd(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await allowManualAdMutation(req, res))) return;

    const creds = await getUserMetaCredentials(userId);
    if (!creds) {
      return res.status(400).json({ 
        error: 'Meta credentials not found',
        requiresConnection: true 
      });
    }

    if (!(await metaEntityBelongsToAccount(id, creds, 'ad'))) {
      return res.status(404).json({ error: 'Ad not found in the connected Meta ad account' });
    }

    const url = `https://graph.facebook.com/${creds.apiVersion}/${id}`;
    if (!(await allowManualAdMutation(req, res))) return;

    const response = await fetchMetaGraph(url, creds.accessToken, {
      method: 'DELETE',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error) {
      logger.error({ metaError: data.error }, '[deleteMetaAd] Meta API error');
      return res.status(400).json({ 
        error: 'Unable to delete the ad. Please try again.' 
      });
    }

    res.json({
      success: true,
      message: 'Ad deleted successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[deleteMetaAd] Error');
    res.status(500).json({ error: 'Unable to delete the ad. Please try again.' });
  }
}
