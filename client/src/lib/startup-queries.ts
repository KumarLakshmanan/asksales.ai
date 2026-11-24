import api from "@/lib/api";
import type { QueryClient } from "@tanstack/react-query";
import type { PlatformAccessResponse } from "@/lib/platform-access";
import type { BusinessProfileSummary } from "@/hooks/use-business-profiles";

/**
 * The two reads every main dashboard page waits on after sign-in: which
 * modules the plan includes, and the business profiles. Shared by their hooks
 * and by the sign-in check, which starts them early (prefetchDashboardGates).
 */
export const PLATFORM_ACCESS_QUERY_KEY = ["platform-access"] as const;
export const PLATFORM_ACCESS_STALE_MS = 30_000;
export const businessProfilesQueryKey = (userId: number | undefined) => ["business-profiles", userId] as const;
export const BUSINESS_PROFILES_STALE_MS = 30_000;

type ReadOptions = { suppressUnauthorizedEvent?: boolean };
export const fetchPlatformAccess = (options?: ReadOptions) =>
  api.get<PlatformAccessResponse>("/api/platform/access", options);
export const fetchBusinessProfiles = (options?: ReadOptions) =>
  api.get<BusinessProfileSummary[]>("/api/settings/business-profiles", options);

/**
 * Starts the dashboard's access and business-profile reads at the same time
 * as the sign-in check, for the account this browser last signed in as.
 * Without this, a page waited for sign-in, then access, then the profiles, then
 * its own data: four round trips in a row.
 *
 * Nothing here decides access. The results only sit in the query cache, and
 * the hooks read them after the sign-in check confirms the same account; a
 * different account clears the cache. A failure does not sign anyone out and
 * leaves no error behind: the entry is reset, so the hook fetches it again
 * with its own retries instead of showing an error it never saw happen.
 */
export function prefetchDashboardGates(queryClient: QueryClient, cachedUserId: number): void {
  const speculative = { suppressUnauthorizedEvent: true };
  const early = (queryKey: readonly unknown[], queryFn: () => Promise<unknown>, staleTime: number) => {
    void queryClient.fetchQuery({ queryKey, queryFn, staleTime, retry: false })
      .catch(() => queryClient.resetQueries({ queryKey, exact: true }));
  };
  early(PLATFORM_ACCESS_QUERY_KEY, () => fetchPlatformAccess(speculative), PLATFORM_ACCESS_STALE_MS);
  early(businessProfilesQueryKey(cachedUserId), () => fetchBusinessProfiles(speculative), BUSINESS_PROFILES_STALE_MS);
}
