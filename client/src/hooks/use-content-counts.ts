"use client";

import { useCallback, useContext, useEffect } from 'react';
import { QueryClientContext, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useCreatorScope } from '@/components/content-studio/CreatorScope';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { tabToApiType } from '@/components/content-library/types';

export const contentCountsKey = (threadId?: number) => ['content-assets-counts', threadId ?? 'all'] as const;

export function useContentCounts(threadId?: number, enabled = true) {
  const queryClient = useQueryClient();
  const { subscribe } = useWebSocket();
  const query = useQuery({
    queryKey: contentCountsKey(threadId),
    queryFn: () => api.get<Record<string, number>>(`/api/content/assets/counts${threadId ? `?threadId=${threadId}` : ''}`),
    enabled,
    staleTime: 30_000,
  });
  useEffect(() => subscribe('content_asset_updated', () => {
    void queryClient.invalidateQueries({ queryKey: ['content-assets-counts'] }, { cancelRefetch: false });
  }), [subscribe, queryClient]);
  const counts: Record<string, number> = {};
  if (query.data) {
    for (const [tab, type] of Object.entries(tabToApiType)) counts[tab] = query.data[type] || 0;
    counts.all = Object.values(counts).reduce((sum, count) => sum + count, 0);
  }
  return { ...query, counts };
}

/** Invalidate after a confirmed save/delete; no speculative transaction timers. */
export function useRefreshContentLibrary() {
  // Manual composers also work in isolated previews with no query provider.
  const client = useContext(QueryClientContext);
  const { onContentCreated } = useCreatorScope();
  return useCallback(() => {
    onContentCreated?.();
    void client?.invalidateQueries({ queryKey: ['content-assets-counts'] }, { cancelRefetch: false });
    void client?.invalidateQueries({ queryKey: ['content-assets'] }, { cancelRefetch: false });
  }, [client, onContentCreated]);
}
