import { createHash } from 'node:crypto';
import { validateCampaignForActivation, type AdLocation, type AdObjective, type CampaignAllocation } from './AutonomousAdsDomain.js';
import { normalizeGoogleCreative, normalizeMetaCreative, validateProviderCampaign, type ProviderAccountSnapshot, type ProviderCampaignConfig } from './ProviderCampaignContract.js';
import {
  campaignCurrencyScale,
  type ApprovedCampaignPublishReview,
  type CampaignPublishReview,
  type CampaignPublishSnapshot,
  type ReviewedAdPlatform,
} from '../../../shared/adCampaignReview.js';
import { asRecord as record } from '../../../shared/records.js';

export function canonicalReviewJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(item => canonicalReviewJson(item ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReviewJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function publishReviewRevision(snapshot: unknown): string {
  return createHash('sha256').update(canonicalReviewJson(snapshot)).digest('hex');
}

function dateString(value: unknown): string {
  // Raw SQL through Drizzle may return timestamp-without-time-zone as text
  // despite pg's Date parser. These columns store UTC, not host-local time.
  const raw = String(value || '').trim();
  const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z` : raw;
  const date = value instanceof Date ? value : new Date(utc);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function minorAmount(value: unknown, currency: string): number {
  const amount = Number(value) * campaignCurrencyScale(currency);
  if (!Number.isFinite(amount) || Math.abs(amount - Math.round(amount)) > 0.00001 || !Number.isSafeInteger(Math.round(amount))) {
    throw new Error('The saved budget or allocation cannot be represented in the selected currency. Review the amounts before publishing.');
  }
  return Math.round(amount);
}

/** Hash only execution inputs, not telemetry, queue state, tokens or timestamps. */
export function buildCampaignPublishReview(
  campaign: Record<string, unknown>,
  allocations: CampaignAllocation[],
): CampaignPublishReview {
  const settings = record(campaign.settings);
  const context = record(settings.context);
  const accounts = record(settings.accountSnapshot);
  const platforms = (Array.isArray(settings.platforms) ? settings.platforms : [campaign.ad_platform])
    .filter((platform): platform is ReviewedAdPlatform => platform === 'meta' || platform === 'google');
  const currency = String(campaign.currency || '').toUpperCase();
  const providerAccounts: CampaignPublishSnapshot['providerAccounts'] = {};
  for (const platform of platforms) {
    const account = record(accounts[platform]);
    const fields = platform === 'meta'
      ? ['adAccountId', 'pageId', 'instagramAccountId', 'currency', 'timezone']
      : ['customerId', 'managerAccountId', 'currency', 'timezone'];
    providerAccounts[platform] = Object.fromEntries(fields.filter(key => account[key] !== undefined).map(key => [key, account[key]]));
  }
  const rawCreatives = record(campaign.ad_creatives);
  const creatives = Object.fromEntries(platforms.map(platform => [platform,
    (Array.isArray(rawCreatives[platform]) ? rawCreatives[platform] as unknown[] : []).map(creative => ({
      ...record(creative),
      ...(platform === 'meta' ? normalizeMetaCreative(creative, String(campaign.name)) : normalizeGoogleCreative(creative, String(campaign.name))),
    })),
  ]));
  const snapshot: CampaignPublishSnapshot = {
    schemaVersion: 1,
    campaignId: Number(campaign.id),
    userId: Number(campaign.user_id),
    campaignVersion: Number(campaign.version || 1),
    name: String(campaign.name || ''),
    objective: String(campaign.objective || ''),
    platforms: [...new Set(platforms)],
    budget: { amountMinor: minorAmount(campaign.budget_amount, currency), currency, budgetType: String(campaign.budget_type || '') },
    landingPageUrl: String(campaign.landing_page_url || ''),
    startDate: dateString(campaign.start_date),
    endDate: campaign.end_date ? dateString(campaign.end_date) : null,
    locations: Array.isArray(campaign.locations) ? campaign.locations : [],
    targeting: record(campaign.targeting),
    allocations: allocations.map(allocation => ({ key: allocation.key, platform: allocation.platform, amountMinor: minorAmount(allocation.amount, currency) })),
    providerAccounts,
    providerConfig: record(settings.providerConfig),
    creativeRevision: Number(context.creativeRevision || campaign.version || 1),
    creativeSources: Array.isArray(context.creativeSources) ? context.creativeSources : [],
    creatives,
    scheduleDates: record(context.scheduleDates),
  };
  // Recompute, rather than making transient errors from draft creation permanent.
  const validationInput = {
    objective: snapshot.objective, lifetimeBudget: Number(campaign.budget_amount), currency,
    allocations, startDate: new Date(snapshot.startDate), endDate: snapshot.endDate ? new Date(snapshot.endDate) : null,
    landingPageUrl: snapshot.landingPageUrl, locations: snapshot.locations as AdLocation[],
    platforms: snapshot.platforms, accountReadiness: { meta: true, google: true },
    creativesCount: { meta: 1, google: 1 },
  };
  // Platform-specific validation (including Google location IDs) stays with
  // that platform so one disconnected provider does not block the other.
  const validationErrors = validateCampaignForActivation({ ...validationInput, platforms: ['meta'] });
  const platformErrors: CampaignPublishReview['platformErrors'] = {};
  if (!platforms.length) validationErrors.push('Select a supported ad platform.');
  for (const platform of platforms) {
    const errors = validateCampaignForActivation({ ...validationInput, platforms: [platform],
      creativesCount: { [platform]: creatives[platform]?.length || 0 },
    }).filter(error => !validationErrors.includes(error));
    const account = providerAccounts[platform];
    if (platform === 'meta' ? !account?.adAccountId || !account.pageId : !account?.customerId) {
      errors.push(`Select and save the ${platform} account${platform === 'meta' ? ' and Facebook Page' : ''} before approving this campaign.`);
    }
    if (!snapshot.providerConfig[platform]) errors.push(`Save the effective ${platform} provider settings before reviewing this campaign.`);
    if (account?.currency && account.currency !== currency) errors.push(`The ${platform} account currency does not match the reviewed budget.`);
    errors.push(...validateProviderCampaign({
      platforms: [platform], objective: snapshot.objective as AdObjective, campaignName: snapshot.name,
      landingPageUrl: snapshot.landingPageUrl, creatives, providerConfig: snapshot.providerConfig as ProviderCampaignConfig,
      hasEndDate: Boolean(snapshot.endDate),
    }));
    platformErrors[platform] = [...new Set(errors)];
  }
  return { schemaVersion: 1, campaignId: snapshot.campaignId, revision: publishReviewRevision(snapshot), snapshot, validationErrors: [...new Set(validationErrors)], platformErrors };
}

export function assertPublishReviewMatches(
  review: ApprovedCampaignPublishReview | undefined,
  campaign: Record<string, unknown>,
  allocations: CampaignAllocation[],
  platform: string,
  now = new Date(),
): void {
  if (!review || review.schemaVersion !== 1 || !review.snapshot || !['live_activation_and_spend', 'paused_creation'].includes(review.scope)) {
    throw new Error('A saved campaign review is required. Open the campaign review and approve it before publishing.');
  }
  const current = buildCampaignPublishReview(campaign, allocations);
  if (publishReviewRevision(review.snapshot) !== review.revision || current.revision !== review.revision
    || !review.snapshot.platforms.includes(platform as ReviewedAdPlatform)) {
    throw new Error('The campaign changed after review. Review the current budget, account, destination, schedule, targeting and creative before publishing.');
  }
  const approvedAt = new Date(review.approvedAt).getTime();
  const age = now.getTime() - approvedAt;
  if (!Number.isFinite(approvedAt) || age < -60_000 || age > 10 * 60 * 1000) {
    throw new Error('The campaign approval expired. Review and confirm again before activation.');
  }
  const errors = [...current.validationErrors, ...(current.platformErrors[platform as ReviewedAdPlatform] || [])];
  if (errors.length) throw new Error(`Campaign review is blocked: ${errors.join(' ')}`);
}

export function assertReviewedProviderAccount(
  snapshot: CampaignPublishSnapshot,
  current: ProviderAccountSnapshot,
  platform: ReviewedAdPlatform,
): void {
  const approved = snapshot.providerAccounts[platform];
  const account = record(current[platform]);
  const keys = platform === 'meta' ? ['adAccountId', 'pageId', 'instagramAccountId'] : ['customerId', 'managerAccountId'];
  if (!approved || keys.some(key => String(approved[key] || '') !== String(account[key] || ''))
    || (approved.currency && account.currency && approved.currency !== account.currency)
    || (approved.timezone && account.timezone && approved.timezone !== account.timezone)) {
    throw new Error(`The ${platform} provider account changed after review. Review the account again before publishing.`);
  }
}
export class CampaignPublishPreflightError extends Error {
  constructor(message: string, public readonly status: 'blocked' | 'gated' = 'blocked') {
    super(message);
    this.name = 'CampaignPublishPreflightError';
  }
}
