"use client";

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { useContentCounts, useRefreshContentLibrary } from '@/hooks/use-content-counts';
import type { BrandToolkit, ContentTabType } from './types';

interface UseContentLibraryOptions { threadId?: number; filterByThread?: boolean; initialTab?: ContentTabType }

export function useContentLibrary({ threadId, filterByThread = false, initialTab = 'all' }: UseContentLibraryOptions = {}) {
  const filterThreadId = filterByThread ? threadId : undefined;
  const [activeTab, setActiveTab] = useState<ContentTabType>(initialTab);
  const counts = useContentCounts(filterThreadId);
  const refreshContent = useRefreshContentLibrary();
  const [refreshKey, setRefreshKey] = useState(0);
  const handleContentCreated = useCallback(() => {
    refreshContent();
    setRefreshKey(value => value + 1);
  }, [refreshContent]);
  const toolkits = useQuery({ queryKey: ['content-brand-toolkits'], queryFn: () => api.get<BrandToolkit[]>('/api/content/brand-toolkits'), staleTime: 60_000 });
  const thread = useQuery({ queryKey: ['content-thread-brand', filterThreadId], queryFn: () => api.get<{ metadata?: { selectedBrandToolkitId?: number } }>(`/api/chat/threads/${filterThreadId}`), enabled: Boolean(filterThreadId), staleTime: 60_000 });
  const available = Array.isArray(toolkits.data) ? toolkits.data : [];
  const selectedId = thread.data?.metadata?.selectedBrandToolkitId;
  const threadToolkit = available.find(item => item.id === selectedId) || null;
  const selectedToolkit = threadToolkit || available.find(item => item.isDefault) || available[0] || null;
  /** 'thread' = brand chosen in this chat; 'default' = no explicit brand, so the default is used. */
  const selectedToolkitSource: 'thread' | 'default' = threadToolkit ? 'thread' : 'default';
  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);
  return {
    activeTab, setActiveTab, filterThreadId, selectedToolkit, selectedToolkitSource, refreshKey,
    contentCounts: counts.counts, loadingCounts: counts.isLoading,
    countsError: counts.isError, loadContentCounts: counts.refetch, handleContentCreated,
  };
}
