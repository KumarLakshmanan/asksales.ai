"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import { ApiError } from "@/lib/api";
import {
  readSupportFilters,
  supportPrivateQueryKeys,
  updateSupportQuery,
  replaceSupportQueryHistory,
  supportDateRangeError,
} from "@/lib/support-report";

export function useSupportWorkspace() {
  const { user } = useAuth();
  const profiles = useBusinessProfiles();
  const profileId = profiles.activeProfile?.id;
  return {
    userId: user?.id,
    profileId,
    profiles,
    ready: Boolean(user?.id && profileId && !profiles.isLoading),
    headers: { [BUSINESS_PROFILE_HEADER]: String(profileId) },
  };
}
export function supportQueryRetry(count: number, error: Error): boolean {
  return (
    count < 1 &&
    !(
      error instanceof ApiError &&
      error.status &&
      error.status >= 400 &&
      error.status < 500
    )
  );
}
export function useDebouncedSupportValue(value: string, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
export function useSupportQueryState(scope: string) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const search = searchParams.toString();
  const [localSearch, setLocalSearch] = useState(search);
  useEffect(() => { setLocalSearch(search); }, [search]);
  const query = new URLSearchParams(localSearch);
  const [previousScope, setPreviousScope] = useState(scope);
  const scopeChanged = Boolean(
    scope && previousScope && previousScope !== scope,
  );
  if (scopeChanged)
    for (const key of supportPrivateQueryKeys) query.delete(key);
  const update = useCallback(
    (changes: Record<string, string | number | null>) => {
      // History changes synchronously, so quick edits merge against the latest
      // URL rather than an intermediate useSearchParams render.
      const current = new URLSearchParams(window.location.search);
      if (('from' in changes || 'to' in changes) && !current.has('from') && !current.has('to')) {
        const defaults = readSupportFilters(current);
        current.set('from', defaults.from);
        current.set('to', defaults.to);
      }
      const next = updateSupportQuery(current, changes);
      replaceSupportQueryHistory(
        `${next.size ? `${pathname}?${next}` : pathname}${window.location.hash}`,
      );
      setLocalSearch(next.toString());
    },
    [pathname],
  );
  useEffect(() => {
    if (scopeChanged) {
      const cleaned = new URLSearchParams(searchParams.toString());
      for (const key of supportPrivateQueryKeys) cleaned.delete(key);
      if (cleaned.toString() === searchParams.toString())
        setPreviousScope(scope);
      else
        update(
          Object.fromEntries(supportPrivateQueryKeys.map((key) => [key, null])),
        );
    } else if (scope && previousScope !== scope) setPreviousScope(scope);
  }, [scope, scopeChanged, previousScope, update, searchParams]);
  return { query, filters: readSupportFilters(query), validationError: supportDateRangeError(query), update };
}
