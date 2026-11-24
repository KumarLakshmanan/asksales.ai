"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { gateQueryRetry, gateQueryRetryDelay } from "@/lib/queryRetry";
import { BUSINESS_PROFILES_STALE_MS, businessProfilesQueryKey, fetchBusinessProfiles } from "@/lib/startup-queries";
import { businessProfileAccountId, selectedBusinessProfileId, selectBusinessProfile, subscribeBusinessProfile, openBusinessDashboard } from '@/lib/business-profile';

export interface BusinessProfileSummary {
  id: number;
  name?: string | null;
  companyName?: string | null;
  businessName?: string | null;
  industry?: string | null;
  isDefault?: boolean | null;
  role?: 'owner' | 'billing_admin' | 'member';
  canManageTeam?: boolean;
  canManageBilling?: boolean;
  billingOrganizationId?: number;
  description?: string | null;
  createdAt?: string;
  archivedAt?: string | null;
  version?: number;
  setupComplete?: boolean;
  ownerApproved?: boolean;
  brandToolkitCompleted?: boolean;
  workspaceType?: string;
}

export function businessProfileName(profile: BusinessProfileSummary): string {
  return profile.companyName?.trim() || profile.businessName?.trim() || profile.name?.trim() || `Business profile ${profile.id}`;
}

let switchingBusiness = false;

export function useBusinessProfiles() {
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading, error: authError } = useAuth();
  const storedAccountId = useSyncExternalStore(subscribeBusinessProfile, businessProfileAccountId, () => null);
  const selectedId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const sessionReady = !!user && !authLoading && !authError && storedAccountId === user.id;
  const [isSwitching, setIsSwitching] = useState(false);
  const query = useQuery({
    queryKey: businessProfilesQueryKey(user?.id),
    queryFn: () => fetchBusinessProfiles(),
    enabled: sessionReady,
    staleTime: BUSINESS_PROFILES_STALE_MS,
    // Every main dashboard page waits on this list. Ride out a short server
    // outage, and recover by itself if the error screen does appear.
    retry: gateQueryRetry,
    retryDelay: gateQueryRetryDelay,
    refetchInterval: (current) => current.state.status === "error" ? 5_000 : false,
  });
  // Disabled queries can still return cached data. Never use it to select a
  // workspace while the account is being verified or has changed in storage.
  const profiles = sessionReady && Array.isArray(query.data) ? query.data.filter(profile => !profile.archivedAt) : [];
  const activeProfile = profiles.find((profile) => profile.id === selectedId)
    ?? profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
  useEffect(() => {
    if (sessionReady && businessProfileAccountId() === user?.id && activeProfile && selectedId !== activeProfile.id) selectBusinessProfile(activeProfile.id);
  }, [sessionReady, user?.id, activeProfile, selectedId]);

  const switchProfile = async (id: number) => {
    const assertCurrentAccount = () => {
      if (!sessionReady || businessProfileAccountId() !== user?.id) throw new Error('Verify your session before switching business profiles.');
    };
    assertCurrentAccount();
    if (!profiles.some((profile) => profile.id === id)) {
      throw new Error("This business profile is no longer available. Refresh the list and try again.");
    }
    if (switchingBusiness) return;
    switchingBusiness = true;

    setIsSwitching(true);
    try {
      // Verify the profile still exists before changing the tab's selection.
      const verified = await api.get<BusinessProfileSummary>(`/api/settings/business-profiles/${id}`);
      assertCurrentAccount();
      if (verified.archivedAt) throw new Error("This workspace was archived. Refresh the list to restore it or choose another profile.");
      await queryClient.cancelQueries();
      assertCurrentAccount();
      selectBusinessProfile(id);
      queryClient.clear();
      openBusinessDashboard();
    } finally {
      switchingBusiness = false;
      setIsSwitching(false);
    }
  };

  const setDefaultProfile = async (id: number) => {
    await api.post(`/api/settings/business-profiles/${id}/default`, {});
    await queryClient.invalidateQueries({ queryKey: ['business-profiles'] });
  };
  return { ...query, data: sessionReady ? query.data : undefined, isLoading: authLoading || query.isLoading || Boolean(user && !authError && !sessionReady) || Boolean(activeProfile && selectedId !== activeProfile.id), profiles, activeProfile, isSwitching, switchProfile, setDefaultProfile };
}
