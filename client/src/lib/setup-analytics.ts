declare global { interface Window { dataLayer?: Array<Record<string, unknown>>; } }
export type SetupEvent = "setup_step_viewed" | "setup_completed" | "draft_save_failed" | "analysis_started" | "analysis_completed" | "analysis_failed" | "analysis_cancelled" | "asset_upload_failed" | "asset_uploaded" | "first_action_opened";
/** Only workflow measurements; no names, URLs, contact details, prompts or credentials. */
export function trackSetupEvent(event: SetupEvent, payload: { step?: number; phase?: string; stage?: string; pages?: number; durationMs?: number; knowledgeSaved?: boolean; reanalysis?: boolean; action?: string } = {}) {
  if (typeof window === "undefined") return;
  const detail = { event, area: "workspace_setup", ...payload };
  window.dispatchEvent(new CustomEvent("asksales:analytics", { detail }));
  window.dataLayer?.push({ event: `workspace_setup_${event}`, ...payload });
}
