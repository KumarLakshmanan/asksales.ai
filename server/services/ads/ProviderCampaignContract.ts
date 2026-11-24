import type { AdObjective, AdPlatform } from './AutonomousAdsDomain.js';
import { asRecord as record } from '../../../shared/records.js';

export const META_BID_STRATEGIES = [
  'LOWEST_COST_WITHOUT_CAP',
  'LOWEST_COST_WITH_BID_CAP',
  'COST_CAP',
  'LOWEST_COST_WITH_MIN_ROAS',
] as const;
export type MetaBidStrategy = (typeof META_BID_STRATEGIES)[number];

export const META_OPTIMIZATION_GOALS = [
  'REACH',
  'IMPRESSIONS',
  'LINK_CLICKS',
  'LANDING_PAGE_VIEWS',
  'POST_ENGAGEMENT',
  'LEAD_GENERATION',
  'OFFSITE_CONVERSIONS',
  'APP_INSTALLS',
] as const;
export type MetaOptimizationGoal = (typeof META_OPTIMIZATION_GOALS)[number];

export const META_BILLING_EVENTS = ['IMPRESSIONS', 'LINK_CLICKS', 'POST_ENGAGEMENT'] as const;
export type MetaBillingEvent = (typeof META_BILLING_EVENTS)[number];

export const META_PLACEMENTS = [
  'facebook_feed',
  'facebook_marketplace',
  'facebook_video_feeds',
  'instagram_stream',
  'instagram_story',
  'instagram_reels',
  'audience_network',
  'messenger_inbox',
] as const;
export type MetaPlacement = (typeof META_PLACEMENTS)[number];

export interface MetaPromotedObject {
  pixelId?: string;
  customConversionId?: string;
  applicationId?: string;
  objectStoreUrl?: string;
  pageId?: string;
}

export interface MetaProviderConfig {
  bidStrategy: MetaBidStrategy;
  bidAmount?: number;
  optimizationGoal: MetaOptimizationGoal;
  billingEvent: MetaBillingEvent;
  specialAdCategories: Array<'HOUSING' | 'EMPLOYMENT' | 'CREDIT' | 'ISSUES_ELECTIONS_POLITICS'>;
  specialAdCategoryCountries?: string[];
  ageMin: number;
  ageMax: number;
  genders: Array<1 | 2>;
  placements: MetaPlacement[];
  interests?: Array<{ id: string; name?: string }>;
  customAudienceIds?: string[];
  excludedCustomAudienceIds?: string[];
  promotedObject?: MetaPromotedObject;
}

export type GoogleBudgetMode = 'CAMPAIGN_TOTAL' | 'AVERAGE_DAILY';
export type GoogleBiddingStrategy =
  | 'MAXIMIZE_CONVERSIONS'
  | 'MAXIMIZE_CONVERSION_VALUE'
  | 'MAXIMIZE_CLICKS'
  | 'TARGET_CPA'
  | 'TARGET_ROAS'
  | 'MANUAL_CPC';
export type GoogleKeywordMatchType = 'BROAD' | 'PHRASE' | 'EXACT';

export interface GoogleProviderConfig {
  budgetMode: GoogleBudgetMode;
  biddingStrategy: GoogleBiddingStrategy;
  targetCpa?: number;
  targetRoas?: number;
  keywordMatchType: GoogleKeywordMatchType;
  negativeKeywords: string[];
  languageIds: string[];
  includeSearchNetwork: boolean;
  includePartnerSearchNetwork: boolean;
  trackingTemplate?: string;
  finalUrlSuffix?: string;
  path1?: string;
  path2?: string;
  containsEuPoliticalAdvertising:
    | 'CONTAINS_EU_POLITICAL_ADVERTISING'
    | 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING';
}

export interface ProviderCampaignConfig {
  meta?: MetaProviderConfig;
  google?: GoogleProviderConfig;
}

export interface ProviderAccountSnapshot {
  capturedAt: string;
  meta?: {
    adAccountId: string;
    adAccountName?: string;
    pageId: string;
    pageName?: string;
    instagramAccountId?: string;
    instagramUsername?: string;
    currency?: string;
    timezone?: string;
  };
  google?: {
    customerId: string;
    accountName?: string;
    managerAccountId?: string;
    currency?: string;
    timezone?: string;
  };
}

export interface MetaCreativeInput {
  name?: string;
  headline: string;
  primaryText: string;
  description?: string;
  callToAction?: string;
  imageUrl?: string;
  imageHash?: string;
  videoUrl?: string;
  videoId?: string;
}

export interface GoogleCreativeInput {
  name?: string;
  headlines: string[];
  descriptions: string[];
  keywords: string[];
  finalUrl?: string;
  path1?: string;
  path2?: string;
}

const META_DEFAULT_OPTIMIZATION: Record<AdObjective, MetaOptimizationGoal> = {
  awareness: 'REACH',
  traffic: 'LANDING_PAGE_VIEWS',
  engagement: 'POST_ENGAGEMENT',
  leads: 'LEAD_GENERATION',
  sales: 'OFFSITE_CONVERSIONS',
  app_promotion: 'APP_INSTALLS',
};

export function defaultMetaProviderConfig(objective: AdObjective): MetaProviderConfig {
  return {
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    optimizationGoal: META_DEFAULT_OPTIMIZATION[objective],
    billingEvent: 'IMPRESSIONS',
    specialAdCategories: [],
    ageMin: 18,
    ageMax: 65,
    genders: [1, 2],
    placements: [],
  };
}

export function defaultGoogleProviderConfig(): GoogleProviderConfig {
  return {
    budgetMode: 'CAMPAIGN_TOTAL',
    biddingStrategy: 'MAXIMIZE_CONVERSIONS',
    keywordMatchType: 'BROAD',
    negativeKeywords: [],
    languageIds: ['languageConstants/1000'],
    includeSearchNetwork: true,
    includePartnerSearchNetwork: false,
    containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

export function normalizeMetaCreative(value: unknown, campaignName: string): MetaCreativeInput {
  const raw = record(value);
  return {
    name: String(raw.name || raw.title || campaignName),
    headline: String(raw.headline || raw.title || campaignName).trim(),
    primaryText: String(raw.primaryText || raw.body || raw.content || raw.description || '').trim(),
    description: String(raw.description || '').trim() || undefined,
    callToAction: String(raw.callToAction || raw.cta || 'LEARN_MORE').trim(),
    imageUrl: String(raw.imageUrl || '').trim() || undefined,
    imageHash: String(raw.imageHash || '').trim() || undefined,
    videoUrl: String(raw.videoUrl || '').trim() || undefined,
    videoId: String(raw.videoId || '').trim() || undefined,
  };
}

export function normalizeGoogleCreative(value: unknown, campaignName: string): GoogleCreativeInput {
  const raw = record(value);
  const headline = String(raw.headline || raw.title || '').trim();
  const body = String(raw.description || raw.body || raw.primaryText || raw.content || '').trim();
  const explicitHeadlines = strings(raw.headlines);
  const explicitDescriptions = strings(raw.descriptions);
  // Missing RSA variants are a review prerequisite, not permission to invent
  // customer-facing copy or additional CTAs from generic marketing defaults.
  const fallbackHeadlines = headline ? [headline] : [];
  const fallbackDescriptions = body ? [body] : [];
  return {
    name: String(raw.name || raw.title || campaignName),
    headlines: explicitHeadlines.length ? explicitHeadlines : fallbackHeadlines,
    descriptions: explicitDescriptions.length ? explicitDescriptions : fallbackDescriptions,
    keywords: strings(raw.keywords),
    finalUrl: String(raw.finalUrl || raw.displayUrl || '').trim() || undefined,
    path1: String(raw.path1 || '').trim() || undefined,
    path2: String(raw.path2 || '').trim() || undefined,
  };
}

export function validateProviderCampaign(input: {
  platforms: AdPlatform[];
  objective: AdObjective;
  campaignName: string;
  landingPageUrl: string;
  creatives: Partial<Record<AdPlatform, unknown[]>>;
  providerConfig: ProviderCampaignConfig;
  hasEndDate: boolean;
}): string[] {
  const errors: string[] = [];
  if (input.platforms.includes('meta')) {
    const config = input.providerConfig.meta || defaultMetaProviderConfig(input.objective);
    if (config.ageMin < 18 || config.ageMax > 65 || config.ageMin > config.ageMax) {
      errors.push('Meta age targeting must be between 18 and 65, with minimum age not greater than maximum age.');
    }
    if (!config.genders.length || config.genders.some((gender) => ![1, 2].includes(gender))) {
      errors.push('Meta gender targeting must contain male, female, or both.');
    }
    if (config.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP' && !config.bidAmount) {
      errors.push(`Meta ${config.bidStrategy} requires a positive bid or cost cap.`);
    }
    if (
      input.objective === 'sales'
      && !config.promotedObject?.pixelId
    ) {
      errors.push('Meta sales campaigns require an explicit Pixel ID for conversion optimization.');
    }
    if (
      input.objective === 'app_promotion'
      && (!config.promotedObject?.applicationId || !config.promotedObject.objectStoreUrl)
    ) {
      errors.push('Meta app promotion campaigns require both an application ID and an App Store or Play Store URL.');
    }
    if (
      config.specialAdCategories.includes('ISSUES_ELECTIONS_POLITICS')
      && !config.specialAdCategoryCountries?.length
    ) {
      errors.push('Meta political campaigns require at least one special-ad-category country.');
    }
    for (const [index, creative] of (input.creatives.meta || []).entries()) {
      const normalized = normalizeMetaCreative(creative, input.campaignName);
      if (!normalized.headline) errors.push(`Meta creative ${index + 1} requires a headline.`);
      if (!normalized.primaryText) errors.push(`Meta creative ${index + 1} requires primary text.`);
      if (!normalized.imageUrl && !normalized.imageHash && !normalized.videoUrl && !normalized.videoId) {
        errors.push(`Meta creative ${index + 1} requires an image or video.`);
      }
    }
  }
  if (input.platforms.includes('google')) {
    const config = input.providerConfig.google || defaultGoogleProviderConfig();
    if (config.budgetMode === 'CAMPAIGN_TOTAL' && !input.hasEndDate) {
      errors.push('Google campaign total budgets require both start and end dates.');
    }
    if (config.biddingStrategy === 'TARGET_CPA' && !config.targetCpa) {
      errors.push('Google Target CPA bidding requires a positive target CPA.');
    }
    if (config.biddingStrategy === 'TARGET_ROAS' && !config.targetRoas) {
      errors.push('Google Target ROAS bidding requires a positive target ROAS.');
    }
    if (config.trackingTemplate && !config.trackingTemplate.includes('{lpurl}')) {
      errors.push('Google tracking templates must include the {lpurl} landing-page placeholder.');
    }
    if (config.finalUrlSuffix && /^[?#]/.test(config.finalUrlSuffix)) {
      errors.push('Google final URL suffix must not begin with ? or #.');
    }
    if (config.negativeKeywords.some((keyword) => keyword.length > 80)) {
      errors.push('Google negative keywords must be 80 characters or fewer.');
    }
    for (const [index, creative] of (input.creatives.google || []).entries()) {
      const normalized = normalizeGoogleCreative(creative, input.campaignName);
      if (normalized.headlines.length < 3 || normalized.headlines.length > 15) {
        errors.push(`Google ad group ${index + 1} requires 3 to 15 headlines.`);
      }
      if (normalized.headlines.some((headline) => headline.length > 30)) {
        errors.push(`Google ad group ${index + 1} headlines must be 30 characters or fewer.`);
      }
      if (new Set(normalized.headlines.map((headline) => headline.toLocaleLowerCase())).size !== normalized.headlines.length) {
        errors.push(`Google ad group ${index + 1} headlines must be unique.`);
      }
      if (normalized.descriptions.length < 2 || normalized.descriptions.length > 4) {
        errors.push(`Google ad group ${index + 1} requires 2 to 4 descriptions.`);
      }
      if (normalized.descriptions.some((description) => description.length > 90)) {
        errors.push(`Google ad group ${index + 1} descriptions must be 90 characters or fewer.`);
      }
      if (new Set(normalized.descriptions.map((description) => description.toLocaleLowerCase())).size !== normalized.descriptions.length) {
        errors.push(`Google ad group ${index + 1} descriptions must be unique.`);
      }
      if (!normalized.keywords.length) {
        errors.push(`Google ad group ${index + 1} requires at least one reviewed keyword.`);
      }
      try {
        new URL(normalized.finalUrl || input.landingPageUrl);
      } catch {
        errors.push(`Google ad group ${index + 1} requires a valid final URL.`);
      }
    }
  }
  return [...new Set(errors)];
}
