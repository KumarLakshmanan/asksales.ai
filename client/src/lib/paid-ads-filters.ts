/** Reporting supports these windows; provider authoring also supports shorter legacy presets. */
const periodPresets: Record<string, string> = {
  "7d": "last_7d",
  "30d": "last_30d",
  "90d": "last_90d",
};
const presetPeriods = Object.fromEntries(
  Object.entries(periodPresets).map(([period, preset]) => [preset, period]),
);
const providerPresets = new Set([
  "today",
  "yesterday",
  "last_7d",
  "last_14d",
  "last_30d",
  "last_90d",
]);
export function paidAdsPeriod(filters: {
  period?: string | null;
  date?: string | null;
}) {
  return filters.period && periodPresets[filters.period]
    ? filters.period
    : presetPeriods[filters.date || ""] || "30d";
}
export function paidAdsProviderPreset(filters: {
  period?: string | null;
  date?: string | null;
}) {
  if (filters.period && periodPresets[filters.period])
    return periodPresets[filters.period];
  return filters.date && providerPresets.has(filters.date)
    ? filters.date
    : "last_30d";
}
export function paidAdsFilterUpdates(
  updates: Record<string, string | null>,
): Record<string, string | null> {
  if (updates.period && periodPresets[updates.period])
    return { ...updates, date: periodPresets[updates.period] };
  if (updates.date)
    return { ...updates, period: presetPeriods[updates.date] || null };
  return updates;
}
export function paidCampaignFreshness(
  updatedAt?: string | null,
  failed = false,
  now = Date.now(),
) {
  if (failed) return "Refresh failed";
  const timestamp = updatedAt ? new Date(updatedAt).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return "No fresh data";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : `${Math.floor(minutes / 60)}h ago`;
}
