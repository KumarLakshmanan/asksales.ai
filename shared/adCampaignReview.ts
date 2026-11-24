/** Public, credential-free contract shown before a paid campaign is approved. */
export type ReviewedAdPlatform = 'meta' | 'google';

export interface CampaignPublishSnapshot {
  schemaVersion: 1;
  campaignId: number;
  userId: number;
  campaignVersion: number;
  name: string;
  objective: string;
  platforms: ReviewedAdPlatform[];
  budget: { amountMinor: number; currency: string; budgetType: string };
  landingPageUrl: string;
  startDate: string;
  endDate: string | null;
  locations: unknown[];
  targeting: Record<string, unknown>;
  allocations: Array<{ key: string; platform: ReviewedAdPlatform; amountMinor: number }>;
  providerAccounts: Partial<Record<ReviewedAdPlatform, Record<string, unknown>>>;
  providerConfig: Record<string, unknown>;
  creativeRevision: number;
  creativeSources: unknown[];
  creatives: Record<string, unknown>;
  scheduleDates: Record<string, unknown>;
}

export interface CampaignPublishReview {
  schemaVersion: 1;
  campaignId: number;
  revision: string;
  snapshot: CampaignPublishSnapshot;
  validationErrors: string[];
  platformErrors: Partial<Record<ReviewedAdPlatform, string[]>>;
}

export interface ApprovedCampaignPublishReview {
  schemaVersion: 1;
  revision: string;
  snapshot: CampaignPublishSnapshot;
  approvedAt: string;
  scope: 'live_activation_and_spend' | 'paused_creation';
}

// These are the currencies accepted by the campaign API. JPY has no cents.
export function campaignCurrencyScale(currency: string): number {
  return currency.toUpperCase() === 'JPY' ? 1 : 100;
}
