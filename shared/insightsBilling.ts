import type { InsightChannel, InsightConversationRef } from './insights.js';

export interface InsightsAttribution {
  attemptId?: string;
  operationId?: string;
  conversation?: InsightConversationRef;
  channel?: Exclude<InsightChannel, 'all'>;
  contactId?: number;
  agent?: string;
  process?: string;
  actorUserId?: number;
}
export interface InsightsPricingSnapshot {
  version: 1;
  capturedAt: string;
  source: 'catalog' | 'admin_override' | 'provider_reported' | 'fixed';
  sourceReference?: string;
  model?: string;
  provider?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  audioInputUsdPerMillion?: number;
  providerCostUsd?: string;
  chargedCostUsd?: string;
  marginPercentage?: number;
  usdToInr: number;
  /** Purchase rate: credits a customer receives per ₹1 paid. Used to value credits in INR. */
  creditsPerInr: number;
  /** Credits charged per ₹1 of measured provider cost. Absent on older snapshots (then equal to creditsPerInr). */
  usageCreditsPerInr?: number;
  minimumCredits: number;
  rounding: 'ceil_whole' | 'round_whole' | 'ceil_hundredth' | 'fixed';
}
export interface InsightsBillingContext extends InsightsAttribution {
  version: 1;
  businessProfileId: number;
  organizationId: number;
  pricing: InsightsPricingSnapshot;
  usageSource?: { table: string; id: number };
}
