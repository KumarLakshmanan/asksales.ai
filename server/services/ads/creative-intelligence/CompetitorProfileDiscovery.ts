import { sql } from "drizzle-orm";
import { requireBusinessScope } from "../../../tenancy/businessContext.js";
import { db } from "../../../models/db.js";
import { CreativeIntelligenceError } from "./contracts.js";
import { asCreativeReferences, publicLibraryUrl, searchPublicMetaAds } from "./PublicMetaAdLibraryService.js";
import type { CreativeReference } from "../../../../shared/adCreativeIntelligence.js";

export interface DiscoveredAdProfile {
  pageId: string;
  pageName: string;
  sampleAdCount: number;
  matchedTerms: string[];
  libraryUrl: string;
}

const clean = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

export function businessSearchTerms(profile: Record<string, unknown>): string[] {
  const ownName = clean(profile.company_name || profile.business_name).toLowerCase();
  return [...new Set([
    profile.sub_industry,
    profile.business_category,
    profile.industry,
    profile.target_market,
  ].map(clean).filter((term) => term.length >= 3 && term.length <= 100 && term.toLowerCase() !== ownName))].slice(0, 3);
}

export function groupAdProfiles(samples: Array<{ term: string; references: CreativeReference[] }>, ownName: string, ownPageId: string): DiscoveredAdProfile[] {
  const profiles = new Map<string, { name: string; ids: Set<string>; terms: Set<string> }>();
  for (const sample of samples) for (const ref of sample.references) {
    if (!ref.pageId || ref.pageId === ownPageId || ref.pageName.trim().toLowerCase() === ownName.trim().toLowerCase()) continue;
    const current = profiles.get(ref.pageId) || { name: ref.pageName, ids: new Set<string>(), terms: new Set<string>() };
    current.ids.add(ref.id);
    current.terms.add(sample.term);
    profiles.set(ref.pageId, current);
  }
  return [...profiles.entries()].map(([pageId, value]) => ({
    pageId,
    pageName: value.name,
    sampleAdCount: value.ids.size,
    matchedTerms: [...value.terms],
    libraryUrl: `https://www.facebook.com/ads/library/?search_type=page&view_all_page_id=${pageId}`,
  })).sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || b.sampleAdCount - a.sampleAdCount).slice(0, 20);
}

async function approvedBusinessProfile(userId: number) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) {
    throw new CreativeIntelligenceError(403, "Select an authorized business profile.");
  }
  const business = await db.execute(sql`
    SELECT company_name,business_name,industry,sub_industry,business_category,target_market
    FROM company_settings
    WHERE user_id=${userId} AND id=${scope.businessProfileId} AND is_approved=TRUE
    LIMIT 1
  `);
  return business.rows[0] as Record<string, unknown> | undefined;
}

export async function discoverCompetitorProfiles(userId: number) {
  const profile = await approvedBusinessProfile(userId);
  const terms = profile ? businessSearchTerms(profile) : [];
  if (!terms.length) return { status: "business_details_required", profiles: [], message: "Add an industry, business category or target market to your selected business profile to discover matching advertisers." };
  const profiles = new Map<string, { pageName: string; ids: Set<string>; terms: Set<string> }>();
  let failed = false;
  let failureMessage = "";
  for (const term of terms) {
    const result = await searchPublicMetaAds(term);
    if (result.status === "provider_error") { failed = true; failureMessage = result.message; break; }
    for (const ad of result.ads) {
      const name = clean(ad.pageName);
      if (!name || name.toLowerCase() === clean(profile?.company_name || profile?.business_name).toLowerCase()) continue;
      const key = name.toLowerCase();
      const entry = profiles.get(key) || { pageName: name, ids: new Set<string>(), terms: new Set<string>() };
      entry.ids.add(ad.id);
      entry.terms.add(term);
      profiles.set(key, entry);
    }
  }
  const candidates = [...profiles.values()].map((entry) => ({ pageName: entry.pageName, sampleAdCount: entry.ids.size, matchedTerms: [...entry.terms], libraryUrl: publicLibraryUrl(entry.pageName) })).sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || b.sampleAdCount - a.sampleAdCount).slice(0, 20);
  return { status: failed ? candidates.length ? "partial" : "provider_error" : candidates.length ? "succeeded" : "empty", profiles: candidates, message: failed ? `${failureMessage} Candidate results may be incomplete.` : candidates.length ? "Public ads matched your business profile. Review each advertiser to confirm it is a competitor." : "No advertiser profiles appeared in the public India search sample." };
}

export async function getCompetitorProfileAds(userId: number, pageName: string) {
  const profile = await approvedBusinessProfile(userId);
  const ownName = clean(profile?.company_name || profile?.business_name);
  if (ownName && ownName.toLowerCase() === pageName.toLowerCase()) return { status: "empty", references: [], message: "Choose an advertiser other than your own business." };
  const result = await searchPublicMetaAds(pageName);
  const matched = result.ads.filter((ad) => ad.pageName.trim().toLowerCase() === pageName.trim().toLowerCase());
  return { status: result.status, references: asCreativeReferences(matched), message: result.status === "provider_error" ? result.message : "Showing public ads whose displayed advertiser name matches this candidate. This does not verify Page identity or campaign outcomes." };
}
