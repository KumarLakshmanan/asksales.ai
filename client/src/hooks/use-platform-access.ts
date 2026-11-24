"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { PLATFORM_ACCESS_QUERY_KEY, PLATFORM_ACCESS_STALE_MS, fetchPlatformAccess } from "@/lib/startup-queries";

function isRetryableAccessError(error: unknown) {
  return !(error instanceof ApiError) || error.status === 0 || error.status === undefined || error.status >= 500;
}

export function usePlatformAccess(enabled = true) {
  return useQuery({
    queryKey: PLATFORM_ACCESS_QUERY_KEY,
    queryFn: () => fetchPlatformAccess(),
    enabled,
    staleTime: PLATFORM_ACCESS_STALE_MS,
    retry: (failureCount, error) => isRetryableAccessError(error) && failureCount < 4,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
    // If the API restarts after the initial retry window, recover the
    // dashboard automatically instead of leaving the user on a stale error.
    refetchInterval: (query) => query.state.status === "error" ? 5_000 : false,
  });
}
