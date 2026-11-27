"use client";

import { useContext } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { selectedBusinessProfileId } from "@/lib/business-profile";
import type { BusinessProfileSummary } from "@/hooks/use-business-profiles";

/**
 * The selected business's name for post previews, read from the business
 * profile list the dashboard already loaded. It never fetches and works
 * outside the app providers, so previews fall back to a generic label.
 */
export function useCachedBrandName(fallback = "Your Brand"): string {
  const client = useContext(QueryClientContext);
  if (!client) return fallback;
  const profiles = client
    .getQueriesData<BusinessProfileSummary[]>({ queryKey: ["business-profiles"] })
    .flatMap(([, data]) => (Array.isArray(data) ? data : []))
    .filter((profile) => !profile.archivedAt);
  const selectedId = selectedBusinessProfileId();
  const profile = profiles.find((item) => item.id === selectedId)
    ?? profiles.find((item) => item.isDefault)
    ?? profiles[0];
  const name = profile?.companyName?.trim() || profile?.businessName?.trim() || profile?.name?.trim();
  return name || fallback;
}

export function brandInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "Y";
}
