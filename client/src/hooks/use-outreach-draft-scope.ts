"use client";

import { useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';

/** Remount private forms immediately when the actor or selected business changes. */
export function useOutreachDraftScope() {
  const { user } = useAuth();
  const businessId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  return `${user?.id ?? 'anonymous'}:${businessId ?? 'unselected'}`;
}
