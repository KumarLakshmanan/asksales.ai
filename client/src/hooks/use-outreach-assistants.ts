"use client";

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useBusinessProfiles } from '@/hooks/use-business-profiles';
import { BUSINESS_PROFILE_HEADER } from '@/lib/business-profile';
import api from '@/lib/api';
import type { AssistantCatalog, OutreachAssistant } from '@/lib/outreach-assistants';

export const ASSISTANT_API = '/api/settings/outreach/assistants';
export function useAssistantWorkspace() {
  const { user } = useAuth();
  const profiles = useBusinessProfiles();
  const profileId = profiles.activeProfile?.id;
  const scopeKey = ['outreach-assistants', user?.id, profileId] as const;
  const requestOptions = { headers: { [BUSINESS_PROFILE_HEADER]: String(profileId) } };
  const catalog = useQuery({
    queryKey: [...scopeKey, 'catalog'],
    queryFn: () => api.get<AssistantCatalog>(`${ASSISTANT_API}/catalog`, requestOptions),
    enabled: !!profileId && !profiles.isLoading,
    retry: 1,
    staleTime: 30_000,
  });
  return { profiles, profileId, scopeKey, requestOptions, catalog };
}
export function useAssistantList(workspace: ReturnType<typeof useAssistantWorkspace>, filters: { search?: string; state?: string } = {}) {
  const query = useInfiniteQuery({
    queryKey: [...workspace.scopeKey, 'list', filters.search || '', filters.state || 'all'],
    initialPageParam: null as string | null,
    queryFn: ({pageParam}) => {
      const params = new URLSearchParams({limit:'24',search:filters.search || '',state:filters.state || 'all'});
      if (pageParam) params.set('cursor',pageParam);
      return api.get<{ assistants: OutreachAssistant[]; runtimeEnabled: boolean; nextCursor?: string | null }>(`${ASSISTANT_API}?${params}`,workspace.requestOptions);
    },
    getNextPageParam: last => last.nextCursor || undefined,
    enabled: !!workspace.profileId && !workspace.profiles.isLoading,
    retry: 1,
    staleTime: 15_000,
  });
  return { ...query, data: query.data ? { assistants: query.data.pages.flatMap(page => page.assistants), runtimeEnabled: query.data.pages[0].runtimeEnabled, nextCursor:query.data.pages.at(-1)?.nextCursor || null } : undefined };
}
export function useAssistantDetail(workspace: ReturnType<typeof useAssistantWorkspace>, assistantId: string) {
  return useQuery({
    queryKey: [...workspace.scopeKey, assistantId],
    queryFn: () => api.get<OutreachAssistant>(`${ASSISTANT_API}/${encodeURIComponent(assistantId)}`, workspace.requestOptions),
    enabled: !!workspace.profileId && !!assistantId && !workspace.profiles.isLoading,
    retry: 1,
  });
}
