"use client";
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import type { SubscriptionPlan } from '../../../shared/subscriptions';
export type PricingCatalog = { version: number; currency: 'INR'; taxInclusive: true; plans: SubscriptionPlan[] };
export function usePricingCatalog() {
  const { isLoading } = useAuth();
  const query = useQuery({ queryKey: ['subscription-catalog'], queryFn: () => api.get<PricingCatalog>('/api/subscriptions/catalog', { skipAuth: true }), enabled: !isLoading, staleTime: 60_000, retry: 1 });
  return { ...query, isLoading: isLoading || query.isLoading };
}
