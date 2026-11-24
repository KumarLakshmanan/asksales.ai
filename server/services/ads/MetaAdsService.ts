import { assertReportingRange, isReportingDate } from '../../utils/reportingDates.js';
import { metaActionValue, metaConversionValue } from './MetaInsightMetrics.js';
import { measuredLeads } from './AdLeadMetrics.js';
/**
 * Meta Ads Service - Facebook/Instagram Marketing API Integration
 * Handles campaign creation, ad set management, and ad publishing
 */

import { logger } from '../../utils/logger.js';
import { getGraphApiBase, getGraphApiVersion } from '../../utils/metaApiVersion.js';

type MetaGraphError = Error & {
  httpStatus?: number;
  providerCode?: number;
  providerSubcode?: number;
  providerType?: string;
  providerTransient?: boolean;
  traceId?: string;
};

function createMetaGraphError(
  response: Response,
  providerError: Record<string, unknown> | undefined,
  fallback: string,
): MetaGraphError {
  const error = new Error(String(providerError?.message || fallback)) as MetaGraphError;
  error.httpStatus = response.status;
  if (Number.isFinite(Number(providerError?.code))) error.providerCode = Number(providerError?.code);
  if (Number.isFinite(Number(providerError?.error_subcode))) error.providerSubcode = Number(providerError?.error_subcode);
  if (typeof providerError?.type === 'string') error.providerType = providerError.type;
  if (typeof providerError?.is_transient === 'boolean') error.providerTransient = providerError.is_transient;
  if (typeof providerError?.fbtrace_id === 'string') error.traceId = providerError.fbtrace_id;
  return error;
}

function normalizeAdAccountId(adAccountId: string): string {
  return adAccountId.trim().replace(/^act_/i, '');
}

export interface MetaCredentials {
  accessToken: string;
  adAccountId: string;
  expiresAt?: Date;
  refreshToken?: string;
}

export interface MetaCampaign {
  name: string;
  objective: 'OUTCOME_AWARENESS' | 'OUTCOME_ENGAGEMENT' | 'OUTCOME_TRAFFIC' | 'OUTCOME_LEADS' | 'OUTCOME_SALES' | 'OUTCOME_APP_PROMOTION';
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  specialAdCategories?: string[];
  dailyBudget?: number; // in cents
  lifetimeBudget?: number; // in cents
  bidStrategy?: 'LOWEST_COST_WITHOUT_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'COST_CAP';
  specialAdCategoryCountries?: string[];
}

export interface MetaAdSet {
  campaignId: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  dailyBudget?: number;
  lifetimeBudget?: number;
  billingEvent: 'IMPRESSIONS' | 'LINK_CLICKS' | 'POST_ENGAGEMENT';
  optimizationGoal: 'REACH' | 'IMPRESSIONS' | 'LINK_CLICKS' | 'LANDING_PAGE_VIEWS' | 'POST_ENGAGEMENT' | 'LEAD_GENERATION' | 'OFFSITE_CONVERSIONS' | 'APP_INSTALLS';
  targeting: MetaTargeting;
  bidStrategy?: 'LOWEST_COST_WITHOUT_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_MIN_ROAS';
  bidAmount?: number;
  promotedObject?: Record<string, unknown>;
  startTime?: Date;
  endTime?: Date;
}

export interface MetaTargeting {
  geoLocations?: {
    countries?: string[];
    regions?: Array<{ key: string }>;
    cities?: Array<{ key: string; radius?: number; distance_unit?: 'mile' | 'kilometer' }>;
  };
  ageMin?: number;
  ageMax?: number;
  genders?: Array<1 | 2>; // 1=male, 2=female
  interests?: Array<{ id: string; name?: string }>;
  behaviors?: Array<{ id: string; name?: string }>;
  flexibleSpec?: Array<{
    interests?: Array<{ id: string }>;
    behaviors?: Array<{ id: string }>;
  }>;
  customAudiences?: Array<{ id: string }>;
  excludedCustomAudiences?: Array<{ id: string }>;
  publisherPlatforms?: Array<'facebook' | 'instagram' | 'audience_network' | 'messenger'>;
  facebookPositions?: string[];
  instagramPositions?: string[];
  audienceNetworkPositions?: string[];
  messengerPositions?: string[];
}

export interface MetaAd {
  adSetId: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  creative: MetaCreative;
}

export interface MetaCreative {
  name: string;
  objectStorySpec?: {
    pageId: string;
    instagramActorId?: string;
    linkData?: {
      link: string;
      message?: string;
      name?: string;
      description?: string;
      imageHash?: string;
      callToAction?: {
        type: string;
        value?: {
          link?: string;
        };
      };
    };
    videoData?: {
      videoId: string;
      message?: string;
      title?: string;
      callToAction?: {
        type: string;
        value?: { link?: string };
      };
    };
  };
  imageUrl?: string;
  imageHash?: string;
}

export interface MetaMetrics {
  campaignId: string;
  adSetId?: string;
  adId?: string;
  impressions: number;
  clicks: number;
  spend: number; // in account currency
  reach: number;
  cpc: number;
  cpm: number;
  ctr: number;
  conversions?: number;
  conversionValue?: number;
  leads?: number;
  costPerConversion?: number;
  dateStart: string;
  dateStop: string;
  reachAggregation?: 'sum_of_daily_reach';
}

export interface MetaAdSetDailyMetric {
  adSetId: string;
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  reach: number;
  conversions: number;
  conversionValue: number;
  engagements: number;
  installs: number;
  status?: string;
  source: Record<string, unknown>;
}

export interface MetaAdDailyMetric extends MetaAdSetDailyMetric {
  adId: string;
}

export interface MetaCampaignDiagnostics {
  campaign: Record<string, unknown>;
  adSets: Array<Record<string, unknown>>;
  placement: Array<Record<string, unknown>>;
  audience: Array<Record<string, unknown>>;
  geography: Array<Record<string, unknown>>;
  tracking: {
    state: 'configured' | 'partial' | 'unavailable';
    pixelIds: string[];
    applicationIds: string[];
    configuredEvents: string[];
    attributionSpecs: unknown[];
    observedActionTypes: string[];
    explanation: string;
  };
  completeness: Record<string, number | boolean>;
  limitations: string[];
}

/**
 * MetaAdsService - Main service for Meta advertising
 */
export class MetaAdsService {
  private static _instance: MetaAdsService | null = null;
  private credentials: MetaCredentials | null = null;

  constructor(credentials?: MetaCredentials) {
    if (credentials) {
      this.credentials = credentials;
    }
  }

  /**
   * Set credentials for API access
   */
  setCredentials(credentials: MetaCredentials): void {
    this.credentials = credentials;
  }

  /**
   * Check if credentials are available and valid
   */
  isAuthenticated(): boolean {
    if (!this.credentials?.accessToken) {
      return false;
    }

    // Check if token is expired
    if (this.credentials.expiresAt && new Date() > this.credentials.expiresAt) {
      return false;
    }

    return true;
  }

  /**
   * Create a campaign
   */
  async createCampaign(campaign: MetaCampaign): Promise<{ success: boolean; campaignId?: string; error?: string }> {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated with Meta' };
    }

    try {
      const adAccountId = normalizeAdAccountId(this.credentials!.adAccountId);
      const url = `${getGraphApiBase(await getGraphApiVersion())}/act_${adAccountId}/campaigns`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        name: campaign.name,
        objective: campaign.objective,
        status: campaign.status,
      };

      if (campaign.specialAdCategories) {
        params.special_ad_categories = JSON.stringify(campaign.specialAdCategories);
      }
      if (campaign.specialAdCategoryCountries?.length) {
        params.special_ad_category_country = JSON.stringify(campaign.specialAdCategoryCountries);
      }

      if (campaign.dailyBudget) {
        params.daily_budget = campaign.dailyBudget;
      }

      if (campaign.lifetimeBudget) {
        params.lifetime_budget = campaign.lifetimeBudget;
      }

      if (campaign.bidStrategy) {
        params.bid_strategy = campaign.bidStrategy;
      }

      const formData = new URLSearchParams(params);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials!.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error?.message || 'Failed to create campaign');
      }

      logger.info(`[MetaAdsService] Campaign created: ${data.id}`);

      return {
        success: true,
        campaignId: data.id,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[MetaAdsService] Error creating campaign:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Create an ad set
   */
  async createAdSet(adSet: MetaAdSet): Promise<{ success: boolean; adSetId?: string; error?: string }> {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated with Meta' };
    }

    try {
      const adAccountId = normalizeAdAccountId(this.credentials!.adAccountId);
      const url = `${getGraphApiBase(await getGraphApiVersion())}/act_${adAccountId}/adsets`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        name: adSet.name,
        campaign_id: adSet.campaignId,
        status: adSet.status,
        billing_event: adSet.billingEvent,
        optimization_goal: adSet.optimizationGoal,
        targeting: JSON.stringify(this.serializeTargeting(adSet.targeting)),
      };
      if (adSet.bidStrategy) params.bid_strategy = adSet.bidStrategy;
      if (adSet.bidAmount) params.bid_amount = adSet.bidAmount;
      if (adSet.promotedObject) params.promoted_object = JSON.stringify(adSet.promotedObject);

      if (adSet.dailyBudget) {
        params.daily_budget = adSet.dailyBudget;
      }

      if (adSet.lifetimeBudget) {
        params.lifetime_budget = adSet.lifetimeBudget;
      }

      if (adSet.startTime) {
        params.start_time = adSet.startTime.toISOString();
      }

      if (adSet.endTime) {
        params.end_time = adSet.endTime.toISOString();
      }

      const formData = new URLSearchParams(params);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials!.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error?.message || 'Failed to create ad set');
      }

      logger.info(`[MetaAdsService] Ad set created: ${data.id}`);

      return {
        success: true,
        adSetId: data.id,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[MetaAdsService] Error creating ad set:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Upload image and get hash
   */
  async uploadImage(imageUrl: string): Promise<{ success: boolean; imageHash?: string; error?: string }> {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated with Meta' };
    }

    try {
      const adAccountId = normalizeAdAccountId(this.credentials!.adAccountId);
      const url = `${getGraphApiBase(await getGraphApiVersion())}/act_${adAccountId}/adimages`;

      const params = new URLSearchParams({
        url: imageUrl,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials!.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error?.message || 'Failed to upload image');
      }

      const imageHash = data.images?.[imageUrl]?.hash;

      if (!imageHash) {
        throw new Error('Image hash not returned');
      }

      logger.info(`[MetaAdsService] Image uploaded: ${imageHash}`);

      return {
        success: true,
        imageHash,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[MetaAdsService] Error uploading image:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  async uploadVideo(videoUrl: string): Promise<{ success: boolean; videoId?: string; error?: string }> {
    if (!this.isAuthenticated()) return { success: false, error: 'Not authenticated with Meta' };
    try {
      const adAccountId = normalizeAdAccountId(this.credentials!.adAccountId);
      const response = await fetch(`${getGraphApiBase(await getGraphApiVersion())}/act_${adAccountId}/advideos`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials!.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ file_url: videoUrl }).toString(),
      });
      const data = await response.json() as { id?: string; error?: { message?: string } };
      if (!response.ok || data.error || !data.id) {
        throw new Error(data.error?.message || 'Failed to upload video');
      }
      return { success: true, videoId: data.id };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown video upload error' };
    }
  }

  /**
   * Create an ad
   */
  async createAd(ad: MetaAd): Promise<{ success: boolean; adId?: string; error?: string }> {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated with Meta' };
    }

    try {
      const adAccountId = normalizeAdAccountId(this.credentials!.adAccountId);

      // First, create the creative
      const creativeUrl = `${getGraphApiBase(await getGraphApiVersion())}/act_${adAccountId}/adcreatives`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const creativeParams: any = {
        name: ad.creative.name,
      };

      if (ad.creative.objectStorySpec) {
        creativeParams.object_story_spec = JSON.stringify(this.serializeObjectStorySpec(ad.creative.objectStorySpec));
      }

      const creativeFormData = new URLSearchParams(creativeParams);

      const creativeResponse = await fetch(creativeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials!.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: creativeFormData.toString(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const creativeData: any = await creativeResponse.json();

      if (!creativeResponse.ok || creativeData.error) {
        throw new Error(creativeData.error?.message || 'Failed to create creative');
      }

      const creativeId = creativeData.id;

      // Now create the ad
      const adUrl = `${getGraphApiBase(await getGraphApiVersion())}/act_${adAccountId}/ads`;

      const adParams = new URLSearchParams({
        name: ad.name,
        adset_id: ad.adSetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: ad.status,
      });

      const adResponse = await fetch(adUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials!.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: adParams.toString(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adData: any = await adResponse.json();

      if (!adResponse.ok || adData.error) {
        throw new Error(adData.error?.message || 'Failed to create ad');
      }

      logger.info(`[MetaAdsService] Ad created: ${adData.id}`);

      return {
        success: true,
        adId: adData.id,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[MetaAdsService] Error creating ad:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  private serializeTargeting(targeting: MetaTargeting): Record<string, unknown> {
    return {
      ...(targeting.geoLocations ? {
        geo_locations: {
          countries: targeting.geoLocations.countries,
          regions: targeting.geoLocations.regions,
          cities: targeting.geoLocations.cities,
        },
      } : {}),
      ...(targeting.ageMin ? { age_min: targeting.ageMin } : {}),
      ...(targeting.ageMax ? { age_max: targeting.ageMax } : {}),
      ...(targeting.genders?.length ? { genders: targeting.genders } : {}),
      ...(targeting.interests?.length ? { interests: targeting.interests } : {}),
      ...(targeting.behaviors?.length ? { behaviors: targeting.behaviors } : {}),
      ...(targeting.flexibleSpec?.length ? { flexible_spec: targeting.flexibleSpec } : {}),
      ...(targeting.customAudiences?.length ? { custom_audiences: targeting.customAudiences } : {}),
      ...(targeting.excludedCustomAudiences?.length ? { excluded_custom_audiences: targeting.excludedCustomAudiences } : {}),
      ...(targeting.publisherPlatforms?.length ? { publisher_platforms: targeting.publisherPlatforms } : {}),
      ...(targeting.facebookPositions?.length ? { facebook_positions: targeting.facebookPositions } : {}),
      ...(targeting.instagramPositions?.length ? { instagram_positions: targeting.instagramPositions } : {}),
      ...(targeting.audienceNetworkPositions?.length ? { audience_network_positions: targeting.audienceNetworkPositions } : {}),
      ...(targeting.messengerPositions?.length ? { messenger_positions: targeting.messengerPositions } : {}),
    };
  }

  private serializeObjectStorySpec(spec: NonNullable<MetaCreative['objectStorySpec']>): Record<string, unknown> {
    return {
      page_id: spec.pageId,
      ...(spec.instagramActorId ? { instagram_actor_id: spec.instagramActorId } : {}),
      ...(spec.linkData ? {
        link_data: {
          link: spec.linkData.link,
          message: spec.linkData.message,
          name: spec.linkData.name,
          description: spec.linkData.description,
          image_hash: spec.linkData.imageHash,
          call_to_action: spec.linkData.callToAction ? {
            type: spec.linkData.callToAction.type,
            value: spec.linkData.callToAction.value,
          } : undefined,
        },
      } : {}),
      ...(spec.videoData ? {
        video_data: {
          video_id: spec.videoData.videoId,
          message: spec.videoData.message,
          title: spec.videoData.title,
          call_to_action: spec.videoData.callToAction ? {
            type: spec.videoData.callToAction.type,
            value: spec.videoData.callToAction.value,
          } : undefined,
        },
      } : {}),
    };
  }

  /** Read a complete insight response before exposing any metrics. */
  private async readDailyInsights(campaignId: string, dateStart: string, dateStop: string, level: 'campaign' | 'adset' | 'ad') {
    assertReportingRange(dateStart, dateStop);
    if (!this.isAuthenticated()) throw new Error('Not authenticated with Meta');
    const fields = ['date_start', 'impressions', 'clicks', 'spend', 'reach', 'actions', 'action_values'];
    if (level !== 'campaign') fields.push('adset_id');
    if (level === 'ad') fields.push('ad_id');
    const params = new URLSearchParams({ level, fields: fields.join(','), time_increment: '1',
      time_range: JSON.stringify({ since: dateStart, until: dateStop }), limit: '500' });
    const base = getGraphApiBase(await getGraphApiVersion());
    const origin = new URL(base).origin;
    let next: string | null = `${base}/${encodeURIComponent(campaignId)}/insights?${params}`;
    const visited = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    while (next) {
      if (visited.has(next) || visited.size >= 100) throw new Error('Meta reporting pagination did not complete');
      if (new URL(next).origin !== origin) throw new Error('Meta returned an invalid reporting page');
      visited.add(next);
      const response = await fetch(next, { method: 'GET', headers: { Authorization: `Bearer ${this.credentials!.accessToken}` } });
      const body = await response.json() as { data?: Array<Record<string, unknown>>; paging?: { next?: string }; error?: Record<string, unknown> };
      if (!response.ok || body.error) throw createMetaGraphError(response, body.error, 'Meta metrics request failed');
      if (!Array.isArray(body.data)) throw new Error('Meta returned incomplete reporting data');
      rows.push(...body.data);
      next = body.paging?.next || null;
    }
    // Daily queries have no breakdowns: one row per entity/day is authoritative.
    // Reject conflicting duplicates rather than inventing a correction order.
    const unique = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const date = row.date_start;
      if (!isReportingDate(date) || date < dateStart || date > dateStop) throw new Error('Meta returned an invalid reporting day');
      if (level !== 'campaign' && !row.adset_id || level === 'ad' && !row.ad_id) throw new Error('Meta returned incomplete child identities');
      const key = `${level === 'ad' ? row.ad_id : level === 'adset' ? row.adset_id : campaignId}:${date}`;
      const previous = unique.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Meta returned conflicting daily facts');
      unique.set(key, row);
    }
    return [...unique.values()];
  }

  private dailyMetric(row: Record<string, unknown>, objective?: string) {
    const actions = row.actions as Array<{ action_type?: string; value?: string }> | undefined;
    const values = row.action_values as Array<{ action_type?: string; value?: string }> | undefined;
    return { date: String(row.date_start), impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0),
      spend: Number(row.spend || 0), reach: Number(row.reach || 0),
      conversions: metaConversionValue(actions, objective), conversionValue: metaActionValue(values, ['purchase', 'omni_purchase']),
      engagements: metaActionValue(actions, ['post_engagement']), installs: metaActionValue(actions, ['mobile_app_install', 'app_install']),
      source: { ...row, leads: measuredLeads({ actions: actions || [] }), conversionValueAvailable: Array.isArray(values) } };
  }

  private metricsError(error: unknown): string {
    const detail = error as MetaGraphError;
    if (detail.providerCode === 100 && detail.providerSubcode === 33) return 'Meta cannot access this campaign. Check that it still exists and reconnect the Meta account with access to it. (Meta code 100, subcode 33)';
    return detail.message || 'Meta metrics request failed';
  }

  async getCampaignMetricsByDateRange(campaignId: string, dateStart: string, dateStop: string, objective?: string) {
    try {
      const rows = await this.readDailyInsights(campaignId, dateStart, dateStop, 'campaign');
      return { success: true as const, metrics: rows.map(row => ({ ...this.dailyMetric(row, objective), campaignId })) };
    } catch (error) { return { success: false as const, error: this.metricsError(error) }; }
  }

  async getCampaignMetrics(campaignId: string, dateStart: string, dateStop: string, objective?: string): Promise<{ success: boolean; metrics?: MetaMetrics; error?: string }> {
    const result = await this.getCampaignMetricsByDateRange(campaignId, dateStart, dateStop, objective);
    if (!result.success) return result;
    const totals = result.metrics.reduce((sum, row) => ({ impressions: sum.impressions + row.impressions,
      clicks: sum.clicks + row.clicks, spend: sum.spend + row.spend, reach: sum.reach + row.reach,
      conversions: sum.conversions + row.conversions, conversionValue: sum.conversionValue + row.conversionValue,
      leads: sum.leads + Number(row.source.leads || 0) }), { impressions: 0, clicks: 0, spend: 0, reach: 0, conversions: 0, conversionValue: 0, leads: 0 });
    return { success: true, metrics: { ...totals, campaignId, dateStart, dateStop, reachAggregation: 'sum_of_daily_reach',
      cpc: totals.clicks ? totals.spend / totals.clicks : 0, cpm: totals.impressions ? totals.spend / totals.impressions * 1000 : 0,
      ctr: totals.impressions ? totals.clicks / totals.impressions * 100 : 0, costPerConversion: totals.conversions ? totals.spend / totals.conversions : 0 } };
  }

  async getAdSetMetricsByDateRange(campaignId: string, dateStart: string, dateStop: string, objective?: string): Promise<{ success: boolean; metrics?: MetaAdSetDailyMetric[]; error?: string }> {
    try {
      const rows = await this.readDailyInsights(campaignId, dateStart, dateStop, 'adset');
      return { success: true, metrics: rows.map(row => ({ ...this.dailyMetric(row, objective), adSetId: String(row.adset_id || '') })).filter(row => Boolean(row.adSetId)) };
    } catch (error) { return { success: false, error: this.metricsError(error) }; }
  }

  async getAdMetricsByDateRange(campaignId: string, dateStart: string, dateStop: string, objective?: string): Promise<{ success: boolean; metrics?: MetaAdDailyMetric[]; error?: string }> {
    try {
      const rows = await this.readDailyInsights(campaignId, dateStart, dateStop, 'ad');
      return { success: true, metrics: rows.map(row => ({ ...this.dailyMetric(row, objective), adSetId: String(row.adset_id || ''), adId: String(row.ad_id || '') })).filter(row => Boolean(row.adId)) };
    } catch (error) { return { success: false, error: this.metricsError(error) }; }
  }

  /** Read-only Meta delivery, audience, and measurement diagnostics. */
  async getCampaignDiagnostics(
    campaignId: string,
    dateStart: string,
    dateStop: string,
  ): Promise<{ success: boolean; diagnostics?: MetaCampaignDiagnostics; error?: string }> {
    if (!this.isAuthenticated()) return { success: false, error: 'Not authenticated with Meta' };
    if (!/^\d+$/.test(campaignId)) return { success: false, error: 'Meta campaign not found' };
    const limitations: string[] = [];
    try {
      const base = getGraphApiBase(await getGraphApiVersion());
      const get = async (url: string) => {
        const response = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${this.credentials!.accessToken}` } });
        const body = await response.json() as Record<string, unknown> & { error?: { message?: string } };
        if (!response.ok || body.error) throw new Error(body.error?.message || 'Meta diagnostics request failed');
        return body;
      };
      const allPages = async (url: string) => {
        const rows: Array<Record<string, unknown>> = [];
        let next: string | null = url;
        let pages = 0;
        while (next && pages < 100) {
          const body = await get(next) as { data?: Array<Record<string, unknown>>; paging?: { next?: string } };
          rows.push(...(body.data || []));
          next = body.paging?.next || null;
          pages += 1;
        }
        if (next) throw new Error('Meta diagnostics exceeded the safe pagination limit');
        return rows;
      };
      const campaignParams = new URLSearchParams({
        fields: 'id,name,status,effective_status,objective,bid_strategy,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,special_ad_categories',
      });
      const campaign = await get(`${base}/${campaignId}?${campaignParams}`);
      const adSetParams = new URLSearchParams({
        fields: 'id,name,status,effective_status,optimization_goal,billing_event,bid_strategy,daily_budget,lifetime_budget,promoted_object,targeting,attribution_spec',
        limit: '200',
      });
      const adSets = await allPages(`${base}/${campaignId}/adsets?${adSetParams}`);
      const insights = async (label: string, breakdowns: string) => {
        const params = new URLSearchParams({
          level: 'campaign',
          fields: 'date_start,date_stop,impressions,reach,clicks,spend,frequency,cpm,cpc,ctr,actions,action_values',
          breakdowns,
          time_range: JSON.stringify({ since: dateStart, until: dateStop }),
          limit: '500',
        });
        try { return await allPages(`${base}/${campaignId}/insights?${params}`); }
        catch (error) {
          limitations.push(`${label} breakdown unavailable: ${error instanceof Error ? error.message : 'Meta rejected this breakdown.'}`);
          return [];
        }
      };
      const [placement, audience, geography] = await Promise.all([
        insights('Placement and device', 'publisher_platform,platform_position,impression_device'),
        insights('Age and gender', 'age,gender'),
        insights('Country', 'country'),
      ]);
      const values = (key: string) => [...new Set(adSets.map(row => {
        const promoted = row.promoted_object as Record<string, unknown> | undefined;
        return String(promoted?.[key] || '').trim();
      }).filter(Boolean))];
      const configuredEvents = [...new Set(adSets.map(row => String((row.promoted_object as Record<string, unknown> | undefined)?.custom_event_type || '').trim()).filter(Boolean))];
      const observedActionTypes = [...new Set([...placement, ...audience, ...geography].flatMap(row => Array.isArray(row.actions) ? row.actions.map(action => String((action as Record<string, unknown>).action_type || '')).filter(Boolean) : []))];
      const pixelIds = values('pixel_id');
      const applicationIds = values('application_id');
      const attributionSpecs = adSets.map(row => row.attribution_spec).filter(value => value != null);
      const configured = pixelIds.length > 0 || applicationIds.length > 0 || configuredEvents.length > 0;
      const observed = observedActionTypes.length > 0;
      const state = configured && observed ? 'configured' : configured || observed ? 'partial' : 'unavailable';
      const explanation = state === 'configured'
        ? 'Meta returned an optimization object and observed action types. CRM lead quality is not available from Ads reporting unless a qualified-lead event is sent back to Meta.'
        : state === 'partial'
          ? 'Only part of the measurement chain is visible. Confirm the Pixel, Conversions API or app event, attribution window, and qualified-lead feedback in Events Manager.'
          : 'No optimization object or observed conversion action was returned. Restore campaign measurement before judging cost per result.';
      return { success: true, diagnostics: {
        campaign, adSets, placement, audience, geography,
        tracking: { state, pixelIds, applicationIds, configuredEvents, attributionSpecs, observedActionTypes, explanation },
        completeness: { paginated: true, adSets: adSets.length, placementRows: placement.length, audienceRows: audience.length, geographyRows: geography.length },
        limitations: [
          ...limitations,
          'Breakdowns contain provider-reported observations for the selected window. Small or restricted audiences can be omitted by Meta.',
          'Audience and placement rows are descriptive. They do not establish that an audience or placement caused the result.',
        ],
      } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Meta diagnostics request failed' };
    }
  }

  /**
   * Refresh access token using long-lived token exchange
   * @param shortLivedToken - The short-lived token to exchange
   * @param userId - User ID to fetch Meta credentials from database
   */
  async refreshAccessToken(shortLivedToken: string, userId?: number): Promise<{ success: boolean; accessToken?: string; expiresIn?: number; error?: string }> {
    try {
      // Try admin-managed credentials first
      const { getActiveAdminCredential } = await import('../../models/adminApiCredentials/functions.js');
      const adminCred = await getActiveAdminCredential('meta_app');

      let appId = adminCred?.apiKey;
      let appSecret = adminCred?.apiSecret;

      // Fallback: per-user credentials from api_credentials
      if ((!appId || !appSecret) && userId) {
        const { getCredential } = await import('../credentialService');
        const cred = await getCredential(userId, 'meta');
        appId = cred?.apiKey;
        appSecret = cred?.apiSecret;
      }

      // Fallback: manual credentials from channel_credentials
      if ((!appId || !appSecret) && userId) {
        try {
          const { channelCredentialsTable } = await import('../../models/channelCredentials/schema.js');
          const { eq, and } = await import('drizzle-orm');
          const { db } = await import('../../models/db.js');
          const manualCreds = await db.select().from(channelCredentialsTable).where(
            and(
              eq(channelCredentialsTable.userId, userId),
              eq(channelCredentialsTable.platform, 'meta'),
              eq(channelCredentialsTable.isActive, true)
            )
          ).limit(1);
          if (manualCreds.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sd = manualCreds[0].sessionData as any;
            if (sd?.appId && sd?.appSecret) {
              appId = sd.appId;
              appSecret = sd.appSecret;
            }
          }
        } catch { /* no manual creds */ }
      }

      if (!appId || !appSecret) {
        throw new Error('Meta App not configured by admin. Please contact your administrator.');
      }

      const params = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken,
      });

      const url = `${getGraphApiBase(await getGraphApiVersion())}/oauth/access_token`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error?.message || 'Failed to refresh token');
      }

      logger.info('[MetaAdsService] Access token refreshed');

      return {
        success: true,
        accessToken: data.access_token,
        expiresIn: data.expires_in,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[MetaAdsService] Error refreshing token:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Get ad account info
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAdAccount(): Promise<{ success: boolean; account?: any; error?: string }> {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated with Meta' };
    }

    try {
      const adAccountId = normalizeAdAccountId(this.credentials!.adAccountId);
      const params = new URLSearchParams({
        fields: 'id,name,account_status,currency,timezone_name,spend_cap,amount_spent',
      });

      const url = `${getGraphApiBase(await getGraphApiVersion())}/act_${adAccountId}?${params.toString()}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.credentials!.accessToken}` },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error?.message || 'Failed to fetch ad account');
      }

      return {
        success: true,
        account: data,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[MetaAdsService] Error fetching ad account:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  async updateResourceStatus(
    resourceId: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isAuthenticated()) return { success: false, error: 'Not authenticated with Meta' };
    try {
      const response = await fetch(`${getGraphApiBase(await getGraphApiVersion())}/${encodeURIComponent(resourceId)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials!.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ status }).toString(),
      });
      const data: any = await response.json();
      if (!response.ok || data.error || data.success === false) {
        throw new Error(data.error?.message || `Meta status update failed for ${resourceId}`);
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Meta status update failed' };
    }
  }

  async updateAdSetLifetimeBudget(
    adSetId: string,
    lifetimeBudgetMinorUnits: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!Number.isSafeInteger(lifetimeBudgetMinorUnits) || lifetimeBudgetMinorUnits < 0) {
      return { success: false, error: 'Meta lifetime budget must be non-negative minor units' };
    }
    if (!this.isAuthenticated()) return { success: false, error: 'Not authenticated with Meta' };
    try {
      const response = await fetch(`${getGraphApiBase(await getGraphApiVersion())}/${encodeURIComponent(adSetId)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials!.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ lifetime_budget: String(lifetimeBudgetMinorUnits) }).toString(),
      });
      const data: any = await response.json();
      if (!response.ok || data.error || data.success === false) {
        throw new Error(data.error?.message || `Meta budget update failed for ${adSetId}`);
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Meta budget update failed' };
    }
  }

  // Backwards-compatible singleton accessor used in many tests
  public static getInstance(credentials?: MetaCredentials): MetaAdsService {
    if (!MetaAdsService._instance) {
      MetaAdsService._instance = new MetaAdsService(credentials);
    }
    if (credentials && MetaAdsService._instance) {
      MetaAdsService._instance.setCredentials(credentials);
    }
    return MetaAdsService._instance;
  }
}

// Export singleton factory
export function createMetaAdsService(credentials?: MetaCredentials): MetaAdsService {
  return new MetaAdsService(credentials);
}
