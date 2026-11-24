import { asRecord as record } from '../../../shared/records.js';
/** Bounded typed evidence for chat response verification. Never copy summaries,
 * provider prose, campaign names, visualizations, or arbitrary nested fields. */
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const metrics = (value: unknown, keys: readonly string[]): Record<string, number> => {
  const source = record(value);
  return Object.fromEntries(keys.filter(key => numeric(source[key])).map(key => [key, source[key] as number]));
};
const leadKeys = ['totalLeads', 'qualifiedLeads', 'convertedLeads', 'conversionRate', 'avgLeadScore'] as const;
const outreachKeys = ['totalSent', 'delivered', 'opened', 'clicked', 'replied', 'openRate', 'clickRate', 'replyRate'] as const;
const campaignKeys = ['impressions', 'clicks', 'conversions', 'ctr', 'cpc', 'spend', 'roi'] as const;
// Enumerated ad platforms only, so a comparison such as Meta vs Google is grounded.
const adPlatforms = new Set(['meta', 'meta_ads', 'facebook', 'instagram', 'google', 'google_ads', 'linkedin', 'linkedin_ads', 'tiktok', 'youtube']);

export interface AnalyticsEvidence {
  queryType: 'campaign' | 'lead' | 'outreach' | 'overview';
  scope?: 'current_campaign' | 'all_owned';
  threadId?: number;
  /** Inclusive reporting period for paid campaign metrics; absent means lifetime totals. */
  dateRange?: { start: string; end: string };
  returnedCampaignCount?: number;
  campaigns?: Array<{ id: string; measured: boolean; currency?: string; platform?: string; metrics: Record<string, number> }>;
  leads?: Record<string, number>;
  outreach?: Record<string, number>;
  deliveryReport?: {checkedAt: string; counts: Record<string, number>; engagement: Record<string, number>; nextAttemptAt?: string | null};
}

export function projectAnalyticsEvidence(output: Record<string, unknown>): AnalyticsEvidence | undefined {
  const queryType = output.queryType;
  if (queryType !== 'campaign' && queryType !== 'lead' && queryType !== 'outreach' && queryType !== 'overview') return undefined;
  const result: AnalyticsEvidence = { queryType };
  if (output.scope === 'all_owned') result.scope = 'all_owned';
  if (output.scope === 'current_campaign' && Number.isSafeInteger(output.threadId) && Number(output.threadId) > 0) {
    result.scope = 'current_campaign'; result.threadId = Number(output.threadId);
  }
  const range = record(output.dateRange);
  const isoDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (isoDate(range.start) && isoDate(range.end)) result.dateRange = { start: String(range.start), end: String(range.end) };
  const data = record(output.data);
  const campaigns = queryType === 'campaign' ? output.data : queryType === 'overview' ? data.campaigns : undefined;
  if (Array.isArray(campaigns)) {
    result.returnedCampaignCount = campaigns.length;
    result.campaigns = campaigns.slice(0, 50).flatMap(value => {
      const row = record(value);
      const id = String(row.campaignId ?? '');
      if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) return [];
      const measured = row.hasPerformanceData === true;
      return [{ id, measured,
        ...(typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? { currency: row.currency } : {}),
        ...(typeof row.platform === 'string' && adPlatforms.has(row.platform.toLowerCase()) ? { platform: row.platform.toLowerCase() } : {}),
        metrics: measured ? metrics(row, campaignKeys) : {},
      }];
    });
  }
  if (queryType === 'lead' || queryType === 'overview') result.leads = metrics(queryType === 'lead' ? data : data.leads, leadKeys);
  if (queryType === 'outreach' || queryType === 'overview') result.outreach = metrics(queryType === 'outreach' ? data : data.outreach, outreachKeys);
  const report=record(record(queryType==='overview' ? data.outreach : data).report);
  if (report.version===1 && report.source==='canonical_outreach' && typeof report.checkedAt==='string' && Number.isFinite(Date.parse(report.checkedAt))) {
    result.deliveryReport={checkedAt:new Date(report.checkedAt).toISOString(),
      counts:metrics(report.counts,['total','accepted','delivered','awaitingConfirmation','queued','retrying','processing','failed','review','cancelled']),
      engagement:metrics(report.engagement,['respondingCustomers','inboundResponses','typedReplies','quickReplies','menuSelections','otherResponses','assistantReplies','responseRate']),
      ...(report.nextAttemptAt===null ? {nextAttemptAt:null} : typeof report.nextAttemptAt==='string' && Number.isFinite(Date.parse(report.nextAttemptAt)) ? {nextAttemptAt:new Date(report.nextAttemptAt).toISOString()} : {}),
    };
  }
  return result;
}

export function describeAnalyticsEvidence(evidence: AnalyticsEvidence): string {
  const scope = evidence.scope === 'current_campaign' ? `Current conversation #${evidence.threadId}`
    : evidence.scope === 'all_owned' ? 'Account-wide saved data' : 'Scope not verified';
  const lines = [`Saved analytics — ${scope}.`];
  if (evidence.returnedCampaignCount !== undefined) {
    lines.push(evidence.dateRange
      ? `Paid campaign period: ${evidence.dateRange.start} to ${evidence.dateRange.end} (inclusive, UTC dates).`
      : 'Paid campaign figures are lifetime totals; no reporting period was applied.');
  }
  if (evidence.returnedCampaignCount === 0) lines.push('No saved paid campaigns returned for this lookup. Missing measurements are not evidence of zero spend or no historical activity.');
  else if (evidence.returnedCampaignCount !== undefined) {
    lines.push(`${evidence.returnedCampaignCount} saved paid campaign(s) returned.`);
    for (const campaign of (evidence.campaigns ?? []).slice(0, 10)) {
      const entries = Object.entries(campaign.metrics).map(([key, value]) =>
        `${key}: ${key === 'spend' || key === 'cpc' ? `${campaign.currency ?? 'currency unavailable'} ` : ''}${value}`);
      lines.push(`Campaign #${campaign.id}${campaign.platform ? ` (${campaign.platform})` : ''}: ${campaign.measured && entries.length ? entries.join('; ') : 'measurements unavailable'}.`);
    }
  }
  for (const [label, values] of [['Leads', evidence.leads], ['Outreach', evidence.outreach]] as const) {
    if (values) lines.push(`${label}: ${Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('; ') || 'measurements unavailable'}.`);
  }
  lines.push('These are saved records, not a live provider check. Missing metrics are unavailable, not zero.');
  if (evidence.deliveryReport) {
    const report=evidence.deliveryReport;
    lines.push(`Canonical delivery snapshot at ${report.checkedAt}: ${Object.entries(report.counts).map(([key,value])=>`${key}: ${value}`).join('; ')}.`);
    lines.push(`Engagement: ${Object.entries(report.engagement).map(([key,value])=>`${key}: ${value}`).join('; ')}. Next queued attempt: ${report.nextAttemptAt || 'not yet scheduled'}.`);
    lines.push('Accepted includes delivered and awaiting confirmation. A saved reply after sending is audience-level attribution, not proof of offer-specific interest. Call-button clicks are unavailable.');
  }
  return lines.join('\n');
}
