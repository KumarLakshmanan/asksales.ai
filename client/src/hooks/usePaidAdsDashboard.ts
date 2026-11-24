"use client";
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { paidAdsPeriod } from '@/lib/paid-ads-filters';

export function paidAdsDashboardQuery(filters: Record<string, string>) {
  const query = new URLSearchParams({ period: paidAdsPeriod(filters), comparison: 'previous_period' });
  for (const key of ['period', 'comparison', 'account', 'platform', 'objective', 'status', 'currency']) {
    if (key !== 'period' && filters[key] && filters[key] !== 'all') query.set(key, filters[key]);
  }
  query.sort();
  return query.toString();
}

export function invalidatePaidAdsReporting(client: ReturnType<typeof useQueryClient>) {
  return client.invalidateQueries({queryKey: ['paid-ads-dashboard'], refetchType: 'none'});
}

/** AuthContext clears QueryClient on identity changes; reporting never lives in a global module cache. */
export function usePaidAdsDashboard<T>(filters: Record<string, string>) {
  const client = useQueryClient();
  const queryString = paidAdsDashboardQuery(filters);
  const query = useQuery<T>({
    queryKey: ['paid-ads-dashboard', queryString],
    queryFn: () => api.get<T>(`/api/campaigns/analytics/dashboard?${queryString}`),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const refresh = async () => {
    await invalidatePaidAdsReporting(client);
    return query.refetch();
  };
  return { ...query, refresh };
}
