import { z } from "zod";
import type {
  CreativeReference,
  ResearchStatus,
} from "../../../../shared/adCreativeIntelligence.js";
import { normalizeLibraryAd, addResearchSignals } from "./researchSignals.js";
import { logger } from "../../../utils/logger.js";
export const COMMERCIAL_LIBRARY_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "GB",
];
const envelopeSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  error: z.object({ code: z.number().optional(), error_subcode: z.number().optional() }).optional(),
  paging: z
    .object({
      next: z.string().optional(),
      cursors: z.object({ after: z.string().max(4096).optional() }).optional(),
    })
    .optional(),
});
export interface LibraryResult {
  status: ResearchStatus;
  references: CreativeReference[];
  message: string;
}
export async function fetchLibraryResearch(
  input: {
    query: string;
    country: string;
    accessToken: string;
    version: string;
    pageId?: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<LibraryResult> {
  if (!COMMERCIAL_LIBRARY_COUNTRIES.includes(input.country))
    return {
      status: "coverage_unavailable",
      references: [],
      message:
        "Commercial API research is available here for UK/EU delivery only. Add manual competitor references for this market.",
    };
  if (!/^v\d+\.\d+$/.test(input.version))
    return {
      status: "provider_error",
      references: [],
      message: "The configured Meta API version is invalid.",
    };
  const references: CreativeReference[] = [];
  let cursor: string | undefined;
  const observedAt = new Date().toISOString();
  try {
    for (let page = 0; page < 3; page++) {
      const url = new URL(
        `https://graph.facebook.com/${input.version}/ads_archive`,
      );
      url.search = new URLSearchParams({
        ...(input.pageId ? { search_page_ids: JSON.stringify([input.pageId]) } : { search_terms: input.query }),
        ad_type: "ALL",
        ad_active_status: "ACTIVE",
        ad_reached_countries: JSON.stringify([input.country]),
        limit: "50",
        fields: [
          "id", "page_id", "page_name", "ad_creative_bodies", "ad_creative_link_titles",
          "ad_creative_link_descriptions", "ad_creative_link_captions",
          "ad_delivery_start_time", "ad_delivery_stop_time", "publisher_platforms",
          ...(input.country === "GB" ? [] : ["eu_total_reach"]),
        ].join(","),
        ...(cursor ? { after: cursor } : {}),
      }).toString();
      const response = await fetcher(url, {
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      const body = envelopeSchema.parse(await response.json());
      if (!response.ok || body.error) {
        const code = body.error?.code;
        const subcode = body.error?.error_subcode;
        logger.warn({ httpStatus: response.status, code, subcode, country: input.country }, "[CreativeIntelligence] Meta Ads Library request rejected");
        const permission =
          code === 190 || [10, 200, 294].includes(Number(code)) ||
          (code == null && [401, 403].includes(response.status));
        const reason = code === 190
          ? "The Meta access token expired or is invalid. Reconnect Meta Ads, then try again."
          : permission
            ? "Meta denied Ad Library API access for this connection. Complete Meta's Ad Library API authorization for the connected app and account, then reconnect."
            : "Meta rejected the Ad Library request. Check the server's Meta Ads Library rejection log for its HTTP status and error code.";
        return {
          status: references.length
            ? "partial"
            : permission
              ? "permission_required"
              : "provider_error",
          references: addResearchSignals(references),
          message: `${reason} ${code != null ? `Meta error ${code}${subcode != null ? `/${subcode}` : ""}.` : `HTTP ${response.status}.`}`,
        };
      }
      if (!Array.isArray(body.data)) throw new Error("Invalid library payload");
      for (const raw of body.data) {
        const ref =
          raw && typeof raw === "object"
            ? normalizeLibraryAd(raw, observedAt)
            : null;
        if (ref && (!input.pageId || ref.pageId === input.pageId)) references.push(ref);
      }
      const next = body.paging?.next;
      cursor =
        typeof body.paging?.cursors?.after === "string"
          ? body.paging.cursors.after
          : undefined;
      if (!next)
        return {
          status: references.length ? "succeeded" : "empty",
          references: addResearchSignals(references),
          message:
            "Research sample only. Competitor CTR, leads, CPA and ROAS are unknown.",
        };
      if (!cursor || page === 2) break;
    }
    return {
      status: "partial",
      references: addResearchSignals(references),
      message:
        "Showing a bounded sample (up to 150 ads); more results may exist. Competitor outcomes are unknown.",
    };
  } catch {
    return {
      status: references.length ? "partial" : "provider_error",
      references: addResearchSignals(references),
      message:
        "Meta research timed out or returned an invalid response. Retry or use manual references.",
    };
  }
}
