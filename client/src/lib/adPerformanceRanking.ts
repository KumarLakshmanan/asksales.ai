import { campaignResult, objectiveMetricKey } from './performancePresentation';
export interface RankableAd {
  platform: string;
  targetType: string;
  targetKey: string;
  measurementWindow?: string;
  metricsUpdatedAt?: string | null;
  aggregate: Record<string, number | null | undefined>;
}

/** Descriptive ranking only: this never authorizes an ad delivery change. */
export function rankAds<T extends RankableAd>(ads: T[], objective: string, now = Date.now()) {
  const metric = objectiveMetricKey(objective);
  const rows = ads.filter(ad => ad.targetType === 'ad').map(ad => {
    const presentation = campaignResult({ objective, metrics: ad.aggregate });
    const result = ad.aggregate[metric];
    const spend = ad.aggregate.spend;
    const age = now - Date.parse(ad.metricsUpdatedAt || '');
    const reason = !ad.measurementWindow || /unknown|Provider cached window/i.test(ad.measurementWindow) ? 'Reporting window unavailable'
      : !Number.isFinite(age) || age > 48 * 3600000 ? 'Needs fresh data'
      : result == null || !Number.isFinite(result) || result < 0 ? 'Result measurement unavailable'
        : spend == null || !Number.isFinite(spend) || spend < 0 ? 'Spend unavailable'
          : !ad.aggregate.impressions ? 'No delivery evidence' : null;
    return { ad, metric, result: result ?? null, costLabel: presentation.costLabel, resultLabel: presentation.resultLabel, costPerResult: Number.isFinite(presentation.cost) ? presentation.cost : null, reason, rank: null as number | null };
  });
  rows.sort((a,b) => Number(Boolean(a.reason)) - Number(Boolean(b.reason))
    || a.ad.platform.localeCompare(b.ad.platform) || (b.result ?? -1) - (a.result ?? -1)
    || (a.costPerResult ?? Infinity) - (b.costPerResult ?? Infinity) || a.ad.targetKey.localeCompare(b.ad.targetKey));
  const positions = new Map<string, number>();
  rows.forEach(row => { if (!row.reason) { const group = `${row.ad.platform}:${row.ad.measurementWindow || "unknown"}`; const next = (positions.get(group) || 0) + 1; row.rank = next; positions.set(group, next); } });
  return rows;
}
