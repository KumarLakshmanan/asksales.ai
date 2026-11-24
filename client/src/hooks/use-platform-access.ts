"use client";

import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { ApiError } from "@/lib/api-client";
import type { PlatformAccessResponse } from "@/lib/platform-access";

function isRetryableAccessError(error: unknown) {
  return !(error instanceof ApiError) || error.status === 0 || error.status === undefined || error.status >= 500;
}

export function usePlatformAccess(enabled = true) {
  return useQuery({
    queryKey: ["platform-access"],
    queryFn: () => api.get<PlatformAccessResponse>("/api/platform/access"),
    enabled,
    staleTime: 30_000,
    retry: (failureCount, error) => isRetryableAccessError(error) && failureCount < 4,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
    // If the API restarts after the initial retry window, recover the
    // dashboard automatically instead of leaving the user on a stale error.
    refetchInterval: (query) => query.state.status === "error" ? 5_000 : false,
  });
}
