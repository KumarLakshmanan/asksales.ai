export type PerformanceMarketingEvent =
  | "workspace_tab_changed"
  | "view_mode_changed"
  | "filter_changed"
  | "campaign_detail_opened"
  | "creative_preview_opened"
  | "recommendation_reviewed"
  | "recommendation_lifecycle_changed"
  | "campaign_policy_saved"
  | "data_connections_opened"
  | "report_saved";

type AnalyticsPayload = Record<string, string | number | boolean | null | undefined>;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

/**
 * Emits a privacy-safe product event for the host analytics adapter. Campaign
 * names, account identifiers, provider resource IDs, and evidence payloads are
 * intentionally excluded from this interface.
 */
export function trackPerformanceMarketingEvent(event: PerformanceMarketingEvent, payload: AnalyticsPayload = {}) {
  if (typeof window === "undefined") return;
  const detail = { event, area: "performance_marketing", ...payload };
  window.dispatchEvent(new CustomEvent("asksales:analytics", { detail }));
  window.dataLayer?.push({ event: `performance_marketing_${event}`, ...payload });
}
