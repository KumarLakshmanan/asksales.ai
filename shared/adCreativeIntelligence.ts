/** Saved competitor observations are research evidence, never performance metrics. */
export interface CreativeReference {
  id: string;
  source: "manual" | "meta_library";
  pageName: string;
  pageId?: string | null;
  estimatedEuReach?: number | null;
  url: string | null;
  bodies: string[];
  titles: string[];
  descriptions: string[];
  captions: string[];
  platforms: string[];
  format: "image" | "video" | "carousel" | "unknown";
  notes: string;
  observedAt: string;
  startDate: string | null;
  endDate: string | null;
  signals: string[];
  /** Public counts only when explicitly shown alongside the ad; null means unavailable. */
  engagement?: { likes: number | null; comments: number | null; shares: number | null };
}
export type ResearchStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "empty"
  | "coverage_unavailable"
  | "permission_required"
  | "provider_error"
  | "failed";
export interface CreativeResearch {
  id: number;
  status: ResearchStatus;
  references: CreativeReference[];
  message: string | null;
  created_at: string;
  expires_at: string | null;
}
export interface CreativeConcept {
  id: string;
  title: string;
  format: "image" | "video" | "carousel" | "text";
  hook: string;
  headline: string;
  copyDirection: string;
  visualDirection: string;
  scenes: string[];
  ctaText: string;
  ctaType:
    | "learn_more"
    | "shop_now"
    | "sign_up"
    | "book_now"
    | "contact_us"
    | "download";
  rationale: string;
  evidenceIds: string[];
  uncertainty: string;
  testVariable: string;
  requiredAssets: string[];
}
export interface CreativeBrief {
  id: number;
  status: "queued" | "running" | "ready" | "failed";
  input: {
    businessFacts: string;
    audience: string;
    objective:
      | "awareness"
      | "traffic"
      | "engagement"
      | "leads"
      | "sales"
      | "app_installs";
    language: string;
    country: string;
    landingUrl?: string;
    constraints: string;
    researchRunIds: number[];
    campaignId?: number;
  };
  evidence: CreativeReference[];
  concepts: CreativeConcept[];
  selected_concept_id: string | null;
  revision: number;
  message: string | null;
  created_at: string;
}
export interface CreativeBriefProvenance {
  creative_brief_id?: number;
  creative_brief_revision?: number;
  creative_concept_id?: string;
}

export function creativeTestMetric(
  objective: CreativeBrief["input"]["objective"],
): string {
  return {
    leads:
      "Measured cost per lead; assess lead quality separately when available",
    sales: "Measured cost per purchase and return on ad spend",
    traffic: "Cost per landing-page visit, with CTR as a diagnostic",
    awareness: "Reach and cost per thousand impressions",
    engagement: "Cost per measured engagement",
    app_installs: "Cost per measured install",
  }[objective];
}
