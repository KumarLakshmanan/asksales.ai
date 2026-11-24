import type { CreativeReference } from "../../../../shared/adCreativeIntelligence.js";

/** Links are display-only. Never fetch user-supplied research URLs. */
export function safeReferenceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return null;
    const host = url.hostname.toLowerCase();
    if (
      !host.includes(".") ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      /^\d+[.]/.test(host) ||
      host.includes(":") ||
      host.includes("[")
    )
      return null;
    if (
      [...url.searchParams.keys()].some((key) =>
        /token|secret|password|signature|credential|api.?key/i.test(key),
      )
    )
      return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string")
        .slice(0, 20)
        .map((v) => v.slice(0, 5000))
    : [];
}
function date(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return null;
  return new Date(value).toISOString();
}
export function normalizeLibraryAd(
  raw: Record<string, unknown>,
  observedAt: string,
): CreativeReference | null {
  if (typeof raw.id !== "string" || !/^\d{1,40}$/.test(raw.id)) return null;
  return {
    id: raw.id,
    source: "meta_library",
    pageName: String(raw.page_name || "Unknown advertiser").slice(0, 200),
    pageId: typeof raw.page_id === "string" && /^\d{1,40}$/.test(raw.page_id) ? raw.page_id : null,
    estimatedEuReach: typeof raw.eu_total_reach === "number" && Number.isSafeInteger(raw.eu_total_reach) && raw.eu_total_reach >= 0 ? raw.eu_total_reach : null,
    // Build a public library permalink; never propagate a token-bearing snapshot URL.
    url: `https://www.facebook.com/ads/library/?id=${raw.id}`,
    bodies: strings(raw.ad_creative_bodies),
    titles: strings(raw.ad_creative_link_titles),
    descriptions: strings(raw.ad_creative_link_descriptions),
    captions: strings(raw.ad_creative_link_captions),
    platforms: strings(raw.publisher_platforms),
    format: "unknown",
    notes: "",
    observedAt,
    startDate: date(raw.ad_delivery_start_time),
    endDate: date(raw.ad_delivery_stop_time),
    signals: [],
  };
}
export function addResearchSignals(
  references: CreativeReference[],
): CreativeReference[] {
  const unique = [...new Map(references.map((ref) => [ref.id, ref])).values()];
  const textKey = (ref: CreativeReference) =>
    ref.bodies.join("\n").trim().toLowerCase().replace(/\s+/g, " ");
  return unique.map((ref) => {
    const signals: string[] = [];
    const start = Date.parse(ref.startDate || "");
    const observed = Date.parse(ref.observedAt);
    const stop = ref.endDate ? Date.parse(ref.endDate) : observed;
    if (
      Number.isFinite(start) &&
      Number.isFinite(stop) &&
      start <= Math.min(stop, observed)
    ) {
      signals.push(
        `${Math.floor((Math.min(stop, observed) - start) / 86400000)} days between delivery dates and observation; continuous delivery is unverified`,
      );
    }
    const key = textKey(ref);
    const repeats = key
      ? unique.filter((other) => textKey(other) === key).length
      : 0;
    if (repeats > 1)
      signals.push(
        `Same text in ${repeats} distinct references in this sample`,
      );
    if (ref.source === "manual")
      signals.push("Manually supplied observation; not independently verified");
    return { ...ref, signals };
  });
}
