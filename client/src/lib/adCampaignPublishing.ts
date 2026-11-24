export type AdPlatform = 'meta' | 'google';
export type CampaignPublishState =
  | 'draft'
  | 'validation_failed'
  | 'gated'
  | 'queued'
  | 'running'
  | 'provider_failed'
  | 'uncertain'
  | 'blocked'
  | 'partial_success'
  | 'published'
  | 'active';

export interface PublishContextSelection {
  businessProfileId?: number;
  brandToolkitId?: number;
  icpId?: number;
  threadId?: number;
  creativeSources?: Array<{
    sourceType: 'content_asset' | 'content_template';
    sourceId: number;
    sourceVersion: number;
    updatedAt?: string;
  }>;
  scheduleDates?: { startDate: string; endDate?: string };
}

export interface CampaignPublishFormValues {
  campaignName: string;
  publishPlatforms: AdPlatform[];
  lifetimeBudget: string;
  currency: string;
  startDate: string;
  endDate: string;
  countries: string[];
  objective: string;
  objectiveRationale: string;
  bidStrategy: string;
  bidAmount?: string;
  optimizationGoal: string;
  billingEvent: string;
  ageMin: number;
  ageMax: number;
  genders: string[];
  placements?: string[];
  specialAdCategories?: string[];
  metaPixelId?: string;
  metaCustomConversionId?: string;
  metaApplicationId?: string;
  metaObjectStoreUrl?: string;
  callToAction: string;
  linkUrl: string;
  googleBudgetMode?: 'CAMPAIGN_TOTAL' | 'AVERAGE_DAILY';
  googleBiddingStrategy?: string;
  googleTargetCpa?: string;
  googleTargetRoas?: string;
  googleKeywordMatchType?: 'BROAD' | 'PHRASE' | 'EXACT';
  googleKeywords?: string[];
  googleNegativeKeywords?: string[];
  googleLanguageIds?: string[];
  googleTrackingTemplate?: string;
  googleFinalUrlSuffix?: string;
  googlePath1?: string;
  googlePath2?: string;
  allowAiPause?: boolean;
  activationConfirmed?: boolean;
}

export interface CampaignPublishResponse {
  id: number;
  local_status?: CampaignPublishState;
  publishState?: CampaignPublishState;
  validationErrors?: string[];
  providerMutationsEnabled?: boolean;
  last_provider_error?: string;
  accountSnapshot?: {
    meta?: {
      adAccountId: string;
      adAccountName?: string;
      pageId: string;
      pageName?: string;
      instagramUsername?: string;
      currency?: string;
      timezone?: string;
    };
    google?: {
      customerId: string;
      accountName?: string;
      currency?: string;
      timezone?: string;
    };
  };
}

export function normalizeMetaBidStrategy(value: string): string {
  return value === 'BID_CAP' ? 'LOWEST_COST_WITH_BID_CAP' : value;
}

export function buildAutonomousCampaignPayload(input: {
  form: CampaignPublishFormValues;
  creatives: Record<AdPlatform, Array<Record<string, unknown>> | undefined>;
  contentStudioContext: string;
  conversationContext?: string;
  context?: PublishContextSelection;
  locations: Array<{
    countryCode: string;
    region?: string;
    city?: string;
    googleGeoTargetId?: string;
    metaLocationKey?: string;
  }>;
  idempotencyKey: string;
  publish: boolean;
}) {
  const { form } = input;
  const bidAmount = Number(form.bidAmount);
  const targetCpa = Number(form.googleTargetCpa);
  const targetRoas = Number(form.googleTargetRoas);
  const promotedObject = {
    pixelId: form.metaPixelId?.trim() || undefined,
    customConversionId: form.metaCustomConversionId?.trim() || undefined,
    applicationId: form.metaApplicationId?.trim() || undefined,
    objectStoreUrl: form.metaObjectStoreUrl?.trim() || undefined,
  };
  const hasPromotedObject = Object.values(promotedObject).some(Boolean);
  const autoActivate = input.publish && form.activationConfirmed === true;
  return {
    name: form.campaignName.trim(),
    brief: form.campaignName.trim(),
    contentStudioContext: input.contentStudioContext,
    conversationContext: input.conversationContext || undefined,
    platforms: form.publishPlatforms,
    objective: form.objective || undefined,
    objectiveRationale: form.objectiveRationale,
    lifetimeBudget: Number(form.lifetimeBudget),
    currency: form.currency,
    locations: input.locations,
    landingPageUrl: form.linkUrl.trim(),
    startDate: new Date(form.startDate).toISOString(),
    endDate: new Date(form.endDate).toISOString(),
    creatives: input.creatives,
    providerConfig: {
      meta: form.publishPlatforms.includes('meta') ? {
        bidStrategy: normalizeMetaBidStrategy(form.bidStrategy),
        bidAmount: Number.isFinite(bidAmount) && bidAmount > 0 ? bidAmount : undefined,
        optimizationGoal: form.optimizationGoal,
        billingEvent: form.billingEvent,
        specialAdCategories: form.specialAdCategories || [],
        specialAdCategoryCountries: form.specialAdCategories?.includes('ISSUES_ELECTIONS_POLITICS')
          ? form.countries
          : undefined,
        ageMin: form.ageMin,
        ageMax: form.ageMax,
        genders: form.genders.map(Number),
        placements: form.placements || [],
        promotedObject: hasPromotedObject ? promotedObject : undefined,
      } : undefined,
      google: form.publishPlatforms.includes('google') ? {
        budgetMode: form.googleBudgetMode || 'CAMPAIGN_TOTAL',
        biddingStrategy: form.googleBiddingStrategy || 'MAXIMIZE_CONVERSIONS',
        targetCpa: Number.isFinite(targetCpa) && targetCpa > 0 ? targetCpa : undefined,
        targetRoas: Number.isFinite(targetRoas) && targetRoas > 0 ? targetRoas : undefined,
        keywordMatchType: form.googleKeywordMatchType || 'BROAD',
        negativeKeywords: form.googleNegativeKeywords || [],
        languageIds: form.googleLanguageIds?.length ? form.googleLanguageIds : ['languageConstants/1000'],
        includeSearchNetwork: true,
        includePartnerSearchNetwork: false,
        trackingTemplate: form.googleTrackingTemplate || undefined,
        finalUrlSuffix: form.googleFinalUrlSuffix || undefined,
        path1: form.googlePath1 || undefined,
        path2: form.googlePath2 || undefined,
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      } : undefined,
    },
    context: input.context,
    idempotencyKey: input.idempotencyKey,
    autoActivate,
    activationConfirmation: autoActivate ? {
      confirmedAt: new Date().toISOString(),
      source: 'direct_review' as const,
      scope: 'live_activation_and_spend' as const,
      campaignName: form.campaignName.trim(),
      platforms: form.publishPlatforms,
      lifetimeBudget: Number(form.lifetimeBudget),
      currency: form.currency,
    } : undefined,
    allowAiPause: form.allowAiPause === true,
    publish: input.publish,
  };
}

export function campaignPublishState(campaign: CampaignPublishResponse): CampaignPublishState {
  if (campaign.validationErrors?.length) return 'validation_failed';
  if (campaign.publishState) return campaign.publishState;
  if (campaign.local_status) return campaign.local_status;
  return campaign.providerMutationsEnabled ? 'queued' : 'gated';
}

export const CAMPAIGN_STATE_COPY: Record<CampaignPublishState, { title: string; description: string }> = {
  draft: { title: 'Campaign draft saved', description: 'No provider action was requested.' },
  validation_failed: { title: 'Campaign needs attention', description: 'No provider action was queued.' },
  gated: { title: 'Campaign approved and gated', description: 'Provider creation is disabled by the live mutation gate.' },
  queued: { title: 'Campaign queued', description: 'Provider creation has not started yet.' },
  running: { title: 'Campaign publishing', description: 'Provider resources are being created.' },
  provider_failed: { title: 'Provider publication failed', description: 'Review the provider error before retrying.' },
  uncertain: { title: 'Provider outcome is being reconciled', description: 'Do not submit again. The existing request will be checked and retried safely.' },
  blocked: { title: 'Campaign publication blocked', description: 'Resolve the account, policy, or validation requirement before trying again.' },
  partial_success: { title: 'Campaign partially published', description: 'At least one provider succeeded. Review the failed provider before taking another action.' },
  published: { title: 'Campaign created paused', description: 'Provider resources were created but are not active.' },
  active: { title: 'Campaign active', description: 'Provider resources were created and activated.' },
};

export function safeDashboardReturnPath(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith('/dashboard/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const parsed = new URL(value, 'https://asksales.local');
    return parsed.origin === 'https://asksales.local' && parsed.pathname.startsWith('/dashboard/')
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}
