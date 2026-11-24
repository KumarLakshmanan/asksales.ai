import { measuredLeads } from './AdLeadMetrics.js';
import { isReportingDate } from '../../utils/reportingDates.js';

export function providerReportingWindow(preset: string, now = new Date()) {
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0);
  if (preset === 'yesterday') end.setUTCDate(end.getUTCDate() - 1);
  if (preset === 'this_month' || preset === 'last_month') {
    const start = new Date(end); start.setUTCDate(1);
    if (preset === 'last_month') { end.setUTCDate(0); start.setUTCMonth(start.getUTCMonth() - 1); }
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const days = ({ today: 1, yesterday: 1, last_7d: 7, last_14d: 14, last_28d: 28, last_30d: 30, last_90d: 90 } as Record<string, number>)[preset] || 30;
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: preset === 'maximum' ? '1970-01-01' : start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const metricKeys = ['impressions', 'clicks', 'spend', 'reach', 'conversions', 'conversionValue', 'engagements', 'installs'] as const;

/** The same daily source selection must drive cards, charts and detail traces. */
export function providerReportingRows(raw: Record<string, unknown>, start: string, end: string) {
  const input = Array.isArray(raw.dailyInsights) ? raw.dailyInsights : [];
  const seen = new Set<string>();
  return input.filter((value): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    const date = String(row.date || row.date_start || '').slice(0, 10);
    if (!isReportingDate(date) || date < start || date > end) return false;
    const fingerprint = JSON.stringify([date, ...metricKeys.map(key => row[key] ?? (key === 'conversionValue' ? row.conversion_value : 0)), measuredLeads(row)]);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

/** Filter before aggregation so changing the date selector also changes KPI cards. */
export function aggregateProviderReportingWindow(raw: Record<string, unknown>, start: string, end: string) {
  const rows = providerReportingRows(raw, start, end);
  const totals = { impressions: 0, clicks: 0, spend: 0, reach: 0, conversions: 0, conversionValue: 0, engagements: 0, installs: 0 };
  let leads: number | null = rows.length ? 0 : null;
  for (const row of rows) {
    const measured = measuredLeads(row);
    leads = leads == null || measured == null ? null : leads + measured;
    for (const key of metricKeys) {
      const value = Number(row[key] ?? (key === 'conversionValue' ? row.conversion_value : 0));
      if (Number.isFinite(value) && value >= 0) totals[key] += value;
    }
  }
  return {
    ...totals, leads,
    ctr: totals.impressions > 0 ? totals.clicks / totals.impressions * 100 : 0,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    cpm: totals.impressions > 0 ? totals.spend / totals.impressions * 1000 : 0,
  };
}
