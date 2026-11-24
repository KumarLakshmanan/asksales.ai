"use client";
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useBillingApi } from './use-billing-api';
import { useBillingOrganizations } from './use-billing-organizations';
import type { SubscriptionState } from '../../../shared/subscriptions';

export function useSubscription() {
  const { user, isLoading } = useAuth();
  const organizations = useBillingOrganizations();
  const api = useBillingApi();
  return useQuery({ queryKey: ['subscription', user?.id, organizations.billingScopeKey], queryFn: () => api.get<SubscriptionState>('/api/subscriptions/current'),
    enabled: !!user && !isLoading && organizations.ready, staleTime: 15000, retry: 1 });
}
