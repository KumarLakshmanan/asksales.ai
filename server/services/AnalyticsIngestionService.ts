import { forEachBusiness } from '../tenancy/businessScopeResolver.js';
/**
 * Analytics Ingestion Service
 * Fetches metrics from ad platforms and stores in database
 * Includes periodic polling for real-time analytics updates
 */

import { db } from '../models/db';
import { sql, type SQL } from 'drizzle-orm';
import { withStatementTimeoutAtMost } from '../tenancy/statementTimeout.js';
import { createMetaAdsService, type MetaCredentials } from './ads/MetaAdsService';
import { logger } from '../utils/logger.js';
import { ANALYTICS_POLL_INTERVAL_MS } from '../utils/timingConstants';
import { normalizeGoogleMetric, normalizeMetaMetric } from './ads/AutonomousAdsDomain.js';
import { sleep } from '../utils/sleep.js';

// Polling interval — from centralized constants
const DEFAULT_POLL_INTERVAL = ANALYTICS_POLL_INTERVAL_MS;

export interface MetricRecord {
  campaignId: number; // Our internal campaign ID
  userId: number;
  platformCampaignId: string; // Platform's campaign ID
  platform: 'meta' | 'google';
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  leads?: number | null;
  cpc: number;
  ctr: number;
  costPerConversion?: number;
  reach?: number;
  frequency?: number;
  conversionValue?: number;
  engagements?: number;
  cpm?: number;
  cpa?: number;
  roas?: number;
  providerStatus?: string;
  source?: unknown;
}

export interface IngestionResult {
  success: boolean;
  metricsIngested: number;
  errors?: string[];
}

/** Upper bound for selecting the campaigns to sync (one cycle, all tenants). */
export const CAMPAIGN_SELECTION_TIMEOUT_MS = 60_000;

/**
 * True when the campaign synced recently enough under its tenant schedule:
 * `analytics_sync_minutes` (default 15), doubled for each failure since the
 * last success (at most 7 doublings), capped at one day.
 *
 * Computed once per campaign and platform from the latest run, the latest
 * success and at most seven later failures. Each lookup is a short descent of
 * ad_analytics_sync_runs_backoff_lookup_idx (migration 588). The previous form
 * recomputed the failure count and the latest success for every historical
 * run, which grew with the square of the run history.
 */
function syncedRecently(platform: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM (
      SELECT
        (SELECT latest.completed_at FROM ad_analytics_sync_runs latest
          WHERE latest.user_id = pac.user_id AND latest.campaign_id = pac.id AND latest.platform = ${platform}
          ORDER BY latest.completed_at DESC LIMIT 1) AS last_completed_at,
        (SELECT LEAST(7, COUNT(*)) FROM (
          SELECT 1 FROM ad_analytics_sync_runs failed
          WHERE failed.user_id = pac.user_id AND failed.campaign_id = pac.id AND failed.platform = ${platform}
            AND failed.status = 'failed'
            AND failed.completed_at > COALESCE((
              SELECT recovered.completed_at FROM ad_analytics_sync_runs recovered
              WHERE recovered.user_id = pac.user_id AND recovered.campaign_id = pac.id
                AND recovered.platform = ${platform} AND recovered.status = 'succeeded'
              ORDER BY recovered.completed_at DESC LIMIT 1
            ), '-infinity'::timestamp)
          LIMIT 7
        ) recent_failures) AS failures
    ) sync
    WHERE sync.last_completed_at > NOW() - (
      LEAST(1440, COALESCE((
        SELECT analytics_sync_minutes FROM ad_settings WHERE user_id = pac.user_id
      ), 15) * POWER(2, sync.failures)) * INTERVAL '1 minute'
    )
  )`;
}

/** Campaigns to sync. New multi-platform campaigns use ad_provider_resources;
 * the UNION keeps legacy single-platform rows in explicit managed scope
 * without importing unrelated provider campaigns. */
export function managedCampaignsQuery(userId: number | undefined, respectTenantSchedule: boolean): SQL {
  const owner = userId ? sql`AND pac.user_id = ${userId}` : sql``;
  const managedPlatform = sql`apr.platform`;
  const legacyPlatform = sql`(CASE WHEN pac.ad_platform = 'facebook' THEN 'meta' ELSE pac.ad_platform END)`;
  return sql`
    SELECT
      pac.id,
      pac.user_id,
      apr.platform,
      COALESCE(apr.provider_resource_name, apr.provider_resource_id) AS platform_campaign_id
    FROM performance_ad_campaigns pac
    JOIN ad_provider_resources apr
      ON apr.campaign_id = pac.id
     AND apr.user_id = pac.user_id
     AND apr.resource_type = 'campaign'
     AND apr.status IN ('created', 'active', 'paused')
    WHERE pac.local_status IN ('published', 'active', 'paused')
      AND COALESCE(apr.provider_resource_name, apr.provider_resource_id) IS NOT NULL
      ${owner}
      ${respectTenantSchedule ? sql`AND NOT ${syncedRecently(managedPlatform)}` : sql``}

    UNION ALL

    SELECT pac.id, pac.user_id, pac.ad_platform, pac.platform_campaign_id
    FROM performance_ad_campaigns pac
    WHERE pac.ad_platform IN ('meta', 'facebook', 'google')
      AND LOWER(pac.status) IN ('published', 'active', 'paused')
      AND pac.platform_campaign_id IS NOT NULL
      ${owner}
      ${respectTenantSchedule ? sql`AND NOT ${syncedRecently(legacyPlatform)}` : sql``}
      AND NOT EXISTS (
        SELECT 1 FROM ad_provider_resources apr
        WHERE apr.campaign_id = pac.id
          AND apr.resource_type = 'campaign'
      )
  `;
}

// One poll at a time per process. The worker builds a new service per job, so
// an instance flag did not stop overlapping cycles.
let pollInFlight = false;

/**
 * AnalyticsIngestionService - Fetches and stores ad metrics
 */
export class AnalyticsIngestionService {
  private static _instance: AnalyticsIngestionService | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;

  /**
   * Start periodic polling for campaign analytics
   * @param interval Polling interval in ms (default: 5 minutes)
   */
  startPolling(interval: number = DEFAULT_POLL_INTERVAL): void {
    if (this.pollingInterval) {
      logger.info('[AnalyticsIngestionService] Polling already running');
      return;
    }

    logger.info({ interval1000: interval / 1000 }, '[AnalyticsIngestionService] Starting analytics polling every s');
    
    // Initial poll
    void forEachBusiness(() => this.pollForMetrics()).catch(err => logger.error({ err }, '[AnalyticsIngestion] Business polling failed'));

    // Set up interval
    this.pollingInterval = setInterval(() => {
      void forEachBusiness(() => this.pollForMetrics()).catch(err => logger.error({ err }, '[AnalyticsIngestion] Business polling failed'));
    }, interval);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logger.info('[AnalyticsIngestionService] Analytics polling stopped');
    }
  }

  /**
   * Poll for metrics - fetches recent metrics for all active campaigns
   */
  async pollForMetrics(): Promise<{ success: boolean; campaignsUpdated: number; errors?: string[] }> {
    if (this.isPolling || pollInFlight) {
      logger.info('[AnalyticsIngestionService] Already polling, skipping');
      return { success: true, campaignsUpdated: 0 };
    }

    this.isPolling = true;
    pollInFlight = true;
    const errors: string[] = [];
    let campaignsUpdated = 0;

    try {
      logger.info('[AnalyticsIngestionService] Starting metrics poll');

      // Get today's date for polling
      const today = new Date().toISOString().split('T')[0];
      // Reconcile delayed attribution and recent provider corrections on every cycle.
      const start = new Date(); start.setUTCDate(start.getUTCDate() - 7);
      const result = await this.ingestAllCampaigns(start.toISOString().slice(0, 10), today, undefined, true);
      campaignsUpdated = result.metricsIngested;

      if (result.errors) {
        errors.push(...result.errors);
      }

      logger.info({ campaignsUpdated: campaignsUpdated }, '[AnalyticsIngestionService] Poll complete - updated campaigns');
      await this.enqueueLifetimeCapPauses();

      return {
        success: result.success,
        campaignsUpdated,
        errors: errors.length > 0 ? errors : undefined,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[AnalyticsIngestionService] Poll error');
      return {
        success: false,
        campaignsUpdated: 0,
        errors: [error.message],
      };
    } finally {
      this.isPolling = false;
      pollInFlight = false;
    }
  }

  /**
   * Ingest metrics for all active campaigns
   */
  async ingestAllCampaigns(
    dateStart: string,
    dateStop: string,
    userId?: number,
    respectTenantSchedule = false,
  ): Promise<IngestionResult> {
    logger.info({ dateStart: dateStart, dateStop: dateStop }, '[AnalyticsIngestionService] Ingesting metrics from to');

    try {
      // Campaigns due for a sync (see managedCampaignsQuery). Bounded and cheap by construction: a slow plan here once ran for
      // 16-21 minutes, held pool connections and blocked a migration.
      const campaignsResult = await withStatementTimeoutAtMost(
        CAMPAIGN_SELECTION_TIMEOUT_MS,
        // Drizzle queries start on await: await inside so the connection is
        // checked out (and the bound applied) within this context.
        async () => await db.execute(managedCampaignsQuery(userId, respectTenantSchedule)),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const campaigns = campaignsResult.rows as any[];
      let metricsIngested = 0;
      const errors: string[] = [];

      // Phase 3.13 / PERF-002: process up to 5 campaigns in parallel to
      // shrink wall-clock time for cron runs without exceeding Meta's
      // recommended ~5 RPS per app.
      const CONCURRENCY = 5;
      let cursor = 0;
      // Use a closure variable updated only after await — single-threaded
      // JS guarantees no torn writes within a microtask.
      const workers = Array.from({ length: Math.min(CONCURRENCY, campaigns.length) }, async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= campaigns.length) return;
          const campaign = campaigns[idx];
          let succeeded = 0;
          try {
            if (campaign.platform === 'meta' || campaign.platform === 'facebook') {
              // Resolve the account bound to this campaign without changing publishing defaults.
              const { resolveCampaignMetaCredentials } = await import('./ads/PaidAdAccountsService.js');
              const credentials = await resolveCampaignMetaCredentials(Number(campaign.user_id), Number(campaign.id));
              if (!credentials) throw new Error('Reconnect Meta Ads and select an ad account before syncing campaign metrics.');

              const result = await this.ingestMetaCampaign(
                campaign.id,
                Number(campaign.user_id),
                campaign.platform_campaign_id,
                { accessToken: credentials.accessToken, adAccountId: credentials.adAccountId, expiresAt: credentials.expiresAt || undefined },
                dateStart,
                dateStop
              );
              if (result.success) succeeded = 1;
              else errors.push(`Campaign ${campaign.id}: ${result.error || 'Meta analytics ingestion failed'}`);
            } else if (campaign.platform === 'google') {
              const { resolveCampaignGoogleCredentials } = await import('./ads/PaidAdAccountsService.js');
              const credentials = await resolveCampaignGoogleCredentials(Number(campaign.user_id), Number(campaign.id));
              if (!credentials) {
                errors.push(`Campaign ${campaign.id}: Google Ads credentials are unavailable`);
                await this.recordSyncRun(
                  campaign.id,
                  Number(campaign.user_id),
                  'google',
                  dateStart,
                  dateStop,
                  'failed',
                  0,
                  'Google Ads credentials are unavailable',
                );
              } else {
                const result = await this.ingestGoogleCampaign(
                  campaign.id,
                  Number(campaign.user_id),
                  campaign.platform_campaign_id,
                  credentials,
                  dateStart,
                  dateStop,
                );
                if (result.success) succeeded = 1;
                else errors.push(`Campaign ${campaign.id}: ${result.error || 'Google analytics ingestion failed'}`);
              }
            }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (error: any) {
            errors.push(`Campaign ${campaign.id}: ${error.message}`);
            const platform = campaign.platform === 'google' ? 'google' : 'meta';
            await this.recordSyncRun(
              campaign.id,
              Number(campaign.user_id),
              platform,
              dateStart,
              dateStop,
              'failed',
              0,
              error.message,
            );
          }
          // Mutate the shared counter only after the await chain resolves
          // so the read is always from a settled value.
          metricsIngested += succeeded;
        }
      });
      await Promise.all(workers);

      logger.info({ metricsIngested: metricsIngested }, '[AnalyticsIngestionService] Ingested metrics for campaigns');

      return {
        success: errors.length === 0,
        metricsIngested,
        errors: errors.length > 0 ? errors : undefined,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[AnalyticsIngestionService] Error ingesting metrics');
      return {
        success: false,
        metricsIngested: 0,
        errors: [error.message],
      };
    }
  }

  /**
   * Ingest metrics for a Meta campaign
   */
  async ingestMetaCampaign(
    campaignId: number,
    userId: number,
    platformCampaignId: string,
    credentials: MetaCredentials,
    dateStart: string,
    dateStop: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const metaService = createMetaAdsService(credentials);

      const objectiveResult = await db.execute(sql`SELECT objective FROM performance_ad_campaigns WHERE id=${campaignId} AND user_id=${userId} LIMIT 1`);
      const objective = String(objectiveResult.rows[0]?.objective || '');
      const metricsResult = await metaService.getCampaignMetricsByDateRange(platformCampaignId, dateStart, dateStop, objective);
      if (!metricsResult.success) throw new Error(metricsResult.error);
      for (const metric of metricsResult.metrics) {
        const normalized = normalizeMetaMetric(metric as unknown as Record<string, unknown>, metric.date);
        await this.storeMetrics({ ...normalized, campaignId, userId, platformCampaignId,
          date: metric.date, leads: metric.source.leads, engagements: metric.engagements });
      }
      const childResult = await metaService.getAdSetMetricsByDateRange(platformCampaignId, dateStart, dateStop, objective);
      if (!childResult.success) throw new Error(childResult.error || 'Meta ad set analytics ingestion failed');
      for (const child of childResult.metrics || []) {
        const childMetric = {
          campaignId,
          userId,
          platform: 'meta',
          providerResource: child.adSetId,
          date: child.date,
          impressions: child.impressions,
          clicks: child.clicks,
          spend: child.spend,
          conversions: child.conversions,
          conversionValue: child.conversionValue,
          providerStatus: child.status,
          source: child.source,
        } as const;
        await this.storeAllocationMetric(childMetric);
        await this.storeUnitMetric({
          ...childMetric,
          targetType: 'ad_set',
          reach: child.reach,
          engagements: child.engagements,
          installs: child.installs,
        });
      }
      const adResult = await metaService.getAdMetricsByDateRange(platformCampaignId, dateStart, dateStop, objective);
      if (!adResult.success) throw new Error(adResult.error || 'Meta ad analytics ingestion failed');
      for (const ad of adResult.metrics || []) {
        await this.storeUnitMetric({
          campaignId, userId, platform: 'meta', targetType: 'ad', providerResource: ad.adId,
          date: ad.date, impressions: ad.impressions, clicks: ad.clicks, spend: ad.spend,
          reach: ad.reach, conversions: ad.conversions, conversionValue: ad.conversionValue,
          engagements: ad.engagements, installs: ad.installs,
          providerStatus: ad.status, source: ad.source, parentProviderResource: ad.adSetId,
        });
      }
      await this.recordSyncRun(
        campaignId, userId, 'meta', dateStart, dateStop, 'succeeded',
        (metricsResult.metrics.length) + (childResult.metrics?.length || 0) + (adResult.metrics?.length || 0),
      );

      return { success: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({
        err: error,
        campaignId,
        userId,
        platformCampaignId,
        dateStart,
        dateStop,
      }, '[AnalyticsIngestionService] Error ingesting Meta campaign');
      await this.recordSyncRun(campaignId, userId, 'meta', dateStart, dateStop, 'failed', 0, error.message);
      return { success: false, error: error.message };
    }
  }

  async ingestGoogleCampaign(
    campaignId: number,
    userId: number,
    platformCampaignId: string,
    credentials: import('./ads/GoogleAdsService.js').GoogleAdsCredentials,
    dateStart: string,
    dateStop: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const objectiveResult = await db.execute(sql`
        SELECT objective FROM performance_ad_campaigns
        WHERE id = ${campaignId} AND user_id = ${userId} LIMIT 1
      `);
      const isAppPromotion = String(objectiveResult.rows[0]?.objective || '') === 'app_promotion';
      const { getCampaignMetricsByDateRange, getAdGroupMetricsByDateRange, getAdMetricsByDateRange } = await import('./ads/GoogleAdsService.js');
      const result = await getCampaignMetricsByDateRange(credentials, platformCampaignId, dateStart, dateStop);
      if (!result.success) throw new Error(result.error || 'Google Ads returned no metrics');
      for (const raw of result.metrics || []) {
        const normalized = normalizeGoogleMetric({ metrics: raw, status: raw.status }, raw.date);
        await this.storeMetrics({
          campaignId,
          userId,
          platformCampaignId,
          platform: 'google',
          date: raw.date,
          impressions: normalized.impressions,
          clicks: normalized.clicks,
          spend: normalized.spend,
          conversions: normalized.conversions,
          conversionValue: normalized.conversionValue,
          engagements: raw.engagements,
          cpc: normalized.cpc,
          cpm: normalized.cpm,
          ctr: normalized.ctr,
          costPerConversion: normalized.cpa,
          cpa: normalized.cpa,
          roas: normalized.roas,
          reach: normalized.reach,
          providerStatus: raw.status,
          source: raw,
        });
      }
      const childResult = await getAdGroupMetricsByDateRange(credentials, platformCampaignId, dateStart, dateStop);
      if (!childResult.success) throw new Error(childResult.error || 'Google ad group analytics ingestion failed');
      for (const child of childResult.metrics || []) {
        const childMetric = {
          campaignId,
          userId,
          platform: 'google',
          providerResource: child.adGroupResourceName,
          date: child.date,
          impressions: child.impressions,
          clicks: child.clicks,
          spend: child.costMicros / 1_000_000,
          conversions: child.conversions,
          conversionValue: child.conversionsValue,
          engagements: child.engagements,
          installs: isAppPromotion ? child.conversions : 0,
          providerStatus: child.status,
          source: child,
        } as const;
        await this.storeAllocationMetric(childMetric);
        await this.storeUnitMetric({ ...childMetric, targetType: 'ad_group' });
      }
      const adResult = await getAdMetricsByDateRange(credentials, platformCampaignId, dateStart, dateStop);
      if (!adResult.success) throw new Error(adResult.error || 'Google ad analytics ingestion failed');
      for (const ad of adResult.metrics || []) {
        await this.storeUnitMetric({
          campaignId, userId, platform: 'google', targetType: 'ad', providerResource: ad.adResourceName,
          date: ad.date, impressions: ad.impressions, clicks: ad.clicks,
          spend: ad.costMicros / 1_000_000, conversions: ad.conversions,
          conversionValue: ad.conversionsValue, providerStatus: ad.status, source: ad,
          engagements: ad.engagements, installs: isAppPromotion ? ad.conversions : 0,
          parentProviderResource: ad.adGroupResourceName,
        });
      }
      await this.recordSyncRun(
        campaignId,
        userId,
        'google',
        dateStart,
        dateStop,
        'succeeded',
        (result.metrics?.length || 0) + (childResult.metrics?.length || 0) + (adResult.metrics?.length || 0),
      );
      return { success: true };
    } catch (error: any) {
      logger.error({ campaignId, err: error }, '[AnalyticsIngestionService] Error ingesting Google campaign');
      await this.recordSyncRun(campaignId, userId, 'google', dateStart, dateStop, 'failed', 0, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Store metrics in database
   */
  private async storeMetrics(metrics: MetricRecord): Promise<void> {
    try {
      await db.execute(sql`
        INSERT INTO performance_metrics (
          campaign_id,
          user_id,
          platform_campaign_id,
          platform,
          date,
          hour,
          impressions,
          clicks,
          spend,
          conversions,
          leads,
          conversion_value,
          post_engagements,
          cpc,
          cpm,
          ctr,
          cpa,
          roas,
          reach,
          platform_data,
          source_scope,
          sync_status,
          provider_status,
          updated_at
        ) VALUES (
          ${metrics.campaignId},
          ${metrics.userId},
          ${metrics.platformCampaignId},
          ${metrics.platform},
          ${metrics.date}::date,
          NULL,
          ${metrics.impressions},
          ${metrics.clicks},
          ${metrics.spend},
          ${metrics.conversions},
          ${metrics.leads ?? null},
          ${metrics.conversionValue || 0},
          ${metrics.engagements || 0},
          ${metrics.cpc},
          ${metrics.cpm || 0},
          ${metrics.ctr},
          ${metrics.cpa || metrics.costPerConversion || 0},
          ${metrics.roas || 0},
          ${metrics.reach || null},
          ${JSON.stringify({ frequency: metrics.frequency || null, source: metrics.source || null, leads: metrics.leads ?? null })}::jsonb,
          'managed',
          'succeeded',
          ${metrics.providerStatus || null},
          NOW()
        )
        ON CONFLICT (campaign_id, platform, date) WHERE hour IS NULL
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          platform_campaign_id = EXCLUDED.platform_campaign_id,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          spend = EXCLUDED.spend,
          conversions = EXCLUDED.conversions,
          leads = EXCLUDED.leads,
          conversion_value = EXCLUDED.conversion_value,
          post_engagements = EXCLUDED.post_engagements,
          cpc = EXCLUDED.cpc,
          cpm = EXCLUDED.cpm,
          ctr = EXCLUDED.ctr,
          cpa = EXCLUDED.cpa,
          roas = EXCLUDED.roas,
          reach = EXCLUDED.reach,
          platform_data = EXCLUDED.platform_data,
          sync_status = 'succeeded',
          sync_error = NULL,
          provider_status = EXCLUDED.provider_status,
          updated_at = NOW()
      `);

      // Refresh campaign-level cached totals from normalized daily rows. The
      // stored lifetime cap is never derived from provider data.
      await db.execute(sql`
        UPDATE performance_ad_campaigns pac
        SET impressions = totals.impressions,
            clicks = totals.clicks,
            conversions = totals.conversions,
            reach = totals.reach,
            spent_amount = totals.spend,
            ctr = totals.ctr,
            cpc = totals.cpc,
            cpa = totals.cpa,
            roas = totals.roas,
            last_synced_at = NOW(),
            updated_at = NOW()
        FROM (
          SELECT campaign_id,
            COALESCE(SUM(impressions), 0)::int AS impressions,
            COALESCE(SUM(clicks), 0)::int AS clicks,
            COALESCE(SUM(conversions), 0)::numeric AS conversions,
            COALESCE(SUM(reach), 0)::int AS reach,
            COALESCE(SUM(spend), 0)::numeric AS spend,
            CASE WHEN SUM(impressions) > 0 THEN (SUM(clicks)::numeric / SUM(impressions)) * 100 ELSE 0 END AS ctr,
            CASE WHEN SUM(clicks) > 0 THEN SUM(spend)::numeric / SUM(clicks) ELSE 0 END AS cpc,
            CASE WHEN SUM(conversions) > 0 THEN SUM(spend)::numeric / SUM(conversions) ELSE 0 END AS cpa,
            CASE WHEN SUM(spend) > 0 THEN SUM(conversion_value)::numeric / SUM(spend) ELSE 0 END AS roas
          FROM performance_metrics
          WHERE campaign_id = ${metrics.campaignId}
            AND user_id = ${metrics.userId}
            AND hour IS NULL
          GROUP BY campaign_id
        ) totals
        WHERE pac.id = totals.campaign_id AND pac.user_id = ${metrics.userId}
      `);

      logger.info({ campaignId: metrics.campaignId, date: metrics.date }, '[AnalyticsIngestionService] Stored metrics for campaign on');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      // Table might not exist - create it
      if (error.message.includes('does not exist')) {
        await this.ensureMetricsTable();
        // Retry
        await this.storeMetrics(metrics);
      } else {
        throw error;
      }
    }
  }

  private async storeAllocationMetric(metric: {
    campaignId: number;
    userId: number;
    platform: 'meta' | 'google';
    providerResource: string;
    date: string;
    impressions: number;
    clicks: number;
    spend: number;
    conversions: number;
    conversionValue: number;
    providerStatus?: string;
    source: unknown;
  }): Promise<void> {
    const providerId = metric.providerResource.split('/').pop() || metric.providerResource;
    await db.execute(sql`
      INSERT INTO ad_allocation_metrics (
        campaign_id, allocation_id, user_id, platform, date,
        impressions, clicks, spend, conversions, conversion_value,
        provider_status, provider_payload
      )
      SELECT
        allocation.campaign_id, allocation.id, allocation.user_id, allocation.platform,
        ${metric.date}::date, ${metric.impressions}, ${metric.clicks}, ${metric.spend},
        ${metric.conversions}, ${metric.conversionValue}, ${metric.providerStatus || null},
        ${JSON.stringify(metric.source || {})}::jsonb
      FROM ad_campaign_allocations allocation
      JOIN ad_provider_resources resource
        ON resource.campaign_id = allocation.campaign_id
       AND resource.user_id = allocation.user_id
       AND resource.platform = allocation.platform
       AND resource.local_key = allocation.child_key
       AND resource.resource_type = CASE WHEN allocation.platform = 'meta' THEN 'ad_set' ELSE 'ad_group' END
      WHERE allocation.campaign_id = ${metric.campaignId}
        AND allocation.user_id = ${metric.userId}
        AND allocation.platform = ${metric.platform}
        AND (
          resource.provider_resource_name = ${metric.providerResource}
          OR resource.provider_resource_id = ${metric.providerResource}
          OR resource.provider_resource_name LIKE ${`%/${providerId}`}
          OR resource.provider_resource_id = ${providerId}
        )
      ON CONFLICT (allocation_id, date) DO UPDATE SET
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        spend = EXCLUDED.spend,
        conversions = EXCLUDED.conversions,
        conversion_value = EXCLUDED.conversion_value,
        provider_status = EXCLUDED.provider_status,
        provider_payload = EXCLUDED.provider_payload,
        updated_at = NOW()
    `);
    await db.execute(sql`
      UPDATE ad_campaign_allocations allocation
      SET spent_amount = LEAST(allocation.allocated_amount, totals.spend),
          provider_resource_name = COALESCE(allocation.provider_resource_name, ${metric.providerResource}),
          status = CASE WHEN ${metric.providerStatus || ''} IN ('ACTIVE', 'ENABLED') THEN 'active' ELSE allocation.status END,
          updated_at = NOW()
      FROM (
        SELECT allocation_id, COALESCE(SUM(spend), 0) AS spend
        FROM ad_allocation_metrics
        WHERE campaign_id = ${metric.campaignId} AND user_id = ${metric.userId}
        GROUP BY allocation_id
      ) totals
      WHERE allocation.id = totals.allocation_id
        AND allocation.campaign_id = ${metric.campaignId}
        AND allocation.user_id = ${metric.userId}
    `);
  }

  private async storeUnitMetric(metric: {
    campaignId: number;
    userId: number;
    platform: 'meta' | 'google';
    targetType: 'ad_set' | 'ad_group' | 'ad';
    providerResource: string;
    parentProviderResource?: string;
    date: string;
    impressions: number;
    clicks: number;
    spend: number;
    reach?: number;
    conversions: number;
    conversionValue: number;
    engagements?: number;
    installs?: number;
    providerStatus?: string;
    source: unknown;
  }): Promise<void> {
    const providerId = metric.providerResource.split('/').pop() || metric.providerResource;
    await db.execute(sql`
      INSERT INTO ad_unit_metrics (
        campaign_id, user_id, platform, target_type, target_key, parent_target_key, provider_resource, date,
        impressions, clicks, spend, reach, conversions, conversion_value, engagements,
        installs, provider_status, provider_payload
      )
      SELECT ${metric.campaignId}, ${metric.userId}, ${metric.platform}, ${metric.targetType},
        resource.local_key,
        (SELECT parent.local_key FROM ad_provider_resources parent
          WHERE parent.campaign_id = resource.campaign_id AND parent.user_id = resource.user_id
            AND parent.platform = resource.platform
            AND parent.resource_type = CASE WHEN resource.platform = 'meta' THEN 'ad_set' ELSE 'ad_group' END
            AND (${metric.parentProviderResource || null}::text IS NOT NULL)
            AND (parent.provider_resource_name = ${metric.parentProviderResource || null}
              OR parent.provider_resource_id = ${metric.parentProviderResource || null}
              OR parent.provider_resource_name LIKE ${metric.parentProviderResource ? `%/${metric.parentProviderResource.split('/').pop()}` : ''})
          ORDER BY parent.id DESC LIMIT 1),
        ${metric.providerResource}, ${metric.date}::date,
        ${metric.impressions}, ${metric.clicks}, ${metric.spend}, ${metric.reach || 0},
        ${metric.conversions}, ${metric.conversionValue}, ${metric.engagements || 0},
        ${metric.installs || 0},
        COALESCE(${metric.providerStatus || null}, UPPER(resource.status)),
        ${JSON.stringify(metric.source || {})}::jsonb
      FROM ad_provider_resources resource
      WHERE resource.campaign_id = ${metric.campaignId}
        AND resource.user_id = ${metric.userId}
        AND resource.platform = ${metric.platform}
        AND resource.resource_type = ${metric.targetType}
        AND (
          resource.provider_resource_name = ${metric.providerResource}
          OR resource.provider_resource_id = ${metric.providerResource}
          OR resource.provider_resource_name LIKE ${`%/${providerId}`}
          OR resource.provider_resource_id = ${providerId}
        )
      ORDER BY resource.id DESC LIMIT 1
      ON CONFLICT (campaign_id, platform, target_type, target_key, date) DO UPDATE SET
        provider_resource = EXCLUDED.provider_resource, parent_target_key = EXCLUDED.parent_target_key,
        impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, spend = EXCLUDED.spend,
        reach = EXCLUDED.reach, conversions = EXCLUDED.conversions,
        conversion_value = EXCLUDED.conversion_value, engagements = EXCLUDED.engagements,
        installs = EXCLUDED.installs, provider_status = EXCLUDED.provider_status,
        provider_payload = EXCLUDED.provider_payload, updated_at = NOW()
    `);
  }

  private async recordSyncRun(
    campaignId: number,
    userId: number,
    platform: 'meta' | 'google',
    dateStart: string,
    dateStop: string,
    status: 'succeeded' | 'failed',
    metricsIngested: number,
    error?: string,
  ): Promise<void> {
    try {
      await db.execute(sql`
        INSERT INTO ad_analytics_sync_runs (
          campaign_id, user_id, platform, date_start, date_stop,
          status, metrics_ingested, error
        ) VALUES (
          ${campaignId}, ${userId}, ${platform}, ${dateStart}::date, ${dateStop}::date,
          ${status}, ${metricsIngested}, ${error || null}
        )
      `);
    } catch (syncError) {
      logger.error({ campaignId, platform, err: syncError }, '[AnalyticsIngestionService] Failed to persist analytics sync outcome');
    }
  }

  private async enqueueLifetimeCapPauses(): Promise<void> {
    await db.execute(sql`
      INSERT INTO ad_action_queue (
        campaign_id, user_id, platform, action_type, idempotency_key,
        payload, metrics_snapshot, rationale, budget_impact
      )
      SELECT DISTINCT
        pac.id,
        pac.user_id,
        resources.platform,
        'pause',
        'campaign:' || pac.id || ':' || resources.platform || ':pause:lifetime-cap:' || pac.spent_amount,
        '{}'::jsonb,
        jsonb_build_object(
          'spent', pac.spent_amount,
          'lifetimeBudget', pac.budget_amount,
          'lastSyncedAt', pac.last_synced_at
        ),
        'Normalized provider spend reached the stored campaign lifetime cap.',
        0
      FROM performance_ad_campaigns pac
      JOIN (
        SELECT DISTINCT campaign_id, user_id, platform
        FROM ad_provider_resources
        WHERE resource_type = 'campaign' AND status IN ('created', 'active', 'paused')
      ) resources ON resources.campaign_id = pac.id AND resources.user_id = pac.user_id
      WHERE pac.local_status = 'active'
        AND pac.budget_type = 'lifetime' AND pac.budget_amount > 0
        AND COALESCE(pac.settings->>'importedProviderCampaign', 'false') <> 'true'
        AND pac.spent_amount >= pac.budget_amount
      ON CONFLICT (business_profile_id, user_id, idempotency_key) DO NOTHING
    `);
  }

  /**
   * Ensure performance_metrics table exists
   */
  private async ensureMetricsTable(): Promise<void> {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS performance_metrics (
          id SERIAL PRIMARY KEY,
          campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
          platform_campaign_id VARCHAR(255) NOT NULL,
          platform VARCHAR(50) NOT NULL,
          user_id INTEGER,
          date DATE NOT NULL,
          hour INTEGER,
          impressions INTEGER NOT NULL DEFAULT 0,
          clicks INTEGER NOT NULL DEFAULT 0,
          spend NUMERIC(12, 2) NOT NULL DEFAULT 0,
          reach INTEGER DEFAULT 0,
          conversions INTEGER DEFAULT 0,
          conversion_value NUMERIC(12, 2) DEFAULT 0,
          cpc NUMERIC(10, 2) DEFAULT 0,
          cpm NUMERIC(10, 2) DEFAULT 0,
          ctr NUMERIC(9, 6) DEFAULT 0,
          cpa NUMERIC(10, 2) DEFAULT 0,
          roas NUMERIC(10, 2) DEFAULT 0,
          platform_data JSONB,
          source_scope VARCHAR(24) NOT NULL DEFAULT 'managed',
          sync_status VARCHAR(24) NOT NULL DEFAULT 'succeeded',
          sync_error TEXT,
          provider_status VARCHAR(64),
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // Create indexes
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_performance_metrics_campaign 
        ON performance_metrics(campaign_id)
      `);

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_performance_metrics_date 
        ON performance_metrics(date)
      `);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS performance_metrics_campaign_platform_daily_uq
        ON performance_metrics(campaign_id, platform, date)
        WHERE hour IS NULL
      `);

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_performance_metrics_platform 
        ON performance_metrics(platform)
      `);

      logger.info('[AnalyticsIngestionService] Metrics table created');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[AnalyticsIngestionService] Error creating metrics table');
      throw error;
    }
  }

  /**
   * Get aggregated metrics for a campaign
   */
  async getCampaignMetrics(
    campaignId: number,
    dateStart: string,
    dateStop: string
  ): Promise<MetricRecord | null> {
    try {
      const result = await db.execute(sql`
        SELECT 
          campaign_id,
          platform_campaign_id,
          platform,
          ${dateStart}::text as date,
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          SUM(spend) as spend,
          SUM(conversions) as conversions,
          AVG(cpc) as cpc,
          AVG(ctr) as ctr,
          AVG(cpa) as cost_per_conversion,
          AVG(reach) as reach,
          AVG(NULLIF(platform_data->>'frequency', '')::numeric) as frequency
        FROM performance_metrics
        WHERE campaign_id = ${campaignId}
          AND date BETWEEN ${dateStart}::date AND ${dateStop}::date
          AND hour IS NULL
        GROUP BY campaign_id, platform_campaign_id, platform
      `);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as unknown as MetricRecord;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[AnalyticsIngestionService] Error fetching metrics');
      return null;
    }
  }

  /**
   * Run daily ingestion (for cron job)
   */
  async runDailyIngestion(): Promise<IngestionResult> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    return await this.ingestAllCampaigns(dateStr, dateStr);
  }

  /**
   * Backfill metrics for a date range
   */
  async backfillMetrics(dateStart: string, dateStop: string): Promise<IngestionResult> {
    const start = new Date(dateStart);
    const stop = new Date(dateStop);
    
    let metricsIngested = 0;
    const errors: string[] = [];

    // Ingest day by day
    for (let date = start; date <= stop; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split('T')[0];
      
      const result = await this.ingestAllCampaigns(dateStr, dateStr);
      metricsIngested += result.metricsIngested;
      
      if (result.errors) {
        errors.push(...result.errors);
      }

      // Small delay to avoid rate limiting
      await sleep(1000);
    }

    return {
      success: true,
      metricsIngested,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // Backwards-compatible singleton accessor used in tests
  public static getInstance(): AnalyticsIngestionService {
    if (!AnalyticsIngestionService._instance) {
      AnalyticsIngestionService._instance = new AnalyticsIngestionService();
    }
    return AnalyticsIngestionService._instance;
  }
}

// Export singleton instance
export const analyticsIngestionService = new AnalyticsIngestionService();

export interface CampaignMetricsRefresh {
  metricsUpdated: number;
  errors: string[];
}

/**
 * The work behind "Sync provider data" on the ads page: ingest one owner's
 * campaigns for the window, then refresh advisory reviews when anything
 * changed. Runs in the performance-sync worker (job 'fetch-campaign-metrics'),
 * not inline in the request, so provider calls and per-campaign reviews never
 * hold an API pool connection or outlive a closed browser tab.
 */
export async function refreshCampaignMetrics(userId: number, dateStart: string, dateStop: string): Promise<CampaignMetricsRefresh> {
  const result = await analyticsIngestionService.ingestAllCampaigns(dateStart, dateStop, userId);
  const errors = Array.isArray(result.errors) ? [...result.errors] : [];
  const metricsUpdated = result.metricsIngested;
  if (metricsUpdated > 0) {
    const reviewable = await db.execute(sql`
      SELECT campaign.id FROM performance_ad_campaigns campaign
      JOIN ad_settings settings ON settings.user_id = campaign.user_id
      WHERE campaign.user_id = ${userId} AND settings.autonomy_mode <> 'off'
        AND campaign.local_status IN ('active', 'published', 'paused', 'completed', 'ended')
      ORDER BY campaign.id LIMIT 500
    `);
    const { adPerformanceService } = await import('./ads/AdPerformanceService.js');
    for (const campaign of reviewable.rows as Array<{ id: number }>) {
      try { await adPerformanceService.evaluateCampaign(userId, Number(campaign.id), { advisoryOnly: true }); }
      catch { errors.push('Campaign advisory review could not be refreshed.'); }
    }
  }
  return { metricsUpdated, errors };
}
