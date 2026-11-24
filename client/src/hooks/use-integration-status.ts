"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { businessProfileAccountId, selectedBusinessProfileId, subscribeBusinessProfile } from "@/lib/business-profile";

/** Brief, memory-only reuse for navigation; mutations still force a fresh read. */
export function useIntegrationStatus<T>(endpoint: string) {
  const accountId = useSyncExternalStore(subscribeBusinessProfile, businessProfileAccountId, () => null);
  const businessId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  return useQuery<T, Error>({
    queryKey: ["integration-status", accountId, businessId, endpoint],
    queryFn: ({ signal }) => api.get<T>(endpoint, { signal, timeoutMs: 12_000 }),
    enabled: accountId !== null && businessId !== null,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}
