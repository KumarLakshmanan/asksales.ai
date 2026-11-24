"use client";

import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { selectedBusinessProfileId } from '@/lib/business-profile';
import { useCreatorScope } from '@/components/content-studio/CreatorScope';

interface BrandToolkitSummary {
  id: number;
  name?: string;
  brandName?: string;
  isDefault?: boolean;
  isActive?: boolean;
  isApproved?: boolean;
  website?: string;
  logoUrl?: string | null;
  logoUrls?: string[] | null;
  logoVisibility?: boolean | null;
}

interface BusinessProfileSummary {
  id: number;
  name?: string;
  companyName?: string;
  isDefault?: boolean;
  isApproved?: boolean;
  website?: string;
}

function selectPreferred<T extends { isDefault?: boolean; isApproved?: boolean }>(items: T[]): T | null {
  return (
    items.find((item) => item.isDefault && item.isApproved !== false) ??
    items.find((item) => item.isApproved) ??
    items.find((item) => item.isDefault) ??
    null
  );
}

/**
 * Resolves identifiers only. The server remains authoritative for tenant
 * ownership and expands these IDs into the full, snapshotted brand context.
 */
export function useContentBrandContext() {
  const scope = useCreatorScope();
  const selectedProfileId = scope.businessProfileId || selectedBusinessProfileId();
  const query = useQuery({
    queryKey: ["content-generation-brand-context", selectedProfileId, scope.brandToolkitId],
    queryFn: async () => {
      const [toolkits, profiles] = await Promise.all([
        api.get<BrandToolkitSummary[]>("/api/content/brand-toolkits"),
        api.get<BusinessProfileSummary[]>("/api/settings/business-profiles"),
      ]);

      const activeToolkits = (Array.isArray(toolkits) ? toolkits : []).filter((item) => item.isActive !== false);
      const availableProfiles = Array.isArray(profiles) ? profiles : [];
      const toolkit = scope.brandToolkitId ? activeToolkits.find(item => item.id === scope.brandToolkitId) || null : selectPreferred(activeToolkits);
      const businessProfile = selectedProfileId ? availableProfiles.find(item => item.id === selectedProfileId) || null : selectPreferred(availableProfiles);

      return { toolkit, businessProfile };
    },
    staleTime: 60_000,
  });

  const toolkit = query.data?.toolkit ?? null;
  const businessProfile = query.data?.businessProfile ?? null;

  return {
    ...query,
    toolkit,
    businessProfile,
    brandToolkitId: toolkit?.id,
    businessProfileId: businessProfile?.id,
    isReady: Boolean(toolkit && businessProfile && toolkit.isApproved !== false && businessProfile.isApproved !== false),
    missingMessage: !businessProfile
      ? "Create or select a default business profile before generating content."
      : !toolkit
        ? "Create or select an active Brand Toolkit before generating content."
        : businessProfile.isApproved === false || toolkit.isApproved === false
          ? "Review and approve the business profile and Brand Toolkit before generation."
          : null,
  };
}
