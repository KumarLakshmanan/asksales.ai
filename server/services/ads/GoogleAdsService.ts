/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Google Ads Service
 *
 * Real implementation against the Google Ads REST API (v25) — no SDK required.
 *
 * Auth model: per-user OAuth2 refresh token + admin-shared developer token.
 * - clientId / clientSecret: app credentials (per-user, since dev tokens are tied to a Google Cloud project)
 * - refreshToken: long-lived user grant exchanged on every API call into a 1-hour access token
 * - customerId: 10-digit account that the campaign lives in (no dashes)
 * - managerAccountId: optional MCC, sent as `login-customer-id`
 * - developerToken: required header on every call; obtained via Google Ads UI
 *
 * Reference: https://developers.google.com/google-ads/api/rest/overview
 */

import { logger } from '../../utils/logger.js';

export const GOOGLE_ADS_API_VERSION = 'v25';
const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleAdsCredentials {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  customerId: string;       // 10 digits, no dashes
  refreshToken: string;
  managerAccountId?: string; // optional MCC
}

export interface GoogleAdsCampaignInput {
  name: string;
  /** Daily budget in account currency, e.g. 25.00 for $25/day. */
  dailyBudgetAmount?: number;
  /** True campaign total for a dated Search campaign. */
  totalBudgetAmount?: number;
  budgetMode?: 'CAMPAIGN_TOTAL' | 'AVERAGE_DAILY';
  /** Final URL for landing page. */
  finalUrl: string;
  /** 3 to 15 headlines, each <=30 chars. */
  headlines: string[];
  /** 2 to 4 descriptions, each <=90 chars. */
  descriptions: string[];
  /** Search keywords (no match-type prefix; defaults to BROAD). */
  keywords: string[];
  /** Optional geoTargetConstant resource names, e.g. "geoTargetConstants/2840" for US. */
  geoTargetIds?: string[];
  /** Optional language constants, e.g. "languageConstants/1000" for English. */
  languageIds?: string[];
  biddingStrategy?: 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'MAXIMIZE_CLICKS' | 'TARGET_CPA' | 'TARGET_ROAS' | 'MANUAL_CPC';
  targetCpa?: number;
  targetRoas?: number;
  keywordMatchType?: 'BROAD' | 'PHRASE' | 'EXACT';
  negativeKeywords?: string[];
  includeSearchNetwork?: boolean;
  includePartnerSearchNetwork?: boolean;
  trackingTemplate?: string;
  finalUrlSuffix?: string;
  path1?: string;
  path2?: string;
  containsEuPoliticalAdvertising?: 'CONTAINS_EU_POLITICAL_ADVERTISING' | 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING';
  /** Stable suffix used for predictable provider names across retries. */
  resourceKey?: string;
  startDate?: Date | string;
  endDate?: Date | string;
  timeZone?: string;
  adGroups?: GoogleAdsAdGroupInput[];
  onResourceCreated?: (resource: {
    resourceType: 'budget' | 'campaign' | 'ad_group' | 'ad' | 'keyword';
    localKey: string;
    resourceName: string;
  }) => Promise<void>;
}

export interface GoogleAdsAdGroupInput {
  key: string;
  name?: string;
  headlines: string[];
  descriptions: string[];
  keywords: string[];
  negativeKeywords?: string[];
  keywordMatchType?: 'BROAD' | 'PHRASE' | 'EXACT';
  finalUrl?: string;
  path1?: string;
  path2?: string;
}

export interface GoogleAdsPublishResult {
  success: boolean;
  campaignResourceName?: string;
  adGroupResourceName?: string;
  adResourceName?: string;
  budgetResourceName?: string;
  keywordResourceNames?: string[];
  adGroupResourceNames?: string[];
  adResourceNames?: string[];
  cleanupErrors?: string[];
  error?: string;
}

export interface GoogleAdsResourceGraph {
  campaignResourceName: string;
  campaignStatus?: string;
  budgetResourceName?: string;
  adGroups: Array<{
    adGroupResourceName: string;
    adGroupName?: string;
    adResourceName?: string;
    keywordResourceNames: string[];
  }>;
}

// ── Token cache ────────────────────────────────────────────────────────────
// Access tokens last ~1 hour; cache per refresh-token to avoid re-exchanging
// on every request burst.
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(creds: GoogleAdsCredentials): Promise<string> {
  const cacheKey = `${creds.clientId}:${creds.refreshToken}`;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google OAuth refresh failed: ${data.error_description || data.error || res.statusText}`);
  }

  const expiresInMs = (data.expires_in || 3600) * 1000;
  accessTokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + expiresInMs,
  });
  return data.access_token;
}

function buildHeaders(creds: GoogleAdsCredentials, accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': creds.developerToken,
    'Content-Type': 'application/json',
  };
  if (creds.managerAccountId) {
    headers['login-customer-id'] = creds.managerAccountId.replace(/-/g, '');
  }
  return headers;
}

/** Complete a GAQL read before exposing any rows to caches or policy evaluation.
 * https://developers.google.com/google-ads/api/rest/common/search
 */
export async function searchGoogleAds<T = Record<string, unknown>>(
  creds: GoogleAdsCredentials,
  query: string,
  options: { maxPages?: number; timeoutMs?: number } = {},
): Promise<T[]> {
  if (!/^\d{10}$/.test(creds.customerId)) throw new Error('Select a valid Google Ads customer account.');
  const accessToken = await getAccessToken(creds);
  const maxPages = Math.max(1, Math.min(1000, options.maxPages ?? 100));
  const rows: T[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const response = await fetch(`${GOOGLE_ADS_API_BASE}/customers/${creds.customerId}/googleAds:search`, {
      method: 'POST',
      headers: buildHeaders(creds, accessToken),
      body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const data = await response.json() as { results?: T[]; nextPageToken?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(data.error?.message || `Google Ads reporting failed (${response.status}).`);
    if (data.results !== undefined && !Array.isArray(data.results)) throw new Error('Google Ads returned an invalid report. Previous evidence was retained.');
    rows.push(...(data.results || []));
    if (!data.nextPageToken) return rows;
    if (seen.has(data.nextPageToken)) throw new Error('Google Ads repeated a report page. Previous evidence was retained.');
    seen.add(data.nextPageToken);
    pageToken = data.nextPageToken;
  }
  throw new Error('Google Ads report exceeded the page limit. Previous evidence was retained.');
}

function assertGoogleReportingDates(start: string, stop: string) {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(stop) || start > stop) throw new Error('Choose a valid reporting date range.');
}

function gaqlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

export function buildGoogleProviderCampaignName(name: string, resourceKey?: string): string {
  if (!resourceKey) return name.slice(0, 255);
  const suffix = resourceKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-48);
  const availableNameLength = Math.max(1, 255 - suffix.length - 3);
  return `${name.slice(0, availableNameLength)} [${suffix}]`;
}

export async function findGoogleCampaignResourceGraph(
  creds: GoogleAdsCredentials,
  providerCampaignName: string,
): Promise<GoogleAdsResourceGraph | null> {
  const search = (query: string) => searchGoogleAds<any>(creds, query);
  const campaignRows = await search(`
    SELECT campaign.resource_name, campaign.status, campaign_budget.resource_name
    FROM campaign
    WHERE campaign.name = '${gaqlString(providerCampaignName)}'
      AND campaign.status != 'REMOVED'
    ORDER BY campaign.id DESC
    LIMIT 1
  `.trim());
  if (!campaignRows.length) return null;
  const campaignResourceName = campaignRows[0].campaign?.resourceName;
  if (!campaignResourceName) return null;
  const escapedCampaignResourceName = gaqlString(campaignResourceName);
  const adRows = await search(`
    SELECT ad_group.resource_name, ad_group.name, ad_group_ad.resource_name
    FROM ad_group_ad
    WHERE campaign.resource_name = '${escapedCampaignResourceName}'
      AND ad_group.status != 'REMOVED'
      AND ad_group_ad.status != 'REMOVED'
    ORDER BY ad_group.id
  `.trim());
  const keywordRows = await search(`
    SELECT ad_group.resource_name, ad_group_criterion.resource_name
    FROM ad_group_criterion
    WHERE campaign.resource_name = '${escapedCampaignResourceName}'
      AND ad_group_criterion.type = 'KEYWORD'
      AND ad_group_criterion.negative = FALSE
      AND ad_group_criterion.status != 'REMOVED'
    ORDER BY ad_group.id, ad_group_criterion.criterion_id
  `.trim());
  const keywordsByAdGroup = new Map<string, string[]>();
  for (const row of keywordRows) {
    const adGroupResourceName = row.adGroup?.resourceName;
    const keywordResourceName = row.adGroupCriterion?.resourceName;
    if (!adGroupResourceName || !keywordResourceName) continue;
    keywordsByAdGroup.set(adGroupResourceName, [
      ...(keywordsByAdGroup.get(adGroupResourceName) || []),
      keywordResourceName,
    ]);
  }
  return {
    campaignResourceName,
    campaignStatus: campaignRows[0].campaign?.status,
    budgetResourceName: campaignRows[0].campaignBudget?.resourceName,
    adGroups: adRows.map((row: any) => ({
      adGroupResourceName: row.adGroup?.resourceName,
      adGroupName: row.adGroup?.name,
      adResourceName: row.adGroupAd?.resourceName,
      keywordResourceNames: keywordsByAdGroup.get(row.adGroup?.resourceName) || [],
    })).filter((row: { adGroupResourceName?: string }) => row.adGroupResourceName),
  };
}

async function callMutate<T = any>(
  creds: GoogleAdsCredentials,
  resourcePath: string,
  operations: any[]
): Promise<T> {
  const accessToken = await getAccessToken(creds);
  const url = `${GOOGLE_ADS_API_BASE}/customers/${creds.customerId}/${resourcePath}:mutate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(creds, accessToken),
    body: JSON.stringify({ operations }),
  });
  const data: any = await res.json();
  if (!res.ok) {
    const errMsg = data?.error?.details?.[0]?.errors?.[0]?.message
      || data?.error?.message
      || res.statusText;
    throw new Error(`Google Ads ${resourcePath}:mutate failed: ${errMsg}`);
  }
  return data as T;
}

/**
 * Verify Google Ads credentials by listing accessible customers.
 * Cheap call — uses the refresh token to confirm the account is reachable.
 */
export async function verifyGoogleAdsCredentials(
  creds: GoogleAdsCredentials
): Promise<{ valid: boolean; error?: string; resourceNames?: string[] }> {
  try {
    const accessToken = await getAccessToken(creds);
    const res = await fetch(`${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`, {
      method: 'GET',
      headers: buildHeaders(creds, accessToken),
      signal: AbortSignal.timeout(30_000),
    });
    const data: any = await res.json();
    if (!res.ok) {
      return { valid: false, error: data?.error?.message || res.statusText };
    }
    return { valid: true, resourceNames: data.resourceNames || [] };
  } catch (err: any) {
    return { valid: false, error: err.message || 'Unknown verification error' };
  }
}

export async function getGoogleAdsAccountInfo(
  creds: GoogleAdsCredentials,
): Promise<{
  valid: boolean;
  account?: { customerId: string; name?: string; currency?: string; timeZone?: string; manager?: boolean; testAccount?: boolean };
  error?: string;
}> {
  try {
    const accessToken = await getAccessToken(creds);
    const query = `
      SELECT customer.id, customer.descriptive_name, customer.currency_code,
             customer.time_zone, customer.manager, customer.test_account
      FROM customer
      LIMIT 1
    `.trim();
    const response = await fetch(`${GOOGLE_ADS_API_BASE}/customers/${creds.customerId}/googleAds:search`, {
      method: 'POST',
      headers: buildHeaders(creds, accessToken),
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
    const data: any = await response.json();
    if (!response.ok || !data.results?.[0]?.customer) {
      return { valid: false, error: data?.error?.message || response.statusText || 'Google Ads customer is unavailable' };
    }
    const customer = data.results[0].customer;
    return {
      valid: true,
      account: {
        customerId: String(customer.id || creds.customerId),
        name: customer.descriptiveName,
        currency: customer.currencyCode,
        timeZone: customer.timeZone,
        manager: Boolean(customer.manager),
        testAccount: Boolean(customer.testAccount),
      },
    };
  } catch (error: any) {
    return { valid: false, error: error.message || 'Google Ads account verification failed' };
  }
}

function buildBiddingFields(input: GoogleAdsCampaignInput): Record<string, unknown> {
  switch (input.biddingStrategy || 'MAXIMIZE_CONVERSIONS') {
    case 'MAXIMIZE_CONVERSION_VALUE':
      return { maximizeConversionValue: {} };
    case 'MAXIMIZE_CLICKS':
      return { maximizeClicks: {} };
    case 'TARGET_CPA':
      return { targetCpa: { targetCpaMicros: String(Math.round((input.targetCpa || 0) * 1_000_000)) } };
    case 'TARGET_ROAS':
      return { targetRoas: { targetRoas: input.targetRoas } };
    case 'MANUAL_CPC':
      return { manualCpc: { enhancedCpcEnabled: false } };
    case 'MAXIMIZE_CONVERSIONS':
    default:
      return { maximizeConversions: {} };
  }
}

export function formatGoogleAdsDate(value: Date | string, timeZone?: string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll('-', '');
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Google Ads campaign date is invalid');
  if (!timeZone) return date.toISOString().slice(0, 10).replaceAll('-', '');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
    const result = `${part('year')}${part('month')}${part('day')}`;
    if (/^\d{8}$/.test(result)) return result;
  } catch {
    // Fall through to UTC when a provider returns an invalid timezone name.
  }
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * Create a complete Google Search campaign:
 *  1. Campaign budget (daily, micros)
 *  2. Campaign (PAUSED, MAXIMIZE_CONVERSIONS bidding)
 *  3. Ad group (CPC default)
 *  4. Responsive search ad (3-15 headlines, 2-4 descriptions)
 *  5. Keywords (BROAD match)
 *
 * All resources are created in a single transactional sequence. If any step
 * fails, earlier resources are NOT auto-rolled-back (Google Ads API behaviour);
 * caller can retry the same campaignName since name is unique per account.
 *
 * Campaign starts PAUSED so user can review before activating.
 */
export async function createGoogleAdsSearchCampaign(
  creds: GoogleAdsCredentials,
  input: GoogleAdsCampaignInput
): Promise<GoogleAdsPublishResult> {
  // ── Validate input upfront ────────────────────────────────────
  if (!input.name) return { success: false, error: 'Campaign name required' };
  const budgetMode = input.budgetMode || (input.totalBudgetAmount ? 'CAMPAIGN_TOTAL' : 'AVERAGE_DAILY');
  const budgetAmount = budgetMode === 'CAMPAIGN_TOTAL' ? input.totalBudgetAmount : input.dailyBudgetAmount;
  if (!budgetAmount || budgetAmount <= 0) {
    return { success: false, error: `${budgetMode === 'CAMPAIGN_TOTAL' ? 'Campaign total' : 'Daily'} budget must be > 0` };
  }
  if (budgetMode === 'CAMPAIGN_TOTAL' && (!input.startDate || !input.endDate)) {
    return { success: false, error: 'Campaign total budgets require both start and end dates' };
  }
  if (!input.finalUrl) return { success: false, error: 'finalUrl required' };
  if (input.trackingTemplate && !input.trackingTemplate.includes('{lpurl}')) {
    return { success: false, error: 'Tracking template must include the {lpurl} placeholder' };
  }
  if (input.finalUrlSuffix && /^[?#]/.test(input.finalUrlSuffix)) {
    return { success: false, error: 'Final URL suffix must not begin with ? or #' };
  }
  if ((input.negativeKeywords || []).some((keyword) => keyword.length > 80)) {
    return { success: false, error: 'Negative keywords must be 80 characters or fewer' };
  }
  const requestedAdGroups: GoogleAdsAdGroupInput[] = input.adGroups?.length
    ? input.adGroups
    : [{
      key: 'default',
      headlines: input.headlines,
      descriptions: input.descriptions,
      keywords: input.keywords,
    }];
  for (const group of requestedAdGroups) {
    if (!group.headlines || group.headlines.length < 3 || group.headlines.length > 15) {
      return { success: false, error: `Ad group ${group.key}: need 3 to 15 headlines` };
    }
    if (group.headlines.some(h => h.length > 30)) {
      return { success: false, error: `Ad group ${group.key}: each headline must be <=30 characters` };
    }
    if (new Set(group.headlines.map((headline) => headline.toLocaleLowerCase())).size !== group.headlines.length) {
      return { success: false, error: `Ad group ${group.key}: headlines must be unique` };
    }
    if (!group.descriptions || group.descriptions.length < 2 || group.descriptions.length > 4) {
      return { success: false, error: `Ad group ${group.key}: need 2 to 4 descriptions` };
    }
    if (group.descriptions.some(d => d.length > 90)) {
      return { success: false, error: `Ad group ${group.key}: each description must be <=90 characters` };
    }
    if (new Set(group.descriptions.map((description) => description.toLocaleLowerCase())).size !== group.descriptions.length) {
      return { success: false, error: `Ad group ${group.key}: descriptions must be unique` };
    }
    if (!group.keywords || group.keywords.length === 0) {
      return { success: false, error: `Ad group ${group.key}: at least one keyword required` };
    }
    if (group.keywords.some((keyword) => keyword.length > 80)) {
      return { success: false, error: `Ad group ${group.key}: keywords must be 80 characters or fewer` };
    }
    try {
      new URL(group.finalUrl || input.finalUrl);
    } catch {
      return { success: false, error: `Ad group ${group.key}: final URL is invalid` };
    }
    if ((group.path1 && group.path1.length > 15) || (group.path2 && group.path2.length > 15)) {
      return { success: false, error: `Ad group ${group.key}: display paths must be 15 characters or fewer` };
    }
  }

  let budgetResourceName: string | undefined;
  let campaignResourceName: string | undefined;
  try {
    // ── 1. Budget ───────────────────────────────────────────────
    // Google Ads uses micros (1_000_000 = 1 unit of currency).
    const amountMicros = Math.round(budgetAmount * 1_000_000);
    const resourceSuffix = (input.resourceKey || input.name)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 80);
    const budgetResp = await callMutate<{ results: { resourceName: string }[] }>(
      creds,
      'campaignBudgets',
      [{
        create: {
          name: `${input.name} budget ${resourceSuffix}`,
          deliveryMethod: 'STANDARD',
          explicitlyShared: false,
          ...(budgetMode === 'CAMPAIGN_TOTAL'
            ? { period: 'CUSTOM_PERIOD', totalAmountMicros: String(amountMicros) }
            : { amountMicros: String(amountMicros) }),
        },
      }]
    );
    budgetResourceName = budgetResp.results[0].resourceName;
    await input.onResourceCreated?.({ resourceType: 'budget', localKey: 'campaign-budget', resourceName: budgetResourceName });

    // ── 2. Campaign ─────────────────────────────────────────────
    const startDate = formatGoogleAdsDate(input.startDate || new Date(), input.timeZone);
    const campaignResp = await callMutate<{ results: { resourceName: string }[] }>(
      creds,
      'campaigns',
      [{
        create: {
          name: buildGoogleProviderCampaignName(input.name, input.resourceKey),
          status: 'PAUSED',
          advertisingChannelType: 'SEARCH',
          campaignBudget: budgetResourceName,
          ...buildBiddingFields(input),
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: input.includeSearchNetwork !== false,
            targetContentNetwork: false,
            targetPartnerSearchNetwork: input.includePartnerSearchNetwork === true,
          },
          containsEuPoliticalAdvertising: input.containsEuPoliticalAdvertising
            || 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          trackingUrlTemplate: input.trackingTemplate,
          finalUrlSuffix: input.finalUrlSuffix,
          startDate,
          endDate: input.endDate ? formatGoogleAdsDate(input.endDate, input.timeZone) : undefined,
        },
      }]
    );
    campaignResourceName = campaignResp.results[0].resourceName;
    await input.onResourceCreated?.({ resourceType: 'campaign', localKey: 'campaign', resourceName: campaignResourceName });

    // ── 2b. Geo / Language targeting (optional) ──────────────────
    if (input.geoTargetIds?.length) {
      await callMutate(creds, 'campaignCriteria', input.geoTargetIds.map(geoId => ({
        create: {
          campaign: campaignResourceName,
          location: { geoTargetConstant: geoId },
        },
      })));
    }
    if (input.languageIds?.length) {
      await callMutate(creds, 'campaignCriteria', input.languageIds.map(langId => ({
        create: {
          campaign: campaignResourceName,
          language: { languageConstant: langId },
        },
      })));
    }

    const adGroupResourceNames: string[] = [];
    const adResourceNames: string[] = [];
    const keywordResourceNames: string[] = [];
    for (const group of requestedAdGroups) {
      // ── 3. Ad Group ───────────────────────────────────────────
      const adGroupResp = await callMutate<{ results: { resourceName: string }[] }>(
        creds,
        'adGroups',
        [{
          create: {
            name: group.name || `${input.name} - ${group.key}`,
            status: 'ENABLED',
            campaign: campaignResourceName,
            type: 'SEARCH_STANDARD',
            ...(input.biddingStrategy === 'MANUAL_CPC' ? { cpcBidMicros: String(1_000_000) } : {}),
          },
        }]
      );
      const adGroupResourceName = adGroupResp.results[0].resourceName;
      adGroupResourceNames.push(adGroupResourceName);
      await input.onResourceCreated?.({ resourceType: 'ad_group', localKey: group.key, resourceName: adGroupResourceName });

      // ── 4. Responsive Search Ad ───────────────────────────────
      const adResp = await callMutate<{ results: { resourceName: string }[] }>(
        creds,
        'adGroupAds',
        [{
          create: {
            adGroup: adGroupResourceName,
            status: 'ENABLED',
            ad: {
              finalUrls: [group.finalUrl || input.finalUrl],
              responsiveSearchAd: {
                headlines: group.headlines.map(text => ({ text })),
                descriptions: group.descriptions.map(text => ({ text })),
                path1: group.path1 || input.path1,
                path2: group.path2 || input.path2,
              },
            },
          },
        }]
      );
      adResourceNames.push(adResp.results[0].resourceName);
      await input.onResourceCreated?.({ resourceType: 'ad', localKey: group.key, resourceName: adResp.results[0].resourceName });

      // ── 5. Keywords ───────────────────────────────────────────
      const keywordResp = await callMutate<{ results: { resourceName: string }[] }>(
        creds,
        'adGroupCriteria',
        [
          ...group.keywords.map(kw => ({
            text: kw,
            negative: false,
            matchType: group.keywordMatchType || input.keywordMatchType || 'BROAD',
          })),
          ...(group.negativeKeywords || input.negativeKeywords || []).map(kw => ({
            text: kw,
            negative: true,
            matchType: group.keywordMatchType || input.keywordMatchType || 'BROAD',
          })),
        ].map(criterion => ({
          create: {
            adGroup: adGroupResourceName,
            status: 'ENABLED',
            negative: criterion.negative,
            keyword: { text: criterion.text, matchType: criterion.matchType },
          },
        }))
      );
      keywordResourceNames.push(...keywordResp.results.map(r => r.resourceName));
      for (let index = 0; index < keywordResp.results.length; index += 1) {
        await input.onResourceCreated?.({
          resourceType: 'keyword',
          localKey: `${group.key}:${index + 1}`,
          resourceName: keywordResp.results[index].resourceName,
        });
      }
    }

    return {
      success: true,
      budgetResourceName,
      campaignResourceName,
      adGroupResourceName: adGroupResourceNames[0],
      adResourceName: adResourceNames[0],
      adGroupResourceNames,
      adResourceNames,
      keywordResourceNames,
    };
  } catch (err: any) {
    const cleanupErrors: string[] = [];
    // Google mutations are not transactional. Remove the campaign first; its
    // descendants are then ineligible to serve. Remove the orphaned budget too.
    if (campaignResourceName) {
      try {
        await callMutate(creds, 'campaigns', [{ remove: campaignResourceName }]);
      } catch (cleanupError: any) {
        cleanupErrors.push(`campaign cleanup: ${cleanupError.message}`);
      }
    }
    if (budgetResourceName) {
      try {
        await callMutate(creds, 'campaignBudgets', [{ remove: budgetResourceName }]);
      } catch (cleanupError: any) {
        cleanupErrors.push(`budget cleanup: ${cleanupError.message}`);
      }
    }
    logger.error({ err: err.message, campaign: input.name }, '[GoogleAds] Campaign publish failed');
    return {
      success: false,
      error: err.message || 'Google Ads campaign publish failed',
      cleanupErrors: cleanupErrors.length ? cleanupErrors : undefined,
    };
  }
}

/**
 * Pause / Resume / Remove a campaign by resource name.
 */
export async function updateCampaignStatus(
  creds: GoogleAdsCredentials,
  campaignResourceName: string,
  status: 'ENABLED' | 'PAUSED' | 'REMOVED'
): Promise<{ success: boolean; error?: string }> {
  try {
    await callMutate(creds, 'campaigns', [{
      update: { resourceName: campaignResourceName, status },
      updateMask: 'status',
    }]);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function removeGoogleCampaignResources(
  creds: GoogleAdsCredentials,
  campaignResourceName: string,
  budgetResourceName?: string,
): Promise<{ success: boolean; errors?: string[] }> {
  const errors: string[] = [];
  try {
    await callMutate(creds, 'campaigns', [{ remove: campaignResourceName }]);
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : 'Google campaign cleanup failed');
  }
  if (budgetResourceName) {
    try {
      await callMutate(creds, 'campaignBudgets', [{ remove: budgetResourceName }]);
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : 'Google budget cleanup failed');
    }
  }
  return { success: errors.length === 0, errors: errors.length ? errors : undefined };
}

export async function updateCampaignBudget(
  creds: GoogleAdsCredentials,
  budgetResourceName: string,
  budgetAmount: number,
  budgetMode: 'CAMPAIGN_TOTAL' | 'AVERAGE_DAILY' = 'AVERAGE_DAILY',
): Promise<{ success: boolean; error?: string }> {
  if (!Number.isFinite(budgetAmount) || budgetAmount <= 0) {
    return {
      success: false,
      error: `Google ${budgetMode === 'CAMPAIGN_TOTAL' ? 'campaign total' : 'daily'} budget must be greater than zero`,
    };
  }
  const providerField = budgetMode === 'CAMPAIGN_TOTAL' ? 'totalAmountMicros' : 'amountMicros';
  const updateMask = budgetMode === 'CAMPAIGN_TOTAL' ? 'total_amount_micros' : 'amount_micros';
  try {
    await callMutate(creds, 'campaignBudgets', [{
      update: {
        resourceName: budgetResourceName,
        [providerField]: String(Math.round(budgetAmount * 1_000_000)),
      },
      updateMask,
    }]);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Google budget update failed' };
  }
}

export async function createGoogleResponsiveSearchAd(
  creds: GoogleAdsCredentials,
  input: {
    adGroupResourceName: string;
    finalUrl: string;
    headlines: string[];
    descriptions: string[];
  },
): Promise<{ success: boolean; adResourceName?: string; error?: string }> {
  if (input.headlines.length < 3 || input.headlines.length > 15 || input.headlines.some((item) => item.length > 30)) {
    return { success: false, error: 'Google replacement requires 3-15 headlines of at most 30 characters' };
  }
  if (input.descriptions.length < 2 || input.descriptions.length > 4 || input.descriptions.some((item) => item.length > 90)) {
    return { success: false, error: 'Google replacement requires 2-4 descriptions of at most 90 characters' };
  }
  try {
    const response = await callMutate<{ results: { resourceName: string }[] }>(creds, 'adGroupAds', [{
      create: {
        adGroup: input.adGroupResourceName,
        status: 'PAUSED',
        ad: {
          finalUrls: [input.finalUrl],
          responsiveSearchAd: {
            headlines: input.headlines.map((text) => ({ text })),
            descriptions: input.descriptions.map((text) => ({ text })),
          },
        },
      },
    }]);
    return { success: true, adResourceName: response.results[0]?.resourceName };
  } catch (err: any) {
    return { success: false, error: err.message || 'Google replacement ad creation failed' };
  }
}

export async function updateGoogleAdStatus(
  creds: GoogleAdsCredentials,
  adResourceName: string,
  status: 'ENABLED' | 'PAUSED' | 'REMOVED',
): Promise<{ success: boolean; error?: string }> {
  try {
    await callMutate(creds, 'adGroupAds', [{
      update: { resourceName: adResourceName, status },
      updateMask: 'status',
    }]);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Google ad status update failed' };
  }
}

export async function updateGoogleAdGroupStatus(
  creds: GoogleAdsCredentials,
  adGroupResourceName: string,
  status: 'ENABLED' | 'PAUSED' | 'REMOVED',
): Promise<{ success: boolean; error?: string }> {
  try {
    await callMutate(creds, 'adGroups', [{
      update: { resourceName: adGroupResourceName, status },
      updateMask: 'status',
    }]);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Google ad-group status update failed' };
  }
}

/**
 * Fetch campaign performance (impressions / clicks / cost) over the last N days.
 * Uses the GAQL search endpoint.
 */
export async function getCampaignMetrics(
  creds: GoogleAdsCredentials,
  campaignResourceName: string,
  daysBack: number = 7
): Promise<{ success: boolean; metrics?: { impressions: number; clicks: number; costMicros: number; conversions: number }; error?: string }> {
  try {
    const campaignId = campaignResourceName.split('/').pop();
    if (!/^\d+$/.test(campaignId || '')) return { success: false, error: 'Invalid Google campaign resource name' };
    const query = `
      SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE campaign.id = ${campaignId}
        AND segments.date DURING LAST_${daysBack === 30 ? '30' : daysBack === 14 ? '14' : '7'}_DAYS
    `.trim();

    const rows = await searchGoogleAds<any>(creds, query);

    // Aggregate rows
    const metrics = { impressions: 0, clicks: 0, costMicros: 0, conversions: 0 };
    for (const row of rows) {
      metrics.impressions += Number(row.metrics?.impressions || 0);
      metrics.clicks += Number(row.metrics?.clicks || 0);
      metrics.costMicros += Number(row.metrics?.costMicros || 0);
      metrics.conversions += Number(row.metrics?.conversions || 0);
    }
    return { success: true, metrics };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export interface GoogleDailyCampaignMetric {
  date: string;
  impressions: number;
  clicks: number;
  engagements: number;
  costMicros: number;
  conversions: number;
  conversionsValue: number;
  status?: string;
}

export interface GoogleDailyAdGroupMetric extends GoogleDailyCampaignMetric {
  adGroupResourceName: string;
}

export interface GoogleDailyAdMetric extends GoogleDailyCampaignMetric {
  adResourceName: string;
  adGroupResourceName: string;
}

export async function getCampaignMetricsByDateRange(
  creds: GoogleAdsCredentials,
  campaignResourceName: string,
  dateStart: string,
  dateStop: string,
): Promise<{ success: boolean; metrics?: GoogleDailyCampaignMetric[]; error?: string }> {
  try {
    const campaignId = campaignResourceName.split('/').pop();
    if (!/^\d+$/.test(campaignId || '')) return { success: false, error: 'Invalid Google campaign resource name' };
    assertGoogleReportingDates(dateStart, dateStop);
    const query = `
      SELECT campaign.status, segments.date, metrics.impressions, metrics.clicks,
             metrics.engagements, metrics.cost_micros, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE campaign.id = ${campaignId}
        AND segments.date BETWEEN '${dateStart}' AND '${dateStop}'
      ORDER BY segments.date
    `.trim();
    const rows = await searchGoogleAds<any>(creds, query);
    return {
      success: true,
      metrics: rows.map((row: any) => ({
        date: row.segments?.date,
        impressions: Number(row.metrics?.impressions || 0),
        clicks: Number(row.metrics?.clicks || 0),
        engagements: Number(row.metrics?.engagements || 0),
        costMicros: Number(row.metrics?.costMicros || 0),
        conversions: Number(row.metrics?.conversions || 0),
        conversionsValue: Number(row.metrics?.conversionsValue || 0),
        status: row.campaign?.status,
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Google Ads metrics request failed' };
  }
}

export async function getAdGroupMetricsByDateRange(
  creds: GoogleAdsCredentials,
  campaignResourceName: string,
  dateStart: string,
  dateStop: string,
): Promise<{ success: boolean; metrics?: GoogleDailyAdGroupMetric[]; error?: string }> {
  try {
    const campaignId = campaignResourceName.split('/').pop();
    if (!/^\d+$/.test(campaignId || '')) return { success: false, error: 'Invalid Google campaign resource name' };
    assertGoogleReportingDates(dateStart, dateStop);
    const query = `
      SELECT ad_group.resource_name, ad_group.status, segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros,
             metrics.engagements, metrics.conversions, metrics.conversions_value
      FROM ad_group
      WHERE campaign.id = ${campaignId}
        AND segments.date BETWEEN '${dateStart}' AND '${dateStop}'
      ORDER BY segments.date, ad_group.resource_name
    `.trim();
    const rows = await searchGoogleAds<any>(creds, query);
    return {
      success: true,
      metrics: rows.map((row: any) => ({
        adGroupResourceName: String(row.adGroup?.resourceName || ''),
        date: row.segments?.date,
        impressions: Number(row.metrics?.impressions || 0),
        clicks: Number(row.metrics?.clicks || 0),
        engagements: Number(row.metrics?.engagements || 0),
        costMicros: Number(row.metrics?.costMicros || 0),
        conversions: Number(row.metrics?.conversions || 0),
        conversionsValue: Number(row.metrics?.conversionsValue || 0),
        status: row.adGroup?.status,
      })).filter((metric: GoogleDailyAdGroupMetric) => Boolean(metric.adGroupResourceName)),
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Google Ads ad group metrics request failed' };
  }
}

export async function getAdMetricsByDateRange(
  creds: GoogleAdsCredentials,
  campaignResourceName: string,
  dateStart: string,
  dateStop: string,
): Promise<{ success: boolean; metrics?: GoogleDailyAdMetric[]; error?: string }> {
  try {
    const campaignId = campaignResourceName.split('/').pop();
    if (!/^\d+$/.test(campaignId || '')) return { success: false, error: 'Invalid Google campaign resource name' };
    assertGoogleReportingDates(dateStart, dateStop);
    const query = `
      SELECT ad_group.resource_name, ad_group_ad.resource_name, ad_group_ad.status, segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros,
             metrics.engagements, metrics.conversions, metrics.conversions_value
      FROM ad_group_ad
      WHERE campaign.id = ${campaignId}
        AND segments.date BETWEEN '${dateStart}' AND '${dateStop}'
      ORDER BY segments.date, ad_group_ad.resource_name
    `.trim();
    const rows = await searchGoogleAds<any>(creds, query);
    return {
      success: true,
      metrics: rows.map((row: any) => ({
        adResourceName: String(row.adGroupAd?.resourceName || ''),
        adGroupResourceName: String(row.adGroup?.resourceName || ''),
        date: row.segments?.date,
        impressions: Number(row.metrics?.impressions || 0),
        clicks: Number(row.metrics?.clicks || 0),
        engagements: Number(row.metrics?.engagements || 0),
        costMicros: Number(row.metrics?.costMicros || 0),
        conversions: Number(row.metrics?.conversions || 0),
        conversionsValue: Number(row.metrics?.conversionsValue || 0),
        status: row.adGroupAd?.status,
      })).filter((metric: GoogleDailyAdMetric) => Boolean(metric.adResourceName)),
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Google Ads ad metrics request failed' };
  }
}

/** Direct access plus manager descendants. One failing manager does not hide verified customers. */
export async function discoverGoogleAdsAccounts(creds: GoogleAdsCredentials) {
  const access = await verifyGoogleAdsCredentials(creds);
  if (!access.valid) throw new Error('Google Ads authorization failed. Reconnect and verify the developer token.');
  type Account = {customerId:string;name?:string;currency?:string;timeZone?:string;manager?:boolean;testAccount?:boolean;managerAccountId?:string};
  const accounts = new Map<string,Account>();
  const failures: string[] = [];
  const roots = [...new Set((access.resourceNames || []).map(name => name.replace(/^customers\//,'')))];
  for (const root of roots) {
    const queue = [{id:root,managerAccountId:''}];
    const visited = new Set<string>();
    while(queue.length) {
      const node = queue.shift()!;
      if(visited.has(node.id)) continue;
      if(visited.size >= 1000) { failures.push('Manager discovery exceeded 1,000 accounts. Select a narrower manager.'); break; }
      visited.add(node.id);
      const scoped = {...creds,customerId:node.id,managerAccountId:node.managerAccountId};
      const info = await getGoogleAdsAccountInfo(scoped);
      if(!info.valid || !info.account) { failures.push(`Account ${node.id} could not be verified. Check manager access.`); continue; }
      if(!accounts.has(node.id)) accounts.set(node.id,{...info.account,managerAccountId:node.managerAccountId || undefined});
      if(!info.account.manager) continue;
      try {
        const children = await searchGoogleAds<{customerClient:{id:string;level:number;manager:boolean}}>(scoped,
          'SELECT customer_client.id, customer_client.level, customer_client.manager FROM customer_client WHERE customer_client.level <= 1');
        for (const row of children) {
          const child = row.customerClient;
          if(child && Number(child.level) === 1) queue.push({id:String(child.id),managerAccountId:node.managerAccountId || root});
        }
      } catch { failures.push(`Manager ${node.id} could not list every customer. Check access and retry.`); }
    }
  }
  return {accounts:[...accounts.values()],failures};
}
