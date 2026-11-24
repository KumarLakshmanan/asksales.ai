"use client";
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import {
  BUSINESS_PROFILE_HEADER,
  selectedBusinessProfileId,
  subscribeBusinessProfile,
} from "@/lib/business-profile";

export type BillingOrganization = {
  id: number;
  businessProfileId: number | null;
  name: string;
  ownerUserId: number;
  defaultForUserId: number | null;
  role: "owner" | "billing_admin" | "member";
  canManageBilling: boolean;
};
export type OrganizationsResponse = {
  organizations: BillingOrganization[];
  invitations: never[];
  selectedOrganizationId: number | null;
};

/** The business profile is the only user-selectable scope. Payer IDs stay internal. */
export function useBillingOrganizations() {
  const { user, isLoading } = useAuth();
  const businessProfileId = useSyncExternalStore(
    subscribeBusinessProfile,
    selectedBusinessProfileId,
    () => null,
  );
  const query = useQuery({
    queryKey: ["billing-organizations", user?.id, businessProfileId],
    queryFn: () =>
      api.get<OrganizationsResponse>("/api/organizations", {
        headers: businessProfileId
          ? { [BUSINESS_PROFILE_HEADER]: String(businessProfileId) }
          : {},
      }),
    enabled: !!user && !isLoading,
    staleTime: 30_000,
    retry: 1,
  });
  const organizations = query.data?.organizations ?? [];
  const organization =
    organizations.find(
      (item) =>
        item.id === query.data?.selectedOrganizationId &&
        (businessProfileId === null ||
          item.businessProfileId === businessProfileId),
    ) ?? null;
  const ready = !!organization && !isLoading && !query.isError;
  return {
    ...query,
    organizations,
    organization,
    organizationId: organization?.id ?? null,
    businessProfileId,
    billingScopeKey: `${user?.id ?? "guest"}:${businessProfileId ?? "setup"}:${organization?.id ?? "loading"}`,
    ready,
    // The billing account cannot be loaded: the request failed, or it
    // succeeded without a business that matches the selected profile. Every
    // gate on `ready` must show an error with Retry (refetch) in this case;
    // otherwise it waits forever.
    unavailable: !ready && !isLoading && (query.isError || (query.isSuccess && !organization)),
  };
}
