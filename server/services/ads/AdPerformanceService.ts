import { businessAuditActor } from '../../tenancy/businessContext.js';
import { updateRecommendationLifecycle, wakeSnoozedRecommendations, type RecommendationStatus, type RecommendationUpdate } from './AdRecommendationLifecycle.js';
import { aggregateProviderReportingWindow, providerReportingWindow, providerReportingRows } from './ProviderReportingWindow.js';
import { measuredLeads } from './AdLeadMetrics.js';
export { measuredLeads } from './AdLeadMetrics.js';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { providerCampaignReview } from './ProviderCampaignReview.js';
import {
  evaluateAdPerformance,
  money,
  objectiveDefaultThresholds,
  selectAutonomousPauseTarget,
  type AdAutonomyMode,
  type AdObjective,
  type AdPlatform,
  type AdTargetType,
  type PerformanceAggregate,
  type PerformanceEvaluationResult,
  type PerformanceThresholds,
} from './AutonomousAdsDomain.js';

export const AD_AUTONOMY_POLICY_VERSION = 'ads-pause-v1';

export function normalizeProviderObjective(value: unknown): AdObjective {
  const objective = String(value || '').toUpperCase();
  if (objective.includes('AWARENESS') || objective.includes('REACH')) return 'awareness';
  if (objective.includes('TRAFFIC') || objective.includes('CLICK')) return 'traffic';
  if (objective.includes('ENGAGEMENT')) return 'engagement';
  if (objective.includes('LEAD')) return 'leads';
  if (objective.includes('APP') || objective.includes('INSTALL')) return 'app_promotion';
  if (objective.includes('SALE') || objective.includes('CONVERSION')) return 'sales';
  return 'traffic';
}

export function importedAllocationSnapshot(value: unknown): { allocatedAmount: number; spentAmount: number } {
  const parsed = Number(value || 0);
  const spentAmount = money(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
  // Provider imports are historical monitoring snapshots, not new budget
  // authorizations. The observed spend is therefore the minimum truthful
  // allocation floor and preserves the database invariant spent <= allocated.
  return { allocatedAmount: spentAmount, spentAmount };
}

function providerBudget(rawData: unknown): { type: 'daily' | 'lifetime'; amount: number } {
  const raw = rawData && typeof rawData === 'object' ? rawData as Record<string, unknown> : {};
  const campaign = raw.campaign && typeof raw.campaign === 'object'
    ? raw.campaign as Record<string, unknown>
    : {};
  if (campaign.budgetAmount != null && Number.isFinite(Number(campaign.budgetAmount))) return { type: campaign.budgetType === 'lifetime' ? 'lifetime' : 'daily', amount: money(Number(campaign.budgetAmount)) };
  const lifetime = Number(campaign.lifetime_budget || 0);
  if (Number.isFinite(lifetime) && lifetime > 0) return { type: 'lifetime', amount: money(lifetime / 100) };
  const daily = Number(campaign.daily_budget || 0);
  return { type: 'daily', amount: Number.isFinite(daily) && daily > 0 ? money(daily / 100) : 0 };
}

function providerCurrency(row: Record<string, unknown> | undefined): string {
  const currency = String(row?.currency || 'USD').toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
}

export interface AdAutonomySettings {
  mode: AdAutonomyMode;
  enabled: boolean;
  policyVersion: string;
  consentedAt: string | null;
  consentedByUserId: number | null;
  notificationEmail: string | null;
  defaultThresholds: PerformanceThresholds;
  analyticsSyncMinutes: number;
  liveProviderMutationsEnabled: boolean;
  environmentMutationGate: boolean;
  lastEvaluatedAt: string | null;
}

export interface CampaignAutonomyPolicy {
  campaignId: number;
  enabled: boolean;
  thresholds: PerformanceThresholds;
  policyVersion: string;
  consentedAt: string | null;
  consentedByUserId: number | null;
  revokedAt: string | null;
  manualHoldUntil: string | null;
}

type CampaignRow = Record<string, any>;
type BaselineEvidence = {
  source: 'campaign_target' | 'historical' | 'sibling_comparison' | 'objective_default' | 'none';
  metrics: Record<string, number>;
  campaignIds: number[];
};
type TargetMetricRow = {
  platform: AdPlatform;
  targetType: AdTargetType;
  targetKey: string;
  providerResource: string | null;
  parentTargetKey?: string | null;
  providerStatus: string | null;
  metricsUpdatedAt: Date | null;
  aggregate: PerformanceAggregate;
  name?: string | null;
  creative?: Record<string, unknown> | null;
  measurementWindow?: string;
  dailyInsights?: Array<Record<string, unknown>>;
};

type StoredEvaluation = {
  id: number;
  platform: AdPlatform;
  targetType: AdTargetType;
  targetKey: string;
  providerResource: string | null;
  parentTargetKey?: string | null;
  state: string;
  shouldPause: boolean;
  result: PerformanceEvaluationResult;
  metrics: PerformanceAggregate;
  providerStatus: string | null;
};

function asThresholds(value: unknown): PerformanceThresholds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed: Array<keyof PerformanceThresholds> = [
    'targetCpl', 'targetCpa', 'targetRoas', 'targetCtr', 'targetCpc', 'targetCpm', 'targetCpe', 'targetEngagementRate', 'spendLimit',
  ];
  return Object.fromEntries(allowed.flatMap((key) => {
    const number = Number((value as Record<string, unknown>)[key]);
    return Number.isFinite(number) && number > 0 ? [[key, number]] : [];
  })) as PerformanceThresholds;
}

function utcDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  const timezoneAware = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw);
  const normalized = timezoneAware ? raw : `${raw.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function iso(value: unknown): string | null {
  return utcDate(value)?.toISOString() || null;
}


function metricAggregate(row: Record<string, unknown>): PerformanceAggregate {
  const impressions = Number(row.impressions || 0);
  const clicks = Number(row.clicks || 0);
  const spend = Number(row.spend || 0);
  const conversions = Number(row.conversions || 0);
  const conversionValue = Number(row.conversion_value || 0);
  const raw = row.raw_data && typeof row.raw_data === 'object' ? row.raw_data as Record<string, unknown> : {};
  const insights = raw.insights && typeof raw.insights === 'object' ? raw.insights as Record<string, unknown> : {};
  const engagements = Number(row.engagements ?? insights.engagements ?? 0);
  const installs = Number(row.installs ?? insights.installs ?? 0);
  return {
    impressions,
    clicks,
    spend: money(spend),
    reach: Number(row.reach || 0),
    conversions,
    leads: measuredLeads(row),
    conversionValue: money(conversionValue),
    engagements,
    installs,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1_000 : 0,
    cpa: conversions > 0 ? spend / conversions : 0,
    roas: spend > 0 ? conversionValue / spend : 0,
    engagementRate: impressions > 0 ? (engagements / impressions) * 100 : 0,
    cpe: engagements > 0 ? spend / engagements : 0,
  };
}

function reportingWindowAggregate(raw: Record<string,unknown>, days: number, window = providerReportingWindow(`last_${days}d`)): PerformanceAggregate {
  if(!Array.isArray(raw.dailyInsights)) return metricAggregate({...((raw.insights as Record<string,unknown>) || {}), conversion_value:(raw.insights as Record<string,unknown> | undefined)?.conversionValue});
  const measured = aggregateProviderReportingWindow(raw, window.start, window.end);
  return metricAggregate({...measured, conversion_value:measured.conversionValue});
}

function providerDailyMetrics(raw: Record<string, unknown>): Array<{
  date: string; impressions: number; clicks: number; spend: number; reach: number; conversions: number; leads: number | null; engagements: number | null; installs: number | null;
}> {
  if (!Array.isArray(raw.dailyInsights)) return [];
  return providerReportingRows(raw, '0001-01-01', '9999-12-31').flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const date = String(row.date || row.date_start || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return [{
      date, leads: measuredLeads(row),
      engagements: row.engagements == null ? null : Number(row.engagements),
      installs: row.installs == null ? null : Number(row.installs),
      impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0),
      spend: Number(row.spend || 0), reach: Number(row.reach || 0), conversions: Number(row.conversions || 0),
    }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function currentFiveMinuteBucket(now = new Date()): string {
  const bucket = new Date(now);
  bucket.setUTCSeconds(0, 0);
  bucket.setUTCMinutes(Math.floor(bucket.getUTCMinutes() / 5) * 5);
  return bucket.toISOString().replace(/[-:.]/g, '').slice(0, 13);
}

function siblingBaseline(targets: TargetMetricRow[], target: TargetMetricRow, objective?: string): Record<string, number> | null {
  if (target.targetType === 'campaign') return null;
  const siblings = targets.filter(item => item.platform === target.platform
    && item.targetType === target.targetType
    && item.targetKey !== target.targetKey
    && item.aggregate.impressions >= 100
    && item.aggregate.spend > 0);
  if (!siblings.length) return null;
  const keys: Array<keyof PerformanceAggregate> = ['ctr', 'cpc', 'cpm', 'cpa', 'roas', 'engagementRate', 'cpe', 'reach', 'spend'];
  return Object.fromEntries(keys.flatMap(key => {
    const values = siblings.map(item => key === 'cpa' && objective === 'leads' ? (item.aggregate.leads ? item.aggregate.spend / item.aggregate.leads : 0) : Number(item.aggregate[key] || 0)).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    if (!values.length) return [];
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    return [[key, median]];
  }));
}

function humanizeGate(code: string): string {
  return ({
    learningComplete: 'The 72-hour learning period is not complete.',
    metricsFresh: 'Performance metrics are stale.',
    enoughSyncs: 'Three successful metric synchronization windows are required.',
    syncHealthy: 'The latest metric synchronization did not succeed.',
    providerActive: 'Provider delivery is not active.',
    enoughVolume: 'More impressions and spend are required for a reliable assessment.',
    manualHold: 'A manual automation hold is active.',
    leadMeasurement: 'Lead-specific measurement is unavailable.',
  } as Record<string, string>)[code] || code;
}

function assessmentFromRuleResults(evaluation: Record<string, unknown> | undefined) {
  if (!evaluation) return null;
  const rules = evaluation.rule_results && typeof evaluation.rule_results === 'object'
    ? evaluation.rule_results as Record<string, unknown>
    : {};
  const blockers = ['learningComplete', 'metricsFresh', 'enoughSyncs', 'syncHealthy', 'providerActive', 'enoughVolume', 'leadMeasurement']
    .filter(key => rules[key] === false)
    .map(code => ({ code, message: humanizeGate(code) }));
  if (rules.manualHold === true) blockers.push({ code: 'manualHold', message: humanizeGate('manualHold') });
  return {
    blockers,
    rationale: String(evaluation.rationale || blockers[0]?.message || 'The deterministic rule evidence is available.'),
    expectedDirection: String(evaluation.expected_direction || (blockers.length ? 'Restore reliable measurement' : 'Maintain or improve objective performance')),
    suggestedNextStep: String(evaluation.suggested_next_step || (blockers.length ? 'Resolve the evidence blockers, then evaluate again.' : 'Continue monitoring the current result trend.')),
  };
}

const UNREADY_CONFIDENCE_STATES = new Set(['learning', 'manual_hold', 'insufficient_data']);

export function redactUnreadyAdPerformanceConfidence(
  evaluationRows: Array<Record<string, unknown>>,
  recommendationRows: Array<Record<string, unknown>>,
) {
  const stateByEvaluationId = new Map(
    evaluationRows.map(row => [String(row.id), String(row.state || '')]),
  );
  return {
    evaluations: evaluationRows.map(row => UNREADY_CONFIDENCE_STATES.has(String(row.state || ''))
      ? { ...row, confidence: null }
      : row),
    recommendations: recommendationRows.map(row => {
      const evaluationState = String(row.evaluation_state || stateByEvaluationId.get(String(row.evaluation_id)) || '');
      return evaluationState && UNREADY_CONFIDENCE_STATES.has(evaluationState)
        ? { ...row, confidence: null }
        : row;
    }),
  };
}

export class AdPerformanceService {
  private async providerAccountIdentity(userId: number, platform: AdPlatform, snapshot?: Record<string, unknown>) {
    if(snapshot?.adAccountId) return { ...snapshot, platform };
    if (platform === 'meta') {
      const identity = snapshot?.meta as Record<string, unknown> | undefined;
      if (!identity?.pageId) return { platform, adAccountId: identity?.adAccountId || null };
      const result = await db.execute(sql`
        SELECT ad_account_id, ad_account_name, page_id, page_name,
          instagram_account_id, instagram_username, instagram_profile_picture
        FROM meta_page_connections
        WHERE user_id = ${userId} AND is_active = TRUE AND page_id = ${String(identity.pageId)}
        ORDER BY updated_at DESC LIMIT 1
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return {
        platform,
        adAccountId: identity.adAccountId || null,
        adAccountName: identity.adAccountName || null,
        facebookPageId: identity.pageId || null,
        facebookPageName: identity.pageName || row?.page_name || null,
        instagramAccountId: identity.instagramAccountId || null,
        instagramUsername: identity.instagramUsername || (identity.instagramAccountId === row?.instagram_account_id ? row?.instagram_username : null) || null,
        instagramProfilePicture: identity.instagramAccountId === row?.instagram_account_id ? row?.instagram_profile_picture || null : null,
      };
    }
    const result = await db.execute(sql`
      SELECT config->>'customerId' AS ad_account_id,
        COALESCE(NULLIF(config->>'accountName', ''), NULLIF(config->>'customerName', '')) AS ad_account_name
      FROM api_credentials
      WHERE user_id = ${userId} AND service_name = 'google_ads' AND is_active = TRUE
      ORDER BY updated_at DESC LIMIT 1
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return { platform, adAccountId: row?.ad_account_id || null, adAccountName: row?.ad_account_name || null };
  }

  private async cachedHierarchy(userId: number, platform: AdPlatform, platformCampaignId: string | null, reportingDays?: number, adAccountId?: string): Promise<TargetMetricRow[]> {
    if (!platformCampaignId) return [];
    const result = await db.execute(sql`
      SELECT * FROM campaign_performance_cache
      WHERE user_id = ${userId} AND platform = ${platform}
        ${adAccountId ? sql`AND ad_account_id=${adAccountId.replace(/^act_/,'')}` : sql``}
        AND (
          parent_entity_id = ${platformCampaignId}
          OR (entity_type = 'ad' AND parent_entity_id IN (
            SELECT platform_entity_id FROM campaign_performance_cache
            WHERE user_id = ${userId} AND platform = ${platform}
        ${adAccountId ? sql`AND ad_account_id=${adAccountId.replace(/^act_/,'')}` : sql``}
              AND parent_entity_id = ${platformCampaignId}
              AND entity_type IN ('adset', 'ad_group')
          ))
        )
      ORDER BY CASE entity_type WHEN 'adset' THEN 1 WHEN 'ad_group' THEN 1 WHEN 'ad' THEN 2 ELSE 3 END,
        name, platform_entity_id
    `);
    return (result.rows as Array<Record<string, unknown>>).map(unit => {
      const raw = unit.raw_data && typeof unit.raw_data === 'object'
        ? unit.raw_data as Record<string, unknown>
        : {};
      return {
        platform,
        targetType: (unit.entity_type === 'ad' ? 'ad' : platform === 'google' ? 'ad_group' : 'ad_set') as AdTargetType,
        targetKey: String(unit.platform_entity_id),
        providerResource: String(unit.platform_entity_id),
        parentTargetKey: unit.parent_entity_id ? String(unit.parent_entity_id) : platformCampaignId,
        providerStatus: unit.status ? String(unit.status) : null,
        metricsUpdatedAt: utcDate(unit.last_refreshed_at),
        name: unit.name ? String(unit.name) : null,
        creative: unit.entity_type === 'ad' && raw.creative && typeof raw.creative === 'object' ? raw.creative as Record<string, unknown> : null,
        measurementWindow: JSON.stringify(reportingDays && Array.isArray(raw.dailyInsights) ? providerReportingWindow(`last_${reportingDays}d`) : raw.reportingWindow || "Provider cached window"),
        dailyInsights: Array.isArray(raw.dailyInsights) ? raw.dailyInsights as Array<Record<string, unknown>> : [],
        aggregate: reportingDays ? reportingWindowAggregate(raw, reportingDays) : metricAggregate({ ...unit, conversion_value: unit.conversion_value }),
      };
    });
  }

  async getAutonomySettings(userId: number): Promise<AdAutonomySettings> {
    const result = await db.execute(sql`
      SELECT settings.*, users.email AS owner_email
      FROM users
      LEFT JOIN ad_settings settings ON settings.user_id = users.id
      WHERE users.id = ${userId}
      LIMIT 1
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const mode = String(row?.autonomy_mode || 'off') as AdAutonomyMode;
    return {
      mode,
      enabled: mode !== 'off' && row?.autonomous_optimization_enabled === true,
      policyVersion: String(row?.consent_policy_version || AD_AUTONOMY_POLICY_VERSION),
      consentedAt: iso(row?.consented_at),
      consentedByUserId: row?.consented_by_user_id ? Number(row.consented_by_user_id) : null,
      notificationEmail: String(row?.notification_email || row?.owner_email || '') || null,
      defaultThresholds: asThresholds(row?.default_thresholds),
      analyticsSyncMinutes: Number(row?.analytics_sync_minutes || 15),
      liveProviderMutationsEnabled: row?.live_provider_mutations_enabled === true,
      environmentMutationGate: process.env.AD_PROVIDER_MUTATIONS_ENABLED === 'true',
      lastEvaluatedAt: iso(row?.last_evaluated_at),
    };
  }

  async updateAutonomySettings(
    userId: number,
    input: { mode: AdAutonomyMode; notificationEmail?: string | null; defaultThresholds?: PerformanceThresholds },
  ): Promise<AdAutonomySettings> {
    const enabled = input.mode !== 'off';
    const thresholds = asThresholds(input.defaultThresholds);
    await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`
        INSERT INTO ad_settings (
          user_id, autonomous_optimization_enabled, autonomy_mode,
          consent_policy_version, consented_at, consented_by_user_id,
          notification_email, default_thresholds, updated_at
        ) VALUES (
          ${userId}, ${enabled}, ${input.mode}, ${AD_AUTONOMY_POLICY_VERSION},
          ${enabled ? new Date() : null}, ${enabled ? businessAuditActor(userId) : null},
          ${input.notificationEmail || null}, ${JSON.stringify(thresholds)}::jsonb, NOW()
        )
        ON CONFLICT (business_profile_id, user_id) DO UPDATE SET
          autonomous_optimization_enabled = EXCLUDED.autonomous_optimization_enabled,
          autonomy_mode = EXCLUDED.autonomy_mode,
          consent_policy_version = EXCLUDED.consent_policy_version,
          consented_at = EXCLUDED.consented_at,
          consented_by_user_id = EXCLUDED.consented_by_user_id,
          notification_email = EXCLUDED.notification_email,
          default_thresholds = EXCLUDED.default_thresholds,
          updated_at = NOW()
      `);
      await tx.execute(sql`
        UPDATE ad_action_queue
        SET status = 'cancelled',
            last_error = ${input.mode === 'live_pause'
              ? 'Account autonomy settings changed; a fresh evaluation is required'
              : 'Account live-pause consent is not active'},
            completed_at = NOW(), updated_at = NOW()
        WHERE user_id = ${userId}
          AND action_type = 'pause'
          AND status IN ('pending', 'processing')
          AND evaluation_id IS NOT NULL
      `);
      await tx.execute(sql`
        INSERT INTO ad_account_autonomy_events (
          user_id, autonomy_mode, enabled, consent_policy_version,
          consented_at, revoked_at, thresholds, notification_destination
        ) VALUES (
          ${userId}, ${input.mode}, ${enabled}, ${AD_AUTONOMY_POLICY_VERSION},
          ${enabled ? new Date() : null}, ${enabled ? null : new Date()},
          ${JSON.stringify(thresholds)}::jsonb, ${input.notificationEmail || null}
        )
      `);
    });
    return this.getAutonomySettings(userId);
  }

  async getCampaignPolicy(userId: number, campaignId: number): Promise<CampaignAutonomyPolicy> {
    const ownership = await db.execute(sql`
      SELECT id FROM performance_ad_campaigns WHERE id = ${campaignId} AND user_id = ${userId} LIMIT 1
    `);
    if (!ownership.rows[0]) throw new Error('Campaign not found.');
    const result = await db.execute(sql`
      SELECT * FROM ad_campaign_autonomy_policies
      WHERE campaign_id = ${campaignId} AND user_id = ${userId} LIMIT 1
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return {
      campaignId,
      enabled: row?.enabled === true,
      thresholds: asThresholds(row?.thresholds),
      policyVersion: String(row?.consent_policy_version || AD_AUTONOMY_POLICY_VERSION),
      consentedAt: iso(row?.consented_at),
      consentedByUserId: row?.consented_by_user_id ? Number(row.consented_by_user_id) : null,
      revokedAt: iso(row?.revoked_at),
      manualHoldUntil: iso(row?.manual_hold_until),
    };
  }

  async updateCampaignPolicy(
    userId: number,
    campaignId: number,
    input: { enabled: boolean; thresholds?: PerformanceThresholds },
  ): Promise<CampaignAutonomyPolicy> {
    await this.getCampaignPolicy(userId, campaignId);
    const thresholds = asThresholds(input.thresholds);
    await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`
        INSERT INTO ad_campaign_autonomy_policies (
          campaign_id, user_id, enabled, thresholds, consent_policy_version,
          consented_at, consented_by_user_id, revoked_at, updated_at
        ) VALUES (
          ${campaignId}, ${userId}, ${input.enabled}, ${JSON.stringify(thresholds)}::jsonb,
          ${AD_AUTONOMY_POLICY_VERSION}, ${input.enabled ? new Date() : null},
          ${input.enabled ? businessAuditActor(userId) : null}, ${input.enabled ? null : new Date()}, NOW()
        )
        ON CONFLICT (business_profile_id, campaign_id, user_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          thresholds = EXCLUDED.thresholds,
          consent_policy_version = EXCLUDED.consent_policy_version,
          consented_at = EXCLUDED.consented_at,
          consented_by_user_id = EXCLUDED.consented_by_user_id,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW()
      `);
      if (!input.enabled) {
        await tx.execute(sql`
          UPDATE ad_action_queue
          SET status = 'cancelled', last_error = 'Campaign autonomy consent was revoked',
              completed_at = NOW(), updated_at = NOW()
          WHERE campaign_id = ${campaignId} AND user_id = ${userId}
            AND action_type = 'pause' AND status IN ('pending', 'processing') AND evaluation_id IS NOT NULL
        `);
      }
      await tx.execute(sql`
        INSERT INTO ad_action_audit (
          campaign_id, user_id, actor_type, action_type, rationale,
          metrics_snapshot, provider_outcome
        ) VALUES (
          ${campaignId}, ${userId}, 'user', 'autonomy_campaign_consent',
          ${input.enabled ? 'Campaign AI pause consent granted.' : 'Campaign AI pause consent revoked.'},
          ${JSON.stringify({ policyVersion: AD_AUTONOMY_POLICY_VERSION, thresholds })}::jsonb,
          ${JSON.stringify({ enabled: input.enabled })}::jsonb
        )
      `);
    });
    return this.getCampaignPolicy(userId, campaignId);
  }

  private async campaign(userId: number, campaignId: number): Promise<CampaignRow> {
    const result = await db.execute(sql`
      SELECT * FROM performance_ad_campaigns
      WHERE id = ${campaignId} AND user_id = ${userId} LIMIT 1
    `);
    const campaign = result.rows[0] as CampaignRow | undefined;
    if (!campaign) throw new Error('Campaign not found.');
    return campaign;
  }

  private async historicalBaseline(campaign: CampaignRow, platform: AdPlatform): Promise<BaselineEvidence> {
    const audienceCategory = campaign.settings?.context?.audienceCategory
      || campaign.targeting?.audienceCategory
      || null;
    const creativeFormat = campaign.settings?.context?.creativeFormat
      || campaign.content_context?.creativeFormat
      || null;
    const result = await db.execute(sql`
      WITH comparable AS (
        SELECT other.id,
          SUM(metrics.impressions)::numeric AS impressions,
          SUM(metrics.clicks)::numeric AS clicks,
          SUM(metrics.spend)::numeric AS spend,
          SUM(metrics.conversions)::numeric AS conversions,
          SUM(metrics.conversion_value)::numeric AS conversion_value,
          SUM(COALESCE(metrics.post_engagements, 0))::numeric AS engagements,
          CASE WHEN SUM(metrics.impressions) > 0 THEN SUM(metrics.clicks)::numeric / SUM(metrics.impressions) * 100 ELSE 0 END AS ctr,
          CASE WHEN SUM(metrics.clicks) > 0 THEN SUM(metrics.spend)::numeric / SUM(metrics.clicks) ELSE 0 END AS cpc,
          CASE WHEN SUM(metrics.impressions) > 0 THEN SUM(metrics.spend)::numeric / SUM(metrics.impressions) * 1000 ELSE 0 END AS cpm,
          CASE WHEN ${String(campaign.objective)} = 'leads' THEN
            CASE WHEN COUNT(metrics.platform_data->>'leads') = COUNT(*) AND SUM(metrics.leads) > 0 THEN SUM(metrics.spend)::numeric / SUM(metrics.leads) ELSE NULL END
            WHEN SUM(metrics.conversions) > 0 THEN SUM(metrics.spend)::numeric / SUM(metrics.conversions) ELSE 0 END AS cpa,
          CASE WHEN SUM(metrics.spend) > 0 THEN SUM(metrics.conversion_value)::numeric / SUM(metrics.spend) ELSE 0 END AS roas,
          CASE WHEN SUM(metrics.impressions) > 0 THEN SUM(COALESCE(metrics.post_engagements, 0))::numeric / SUM(metrics.impressions) * 100 ELSE 0 END AS engagement_rate,
          CASE WHEN SUM(COALESCE(metrics.post_engagements, 0)) > 0 THEN SUM(metrics.spend)::numeric / SUM(COALESCE(metrics.post_engagements, 0)) ELSE 0 END AS cpe
        FROM performance_ad_campaigns other
        JOIN performance_metrics metrics ON metrics.campaign_id = other.id AND metrics.hour IS NULL
        WHERE other.user_id = ${Number(campaign.user_id)}
          AND other.id <> ${Number(campaign.id)}
          AND other.objective = ${String(campaign.objective)}
          AND UPPER(COALESCE(other.currency, 'USD')) = ${String(campaign.currency || 'USD').toUpperCase()}
          AND (${audienceCategory}::text IS NULL OR COALESCE(
            other.settings->'context'->>'audienceCategory', other.targeting->>'audienceCategory'
          ) = ${audienceCategory})
          AND (${creativeFormat}::text IS NULL OR COALESCE(
            other.settings->'context'->>'creativeFormat', other.content_context->>'creativeFormat'
          ) = ${creativeFormat})
          AND metrics.platform = ${platform}
          AND metrics.date >= CURRENT_DATE - INTERVAL '180 days'
          AND other.local_status IN ('active', 'published', 'paused', 'completed', 'ended')
        GROUP BY other.id
        HAVING SUM(metrics.impressions) > 0
      )
      SELECT ARRAY_AGG(id ORDER BY id) AS campaign_ids,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ctr) AS ctr,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY cpc) AS cpc,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY cpm) AS cpm,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY cpa) AS cpa,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY roas) AS roas,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY engagement_rate) AS engagement_rate,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY cpe) AS cpe,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions) AS impressions,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY spend) AS spend
      FROM comparable
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const campaignIds = Array.isArray(row?.campaign_ids) ? row!.campaign_ids.map(Number) : [];
    if (campaignIds.length < 5) return { source: 'none', metrics: {}, campaignIds };
    return {
      source: 'historical',
      campaignIds,
      metrics: {
        targetCtr: Number(row?.ctr || 0), targetCpc: Number(row?.cpc || 0),
        targetCpm: Number(row?.cpm || 0), targetCpa: Number(row?.cpa || 0),
        targetRoas: Number(row?.roas || 0), targetEngagementRate: Number(row?.engagement_rate || 0),
        targetCpe: Number(row?.cpe || 0), impressions: Number(row?.impressions || 0), spend: Number(row?.spend || 0),
      },
    };
  }

  private async targetMetrics(userId: number, campaignId: number, historyDays = 7): Promise<TargetMetricRow[]> {
    const unitResult = await db.execute(sql`
      SELECT platform, target_type, target_key,
        (ARRAY_AGG(provider_resource ORDER BY date DESC, updated_at DESC))[1] AS provider_resource,
        (ARRAY_AGG(parent_target_key ORDER BY date DESC, updated_at DESC))[1] AS parent_target_key,
        (ARRAY_AGG(provider_status ORDER BY date DESC, updated_at DESC))[1] AS provider_status,
        MAX(updated_at) AS metrics_updated_at,
        SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(spend) AS spend,
        SUM(reach) AS reach, SUM(conversions) AS conversions,
        SUM(conversion_value) AS conversion_value, SUM(engagements) AS engagements,
        SUM(installs) AS installs, JSONB_AGG(provider_payload) AS daily_payloads
      FROM ad_unit_metrics
      WHERE COALESCE(provider_payload->>'importedFromProviderCache', 'false') <> 'true'
        AND user_id = ${userId} AND campaign_id = ${campaignId}
        AND date >= CURRENT_DATE - (${historyDays} * INTERVAL '1 day')
      GROUP BY platform, target_type, target_key
      ORDER BY CASE target_type WHEN 'ad' THEN 1 WHEN 'ad_set' THEN 2 WHEN 'ad_group' THEN 2 ELSE 3 END, target_key
    `);
    return (unitResult.rows as Array<Record<string, unknown>>).map((row) => ({
      platform: String(row.platform) as AdPlatform,
      targetType: String(row.target_type) as AdTargetType,
      targetKey: String(row.target_key),
      providerResource: row.provider_resource ? String(row.provider_resource) : null,
      parentTargetKey: row.parent_target_key ? String(row.parent_target_key) : null,
      providerStatus: row.provider_status ? String(row.provider_status) : null,
      metricsUpdatedAt: utcDate(row.metrics_updated_at),
      measurementWindow: `Recent ${historyDays + 1} calendar days`,
      aggregate: metricAggregate({ ...row, leads: Array.isArray(row.daily_payloads)
        && row.daily_payloads.every(payload => measuredLeads(payload) !== null)
        ? row.daily_payloads.reduce((sum: number, payload: unknown) => sum + measuredLeads(payload)!, 0) : null }),
    }));
  }

  private async campaignMetric(campaign: CampaignRow, platform: AdPlatform, historyDays = 7): Promise<TargetMetricRow> {
    const result = await db.execute(sql`
      SELECT (ARRAY_AGG(provider_status ORDER BY date DESC, updated_at DESC))[1] AS provider_status,
        (SELECT COALESCE(resource.provider_resource_name, resource.provider_resource_id)
          FROM ad_provider_resources resource
          WHERE resource.user_id = ${Number(campaign.user_id)} AND resource.campaign_id = ${Number(campaign.id)}
            AND resource.platform = ${platform} AND resource.resource_type = 'campaign'
          ORDER BY resource.id DESC LIMIT 1) AS provider_resource,
        MAX(updated_at) AS metrics_updated_at,
        SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(spend) AS spend,
        SUM(reach) AS reach, SUM(conversions) AS conversions, CASE WHEN COUNT(platform_data->>'leads') = COUNT(*) THEN SUM(leads) END AS leads, SUM(conversion_value) AS conversion_value,
        COALESCE(NULLIF((SELECT SUM(unit.engagements) FROM ad_unit_metrics unit
          WHERE unit.user_id = ${Number(campaign.user_id)} AND unit.campaign_id = ${Number(campaign.id)}
            AND unit.platform = ${platform} AND unit.target_type = 'ad'
            AND COALESCE(unit.provider_payload->>'importedFromProviderCache', 'false') <> 'true'
            AND unit.date >= CURRENT_DATE - (${historyDays} * INTERVAL '1 day')), 0), SUM(COALESCE(post_engagements, 0))) AS engagements,
        COALESCE(NULLIF((SELECT SUM(unit.installs) FROM ad_unit_metrics unit
          WHERE unit.user_id = ${Number(campaign.user_id)} AND unit.campaign_id = ${Number(campaign.id)}
            AND unit.platform = ${platform} AND unit.target_type = 'ad'
            AND COALESCE(unit.provider_payload->>'importedFromProviderCache', 'false') <> 'true'
            AND unit.date >= CURRENT_DATE - (${historyDays} * INTERVAL '1 day')), 0),
          SUM(CASE WHEN ${String(campaign.objective)} = 'app_promotion' THEN conversions ELSE 0 END)) AS installs
      FROM performance_metrics
      WHERE user_id = ${Number(campaign.user_id)} AND campaign_id = ${Number(campaign.id)}
        AND platform = ${platform} AND hour IS NULL
        AND date >= CURRENT_DATE - (${historyDays} * INTERVAL '1 day')
    `);
    const row = result.rows[0] as Record<string, unknown> || {};
    return {
      platform,
      targetType: 'campaign',
      targetKey: 'campaign',
      providerResource: row.provider_resource
        ? String(row.provider_resource)
        : campaign.platform_campaign_id ? String(campaign.platform_campaign_id) : null,
      parentTargetKey: null,
      providerStatus: String(campaign.local_status || '').toLowerCase() === 'paused'
        ? String(campaign.provider_status || 'PAUSED')
        : row.provider_status ? String(row.provider_status) : String(campaign.provider_status || ''),
      metricsUpdatedAt: utcDate(row.metrics_updated_at),
      aggregate: metricAggregate(row),
    };
  }

  private async syncEvidence(userId: number, campaignId: number, platform: AdPlatform): Promise<{ successfulWindows: number; latestStatus: string | null }> {
    const result = await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE status = 'succeeded') AS count,
        (ARRAY_AGG(status ORDER BY completed_at DESC))[1] AS latest_status
      FROM ad_analytics_sync_runs
      WHERE user_id = ${userId} AND campaign_id = ${campaignId} AND platform = ${platform}
        AND completed_at >= NOW() - INTERVAL '7 days'
    `);
    return {
      successfulWindows: Number(result.rows[0]?.count || 0),
      latestStatus: result.rows[0]?.latest_status ? String(result.rows[0].latest_status) : null,
    };
  }

  private async holdUntil(userId: number, campaignId: number, target: TargetMetricRow): Promise<Date | null> {
    const result = await db.execute(sql`
      SELECT hold_until FROM ad_target_automation_holds
      WHERE user_id = ${userId} AND campaign_id = ${campaignId}
        AND platform = ${target.platform} AND target_type = ${target.targetType}
        AND target_key = ${target.targetKey} AND hold_until > NOW()
      LIMIT 1
    `);
    return utcDate(result.rows[0]?.hold_until);
  }

  private async consecutiveFailures(userId: number, campaignId: number, target: TargetMetricRow): Promise<number> {
    const result = await db.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (metrics_updated_at) state, rule_results, metrics_updated_at
        FROM ad_performance_evaluations
        WHERE user_id = ${userId} AND campaign_id = ${campaignId}
          AND platform = ${target.platform} AND target_type = ${target.targetType} AND target_key = ${target.targetKey}
          AND metrics_updated_at < (${target.metricsUpdatedAt?.toISOString() || null}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY metrics_updated_at DESC, created_at DESC, id DESC
      ) windows ORDER BY metrics_updated_at DESC LIMIT 3
    `);
    let count = 0;
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const rules = row.rule_results as Record<string, unknown> | undefined;
      if (!['watch', 'recommendation'].includes(String(row.state))
        || rules?.failing !== true || rules.reportingOnlyHistorical !== false) break;
      count += 1;
    }
    return count;
  }

  private async storeEvaluation(
    campaign: CampaignRow,
    target: TargetMetricRow,
    baseline: BaselineEvidence,
    result: PerformanceEvaluationResult,
    consentContext: string,
  ): Promise<number> {
    const now = new Date();
    const windowEnd = now.toISOString().slice(0, 10);
    const windowStart = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    const contextHash = createHash('sha256').update(consentContext).digest('hex').slice(0, 16);
    const key = `${campaign.id}:${target.platform}:${target.targetType}:${target.targetKey}:${currentFiveMinuteBucket(now)}:${contextHash}`;
    const stored = await db.execute(sql`
      INSERT INTO ad_performance_evaluations (
        campaign_id, user_id, platform, target_type, target_key, objective,
        window_start, window_end, metrics_snapshot, metrics_updated_at, baseline_source,
        baseline_metrics, comparable_campaign_ids, rule_results, confidence,
        state, rationale, expected_direction, suggested_next_step,
        hypothetical_action, evaluation_key
      ) VALUES (
        ${Number(campaign.id)}, ${Number(campaign.user_id)}, ${target.platform},
        ${target.targetType}, ${target.targetKey}, ${String(campaign.objective)},
        ${windowStart}::date, ${windowEnd}::date, ${JSON.stringify(target.aggregate)}::jsonb,
        ${target.metricsUpdatedAt},
        ${baseline.source}, ${JSON.stringify(baseline.metrics)}::jsonb,
        ${JSON.stringify(baseline.campaignIds)}::jsonb, ${JSON.stringify(result.ruleResults)}::jsonb,
        ${result.confidence}, ${result.state}, ${result.rationale}, ${result.expectedDirection},
        ${result.suggestedNextStep}, ${result.shouldPause ? 'pause' : null}, ${key}
      )
      ON CONFLICT (business_profile_id, user_id, evaluation_key) DO NOTHING
      RETURNING id
    `);
    if (stored.rows[0]) return Number(stored.rows[0].id);
    const existing = await db.execute(sql`
      SELECT id FROM ad_performance_evaluations
      WHERE user_id = ${Number(campaign.user_id)} AND evaluation_key = ${key} LIMIT 1
    `);
    return Number(existing.rows[0].id);
  }

  private async storeRecommendation(
    campaign: CampaignRow,
    target: TargetMetricRow,
    evaluationId: number,
    result: PerformanceEvaluationResult,
    baseline: BaselineEvidence,
  ): Promise<void> {
    const evidenceWindowEnd = new Date().toISOString().slice(0, 10);
    const evidenceWindowStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const targetMetrics = Object.fromEntries(
      Object.entries(result.ruleResults).filter(([key, value]) =>
        (key.startsWith('target') || key.startsWith('baseline'))
        && typeof value === 'number'
        && Number.isFinite(value)),
    );
    const evidence = {
      objective: String(campaign.objective),
      affectedUnit: { platform: target.platform, targetType: target.targetType, targetKey: target.targetKey, name: target.name || null },
      evidenceWindow: { start: evidenceWindowStart, end: evidenceWindowEnd, metricsUpdatedAt: target.metricsUpdatedAt?.toISOString() || null },
      currentMetrics: target.aggregate,
      targetMetrics,
      historicalComparison: { baselineSource: baseline.source, baselineMetrics: baseline.metrics, comparableCampaignIds: baseline.campaignIds },
      ruleResults: result.ruleResults,
      state: result.state,
    };
    await db.transaction(async (tx: typeof db) => {
      // Serialize recurring evaluations so one issue has one current recommendation.
      await tx.execute(sql`SELECT id FROM performance_ad_campaigns WHERE id = ${Number(campaign.id)} AND user_id = ${Number(campaign.user_id)} FOR UPDATE`);
      const previous = await tx.execute(sql`
        SELECT recommendation.*, evaluation.state AS evaluation_state
        FROM ad_recommendations recommendation
        JOIN ad_performance_evaluations evaluation ON evaluation.id = recommendation.evaluation_id
        WHERE recommendation.campaign_id = ${Number(campaign.id)} AND recommendation.user_id = ${Number(campaign.user_id)}
          AND recommendation.platform = ${target.platform} AND recommendation.target_type = ${target.targetType}
          AND recommendation.target_key = ${target.targetKey} AND recommendation.status <> 'superseded'
        ORDER BY recommendation.created_at DESC, recommendation.id DESC LIMIT 1
      `);
      const prior = previous.rows[0];
      const sameIssue = prior && prior.category === result.category && prior.evaluation_state === result.state;
      const unchanged = sameIssue && (['accepted','dismissed','snoozed','implemented','outcome_measured'].includes(prior.status) || (prior.rationale === result.rationale
        && prior.expected_direction === result.expectedDirection && prior.suggested_next_step === result.suggestedNextStep));
      await tx.execute(sql`
        UPDATE ad_recommendations SET status = 'superseded', updated_at = NOW()
        WHERE campaign_id = ${Number(campaign.id)} AND user_id = ${Number(campaign.user_id)}
          AND platform = ${target.platform} AND target_type = ${target.targetType} AND target_key = ${target.targetKey}
          AND status = 'open' AND id <> ${unchanged ? Number(prior.id) : 0}
      `);
      if (unchanged) {
        // Keep the user's lifecycle choice while refreshing current evidence.
        await tx.execute(sql`
          UPDATE ad_recommendations SET evaluation_id = ${evaluationId}, evidence = ${JSON.stringify(evidence)}::jsonb,
            confidence = ${result.confidence}, updated_at = NOW()
          WHERE id = ${Number(prior.id)}
        `);
        return;
      }
      await tx.execute(sql`
      INSERT INTO ad_recommendations (
        evaluation_id, campaign_id, user_id, platform, target_type, target_key,
        category, title, rationale, evidence, expected_direction,
        suggested_next_step, confidence
      ) VALUES (
        ${evaluationId}, ${Number(campaign.id)}, ${Number(campaign.user_id)}, ${target.platform},
        ${target.targetType}, ${target.targetKey}, ${result.category},
        ${`${result.category === 'tracking' ? 'Restore measurement' : result.category === 'budget' ? 'Review spend efficiency' : result.category === 'landing_page' ? 'Inspect conversion path' : result.category === 'creative' ? 'Test a stronger creative' : result.category === 'audience' ? 'Refine audience fit' : 'Review placement efficiency'} · ${target.name || target.targetKey}`},
        ${result.rationale},
        ${JSON.stringify(evidence)}::jsonb,
        ${result.expectedDirection}, ${result.suggestedNextStep}, ${result.confidence}
      )
      ON CONFLICT (evaluation_id, category) DO NOTHING
      `);
    });
  }

  private async queuePause(
    campaign: CampaignRow,
    policy: CampaignAutonomyPolicy,
    settings: AdAutonomySettings,
    evaluation: StoredEvaluation,
  ): Promise<boolean> {
    if (!evaluation.providerResource) return false;
    const recent = await db.execute(sql`
      SELECT id FROM ad_action_queue
      WHERE user_id = ${Number(campaign.user_id)} AND campaign_id = ${Number(campaign.id)}
        AND action_type = 'pause' AND evaluation_id IS NOT NULL
        AND status IN ('pending', 'processing', 'succeeded')
        AND created_at >= NOW() - INTERVAL '24 hours'
      LIMIT 1
    `);
    if (recent.rows[0]) return false;
    const idempotencyKey = `ai-pause:${campaign.id}:${evaluation.platform}:${evaluation.targetType}:${evaluation.targetKey}:${evaluation.id}`;
    const consentSnapshot = {
      accountMode: settings.mode,
      accountConsentedAt: settings.consentedAt,
      campaignConsentedAt: policy.consentedAt,
      policyVersion: AD_AUTONOMY_POLICY_VERSION,
    };
    const inserted = await db.execute(sql`
      INSERT INTO ad_action_queue (
        campaign_id, user_id, platform, action_type, idempotency_key,
        payload, metrics_snapshot, rationale, budget_impact,
        evaluation_id, target_type, target_key, consent_snapshot, policy_version
        , target_resource
      ) VALUES (
        ${Number(campaign.id)}, ${Number(campaign.user_id)}, ${evaluation.platform}, 'pause',
        ${idempotencyKey},
        ${JSON.stringify({ actorType: 'ai', targetType: evaluation.targetType, targetKey: evaluation.targetKey, beforeStatus: evaluation.providerStatus })}::jsonb,
        ${JSON.stringify({ ...evaluation.result.ruleResults, metrics: evaluation.metrics })}::jsonb, ${evaluation.result.rationale}, 0,
        ${evaluation.id}, ${evaluation.targetType}, ${evaluation.targetKey},
        ${JSON.stringify(consentSnapshot)}::jsonb, ${AD_AUTONOMY_POLICY_VERSION}, ${evaluation.providerResource}
      )
      ON CONFLICT (business_profile_id, user_id, idempotency_key) DO NOTHING RETURNING id
    `);
    if (!inserted.rows[0]) return false;
    await db.execute(sql`
      INSERT INTO ad_action_audit (
        action_id, campaign_id, user_id, actor_type, action_type, rationale,
        metrics_snapshot, budget_before, budget_after, provider_outcome
      ) VALUES (
        ${Number(inserted.rows[0].id)}, ${Number(campaign.id)}, ${Number(campaign.user_id)},
        'ai', 'pause_queued', ${evaluation.result.rationale},
        ${JSON.stringify({ ...evaluation.result.ruleResults, metrics: evaluation.metrics })}::jsonb,
        ${Number(campaign.budget_amount)}, ${Number(campaign.budget_amount)},
        ${JSON.stringify({ queued: true, targetType: evaluation.targetType, targetKey: evaluation.targetKey, beforeStatus: evaluation.providerStatus })}::jsonb
      )
    `);
    return true;
  }

  private async hierarchyConfirmed(
    userId: number,
    campaignId: number,
    platform: AdPlatform,
    stored: StoredEvaluation[],
  ): Promise<boolean> {
    const campaignEvaluation = stored.find((item) => item.targetType === 'campaign');
    if (!campaignEvaluation?.shouldPause) return false;
    const eligibleChildren = stored.filter((item) =>
      ['ad_set', 'ad_group'].includes(item.targetType)
      && !['learning', 'manual_hold', 'insufficient_data'].includes(item.state));
    if (eligibleChildren.length === 0 || !eligibleChildren.every((item) => item.shouldPause)) return false;

    const targets = [campaignEvaluation, ...eligibleChildren];
    const confirmations = await Promise.all(targets.map(async (target) => {
      const prior = await db.execute(sql`
        SELECT id FROM ad_performance_evaluations
        WHERE user_id = ${userId} AND campaign_id = ${campaignId}
          AND platform = ${platform} AND target_type = ${target.targetType}
          AND target_key = ${target.targetKey} AND id <> ${target.id}
          AND hypothetical_action = 'pause'
          AND created_at <= NOW() - INTERVAL '6 hours'
        ORDER BY created_at DESC LIMIT 1
      `);
      return Boolean(prior.rows[0]);
    }));
    return confirmations.every(Boolean);
  }

  async evaluateCampaign(userId: number, campaignId: number, options: { advisoryOnly?: boolean } = {}): Promise<{ evaluations: number; recommendations: number; actionsQueued: number }> {
    const [campaign, settings, policy] = await Promise.all([
      this.campaign(userId, campaignId),
      this.getAutonomySettings(userId),
      this.getCampaignPolicy(userId, campaignId),
    ]);
    await wakeSnoozedRecommendations(userId,campaignId);
    if (settings.mode === 'off' && !options.advisoryOnly) return { evaluations: 0, recommendations: 0, actionsQueued: 0 };
    const forcedAdvisory = options.advisoryOnly === true;
    const localStatus = String(campaign.local_status || '').toLowerCase();
    const providerStatus = String(campaign.provider_status || '').toUpperCase();
    const advisoryOnlyCampaign = ['completed', 'ended', 'paused', 'inactive', 'archived'].includes(localStatus)
      || (!['ACTIVE', 'ENABLED'].includes(providerStatus) && Boolean(providerStatus));
    const historyDays = advisoryOnlyCampaign ? 180 : 7;
    const platforms: AdPlatform[] = Array.isArray(campaign.settings?.platforms)
      ? campaign.settings.platforms as AdPlatform[]
      : [String(campaign.ad_platform) === 'google' ? 'google' : 'meta'] as AdPlatform[];
    let evaluations = 0;
    let recommendations = 0;
    let actionsQueued = 0;

    for (const platform of platforms) {
      const [baseline, unitTargets, syncEvidence] = await Promise.all([
        this.historicalBaseline(campaign, platform),
        this.targetMetrics(userId, campaignId, historyDays),
        this.syncEvidence(userId, campaignId, platform),
      ]);
      const campaignTarget = await this.campaignMetric(campaign, platform, historyDays);
      const targets = [...unitTargets.filter((item) => item.platform === platform), campaignTarget];
      const stored: StoredEvaluation[] = [];
      for (const target of targets) {
        const [manualHoldUntil, consecutiveFailingWindows] = await Promise.all([
          this.holdUntil(userId, campaignId, target),
          this.consecutiveFailures(userId, campaignId, target),
        ]);
        const providerConfig = campaign.settings?.providerConfig?.[platform] || {};
        const providerTargets: PerformanceThresholds = {
          ...(Number(providerConfig.targetCpa) > 0 ? { targetCpa: Number(providerConfig.targetCpa) } : {}),
          ...(Number(providerConfig.targetRoas) > 0 ? { targetRoas: Number(providerConfig.targetRoas) } : {}),
        };
        const campaignThresholds = { ...providerTargets, ...policy.thresholds };
        const useCampaignTarget = Object.keys(campaignThresholds).length > 0;
        const useHistorical = !useCampaignTarget && baseline.source === 'historical';
        const siblingMetrics = !useCampaignTarget && !useHistorical ? siblingBaseline(targets, target, String(campaign.objective)) : null;
        const useSibling = Boolean(siblingMetrics && Object.keys(siblingMetrics).length);
        const objectiveDefaults = {
          ...objectiveDefaultThresholds(String(campaign.objective) as AdObjective),
          ...settings.defaultThresholds,
        };
        const mergedThresholds = useCampaignTarget
          ? campaignThresholds
          : useHistorical
            ? {}
            : useSibling
              ? {}
              : objectiveDefaults;
        const baselineSource: BaselineEvidence['source'] = useCampaignTarget
          ? 'campaign_target'
          : useHistorical
            ? 'historical'
            : useSibling
              ? 'sibling_comparison'
            : Object.keys(objectiveDefaults).length > 0
              ? 'objective_default'
              : 'none';
        const evaluationBaseline: BaselineEvidence = {
          ...baseline,
          source: baselineSource,
          metrics: useSibling ? siblingMetrics! : baseline.metrics,
        };
        const objective = String(campaign.objective) as AdObjective;
        const evaluationMetrics = objective === 'app_promotion'
          ? {
            ...target.aggregate,
            cpa: target.aggregate.installs > 0 ? target.aggregate.spend / target.aggregate.installs : 0,
          }
          : target.aggregate;
        const result = evaluateAdPerformance({
          objective,
          metrics: evaluationMetrics,
          lifetimeBudget: Number(campaign.budget_amount || 0),
          thresholds: mergedThresholds,
          baseline: evaluationBaseline.metrics,
          baselineSource,
          launchedAt: campaign.launched_at ? new Date(campaign.launched_at) : campaign.start_date ? new Date(campaign.start_date) : null,
          metricsUpdatedAt: target.metricsUpdatedAt,
          analyticsSyncMinutes: settings.analyticsSyncMinutes,
          successfulSyncWindows: syncEvidence.successfulWindows,
          syncHealthy: syncEvidence.latestStatus === 'succeeded',
          providerStatus: target.providerStatus,
          consecutiveFailingWindows,
          manualHoldUntil,
          // Paused and historical campaigns remain analyzable, but this flag
          // hard-disables provider actions in the deterministic domain result.
          reportingOnlyHistorical: forcedAdvisory || advisoryOnlyCampaign || useSibling,
          lifetimeSpend: target.targetType === 'campaign' ? Number(campaign.spent_amount || target.aggregate.spend || 0) : undefined,
        });
        const evaluatedTarget = { ...target, aggregate: evaluationMetrics };
        const evaluationId = await this.storeEvaluation(
          campaign,
          evaluatedTarget,
          evaluationBaseline,
          result,
          `${settings.mode}:${settings.consentedAt || 'none'}:${policy.consentedAt || 'none'}`,
        );
        evaluations += 1;
        stored.push({ id: evaluationId, platform, targetType: target.targetType, targetKey: target.targetKey, providerResource: target.providerResource, parentTargetKey: target.parentTargetKey, providerStatus: target.providerStatus, state: result.state, shouldPause: result.shouldPause, result, metrics: evaluationMetrics });
        if (settings.mode !== 'shadow' && ['watch', 'recommendation', 'insufficient_data'].includes(result.state)) {
          await this.storeRecommendation(campaign, evaluatedTarget, evaluationId, result, evaluationBaseline);
          recommendations += 1;
        } else if (settings.mode !== 'shadow') {
          await db.execute(sql`
            UPDATE ad_recommendations SET status = 'superseded', updated_at = NOW()
            WHERE user_id = ${userId} AND campaign_id = ${campaignId}
              AND platform = ${platform} AND target_type = ${target.targetType} AND target_key = ${target.targetKey}
              AND status = 'open'
          `);
        }
      }

      if (!forcedAdvisory && settings.mode === 'live_pause' && settings.enabled && policy.enabled
        && policy.policyVersion === settings.policyVersion && settings.policyVersion === AD_AUTONOMY_POLICY_VERSION) {
        const hierarchyConfirmed = await this.hierarchyConfirmed(userId, campaignId, platform, stored);
        const candidate = selectAutonomousPauseTarget(stored, hierarchyConfirmed);
        if (candidate && await this.queuePause(campaign, policy, settings, candidate)) actionsQueued += 1;
      }
    }
    await db.execute(sql`UPDATE ad_settings SET last_evaluated_at = NOW() WHERE user_id = ${userId}`);
    return { evaluations, recommendations, actionsQueued };
  }

  async runCycle(): Promise<{ campaignsEvaluated: number; evaluations: number; recommendations: number; actionsQueued: number; errors: string[] }> {
    const due = await db.execute(sql`
      SELECT pac.id, pac.user_id
      FROM performance_ad_campaigns pac
      JOIN ad_settings settings ON settings.user_id = pac.user_id
      WHERE settings.autonomy_mode <> 'off'
        AND pac.local_status IN ('active', 'published', 'paused', 'completed', 'ended')
        AND NOT EXISTS (
          SELECT 1 FROM ad_performance_evaluations evaluation
          WHERE evaluation.user_id = pac.user_id AND evaluation.campaign_id = pac.id
            AND evaluation.created_at > NOW() - (settings.analytics_sync_minutes * INTERVAL '1 minute')
        )
      ORDER BY pac.id LIMIT 500
    `);
    let evaluations = 0;
    let recommendations = 0;
    let actionsQueued = 0;
    const errors: string[] = [];
    for (const row of due.rows as Array<Record<string, unknown>>) {
      try {
        const result = await this.evaluateCampaign(Number(row.user_id), Number(row.id));
        evaluations += result.evaluations;
        recommendations += result.recommendations;
        actionsQueued += result.actionsQueued;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown evaluation error';
        errors.push(`Campaign ${row.id}: ${message}`);
        logger.error({ err: error, campaignId: row.id }, '[AdPerformance] Evaluation failed');
      }
    }
    return { campaignsEvaluated: due.rows.length, evaluations, recommendations, actionsQueued, errors };
  }

  async recommendationStatus(userId: number, campaignId: number, recommendationId: number, status: RecommendationStatus, input:RecommendationUpdate={}) {
    return updateRecommendationLifecycle(userId,campaignId,recommendationId,status,input);
  }

  async createImprovedVersion(userId: number, campaignId: number) {
    const campaign = await this.campaign(userId, campaignId);
    const recommendations = await db.execute(sql`
      SELECT id, category, title, suggested_next_step
      FROM ad_recommendations
      WHERE user_id = ${userId} AND campaign_id = ${campaignId} AND status = 'accepted'
      ORDER BY created_at
    `);
    if (!recommendations.rows.length) throw new Error('Accept at least one recommendation before creating an improved version.');
    return db.transaction(async (tx: typeof db) => {
      const created = await tx.execute(sql`
        INSERT INTO performance_ad_campaigns (
          user_id, name, description, objective, objective_source, objective_rationale,
          ad_platform, budget_type, budget_amount, currency, spent_amount, targeting,
          locations, landing_page_url, ad_creatives, start_date, end_date, status,
          local_status, provider_status, is_active, validation_errors, content_context,
          idempotency_key, auto_activate, settings
        ) VALUES (
          ${userId}, ${`${String(campaign.name)} — improved`}, ${campaign.description || null},
          ${String(campaign.objective)}, 'accepted_recommendations',
          'Draft created from accepted, evidence-backed recommendations. Review is required before publishing.',
          ${String(campaign.ad_platform)}, ${String(campaign.budget_type || 'lifetime')},
          ${Number(campaign.budget_amount)}, ${String(campaign.currency || 'USD')}, 0,
          ${JSON.stringify(campaign.targeting || {})}::jsonb, ${JSON.stringify(campaign.locations || [])}::jsonb,
          ${String(campaign.landing_page_url || '')}, ${JSON.stringify(campaign.ad_creatives || {})}::jsonb,
          NOW(), ${campaign.end_date || null}, 'draft', 'draft', NULL, FALSE, '[]'::jsonb,
          ${JSON.stringify({ ...(campaign.content_context || {}), sourceCampaignId: campaignId, acceptedRecommendations: recommendations.rows })}::jsonb,
          ${`improved:${campaignId}:${Date.now()}`}, FALSE,
          ${JSON.stringify({ ...(campaign.settings || {}), sourceCampaignId: campaignId, acceptedRecommendations: recommendations.rows, requiresReview: true })}::jsonb
        ) RETURNING id, name, local_status
      `);
      const newCampaignId = Number(created.rows[0].id);
      await tx.execute(sql`
        INSERT INTO ad_campaign_allocations (
          campaign_id, user_id, platform, child_type, child_key,
          allocated_amount, spent_amount, status
        )
        SELECT ${newCampaignId}, ${userId}, platform, child_type, child_key,
          allocated_amount, 0, 'draft'
        FROM ad_campaign_allocations
        WHERE campaign_id = ${campaignId} AND user_id = ${userId}
      `);
      await tx.execute(sql`
        INSERT INTO ad_campaign_autonomy_policies (
          campaign_id, user_id, enabled, thresholds, consent_policy_version, revoked_at
        ) VALUES (${newCampaignId}, ${userId}, FALSE, '{}'::jsonb, ${AD_AUTONOMY_POLICY_VERSION}, NOW())
        ON CONFLICT (business_profile_id, campaign_id, user_id) DO UPDATE SET
          enabled = FALSE, thresholds = '{}'::jsonb,
          consent_policy_version = EXCLUDED.consent_policy_version,
          consented_at = NULL, consented_by_user_id = NULL,
          revoked_at = NOW(), updated_at = NOW()
      `);
      await tx.execute(sql`
        INSERT INTO ad_action_audit (
          campaign_id, user_id, actor_type, action_type, rationale, metrics_snapshot, provider_outcome
        ) VALUES (
          ${newCampaignId}, ${userId}, 'user', 'create_improved_version',
          'Created a review-only draft from accepted recommendations.',
          ${JSON.stringify({ sourceCampaignId: campaignId, recommendationIds: recommendations.rows.map((row: Record<string, unknown>) => row.id) })}::jsonb,
          ${JSON.stringify({ created: true, requiresReview: true })}::jsonb
        )
      `);
      return { ...created.rows[0], acceptedRecommendations: recommendations.rows.length, requiresReview: true };
    });
  }

  async manualResume(userId: number, campaignId: number, platform: AdPlatform, targetType: AdTargetType, targetKey: string) {
    const campaign = await this.campaign(userId, campaignId);
    const resumable = await db.execute(sql`
      SELECT id, COALESCE(provider_resource_name, provider_resource_id) AS target_resource
      FROM ad_provider_resources
      WHERE campaign_id = ${campaignId} AND user_id = ${userId}
        AND platform = ${platform} AND resource_type = ${targetType}
        AND local_key = ${targetKey} AND cleanup_status IS NULL
        AND LOWER(status) IN ('paused', 'disabled')
      ORDER BY id DESC LIMIT 1
    `);
    if (!resumable.rows[0]) {
      throw new Error('The provider target is not paused or is no longer available to resume.');
    }
    const holdUntil = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const idempotencyKey = `manual-resume:${campaignId}:${platform}:${targetType}:${targetKey}:${Date.now()}`;
    return db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`
        INSERT INTO ad_target_automation_holds (
          campaign_id, user_id, platform, target_type, target_key,
          hold_until, reason, created_by_user_id, updated_at
        ) VALUES (
          ${campaignId}, ${userId}, ${platform}, ${targetType}, ${targetKey}, ${holdUntil},
          'Manual resume: autonomous pausing is held for 72 hours.', ${userId}, NOW()
        )
        ON CONFLICT (business_profile_id, campaign_id, user_id, platform, target_type, target_key) DO UPDATE SET
          hold_until = EXCLUDED.hold_until, reason = EXCLUDED.reason,
          created_by_user_id = EXCLUDED.created_by_user_id, updated_at = NOW()
      `);
      if (targetType === 'campaign') {
        await tx.execute(sql`
          UPDATE ad_campaign_autonomy_policies
          SET manual_hold_until = ${holdUntil}, updated_at = NOW()
          WHERE campaign_id = ${campaignId} AND user_id = ${userId}
        `);
      }
      const action = await tx.execute(sql`
        INSERT INTO ad_action_queue (
          campaign_id, user_id, platform, action_type, idempotency_key,
          payload, rationale, target_type, target_key, consent_snapshot, policy_version
          , target_resource
        ) VALUES (
          ${campaignId}, ${userId}, ${platform}, 'resume', ${idempotencyKey},
          ${JSON.stringify({ actorType: 'user', targetType, targetKey })}::jsonb,
          'User manually resumed delivery; AI pause hold applied for 72 hours.',
          ${targetType}, ${targetKey}, ${JSON.stringify({ actorType: 'user', requestedAt: new Date().toISOString() })}::jsonb,
          ${AD_AUTONOMY_POLICY_VERSION}, ${resumable.rows[0].target_resource ? String(resumable.rows[0].target_resource) : null}
        ) RETURNING id
      `);
      await tx.execute(sql`
        INSERT INTO ad_performance_evaluations (
          campaign_id, user_id, platform, target_type, target_key, objective,
          window_start, window_end, metrics_snapshot, metrics_updated_at,
          baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
          confidence, state, hypothetical_action, evaluation_key, actual_action_id, created_at
        )
        SELECT campaign_id, user_id, platform, target_type, target_key, objective,
          window_start, window_end, metrics_snapshot, metrics_updated_at,
          baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
          confidence, 'manual_hold', NULL,
          LEFT(evaluation_key || ':manual-hold:' || ${Number(action.rows[0].id)}, 240),
          ${Number(action.rows[0].id)}, NOW()
        FROM ad_performance_evaluations
        WHERE user_id = ${userId} AND campaign_id = ${campaignId}
          AND platform = ${platform} AND target_type = ${targetType} AND target_key = ${targetKey}
        ORDER BY created_at DESC LIMIT 1
        ON CONFLICT (business_profile_id, user_id, evaluation_key) DO NOTHING
      `);
      await tx.execute(sql`
        INSERT INTO ad_action_audit (
          action_id, campaign_id, user_id, actor_type, action_type, rationale,
          metrics_snapshot, budget_before, budget_after, provider_outcome
        ) VALUES (
          ${Number(action.rows[0].id)}, ${campaignId}, ${userId}, 'user', 'manual_resume_queued',
          'User manually resumed delivery; AI pause hold applied for 72 hours.',
          ${JSON.stringify({ platform, targetType, targetKey, holdUntil: holdUntil.toISOString() })}::jsonb,
          ${Number(campaign.budget_amount)}, ${Number(campaign.budget_amount)},
          ${JSON.stringify({ queued: true })}::jsonb
        )
      `);
      return { actionId: Number(action.rows[0].id), holdUntil: holdUntil.toISOString() };
    });
  }

  async performanceDetail(userId: number, campaignId: number, reportingDays?: number) {
    const campaign = await this.campaign(userId, campaignId);
    await wakeSnoozedRecommendations(userId,campaignId);
    const platforms: AdPlatform[] = Array.isArray(campaign.settings?.platforms)
      ? campaign.settings.platforms as AdPlatform[]
      : [String(campaign.ad_platform) === 'google' ? 'google' : 'meta'];
    // This page used to start 12+ reads at once (more with two platforms),
    // which could take most of the pool for one view. Now about three run at a
    // time (one per platform for the per-platform reads).
    const [settings, policy, evaluations] = await Promise.all([
      this.getAutonomySettings(userId),
      this.getCampaignPolicy(userId, campaignId),
      db.execute(sql`SELECT * FROM ad_performance_evaluations WHERE user_id = ${userId} AND campaign_id = ${campaignId} ORDER BY created_at DESC LIMIT 100`),
    ]);
    const [recommendations, actions, units] = await Promise.all([
      db.execute(sql`
        SELECT recommendation.*, evaluation.state AS evaluation_state,
          COALESCE((SELECT jsonb_agg(event ORDER BY event.created_at DESC) FROM ad_recommendation_events event
            WHERE event.recommendation_id=recommendation.id AND event.user_id=${userId} AND event.campaign_id=${campaignId}), '[]'::jsonb) AS history
        FROM ad_recommendations recommendation
        LEFT JOIN ad_performance_evaluations evaluation ON evaluation.id = recommendation.evaluation_id
        WHERE recommendation.user_id = ${userId} AND recommendation.campaign_id = ${campaignId}
          AND recommendation.status <> 'superseded'
        ORDER BY CASE recommendation.category WHEN 'tracking' THEN 0 WHEN 'budget' THEN 1 ELSE 2 END, recommendation.created_at DESC LIMIT 100
      `),
      db.execute(sql`SELECT * FROM ad_action_audit WHERE user_id = ${userId} AND campaign_id = ${campaignId} ORDER BY created_at DESC LIMIT 100`),
      this.targetMetrics(userId, campaignId, reportingDays ? reportingDays - 1 : 7),
    ]);
    const [campaignUnits, performanceTrace, historicalBaselines] = await Promise.all([
      Promise.all(platforms.map((platform) => this.campaignMetric(campaign, platform, reportingDays ? reportingDays - 1 : 90))),
      db.execute(sql`
        SELECT date, platform, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
          SUM(spend) AS spend, SUM(reach) AS reach, SUM(conversions) AS conversions,
          CASE WHEN COUNT(platform_data->>'leads') = COUNT(*) THEN SUM(leads) END AS leads,
          SUM(post_engagements) AS engagements,
          CASE WHEN ${String(campaign.objective)} = 'app_promotion' THEN SUM(conversions) END AS installs
        FROM performance_metrics
        WHERE user_id = ${userId} AND campaign_id = ${campaignId}
          AND hour IS NULL AND date >= CURRENT_DATE - (${reportingDays ? reportingDays - 1 : 90} * INTERVAL '1 day')
        GROUP BY date, platform ORDER BY date, platform
      `),
      Promise.all(platforms.map(async (platform) => ({ platform, ...(await this.historicalBaseline(campaign, platform)) }))),
    ]);
    const [cachedUnits, accountIdentity, syncEvidence] = await Promise.all([
      Promise.all(platforms.map(platform => this.cachedHierarchy(userId, platform, String(campaign.platform_campaign_id || '') || null, reportingDays, campaign.ad_account_id ? String(campaign.ad_account_id) : undefined))),
      this.providerAccountIdentity(userId, platforms[0], campaign.settings?.accountSnapshot as Record<string, unknown> | undefined),
      Promise.all(platforms.map(platform => this.syncEvidence(userId, campaignId, platform))),
    ]);
    const publicEvidence = redactUnreadyAdPerformanceConfidence(
      evaluations.rows as Array<Record<string, unknown>>,
      recommendations.rows as Array<Record<string, unknown>>,
    );
    const latestEvaluation = publicEvidence.evaluations[0] as Record<string, unknown> | undefined;
    const assessment = assessmentFromRuleResults(latestEvaluation);
    const hierarchy = cachedUnits.flat();
    const unitMap = new Map<string, TargetMetricRow>();
    for (const unit of [...hierarchy, ...units]) {
      const current = unitMap.get(`${unit.platform}:${unit.targetType}:${unit.targetKey}`);
      unitMap.set(`${unit.platform}:${unit.targetType}:${unit.targetKey}`, { ...current, ...unit, name: unit.name || current?.name, creative: unit.creative || current?.creative, aggregate: unit.aggregate || current?.aggregate });
    }
    const providerActive = ['ACTIVE', 'ENABLED'].includes(String(campaign.provider_status || '').toUpperCase());
    const hierarchyGroups = [...unitMap.values()].filter(unit => ['ad_set', 'ad_group'].includes(unit.targetType)).length;
    const hierarchyAds = [...unitMap.values()].filter(unit => unit.targetType === 'ad').length;
    const evidenceBlockers = assessment?.blockers.filter(blocker => blocker.code !== 'providerActive') || [];
    const analysisReady = Boolean(latestEvaluation) && evidenceBlockers.length === 0;
    const automationBlockers = [
      ...(!providerActive ? [{ code: 'providerActive', message: humanizeGate('providerActive') }] : []),
      ...(!policy.enabled ? [{ code: 'campaignConsent', message: 'Campaign pause consent is not enabled.' }] : []),
      ...(settings.mode !== 'live_pause' ? [{ code: 'accountMode', message: 'Account mode is not Live pause.' }] : []),
      ...evidenceBlockers,
    ];
    const latestByTarget = new Map<string, Record<string, unknown>>();
    for (const evaluation of publicEvidence.evaluations) {
      const key = `${evaluation.platform}:${evaluation.target_type}:${evaluation.target_key}`;
      if (!latestByTarget.has(key)) latestByTarget.set(key, evaluation);
    }
    const targetRank: Record<string, number> = { ad: 0, ad_set: 1, ad_group: 1, campaign: 2 };
    const candidateTargets = [...latestByTarget.values()]
      .filter(evaluation => evaluation.hypothetical_action === 'pause')
      .sort((left, right) => (targetRank[String(left.target_type)] ?? 3) - (targetRank[String(right.target_type)] ?? 3))
      .map(evaluation => ({ platform: evaluation.platform, targetType: evaluation.target_type, targetKey: evaluation.target_key }));
    const nextEvaluationAt = new Date((settings.lastEvaluatedAt ? new Date(settings.lastEvaluatedAt).getTime() : Date.now()) + settings.analyticsSyncMinutes * 60_000).toISOString();
    return {
      campaign: { ...campaign, ...(reportingDays ? { reporting_window: providerReportingWindow(`last_${reportingDays}d`) } : {}), metrics_updated_at: iso(campaign.metrics_updated_at || campaign.last_synced_at) },
      settings,
      policy,
      evaluations: publicEvidence.evaluations,
      recommendations: publicEvidence.recommendations,
      actions: actions.rows,
      units: [...unitMap.values(), ...campaignUnits],
      providerAggregate: { ...metricAggregate(campaignUnits.reduce<Record<string, number>>((total, unit) => {
        for (const key of ['impressions', 'clicks', 'spend', 'reach', 'conversions', 'engagements', 'installs'] as const) total[key] = (total[key] || 0) + unit.aggregate[key];
        total.conversion_value = (total.conversion_value || 0) + unit.aggregate.conversionValue;
        return total;
      }, {})), leads: campaignUnits.every(unit => unit.aggregate.leads != null) ? campaignUnits.reduce((sum, unit) => sum + unit.aggregate.leads!, 0) : null },
      performanceTrace: performanceTrace.rows,
      historicalBaselines,
      accountIdentity,
      monitoring: { state: 'monitored', importedCampaignId: campaignId, canImport: false },
      analysisReadiness: {
        status: !latestEvaluation ? 'pending' : analysisReady ? 'ready' : 'blocked',
        blockers: evidenceBlockers,
        baselineAvailable: historicalBaselines.some(item => item.source === 'historical' && item.campaignIds.length >= 5),
        successfulSyncWindows: Math.max(0, ...syncEvidence.map(item => item.successfulWindows)),
        latestSyncStatus: syncEvidence.find(item => item.latestStatus)?.latestStatus || null,
      },
      automationEligibility: { eligible: automationBlockers.length === 0, blockers: automationBlockers, nextEvaluationAt, candidateTargets },
      currentAssessment: assessment,
      hierarchyState: {
        status: hierarchyGroups === 0 && hierarchyAds === 0 ? 'empty' : hierarchyGroups > 0 && hierarchyAds === 0 ? 'partial' : 'success',
        groupCount: hierarchyGroups,
        adCount: hierarchyAds,
      },
    };
  }

  async providerPerformanceDetail(userId: number, platform: AdPlatform, platformCampaignId: string, reportingDays?: number, accountId?: number) {
    const reportingWindow = reportingDays ? providerReportingWindow(`last_${reportingDays}d`) : undefined;
    const selectedAccount = accountId ? await (await import('./PaidAdAccountsService.js')).ownedPaidAdAccount(userId,accountId) : null;
    if(selectedAccount && selectedAccount.platform!==platform) throw new Error('Provider campaign not found.');
    const cacheAccountFilter=selectedAccount?sql`AND ad_account_id=${selectedAccount.provider_account_id}`:sql``;
    const managedCampaignResult = await db.execute(sql`
      SELECT id FROM performance_ad_campaigns
      WHERE user_id = ${userId}
        AND ad_platform = ${platform}
        AND platform_campaign_id = ${platformCampaignId}
        ${selectedAccount ? sql`AND ad_account_id=${selectedAccount.provider_account_id}` : sql``}
      ORDER BY updated_at DESC, id DESC
      LIMIT 2
    `);
    if(managedCampaignResult.rows.length>1) throw new Error('Select an ad account to view this campaign.');
    const managedCampaignId = Number((managedCampaignResult.rows[0] as Record<string, unknown> | undefined)?.id);
    if (Number.isSafeInteger(managedCampaignId) && managedCampaignId > 0) {
      return this.performanceDetail(userId, managedCampaignId, reportingDays);
    }

    const [campaignResult, unitResult, currencyResult, accountIdentity] = await Promise.all([
      db.execute(sql`
        SELECT * FROM campaign_performance_cache
        WHERE user_id = ${userId} AND platform = ${platform}
          ${cacheAccountFilter}
          AND entity_type = 'campaign' AND platform_entity_id = ${platformCampaignId}
        LIMIT 2
      `),
      db.execute(sql`
        SELECT * FROM campaign_performance_cache
        WHERE user_id = ${userId} AND platform = ${platform}
          ${cacheAccountFilter}
          AND (
            parent_entity_id = ${platformCampaignId}
            OR (
              entity_type = 'ad'
              AND parent_entity_id IN (
                SELECT platform_entity_id FROM campaign_performance_cache
                WHERE user_id = ${userId} AND platform = ${platform}
          ${cacheAccountFilter}
                  AND parent_entity_id = ${platformCampaignId}
                  AND entity_type IN ('adset', 'ad_group')
              )
            )
          )
        ORDER BY CASE entity_type WHEN 'adset' THEN 1 WHEN 'ad_group' THEN 1 WHEN 'ad' THEN 2 ELSE 3 END,
          name, platform_entity_id
      `),
      db.execute(sql`
        SELECT COALESCE(
          CASE WHEN ${platform} = 'meta' THEN (
            SELECT ad_account_currency FROM meta_page_connections
            WHERE user_id = ${userId} AND is_active = TRUE AND ad_account_currency IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1
          ) END,
          CASE WHEN ${platform} = 'google' THEN (
            SELECT COALESCE(NULLIF(config->>'currency', ''), NULLIF(config->>'currencyCode', ''))
            FROM api_credentials
            WHERE user_id = ${userId} AND service_name = 'google_ads' AND is_active = TRUE
              AND COALESCE(NULLIF(config->>'currency', ''), NULLIF(config->>'currencyCode', '')) IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1
          ) END,
          (SELECT currency FROM ad_settings WHERE user_id = ${userId} LIMIT 1),
          'USD'
        ) AS currency
      `),
      this.providerAccountIdentity(userId, platform),
    ]);
    if(campaignResult.rows.length>1) throw new Error('Select an ad account to view this campaign.');
    const row = campaignResult.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('Provider campaign not found.');
    const raw = row.raw_data && typeof row.raw_data === 'object'
      ? row.raw_data as Record<string, unknown>
      : {};
    const providerCampaign = raw.campaign && typeof raw.campaign === 'object'
      ? raw.campaign as Record<string, unknown>
      : {};
    const budget = providerBudget(raw);
    const objective = normalizeProviderObjective(providerCampaign.objective);
    const identity = raw.accountIdentity as Record<string, unknown> | undefined;
    const currency = providerCurrency(identity?.currency ? identity : currencyResult.rows[0] as Record<string, unknown> | undefined);
    const metricsUpdatedAt = iso(row.last_refreshed_at);
    const aggregate = reportingDays ? reportingWindowAggregate(raw, reportingDays, reportingWindow) : metricAggregate({
      ...row,
      engagements: Number((raw.insights as Record<string, unknown> | undefined)?.engagements || 0),
      conversion_value: row.conversion_value,
    });
    const unitRows = unitResult.rows as Array<Record<string, unknown>>;
    const groupCount = unitRows.filter(unit => unit.entity_type === 'adset' || unit.entity_type === 'ad_group').length;
    const adCount = unitRows.filter(unit => unit.entity_type === 'ad').length;
    return {
      campaign: {
        id: `provider:${platform}:${platformCampaignId}`,
        source: 'provider_cache',
        managedCampaignId: null,
        platformCampaignId,
        name: row.name || 'Unnamed campaign',
        objective: /MESSAGE|CONVERSATION/i.test(String(providerCampaign.objective)) ? 'conversations' : platform === 'google' ? 'conversions' : objective,
        ad_platform: platform,
        currency,
        budget_type: budget.type,
        budget_amount: budget.amount,
        local_status: 'report_only',
        provider_status: row.status || 'unknown',
        metrics_updated_at: metricsUpdatedAt,
        raw_provider_objective: providerCampaign.objective || null,
        reporting_window: reportingWindow && Array.isArray(raw.dailyInsights) ? reportingWindow : raw.reportingWindow || null,
      },
      settings: await this.getAutonomySettings(userId),
      policy: {
        campaignId: null,
        enabled: false,
        thresholds: {},
        policyVersion: AD_AUTONOMY_POLICY_VERSION,
        consentedAt: null,
        consentedByUserId: null,
        revokedAt: null,
        manualHoldUntil: null,
        reportOnly: true,
      },
      evaluations: [],
      recommendations: [],
      actions: [],
      units: (unitResult.rows as Array<Record<string, unknown>>).map((unit) => {
        const unitRaw = unit.raw_data && typeof unit.raw_data === 'object' ? unit.raw_data as Record<string, unknown> : {};
        return ({
        platform,
        targetType: unit.entity_type === 'ad' ? 'ad' : platform === 'google' ? 'ad_group' : 'ad_set',
        targetKey: String(unit.platform_entity_id),
        providerResource: String(unit.platform_entity_id),
        parentTargetKey: unit.parent_entity_id ? String(unit.parent_entity_id) : platformCampaignId,
        providerStatus: unit.status ? String(unit.status) : null,
        metricsUpdatedAt: iso(unit.last_refreshed_at),
        name: unit.name || null,
        creative: unit.entity_type === 'ad' && unitRaw.creative && typeof unitRaw.creative === 'object' ? unitRaw.creative : null,
        measurementWindow: JSON.stringify(reportingWindow && Array.isArray(unitRaw.dailyInsights) ? reportingWindow : unitRaw.reportingWindow || "Provider cached window"),
        dailyInsights: Array.isArray(unitRaw.dailyInsights) ? unitRaw.dailyInsights as Array<Record<string, unknown>> : [],
        aggregate: reportingDays ? reportingWindowAggregate(unitRaw, reportingDays, reportingWindow) : metricAggregate({ ...unit, conversion_value: unit.conversion_value }),
      }); }),
      performanceTrace: providerDailyMetrics(raw).filter(point => !reportingWindow || (point.date >= reportingWindow.start && point.date <= reportingWindow.end)).map(point => ({ platform, ...point })),
      historicalBaselines: [],
      providerAggregate: aggregate,
      accountIdentity: raw.accountIdentity && typeof raw.accountIdentity === 'object'
        ? { ...(raw.accountIdentity as Record<string, unknown>), platform } : accountIdentity,
      monitoring: { state: 'report_only', importedCampaignId: null, canImport: true },
      analysisReadiness: {
        status: 'import_required',
        blockers: [{ code: 'importRequired', message: 'Import this campaign into AskSales monitoring to store evaluations and recommendations.' }],
        baselineAvailable: false,
        successfulSyncWindows: 0,
        latestSyncStatus: null,
      },
      automationEligibility: {
        eligible: false,
        blockers: [{ code: 'importRequired', message: 'Monitoring import and separate campaign consent are required.' }],
      },
      currentAssessment: providerCampaignReview({ objective, metrics: aggregate, currency, providerStatus: String(row.status || 'unknown'), metricsUpdatedAt }),
      hierarchyState: {
        status: groupCount === 0 && adCount === 0 ? 'empty' : groupCount > 0 && adCount === 0 ? 'partial' : 'success',
        groupCount,
        adCount,
      },
    };
  }

  async importProviderCampaign(userId: number, platform: AdPlatform, platformCampaignId: string, accountId?: number) {
    const selectedAccount=accountId?await (await import('./PaidAdAccountsService.js')).ownedPaidAdAccount(userId,accountId):null;
    if(selectedAccount && selectedAccount.platform!==platform) throw new Error('Provider campaign not found.');
    const cacheAccountFilter=selectedAccount?sql`AND ad_account_id=${selectedAccount.provider_account_id}`:sql``;
    const [campaignResult, unitsResult, currencyResult] = await Promise.all([
      db.execute(sql`
        SELECT * FROM campaign_performance_cache
        WHERE user_id = ${userId} AND platform = ${platform}
          ${cacheAccountFilter}
          AND entity_type = 'campaign' AND platform_entity_id = ${platformCampaignId}
        LIMIT 2
      `),
      db.execute(sql`
        SELECT * FROM campaign_performance_cache
        WHERE user_id = ${userId} AND platform = ${platform}
          ${cacheAccountFilter}
          AND (
            parent_entity_id = ${platformCampaignId}
            OR (
              entity_type = 'ad'
              AND parent_entity_id IN (
                SELECT platform_entity_id FROM campaign_performance_cache
                WHERE user_id = ${userId} AND platform = ${platform}
          ${cacheAccountFilter}
                  AND parent_entity_id = ${platformCampaignId}
                  AND entity_type IN ('adset', 'ad_group')
              )
            )
          )
        ORDER BY CASE entity_type WHEN 'adset' THEN 1 WHEN 'ad_group' THEN 1 WHEN 'ad' THEN 2 ELSE 3 END,
          platform_entity_id
      `),
      db.execute(sql`
        SELECT COALESCE(
          CASE WHEN ${platform} = 'meta' THEN (
            SELECT ad_account_currency FROM meta_page_connections
            WHERE user_id = ${userId} AND is_active = TRUE AND ad_account_currency IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1
          ) END,
          CASE WHEN ${platform} = 'google' THEN (
            SELECT COALESCE(NULLIF(config->>'currency', ''), NULLIF(config->>'currencyCode', ''))
            FROM api_credentials
            WHERE user_id = ${userId} AND service_name = 'google_ads' AND is_active = TRUE
              AND COALESCE(NULLIF(config->>'currency', ''), NULLIF(config->>'currencyCode', '')) IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1
          ) END,
          (SELECT currency FROM ad_settings WHERE user_id = ${userId} LIMIT 1),
          'USD'
        ) AS currency
      `),
    ]);
    if(campaignResult.rows.length>1) throw new Error('Select an ad account to import this campaign.');
    const cached = campaignResult.rows[0] as Record<string, unknown> | undefined;
    if (!cached) throw new Error('Provider campaign not found.');
    const raw = cached.raw_data && typeof cached.raw_data === 'object'
      ? cached.raw_data as Record<string, unknown>
      : {};
    const providerCampaign = raw.campaign && typeof raw.campaign === 'object'
      ? raw.campaign as Record<string, unknown>
      : {};
    const objective = normalizeProviderObjective(providerCampaign.objective);
    const budget = providerBudget(raw);
    const identity = raw.accountIdentity as Record<string, unknown> | undefined;
    const currency = providerCurrency(identity?.currency ? identity : currencyResult.rows[0] as Record<string, unknown> | undefined);
    const providerStatus = String(cached.status || 'unknown').toLowerCase();
    const localStatus = providerStatus === 'active' ? 'active' : providerStatus === 'paused' ? 'paused' : 'imported';
    const createdAt = utcDate(providerCampaign.created_time) || new Date();
    const idempotencyKey = `provider-import:${platform}:${platformCampaignId}${platform === "google" && identity?.adAccountId ? `:${identity.adAccountId}` : ""}`;

    return db.transaction(async (tx: typeof db) => {
      const inserted = await tx.execute(sql`
        INSERT INTO performance_ad_campaigns (
          user_id, name, description, objective, objective_source, objective_rationale,
          ad_platform, platform_campaign_id, ad_account_id, budget_type, budget_amount, currency,
          spent_amount, targeting, locations, landing_page_url, ad_creatives,
          start_date, status, local_status, provider_status, is_active,
          validation_errors, content_context, idempotency_key, auto_activate, settings,
          last_synced_at
        ) VALUES (
          ${userId}, ${String(cached.name || 'Unnamed campaign')},
          'Imported from the provider cache for report-only monitoring and explicit AI policy setup.',
          ${objective}, 'provider_import',
          ${`Mapped from provider objective ${String(providerCampaign.objective || 'unknown')}. Review before enabling automation.`},
          ${platform}, ${platformCampaignId}, ${identity?.adAccountId ? String(identity.adAccountId) : null}, ${budget.type}, ${budget.amount}, ${currency},
          ${Number(cached.spend || 0)}, '{}'::jsonb, '[]'::jsonb, NULL, '[]'::jsonb,
          ${createdAt}, ${providerStatus}, ${localStatus}, ${String(cached.status || 'unknown')},
          ${providerStatus === 'active'}, '[]'::jsonb,
          ${JSON.stringify({ importedFromProviderCache: true, cacheRecordId: cached.id })}::jsonb,
          ${idempotencyKey}, FALSE,
          ${JSON.stringify({
            accountSnapshot: identity || {},
            platforms: [platform],
            importedProviderCampaign: true,
            providerCampaignId: platformCampaignId,
            providerObjective: providerCampaign.objective || null,
          })}::jsonb,
          ${utcDate(cached.last_refreshed_at)}
        )
        ON CONFLICT (business_profile_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING *
      `);
      let campaign = inserted.rows[0] as Record<string, unknown> | undefined;
      const idempotentReplay = !campaign;
      if (!campaign) {
        const existing = await tx.execute(sql`
          SELECT * FROM performance_ad_campaigns
          WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey}
          LIMIT 1
        `);
        campaign = existing.rows[0] as Record<string, unknown> | undefined;
      }
      if (!campaign) throw new Error('Provider campaign import could not be persisted.');
      const campaignId = Number(campaign.id);
      if (!idempotentReplay) {
        await tx.execute(sql`
          INSERT INTO ad_campaign_autonomy_policies (
            campaign_id, user_id, enabled, thresholds, consent_policy_version,
            consented_at, consented_by_user_id, revoked_at, updated_at
          ) VALUES (
            ${campaignId}, ${userId}, FALSE, '{}'::jsonb, ${AD_AUTONOMY_POLICY_VERSION},
            NULL, NULL, NOW(), NOW()
          )
          ON CONFLICT (business_profile_id, campaign_id, user_id) DO NOTHING
        `);
        for (const unit of unitsResult.rows as Array<Record<string, unknown>>) {
          if (unit.entity_type === 'ad') continue;
          const childType = platform === 'google' ? 'ad_group' : 'ad_set';
          const allocation = importedAllocationSnapshot(unit.spend);
          await tx.execute(sql`
            INSERT INTO ad_campaign_allocations (
              campaign_id, user_id, platform, child_type, child_key,
              allocated_amount, spent_amount, status
            ) VALUES (
              ${campaignId}, ${userId}, ${platform}, ${childType},
              ${String(unit.platform_entity_id)}, ${allocation.allocatedAmount}, ${allocation.spentAmount},
              ${String(unit.status || 'unknown').toLowerCase()}
            )
          `);
        }
        const dailyMetrics = providerDailyMetrics(raw);
        for (const metric of dailyMetrics) {
          const ctr = metric.impressions > 0 ? (metric.clicks / metric.impressions) * 100 : 0;
          const cpc = metric.clicks > 0 ? metric.spend / metric.clicks : 0;
          const cpm = metric.impressions > 0 ? (metric.spend / metric.impressions) * 1000 : 0;
          const cpa = metric.conversions > 0 ? metric.spend / metric.conversions : 0;
          await tx.execute(sql`
            INSERT INTO performance_metrics (
              campaign_id, user_id, platform_campaign_id, platform, date, hour,
              impressions, clicks, spend, reach, conversions, leads,
              ctr, cpc, cpm, cpa, platform_data, source_scope, sync_status,
              provider_status, updated_at
            ) VALUES (
              ${campaignId}, ${userId}, ${platformCampaignId}, ${platform}, ${metric.date}::date, NULL,
              ${metric.impressions}, ${metric.clicks}, ${metric.spend}, ${metric.reach}, ${metric.conversions},
              ${metric.leads}, ${ctr}, ${cpc}, ${cpm}, ${cpa},
              ${JSON.stringify({ importedFromProviderCache: true, leads: metric.leads })}::jsonb, 'provider_cache', 'succeeded',
              ${String(cached.status || 'unknown')}, ${utcDate(cached.last_refreshed_at)}
            )
            ON CONFLICT (campaign_id, platform, date) WHERE hour IS NULL DO UPDATE SET
              impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, spend=EXCLUDED.spend,
              reach=EXCLUDED.reach, conversions=EXCLUDED.conversions, leads=EXCLUDED.leads,
              ctr=EXCLUDED.ctr, cpc=EXCLUDED.cpc, cpm=EXCLUDED.cpm, cpa=EXCLUDED.cpa,
              platform_data=EXCLUDED.platform_data, source_scope=EXCLUDED.source_scope,
              sync_status='succeeded', provider_status=EXCLUDED.provider_status, updated_at=EXCLUDED.updated_at
          `);
        }
        if (dailyMetrics.length) {
          await tx.execute(sql`
            INSERT INTO ad_analytics_sync_runs (
              campaign_id, user_id, platform, date_start, date_stop, status, metrics_ingested
            ) VALUES (
              ${campaignId}, ${userId}, ${platform}, ${dailyMetrics[0].date}::date,
              ${dailyMetrics[dailyMetrics.length - 1].date}::date, 'succeeded', ${dailyMetrics.length}
            )
          `);
        }
        await tx.execute(sql`
          INSERT INTO ad_action_audit (
            campaign_id, user_id, actor_type, action_type, rationale,
            metrics_snapshot, budget_before, budget_after, provider_outcome
          ) VALUES (
            ${campaignId}, ${userId}, 'user', 'import_provider_campaign',
            'Provider campaign imported for monitoring. Autonomous pause consent remains disabled.',
            ${JSON.stringify({
              providerCampaignId: platformCampaignId,
              platform,
              cacheRecordId: cached.id,
              metricsUpdatedAt: iso(cached.last_refreshed_at),
            })}::jsonb,
            ${budget.amount}, ${budget.amount},
            ${JSON.stringify({ success: true, providerMutation: false })}::jsonb
          )
        `);
      }
      // Persist verified resource identities so daily unit sync and guarded pause can resolve the imported hierarchy.
      if(platform === 'meta' || /^\d{10}$/.test(String(identity?.adAccountId || ''))) {
        for (const resource of [cached, ...(unitsResult.rows as Array<Record<string, unknown>>)]) {
          const type = resource.entity_type === 'campaign' ? 'campaign' : resource.entity_type === 'ad' ? 'ad' : platform === 'google' ? 'ad_group' : 'ad_set';
          const key = type === 'campaign' ? 'campaign' : String(resource.platform_entity_id);
          const rawResource = resource.raw_data as Record<string,unknown> | undefined;
          const resourceName = platform === 'google' ? String(rawResource?.providerResource || `customers/${identity?.adAccountId}/${type === 'campaign' ? 'campaigns' : type === 'ad_group' ? 'adGroups' : 'adGroupAds'}/${resource.platform_entity_id}`) : null;
          await tx.execute(sql`INSERT INTO ad_provider_resources (
            campaign_id,user_id,platform,resource_type,local_key,provider_resource_id,provider_resource_name,status,idempotency_key,metadata
          ) VALUES (${campaignId},${userId},${platform},${type},${key},${String(resource.platform_entity_id)},${resourceName},${String(resource.status || 'unknown')},
            ${`provider-import:${campaignId}:${type}:${key}`},${JSON.stringify({importedFromProviderCache:true,adAccountId:identity?.adAccountId || null})}::jsonb)
          ON CONFLICT(business_profile_id, user_id,platform,idempotency_key) DO NOTHING`);
        }
      }
      // Cached ad/ad-set totals describe a provider reporting window, not a
      // single day. cachedHierarchy exposes them for review; only daily
      // provider syncs may populate ad_unit_metrics for policy evaluation.
      return { ...campaign, idempotentReplay, policyEnabled: false };
    });
  }

  async dashboardSummary(userId: number) {
    const [settings, summary, recentActions, operational] = await Promise.all([
      this.getAutonomySettings(userId),
      db.execute(sql`
        WITH latest_units AS (
          SELECT DISTINCT ON (evaluation.campaign_id, evaluation.platform, evaluation.target_type, evaluation.target_key)
            evaluation.state, evaluation.created_at, evaluation.metrics_updated_at
          FROM ad_performance_evaluations evaluation
          WHERE evaluation.user_id = ${userId}
          ORDER BY evaluation.campaign_id, evaluation.platform, evaluation.target_type, evaluation.target_key, evaluation.created_at DESC
        )
        SELECT
          (SELECT COUNT(*) FROM ad_campaign_autonomy_policies policy WHERE policy.user_id = ${userId} AND policy.enabled) AS consented_campaigns,
          (SELECT COUNT(*) FROM performance_ad_campaigns campaign WHERE campaign.user_id = ${userId}) AS total_campaigns,
          COUNT(*) FILTER (WHERE state IN ('watch', 'recommendation')) AS watched_units,
          COUNT(*) FILTER (WHERE state = 'ai_paused') AS paused_units,
          MAX(created_at) AS last_evaluation_at,
          MAX(metrics_updated_at) AS data_freshness_at
        FROM latest_units
      `),
      db.execute(sql`
        SELECT audit.* FROM ad_action_audit audit
        WHERE audit.user_id = ${userId}
          AND audit.action_type IN ('pause', 'pause_queued', 'manual_resume_queued')
        ORDER BY audit.created_at DESC LIMIT 10
      `),
      db.execute(sql`
        WITH ai_pauses AS (
          SELECT id, campaign_id, status, completed_at
          FROM ad_action_queue
          WHERE user_id = ${userId} AND action_type = 'pause' AND evaluation_id IS NOT NULL
            AND created_at >= NOW() - INTERVAL '30 days'
        ), reversals AS (
          SELECT COUNT(*) AS count
          FROM ad_action_audit resume
          WHERE resume.user_id = ${userId} AND resume.action_type = 'manual_resume_queued'
            AND resume.created_at >= NOW() - INTERVAL '30 days'
            AND EXISTS (
              SELECT 1 FROM ai_pauses pause
              WHERE pause.campaign_id = resume.campaign_id AND pause.status = 'succeeded'
                AND pause.completed_at BETWEEN resume.created_at - INTERVAL '72 hours' AND resume.created_at
            )
        ), notification_sla AS (
          SELECT COUNT(*) FILTER (WHERE delivery.status = 'succeeded'
              AND delivery.delivered_at <= pause.completed_at + INTERVAL '2 minutes') AS on_time,
            COUNT(*) AS total
          FROM ad_action_notification_deliveries delivery
          JOIN ai_pauses pause ON pause.id = delivery.action_id AND pause.status = 'succeeded'
        )
        SELECT COUNT(*) AS total_pauses,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed_pauses,
          (SELECT count FROM reversals) AS manual_reversals,
          (SELECT on_time FROM notification_sla) AS notifications_on_time,
          (SELECT total FROM notification_sla) AS notification_total
        FROM ai_pauses
      `),
    ]);
    const row = summary.rows[0] as Record<string, unknown> || {};
    const health = operational.rows[0] as Record<string, unknown> || {};
    const totalPauses = Number(health.total_pauses || 0);
    const notificationTotal = Number(health.notification_total || 0);
    return {
      settings,
      consentedCampaigns: Number(row.consented_campaigns || 0),
      totalCampaigns: Number(row.total_campaigns || 0),
      watchedUnits: Number(row.watched_units || 0),
      pausedUnits: Number(row.paused_units || 0),
      lastEvaluationAt: iso(row.last_evaluation_at),
      dataFreshnessAt: iso(row.data_freshness_at),
      recentActions: recentActions.rows,
      operational: {
        providerPauseFailureRate: totalPauses > 0 ? Number(health.failed_pauses || 0) / totalPauses * 100 : 0,
        manualReversalRate: totalPauses > 0 ? Number(health.manual_reversals || 0) / totalPauses * 100 : 0,
        notificationWithinTwoMinutes: notificationTotal > 0
          ? Number(health.notifications_on_time || 0) / notificationTotal * 100
          : 100,
      },
    };
  }

  async revalidateAutonomousPause(action: Record<string, unknown>): Promise<{ valid: boolean; reason?: string }> {
    if (String(action.action_type) !== 'pause' || !action.evaluation_id) return { valid: true };
    const [settings, policy] = await Promise.all([
      this.getAutonomySettings(Number(action.user_id)),
      this.getCampaignPolicy(Number(action.user_id), Number(action.campaign_id)),
    ]);
    if (settings.mode !== 'live_pause' || !settings.enabled) return { valid: false, reason: 'Account live-pause consent is not active.' };
    if (!policy.enabled) return { valid: false, reason: 'Campaign AI-pause consent is not active.' };
    if (settings.policyVersion !== AD_AUTONOMY_POLICY_VERSION || policy.policyVersion !== AD_AUTONOMY_POLICY_VERSION
      || String(action.policy_version || '') !== AD_AUTONOMY_POLICY_VERSION) {
      return { valid: false, reason: 'The consent policy version changed after evaluation.' };
    }
    const consentSnapshot = action.consent_snapshot && typeof action.consent_snapshot === 'object'
      ? action.consent_snapshot as Record<string, unknown>
      : {};
    if (String(consentSnapshot.accountConsentedAt || '') !== String(settings.consentedAt || '')
      || String(consentSnapshot.campaignConsentedAt || '') !== String(policy.consentedAt || '')) {
      return { valid: false, reason: 'Consent was revoked or renewed after this action was evaluated.' };
    }
    const hold = await db.execute(sql`
      SELECT id FROM ad_target_automation_holds
      WHERE user_id = ${Number(action.user_id)} AND campaign_id = ${Number(action.campaign_id)}
        AND platform = ${String(action.platform)} AND target_type = ${String(action.target_type)}
        AND target_key = ${String(action.target_key)} AND hold_until > NOW() LIMIT 1
    `);
    if (hold.rows[0]) return { valid: false, reason: 'A manual 72-hour hold is active for this unit.' };
    const evaluation = await db.execute(sql`
      SELECT metrics_updated_at, state, hypothetical_action FROM ad_performance_evaluations
      WHERE id = ${Number(action.evaluation_id)} AND user_id = ${Number(action.user_id)}
        AND campaign_id = ${Number(action.campaign_id)} LIMIT 1
    `);
    if (String(evaluation.rows[0]?.state || '') !== 'recommendation'
      || evaluation.rows[0]?.hypothetical_action !== 'pause') {
      return { valid: false, reason: 'The originating evaluation no longer authorizes a pause.' };
    }
    const latestDecision = await db.execute(sql`
      SELECT id, state FROM ad_performance_evaluations
      WHERE user_id = ${Number(action.user_id)} AND campaign_id = ${Number(action.campaign_id)}
        AND platform = ${String(action.platform)} AND target_type = ${String(action.target_type)}
        AND target_key = ${String(action.target_key)}
      ORDER BY created_at DESC, id DESC LIMIT 1
    `);
    if (Number(latestDecision.rows[0]?.id || 0) !== Number(action.evaluation_id)) {
      return { valid: false, reason: 'A newer performance evaluation superseded this pause decision.' };
    }
    const metricsUpdatedAt = utcDate(evaluation.rows[0]?.metrics_updated_at);
    const freshnessMs = Math.max(30, settings.analyticsSyncMinutes * 2) * 60_000;
    if (!metricsUpdatedAt || Date.now() - metricsUpdatedAt.getTime() > freshnessMs) {
      return { valid: false, reason: 'The underlying provider metrics are stale; a fresh evaluation is required.' };
    }
    const latestSync = await db.execute(sql`
      SELECT status FROM ad_analytics_sync_runs
      WHERE user_id = ${Number(action.user_id)} AND campaign_id = ${Number(action.campaign_id)}
        AND platform = ${String(action.platform)}
      ORDER BY completed_at DESC LIMIT 1
    `);
    if (String(latestSync.rows[0]?.status || '') !== 'succeeded') {
      return { valid: false, reason: 'The latest provider metric synchronization is not successful.' };
    }
    const target = await db.execute(sql`
      SELECT status, COALESCE(provider_resource_name, provider_resource_id) AS provider_resource
      FROM ad_provider_resources
      WHERE user_id = ${Number(action.user_id)} AND campaign_id = ${Number(action.campaign_id)}
        AND platform = ${String(action.platform)} AND resource_type = ${String(action.target_type)}
        AND local_key = ${String(action.target_key)} AND cleanup_status IS NULL
      ORDER BY id DESC LIMIT 1
    `);
    if (!target.rows[0] || String(target.rows[0].status || '').toLowerCase() !== 'active') {
      return { valid: false, reason: 'The provider target is no longer active and eligible for pausing.' };
    }
    if (!action.target_resource || String(target.rows[0].provider_resource || '') !== String(action.target_resource)) {
      return { valid: false, reason: 'The provider target changed after evaluation; a fresh evaluation is required.' };
    }
    return { valid: true };
  }
}

export const adPerformanceService = new AdPerformanceService();
