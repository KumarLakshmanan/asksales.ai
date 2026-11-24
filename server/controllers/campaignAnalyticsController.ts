import { isReportingDate, reportingPeriod } from '../utils/reportingDates.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { aggregateProviderReportingWindow, providerReportingRows } from '../services/ads/ProviderReportingWindow.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { AuthenticatedRequest, AuthenticatedRequest as AuthRequest } from '../types/express.js';
import type { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { db } from "../models/db";
import { sql } from "drizzle-orm";
import { analyticsIngestionService, type CampaignMetricsRefresh } from "../services/AnalyticsIngestionService";

/** How long fetch-now waits for the queued refresh before answering 202. */
const FETCH_NOW_WAIT_MS = 20_000;
import { adPerformanceService, normalizeProviderObjective } from '../services/ads/AdPerformanceService.js';

function calculateTargetVariance(
  objective: string,
  metrics: Record<string, number>,
  baselineValue: unknown,
): { metric: string; current: number; target: number; percent: number } | null {
  const baseline = baselineValue && typeof baselineValue === 'object'
    ? baselineValue as Record<string, unknown>
    : {};
  const salesUsesRoas = objective === 'sales'
    && Number(baseline.targetRoas || baseline.roas || 0) > 0;
  const selection = objective === 'awareness'
    ? ['cpm', 'targetCpm', 'lower']
    : objective === 'traffic'
      ? ['ctr', 'targetCtr', 'higher']
      : objective === 'engagement'
        ? ['engagementRate', 'targetEngagementRate', 'higher']
        : salesUsesRoas
          ? ['roas', 'targetRoas', 'higher']
          : ['cpa', 'targetCpa', 'lower'];
  const current = Number(metrics[selection[0]] || 0);
  const target = Number(baseline[selection[1]] || baseline[selection[0]] || 0);
  if (!(target > 0)) return null;
  return {
    metric: selection[0],
    current,
    target,
    // Positive always means worse than target; negative means better. This
    // keeps the UI's variance color semantics consistent across CPA and ROAS.
    percent: selection[2] === 'higher'
      ? ((target - current) / target) * 100
      : ((current - target) / target) * 100,
  };
}

function primaryResultCount(objective: string, metrics: Record<string, unknown>): number {
  if (objective === 'awareness') return Number(metrics.reach || 0);
  if (objective === 'traffic') return Number(metrics.clicks || 0);
  if (objective === 'engagement') return Number(metrics.engagements || 0);
  if (objective === 'leads') return metrics.leads == null ? Number.NaN : Number(metrics.leads);
  if (objective === 'app_promotion') return Number(metrics.installs || metrics.conversions || 0);
  return Number(metrics.conversions || 0);
}

function utcIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const raw = String(value).trim();
  const timezoneAware = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw);
  const parsed = new Date(timezoneAware ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}


export { getCampaignAnalytics, getCampaignPerformanceTrends, getTopHooksAndHashtags, compareCampaigns } from './legacyCampaignAnalyticsController.js';

export async function startAnalyticsPolling(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(req as any).user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    return res.status(409).json({
      success: false,
      message: "Analytics polling is managed by the server scheduler.",
    });
  } catch (error) {
    logger.error({ err: error }, 'Start analytics polling error');
    res.status(500).json({ 
      success: false, 
      message: "Unable to start analytics polling. Please try again." 
    });
  }
}

/**
 * Stop analytics polling
 * POST /api/campaign-analytics/polling/stop
 */
export async function stopAnalyticsPolling(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(req as any).user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    return res.status(409).json({
      success: false,
      message: "Analytics polling is managed by the server scheduler.",
    });
  } catch (error) {
    logger.error({ err: error }, 'Stop analytics polling error');
    res.status(500).json({ 
      success: false, 
      message: "Unable to stop analytics polling. Please try again." 
    });
  }
}

/**
 * Manually trigger metrics fetch
 * POST /api/campaign-analytics/fetch
 */
export async function fetchMetricsNow(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const { dateStart, dateStop } = req.body;

    if ((dateStart !== undefined) !== (dateStop !== undefined)) {
      return res.status(400).json({ success: false, message: "dateStart and dateStop must be provided together" });
    }
    if (dateStart !== undefined && dateStop !== undefined) {
      if (!isReportingDate(dateStart) || !isReportingDate(dateStop)) {
        return res.status(400).json({ success: false, message: "Dates must use YYYY-MM-DD format" });
      }
      const start = new Date(`${dateStart}T00:00:00Z`);
      const stop = new Date(`${dateStop}T00:00:00Z`);
      const rangeDays = (stop.getTime() - start.getTime()) / 86_400_000;
      if (!Number.isFinite(rangeDays) || rangeDays < 0 || rangeDays > 90) {
        return res.status(400).json({ success: false, message: "Date range must be between 0 and 90 days" });
      }
    }
    
    const today = new Date().toISOString().split('T')[0];
    const range = { dateStart: dateStart ?? today, dateStop: dateStop ?? today };

    // The refresh calls Meta/Google for every campaign and then re-reviews
    // them, so it runs in the performance-sync worker. Repeated clicks join
    // the job already queued for the same window instead of stacking copies.
    const { queueRegistry, QUEUE_NAMES } = await import('../queues/index.js');
    const jobId = await queueRegistry.addJob<import('../queues/index.js').BaseJobPayload & { type: string; input: typeof range }>(
      QUEUE_NAMES.PERFORMANCE_SYNC, 'fetch-campaign-metrics',
      { userId, createdAt: new Date().toISOString(), type: 'fetch-campaign-metrics', input: range },
      {
        attempts: 1,
        deduplication: { id: `campaign-metrics-${userId}-${range.dateStart}-${range.dateStop}` },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 1000 },
      },
    );
    let result: CampaignMetricsRefresh | undefined;
    try {
      const output = await queueRegistry.waitForJobResult(QUEUE_NAMES.PERFORMANCE_SYNC, jobId, FETCH_NOW_WAIT_MS) as Partial<CampaignMetricsRefresh> | undefined;
      // A worker that predates this job type answers { success: true } without
      // running it; do not report that as "0 campaigns refreshed".
      if (typeof output?.metricsUpdated === 'number') result = output as CampaignMetricsRefresh;
      else logger.warn({ jobId }, 'fetch-now: worker returned no refresh result; is the worker up to date?');
    } catch (error) {
      if (!/timed out/i.test(error instanceof Error ? error.message : '')) throw error;
    }
    if (!result) {
      return res.status(202).json({
        success: true,
        queued: true,
        jobId,
        metricsUpdated: 0,
        errors: [],
        partialSuccess: false,
        message: 'Metrics refresh is still running. Updated figures appear here when it finishes.',
      });
    }
    const metricsUpdated = Number(result.metricsUpdated) || 0;
    const ingestionErrors = Array.isArray(result.errors) ? result.errors : [];

    if (metricsUpdated === 0 && ingestionErrors.length > 0) {
      return res.status(502).json({
        success: false,
        metricsUpdated: 0,
        errors: ingestionErrors,
        message: 'No campaign metrics could be refreshed. Check the connected ad account and try again.',
      });
    }

    res.json({
      success: true,
      metricsUpdated,
      errors: ingestionErrors,
      partialSuccess: ingestionErrors.length > 0,
      message: ingestionErrors.length > 0
        ? `Updated ${metricsUpdated} campaigns; ${ingestionErrors.length} refresh operation(s) failed`
        : `Fetched metrics for ${metricsUpdated} campaigns`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Fetch metrics error');
    res.status(500).json({ 
      success: false, 
      message: "Unable to retrieve metrics. Please try again." 
    });
  }
}

/**
 * Get ad set level metrics for a campaign
 * GET /api/campaign-analytics/adsets/:campaignId
 */
export async function getAdSetMetrics(req: AuthenticatedRequest, res: Response) {
  try {
    const { campaignId } = req.params;
    const { dateStart, dateStop } = req.query;
    
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const parsedCampaignId = Number(campaignId);
    if (!Number.isInteger(parsedCampaignId) || parsedCampaignId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid campaign ID" });
    }
    for (const value of [dateStart, dateStop]) {
      if (value !== undefined && (!isReportingDate(value))) {
        return res.status(400).json({ success: false, message: "Dates must use YYYY-MM-DD format" });
      }
    }
    
    if (dateStart && dateStop && String(dateStart) > String(dateStop)) {
      return res.status(400).json({ success: false, message: 'Start date must be on or before end date' });
    }
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_647
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (req.query.offset !== undefined && (typeof req.query.offset !== 'string' || !/^\d+$/.test(req.query.offset)))
      || (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^[1-9]\d*$/.test(req.query.limit)))) {
      return res.status(400).json({ success: false, message: 'Invalid metrics pagination' });
    }
    const metricsResult = await db.execute(sql`
      SELECT unit.platform, unit.target_type, unit.target_key, unit.provider_resource,
        unit.date AS metric_date, unit.impressions, unit.clicks, unit.spend,
        unit.conversions, unit.conversion_value, unit.reach,
        CASE WHEN unit.impressions > 0 THEN 100.0 * unit.clicks / unit.impressions ELSE 0 END AS ctr,
        CASE WHEN unit.clicks > 0 THEN unit.spend / unit.clicks ELSE 0 END AS cpc,
        unit.updated_at AS ingested_at
      FROM ad_unit_metrics unit
      JOIN performance_ad_campaigns pac ON pac.id = unit.campaign_id AND pac.user_id = unit.user_id
      WHERE pac.id = ${parsedCampaignId} AND pac.user_id = ${userId}
        AND unit.target_type IN ('ad_set', 'ad_group')
        ${dateStart ? sql`AND unit.date >= ${dateStart}::date` : sql``}
        ${dateStop ? sql`AND unit.date <= ${dateStop}::date` : sql``}
      ORDER BY unit.date DESC, unit.platform, unit.target_type, unit.target_key, unit.id
      LIMIT ${limit + 1} OFFSET ${offset}
    `);
    res.json({ success: true, campaignId: parsedCampaignId, grain: 'child_daily',
      metrics: metricsResult.rows.slice(0, limit),
      nextOffset: metricsResult.rows.length > limit ? offset + limit : null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Get adset metrics error');
    res.status(500).json({ 
      success: false, 
      message: "Unable to retrieve adset metrics. Please try again." 
    });
  }
}

/**
 * Get comprehensive ads analytics dashboard data
 * GET /api/ads-analytics/dashboard
 */
export async function getAdsDashboard(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const period = typeof req.query.period === 'string' ? req.query.period : '30d';
    if (!['7d', '30d', '90d'].includes(period)) {
      return res.status(400).json({ success: false, message: "Invalid analytics period" });
    }
    const comparison = typeof req.query.comparison === 'string' ? req.query.comparison : 'previous_period';
    if (!['previous_period', 'previous_year'].includes(comparison)) {
      return res.status(400).json({ success: false, message: "Invalid comparison period" });
    }
    const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
    const objective = typeof req.query.objective === 'string' ? req.query.objective : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (platform && !['meta', 'google'].includes(platform)) {
      return res.status(400).json({ success: false, message: "Invalid ad platform" });
    }
    if (objective && !['awareness', 'traffic', 'engagement', 'leads', 'sales', 'app_promotion', 'conversations', 'conversions'].includes(objective)) {
      return res.status(400).json({ success: false, message: "Invalid campaign objective" });
    }
    if (status && !['active', 'published', 'paused', 'report_only', 'provider_failed', 'draft'].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid campaign status" });
    }
    const accountId = typeof req.query.account === 'string' && /^\d+$/.test(req.query.account) ? Number(req.query.account) : null;
    if (req.query.account && !accountId) return res.status(400).json({message:'Invalid ad account'});
    let selectedAccount: import('../services/ads/PaidAdAccountsService.js').PaidAdAccount | null = null;
    if(accountId) {
      try { selectedAccount = await (await import('../services/ads/PaidAdAccountsService.js')).ownedPaidAdAccount(userId,accountId); }
      catch { return res.status(404).json({message:'Ad account not found'}); }
    }
    const managedAccountFilter = selectedAccount ? sql`AND pac.ad_platform=${selectedAccount.platform} AND REGEXP_REPLACE(COALESCE(pac.ad_account_id,''),'^act_','')=${selectedAccount.provider_account_id}` : sql``;
    const managedPlatformFilter = platform ? sql`AND (pac.ad_platform = ${platform} OR pac.ad_platform = 'multi')` : sql``;
    const metricPlatform = selectedAccount?.platform || platform;
    const metricPlatformFilter = metricPlatform ? sql`AND pm.platform = ${metricPlatform}` : sql``;
    const managedObjectiveFilter = objective ? sql`AND (CASE WHEN pac.ad_platform = 'google' THEN 'conversions' WHEN pac.objective ~* 'message|conversation' THEN 'conversations' ELSE pac.objective END) = ${objective}` : sql``;
    const managedStatusFilter = status === 'provider_failed'
      ? sql`AND LOWER(COALESCE(pac.provider_status, '')) LIKE '%fail%'`
      : status === 'report_only'
        ? sql`AND FALSE`
        : status
          ? status === 'draft' ? sql`AND LOWER(COALESCE(pac.local_status, pac.status, '')) = 'draft'` : status === 'active' ? sql`AND LOWER(COALESCE(NULLIF(pac.provider_status, ''), pac.local_status, pac.status, '')) IN ('active', 'enabled', 'published')` : sql`AND LOWER(COALESCE(NULLIF(pac.provider_status, ''), pac.local_status, pac.status, '')) = ${status}`
          : sql``;
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    const startDate = new Date(today);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
    const startDateStr = startDate.toISOString().split('T')[0];

    const [currencyRows, providerCurrencyRows] = await Promise.all([db.execute(sql`
      SELECT DISTINCT UPPER(COALESCE(currency, 'USD')) AS currency
      FROM performance_ad_campaigns
      WHERE user_id = ${userId}
      ORDER BY currency
    `), db.execute(sql`
      SELECT 'meta' AS platform, UPPER(ad_account_currency) AS currency
      FROM meta_page_connections
      WHERE user_id = ${userId} AND is_active = TRUE AND ad_account_currency IS NOT NULL
      UNION
      SELECT 'google' AS platform,
        UPPER(COALESCE(NULLIF(config->>'currency', ''), NULLIF(config->>'currencyCode', ''))) AS currency
      FROM api_credentials
      WHERE user_id = ${userId} AND service_name = 'google_ads' AND is_active = TRUE
        AND COALESCE(NULLIF(config->>'currency', ''), NULLIF(config->>'currencyCode', '')) IS NOT NULL
      UNION SELECT platform, UPPER(currency) FROM paid_ad_accounts WHERE user_id=${userId} AND is_active=TRUE AND currency IS NOT NULL
    `)]);
    const providerCurrencyByPlatform = new Map<string, string>();
    for (const provider of ['meta','google']) {
      const currencies = [...new Set((providerCurrencyRows.rows as Array<Record<string,unknown>>).filter(row=>row.platform===provider).map(row=>String(row.currency)))];
      if(currencies.length===1) providerCurrencyByPlatform.set(provider,currencies[0]);
    }
    const availableCurrencies = [...new Set([...currencyRows.rows, ...providerCurrencyRows.rows]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((row: any) => String(row.currency || '').toUpperCase())
      .filter((currency: string) => /^[A-Z]{3}$/.test(currency)))]
      .sort();
    const requestedCurrency = typeof req.query.currency === 'string'
      ? req.query.currency.toUpperCase()
      : undefined;
    if (!selectedAccount && requestedCurrency && !availableCurrencies.includes(requestedCurrency)) {
      return res.status(400).json({ success: false, message: "Currency is not available for this account" });
    }
    const selectedCurrency = selectedAccount?.currency || requestedCurrency || availableCurrencies[0] || 'USD';
    
    // Get all user's campaigns with metrics
    const campaignsWithMetrics = await db.execute(sql`
      SELECT 
        pac.id,
        pac.name,
        pac.local_status,
        pac.provider_status,
        pac.objective,
        pac.ad_platform,
        UPPER(COALESCE(pac.currency, 'USD')) AS currency,
        pac.budget_type,
        pac.budget_amount,
        pac.platform_campaign_id,
        pac.ad_account_id,
        pac.created_at,
        TO_CHAR(MAX(pm.updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS metrics_updated_at,
        (
          SELECT evaluation.state FROM ad_performance_evaluations evaluation
          WHERE evaluation.campaign_id = pac.id AND evaluation.user_id = ${userId}
          ORDER BY evaluation.created_at DESC LIMIT 1
        ) AS ai_state,
        (
          SELECT TO_CHAR(evaluation.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM ad_performance_evaluations evaluation
          WHERE evaluation.campaign_id = pac.id AND evaluation.user_id = ${userId}
          ORDER BY evaluation.created_at DESC LIMIT 1
        ) AS last_evaluation_at,
        (
          SELECT COALESCE(evaluation.baseline_metrics, '{}'::jsonb)
            || COALESCE(evaluation.rule_results, '{}'::jsonb)
          FROM ad_performance_evaluations evaluation
          WHERE evaluation.campaign_id = pac.id AND evaluation.user_id = ${userId}
          ORDER BY evaluation.created_at DESC LIMIT 1
        ) AS baseline_metrics,
        COALESCE((
          SELECT policy.enabled FROM ad_campaign_autonomy_policies policy
          WHERE policy.campaign_id = pac.id AND policy.user_id = ${userId} LIMIT 1
        ), FALSE) AS campaign_ai_consent,
        (
          SELECT COUNT(*) FROM ad_recommendations recommendation
          WHERE recommendation.campaign_id = pac.id AND recommendation.user_id = ${userId}
            AND recommendation.status = 'open'
        ) AS open_recommendations,
        (
          SELECT COUNT(*)
          FROM ad_analytics_sync_runs sync_run
          WHERE sync_run.campaign_id = pac.id
            AND sync_run.user_id = ${userId}
            AND sync_run.status = 'failed'
            AND sync_run.completed_at >= ${startDateStr}::date
            AND sync_run.completed_at > COALESCE((
              SELECT MAX(recovered.completed_at) FROM ad_analytics_sync_runs recovered
              WHERE recovered.user_id = ${userId} AND recovered.campaign_id = pac.id
                AND recovered.status = 'succeeded'
            ), '-infinity'::timestamptz)
        ) AS failed_syncs,
        (
          SELECT sync_run.error
          FROM ad_analytics_sync_runs sync_run
          WHERE sync_run.campaign_id = pac.id
            AND sync_run.user_id = ${userId}
            AND sync_run.status = 'failed'
            AND sync_run.completed_at > COALESCE((
              SELECT MAX(recovered.completed_at) FROM ad_analytics_sync_runs recovered
              WHERE recovered.user_id = ${userId} AND recovered.campaign_id = pac.id
                AND recovered.status = 'succeeded'
            ), '-infinity'::timestamptz)
          ORDER BY sync_run.completed_at DESC
          LIMIT 1
        ) AS last_sync_error,
        COALESCE(SUM(pm.impressions), 0) as total_impressions,
        COALESCE(SUM(pm.clicks), 0) as total_clicks,
        COALESCE(SUM(pm.spend), 0) as total_spend,
        COALESCE(SUM(pm.reach), 0) as total_reach,
        COALESCE(SUM(pm.conversions), 0) as total_conversions,
        COALESCE(SUM(pm.conversion_value), 0) as total_conversion_value,
        COALESCE(SUM(pm.post_engagements), 0) as total_engagements,
        CASE WHEN COUNT(pm.id) > 0 AND COUNT(pm.platform_data->>'leads') = COUNT(pm.id) THEN SUM(pm.leads) END as total_leads,
        CASE WHEN SUM(pm.impressions) > 0 
          THEN ROUND((SUM(pm.clicks)::decimal / SUM(pm.impressions)) * 100, 2) 
          ELSE 0 END as ctr,
        CASE WHEN SUM(pm.clicks) > 0 
          THEN ROUND(SUM(pm.spend)::decimal / SUM(pm.clicks), 2) 
          ELSE 0 END as cpc,
        CASE WHEN SUM(pm.impressions) > 0 
          THEN ROUND((SUM(pm.spend)::decimal / SUM(pm.impressions)) * 1000, 2) 
          ELSE 0 END as cpm
      FROM performance_ad_campaigns pac
      LEFT JOIN performance_metrics pm ON pm.campaign_id = pac.id 
        AND pm.date >= ${startDateStr}
        AND pm.date <= ${todayStr}
        AND pm.hour IS NULL
        ${metricPlatformFilter}
      WHERE pac.user_id = ${userId}
        AND UPPER(COALESCE(pac.currency, 'USD')) = ${selectedCurrency}
        ${managedPlatformFilter}
        ${managedAccountFilter}
        ${managedObjectiveFilter}
        ${managedStatusFilter}
      GROUP BY pac.id
      ORDER BY pac.created_at DESC
    `);
    const cachedProviderCampaigns = await db.execute(sql`
      SELECT cache.*, account.id AS account_registry_id FROM campaign_performance_cache cache
      LEFT JOIN paid_ad_accounts account ON account.user_id=cache.user_id AND account.platform=cache.platform AND account.provider_account_id=cache.ad_account_id AND account.is_active=TRUE
      WHERE cache.user_id = ${userId} AND cache.entity_type = 'campaign'
      ORDER BY cache.last_refreshed_at DESC, cache.id DESC
    `);
    const ownedManaged = await db.execute(sql`SELECT ad_platform,platform_campaign_id,ad_account_id FROM performance_ad_campaigns WHERE user_id=${userId} AND platform_campaign_id IS NOT NULL`);
    const managedProviderKeys = new Set((ownedManaged.rows as Array<Record<string,unknown>>).map(row=>`${String(row.ad_platform)}:${String(row.ad_account_id || "*").replace(/^act_/,"")}:${String(row.platform_campaign_id)}`));
    const providerOnlyRows = (cachedProviderCampaigns.rows as Array<Record<string, unknown>>).flatMap((row) => {
      const platform = String(row.platform || 'meta');
      if (managedProviderKeys.has(`${platform}:${String(row.ad_account_id || "")}:${String(row.platform_entity_id)}`) || managedProviderKeys.has(`${platform}:*:${String(row.platform_entity_id)}`)) return [];
      if (req.query.platform && platform !== String(req.query.platform)) return [];
      const raw = row.raw_data && typeof row.raw_data === 'object'
        ? row.raw_data as Record<string, unknown>
        : {};
      const identity = raw.accountIdentity && typeof raw.accountIdentity === 'object' ? raw.accountIdentity as Record<string,unknown> : {};
      if(selectedAccount && (platform!==selectedAccount.platform || String(identity.adAccountId || '').replace(/^act_/,'')!==selectedAccount.provider_account_id)) return [];
      const rowCurrency = String(identity.currency || providerCurrencyByPlatform.get(platform) || selectedCurrency).toUpperCase();
      if(rowCurrency!==selectedCurrency) return [];
      const providerCampaign = raw.campaign && typeof raw.campaign === 'object'
        ? raw.campaign as Record<string, unknown>
        : {};
      const normalizedObjective = normalizeProviderObjective(providerCampaign.objective);
      const providerStatus = String(row.status || 'unknown').toLowerCase();
      const reportingObjective = /MESSAGE|CONVERSATION/i.test(String(providerCampaign.objective)) ? 'conversations' : platform === 'google' ? 'conversions' : normalizedObjective;
      if (objective && reportingObjective !== objective) return [];
      if (status === 'draft') return [];
      if (status && status !== 'report_only' && status !== providerStatus && !(status === 'active' && ['active', 'enabled', 'published'].includes(providerStatus)) && !(status === 'provider_failed' && providerStatus.includes('fail'))) return [];
      const windowMetrics = aggregateProviderReportingWindow(raw, startDateStr, todayStr);
      return [{
        id: `provider:${platform}:${String(row.ad_account_id || "")}:${String(row.platform_entity_id)}`,
        source: 'provider_cache',
        name: row.name || 'Unnamed campaign',
        local_status: 'report_only',
        provider_status: row.status || 'unknown',
        objective: /MESSAGE|CONVERSATION/i.test(String(providerCampaign.objective)) ? 'conversations' : platform === 'google' ? 'conversions' : normalizedObjective,
        ad_platform: platform,
        currency: rowCurrency,
        budget_type: providerCampaign.budgetType || (providerCampaign.lifetime_budget ? 'lifetime' : 'daily'),
        budget_amount: providerCampaign.budgetAmount != null ? Number(providerCampaign.budgetAmount) : Number(providerCampaign.lifetime_budget || providerCampaign.daily_budget || 0) / 100,
        platform_campaign_id: row.platform_entity_id,
        ad_account_id: row.ad_account_id,
        account_registry_id: row.account_registry_id,
        created_at: providerCampaign.created_time || row.created_at,
        metrics_updated_at: row.last_refreshed_at,
        failed_syncs: 0,
        last_sync_error: null,
        ai_state: 'insufficient_data',
        campaign_ai_consent: false,
        last_evaluation_at: null,
        open_recommendations: 0,
        total_impressions: windowMetrics.impressions,
        total_clicks: windowMetrics.clicks,
        total_spend: windowMetrics.spend,
        total_reach: windowMetrics.reach,
        total_conversions: windowMetrics.conversions,
        total_conversion_value: windowMetrics.conversionValue,
        total_engagements: windowMetrics.engagements,
        total_installs: windowMetrics.installs,
        total_leads: windowMetrics.leads,
        ctr: windowMetrics.ctr,
        cpc: windowMetrics.cpc,
        cpm: windowMetrics.cpm,
        baseline_metrics: {},
        provider_daily_insights: Array.isArray(raw.dailyInsights) ? raw.dailyInsights : [],
      }];
    });
    const allCampaignRows = [
      ...(campaignsWithMetrics.rows as Array<Record<string, unknown>>),
      ...providerOnlyRows,
    ];

    // Get daily trends
    const dailyTrends = await db.execute(sql`
      SELECT 
        pm.date,
        SUM(pm.impressions) as impressions,
        SUM(pm.clicks) as clicks,
        SUM(pm.spend) as spend,
        SUM(pm.reach) as reach,
        SUM(pm.conversions) as conversions
      FROM performance_metrics pm
      JOIN performance_ad_campaigns pac ON pac.id = pm.campaign_id
      WHERE pac.user_id = ${userId}
        AND UPPER(COALESCE(pac.currency, 'USD')) = ${selectedCurrency}
        ${managedPlatformFilter}
        ${managedAccountFilter}
        ${managedObjectiveFilter}
        ${managedStatusFilter}
        AND pm.date >= ${startDateStr}
        AND pm.date <= ${todayStr}
        AND pm.hour IS NULL
        ${metricPlatformFilter}
      GROUP BY pm.date
      ORDER BY pm.date ASC
    `);
    const trendByDate = new Map<string, { date: string; impressions: number; clicks: number; spend: number; reach: number; conversions: number }>();
    for (const row of dailyTrends.rows as Array<Record<string, unknown>>) {
      const date = String(row.date).slice(0, 10);
      trendByDate.set(date, {
        date,
        impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0),
        spend: Number(row.spend || 0), reach: Number(row.reach || 0), conversions: Number(row.conversions || 0),
      });
    }
    for (const campaign of providerOnlyRows) {
      for (const rawPoint of providerReportingRows({ dailyInsights: campaign.provider_daily_insights }, startDateStr, todayStr)) {
        const date = String(rawPoint.date || rawPoint.date_start || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDateStr || date > todayStr) continue;
        const point = trendByDate.get(date) || { date, impressions: 0, clicks: 0, spend: 0, reach: 0, conversions: 0 };
        point.impressions += Number(rawPoint.impressions || 0);
        point.clicks += Number(rawPoint.clicks || 0);
        point.spend += Number(rawPoint.spend || 0);
        point.reach += Number(rawPoint.reach || 0);
        point.conversions += Number(rawPoint.conversions || 0);
        trendByDate.set(date, point);
      }
    }

    // Get totals
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totals = (allCampaignRows as any[]).reduce((acc, c) => ({
      impressions: acc.impressions + parseInt(c.total_impressions || '0'),
      clicks: acc.clicks + parseInt(c.total_clicks || '0'),
      spend: acc.spend + parseFloat(c.total_spend || '0'),
      reach: acc.reach + parseInt(c.total_reach || '0'),
      conversions: acc.conversions + Number(c.total_conversions || 0),
    }), { impressions: 0, clicks: 0, spend: 0, reach: 0, conversions: 0 });

    // Calculate averages
    const avgCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
    const avgCpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
    const avgCpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;

    // Get previous period for comparison
    const prevStartDate = new Date(startDate);
    const prevEndDate = new Date(today);
    if (comparison === 'previous_year') {
      prevStartDate.setUTCFullYear(prevStartDate.getUTCFullYear() - 1);
      prevEndDate.setUTCFullYear(prevEndDate.getUTCFullYear() - 1);
    } else {
      prevStartDate.setUTCDate(prevStartDate.getUTCDate() - days);
      prevEndDate.setTime(startDate.getTime());
      prevEndDate.setUTCDate(prevEndDate.getUTCDate() - 1);
    }
    const prevStartDateStr = prevStartDate.toISOString().split('T')[0];
    const prevEndDateStr = prevEndDate.toISOString().split('T')[0];

    const prevPeriodTotals = await db.execute(sql`
      SELECT 
        COALESCE(SUM(pm.impressions), 0) as impressions,
        COALESCE(SUM(pm.clicks), 0) as clicks,
        COALESCE(SUM(pm.spend), 0) as spend,
        COALESCE(SUM(pm.reach), 0) as reach,
        COALESCE(SUM(pm.conversions), 0) as conversions
      FROM performance_metrics pm
      JOIN performance_ad_campaigns pac ON pac.id = pm.campaign_id
      WHERE pac.user_id = ${userId}
        AND UPPER(COALESCE(pac.currency, 'USD')) = ${selectedCurrency}
        ${managedPlatformFilter}
        ${managedAccountFilter}
        ${managedObjectiveFilter}
        ${managedStatusFilter}
        AND pm.date >= ${prevStartDateStr}
        AND pm.date <= ${prevEndDateStr}
        AND pm.hour IS NULL
        ${metricPlatformFilter}
    `);
    const previousCampaignTotals = await db.execute(sql`
      SELECT pm.campaign_id, pac.objective,
        COALESCE(SUM(pm.reach), 0) AS reach,
        COALESCE(SUM(pm.clicks), 0) AS clicks,
        COALESCE(SUM(pm.post_engagements), 0) AS engagements,
        COALESCE(SUM(pm.leads), 0) AS leads,
        COALESCE(SUM(pm.conversions), 0) AS conversions
      FROM performance_metrics pm
      JOIN performance_ad_campaigns pac ON pac.id = pm.campaign_id
      WHERE pac.user_id = ${userId}
        AND UPPER(COALESCE(pac.currency, 'USD')) = ${selectedCurrency}
        ${managedPlatformFilter}
        ${managedAccountFilter}
        ${managedObjectiveFilter}
        ${managedStatusFilter}
        AND pm.date >= ${prevStartDateStr}
        AND pm.date <= ${prevEndDateStr}
        AND pm.hour IS NULL
        ${metricPlatformFilter}
      GROUP BY pm.campaign_id, pac.objective
    `);
    const previousResultsByCampaign = new Map<number, number>(
      previousCampaignTotals.rows.map((row: Record<string, unknown>): [number, number] => [
        Number(row.campaign_id),
        primaryResultCount(String(row.objective), row),
      ]),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevTotals = { ...(prevPeriodTotals.rows[0] as Record<string, unknown> || {}) };
    for (const campaign of providerOnlyRows) {
      const previous = aggregateProviderReportingWindow({ dailyInsights: campaign.provider_daily_insights }, prevStartDateStr, prevEndDateStr);
      for (const key of ['impressions', 'clicks', 'spend', 'reach', 'conversions'] as const) prevTotals[key] = Number(prevTotals[key] || 0) + previous[key];
    }
    const prevImp = Number(prevTotals.impressions || 0);
    const prevClicks = Number(prevTotals.clicks || 0);
    const prevSpend = Number(prevTotals.spend || 0);

    // Calculate period-over-period changes
    const changes = {
      impressions: prevImp > 0 ? ((totals.impressions - prevImp) / prevImp) * 100 : null,
      clicks: prevClicks > 0 ? ((totals.clicks - prevClicks) / prevClicks) * 100 : null,
      spend: prevSpend > 0 ? ((totals.spend - prevSpend) / prevSpend) * 100 : null,
      ctr: prevImp > 0 ? avgCtr - ((prevClicks / prevImp) * 100) : null,
    };

    // Get top performing campaigns
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topCampaigns = (allCampaignRows as any[])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((c: any) => parseInt(c.total_impressions || '0') > 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sort((a: any, b: any) => parseFloat(b.ctr || '0') - parseFloat(a.ctr || '0'))
      .slice(0, 5);

    // Get campaign status distribution
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusCounts = (allCampaignRows as any[]).reduce((acc: Record<string, number>, c: any) => {
      const status = c.local_status || 'unknown';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const aiSummary = await adPerformanceService.dashboardSummary(userId);
    if (!aiSummary.dataFreshnessAt) {
      const newest = allCampaignRows
        .map(row => utcIso(row.metrics_updated_at))
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      aiSummary.dataFreshnessAt = newest || null;
    }
    res.json({
      success: true,
      period,
      comparison,
      currency: selectedCurrency,
      availableCurrencies,
      summary: {
        totalCampaigns: allCampaignRows.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        activeCampaigns: (allCampaignRows as any[]).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => ['ACTIVE', 'ENABLED', 'PUBLISHED'].includes(String(c.source === 'provider_cache' ? c.provider_status : c.local_status || '').toUpperCase())
        ).length,
        totalSpend: Math.round(totals.spend * 100) / 100,
        totalImpressions: totals.impressions,
        totalClicks: totals.clicks,
        totalReach: totals.reach,
        reachAggregation: 'sum_of_daily_reach',
        totalConversions: totals.conversions,
        avgCtr: Math.round(avgCtr * 100) / 100,
        avgCpc: Math.round(avgCpc * 100) / 100,
        avgCpm: Math.round(avgCpm * 100) / 100,
        changes: {
          impressions: providerOnlyRows.length || changes.impressions == null ? null : Math.round(changes.impressions * 10) / 10,
          clicks: providerOnlyRows.length || changes.clicks == null ? null : Math.round(changes.clicks * 10) / 10,
          spend: providerOnlyRows.length || changes.spend == null ? null : Math.round(changes.spend * 10) / 10,
          ctr: providerOnlyRows.length || changes.ctr == null ? null : Math.round(changes.ctr * 100) / 100,
        },
        includesProviderCache: providerOnlyRows.length > 0,
      },
      dailyTrends: [...trendByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      campaigns: (allCampaignRows as any[]).map((c: any) => ({
        id: c.id,
        source: c.source || 'managed',
        name: c.name,
        status: c.local_status,
        providerStatus: c.provider_status,
        objective: c.ad_platform === 'google' ? 'conversions' : c.objective,
        adPlatform: c.ad_platform,
        currency: c.currency,
        budgetType: c.budget_type,
        budgetAmount: parseFloat(c.budget_amount || '0'),
        platformCampaignId: c.platform_campaign_id,
        adAccountId: c.ad_account_id || null,
        accountRegistryId: c.account_registry_id || null,
        createdAt: c.created_at,
        metricsUpdatedAt: utcIso(c.metrics_updated_at),
        failedSyncs: Number(c.failed_syncs || 0),
        lastSyncError: c.last_sync_error,
        aiState: c.ai_state || 'insufficient_data',
        campaignAiConsent: c.campaign_ai_consent === true,
        lastEvaluationAt: c.last_evaluation_at,
        openRecommendations: Number(c.open_recommendations || 0),
        trend: c.source === 'provider_cache' ? null : previousResultsByCampaign.get(Number(c.id))
          ? ((primaryResultCount(String(c.objective), {
              reach: c.total_reach, clicks: c.total_clicks, engagements: c.total_engagements,
              leads: c.total_leads, conversions: c.total_conversions,
            }) - previousResultsByCampaign.get(Number(c.id))!)
            / previousResultsByCampaign.get(Number(c.id))!) * 100
          : primaryResultCount(String(c.objective), {
              reach: c.total_reach, clicks: c.total_clicks, engagements: c.total_engagements,
              leads: c.total_leads, conversions: c.total_conversions,
            }) > 0 ? 100 : 0,
        targetVariance: c.objective === 'leads' && c.total_leads == null ? null : calculateTargetVariance(c.objective, {
          spend: Number(c.total_spend || 0),
          impressions: Number(c.total_impressions || 0),
          clicks: Number(c.total_clicks || 0),
          conversions: Number(c.total_conversions || 0),
          engagementRate: Number(c.total_impressions || 0) > 0
            ? Number(c.total_engagements || 0) / Number(c.total_impressions) * 100 : 0,
          cpa: Number((c.objective === 'leads' ? c.total_leads : c.total_conversions) || 0) > 0
            ? Number(c.total_spend || 0) / Number(c.objective === 'leads' ? c.total_leads : c.total_conversions) : 0,
          roas: Number(c.total_spend || 0) > 0
            ? Number(c.total_conversion_value || 0) / Number(c.total_spend) : 0,
          ctr: Number(c.ctr || 0),
          cpc: Number(c.cpc || 0),
          cpm: Number(c.cpm || 0),
        }, c.baseline_metrics),
        metrics: {
          impressions: parseInt(c.total_impressions || '0'),
          clicks: parseInt(c.total_clicks || '0'),
          spend: parseFloat(c.total_spend || '0'),
          reach: parseInt(c.total_reach || '0'),
          conversions: Number(c.total_conversions || 0),
          conversionValue: parseFloat(c.total_conversion_value || '0'),
          engagements: parseInt(c.total_engagements || '0'),
          leads: c.total_leads == null ? null : Number(c.total_leads),
          installs: c.source === 'provider_cache' ? Number(c.total_installs || 0) : c.objective === 'app_promotion' ? parseFloat(c.total_conversions || '0') : 0,
          ctr: parseFloat(c.ctr || '0'),
          cpc: parseFloat(c.cpc || '0'),
          cpm: parseFloat(c.cpm || '0'),
        },
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      topCampaigns: topCampaigns.map((c: any) => ({
        id: c.id,
        name: c.name,
        ctr: parseFloat(c.ctr || '0'),
        clicks: parseInt(c.total_clicks || '0'),
        spend: parseFloat(c.total_spend || '0'),
      })),
      statusDistribution: statusCounts,
      aiSummary,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Get ads dashboard error');
    res.status(500).json({ 
      success: false, 
      message: "Unable to retrieve the ads dashboard. Please try again." 
    });
  }
}

/**
 * Get campaign performance time series
 * GET /api/ads-analytics/campaign/:campaignId/trends
 */
export async function getCampaignTrends(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const { campaignId } = req.params;
    const { period = '30d', granularity = 'daily' } = req.query;
    const parsedCampaignId = Number(campaignId);
    if (!Number.isInteger(parsedCampaignId) || parsedCampaignId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid campaign ID" });
    }
    if (typeof period !== 'string' || !['7d', '30d', '90d'].includes(period)) {
      return res.status(400).json({ success: false, message: "Invalid analytics period" });
    }
    if (granularity !== 'daily' && granularity !== 'hourly') {
      return res.status(400).json({ success: false, message: "Invalid analytics granularity" });
    }
    
    const { start: startDateStr, end: endDateStr } = reportingPeriod(period as '7d' | '30d' | '90d');

    let trends;
    if (granularity === 'hourly') {
      // Get hourly data for the last 24 hours
      trends = await db.execute(sql`
        SELECT 
          pm.date,
          pm.hour,
          pm.impressions,
          pm.clicks,
          pm.spend,
          pm.reach,
          pm.conversions,
          pm.ctr,
          pm.cpc
        FROM performance_metrics pm
        JOIN performance_ad_campaigns pac ON pac.id = pm.campaign_id
        WHERE pac.id = ${parsedCampaignId}
          AND pac.user_id = ${userId}
          AND (pm.date::timestamp + pm.hour * INTERVAL '1 hour') >= NOW() - INTERVAL '24 hours'
          AND (pm.date::timestamp + pm.hour * INTERVAL '1 hour') <= NOW()
          AND pm.hour IS NOT NULL
        ORDER BY pm.date ASC, pm.hour ASC
      `);
    } else {
      trends = await db.execute(sql`
        SELECT 
          pm.date,
          pm.impressions,
          pm.clicks,
          pm.spend,
          pm.reach,
          pm.conversions,
          pm.ctr,
          pm.cpc
        FROM performance_metrics pm
        JOIN performance_ad_campaigns pac ON pac.id = pm.campaign_id
        WHERE pac.id = ${parsedCampaignId}
          AND pac.user_id = ${userId}
          AND pm.date >= ${startDateStr}
          AND pm.date <= ${endDateStr}
          AND pm.hour IS NULL
        ORDER BY pm.date ASC
      `);
    }

    res.json({
      success: true,
      campaignId: parsedCampaignId,
      period,
      granularity,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trends: trends.rows.map((row: any) => ({
        date: row.date,
        hour: row.hour,
        impressions: parseInt(row.impressions || '0'),
        clicks: parseInt(row.clicks || '0'),
        spend: parseFloat(row.spend || '0'),
        reach: parseInt(row.reach || '0'),
        conversions: Number(row.conversions || 0),
        ctr: parseFloat(row.ctr || '0'),
        cpc: parseFloat(row.cpc || '0'),
      })),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Get campaign trends error');
    res.status(500).json({ 
      success: false, 
      message: "Unable to retrieve campaign trends. Please try again." 
    });
  }
}

/**
 * Get campaign comparison data
 * POST /api/ads-analytics/compare
 */
export async function compareAdCampaigns(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const { campaignIds, period = '30d' } = req.body;
    
    if (!campaignIds || !Array.isArray(campaignIds) || campaignIds.length < 2) {
      return res.status(400).json({ success: false, message: "At least 2 campaign IDs required" });
    }
    if (campaignIds.length > 5) {
      return res.status(400).json({ success: false, message: "A maximum of 5 campaigns can be compared" });
    }
    const normalizedCampaignIds = [...new Set(campaignIds.map(Number))];
    if (
      normalizedCampaignIds.length < 2 ||
      normalizedCampaignIds.some((id) => !Number.isInteger(id) || id <= 0)
    ) {
      return res.status(400).json({ success: false, message: "Campaign IDs must be unique positive integers" });
    }
    if (!['7d', '30d', '90d'].includes(period)) {
      return res.status(400).json({ success: false, message: "Invalid analytics period" });
    }
    
    const { start: startDateStr, end: endDateStr } = reportingPeriod(period as '7d' | '30d' | '90d');

    const comparison = await db.execute(sql`
      SELECT 
        pac.id,
        pac.name,
        pac.status,
        pac.objective,
        UPPER(COALESCE(pac.currency, 'USD')) AS currency,
        COALESCE(SUM(pm.impressions), 0) as impressions,
        COALESCE(SUM(pm.clicks), 0) as clicks,
        COALESCE(SUM(pm.spend), 0) as spend,
        COALESCE(SUM(pm.reach), 0) as reach,
        COALESCE(SUM(pm.conversions), 0) as conversions,
        CASE WHEN SUM(pm.impressions) > 0 
          THEN ROUND((SUM(pm.clicks)::decimal / SUM(pm.impressions)) * 100, 2) 
          ELSE 0 END as ctr,
        CASE WHEN SUM(pm.clicks) > 0 
          THEN ROUND(SUM(pm.spend)::decimal / SUM(pm.clicks), 2) 
          ELSE 0 END as cpc
      FROM performance_ad_campaigns pac
      LEFT JOIN performance_metrics pm ON pm.campaign_id = pac.id 
        AND pm.date >= ${startDateStr}
          AND pm.date <= ${endDateStr}
        AND pm.hour IS NULL
      WHERE pac.user_id = ${userId}
        AND pac.id = ANY(${sql.param(normalizedCampaignIds)}::int[])
      GROUP BY pac.id ORDER BY pac.id
    `);

    res.json({
      success: true,
      period,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      comparison: comparison.rows.map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        currency: c.currency,
        impressions: parseInt(c.impressions || '0'),
        clicks: parseInt(c.clicks || '0'),
        spend: parseFloat(c.spend || '0'),
        reach: parseInt(c.reach || '0'),
        conversions: Number(c.conversions || 0),
        ctr: parseFloat(c.ctr || '0'),
        cpc: parseFloat(c.cpc || '0'),
      })),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Compare ad campaigns error');
    res.status(500).json({ 
      success: false, 
      message: "Unable to compare campaigns. Please try again." 
    });
  }
}
