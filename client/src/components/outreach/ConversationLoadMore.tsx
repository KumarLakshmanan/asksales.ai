"use client";

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

export interface ConversationLoadMoreProps {
  hasMore?: boolean;
  loading?: boolean;
  error?: string | null;
  onLoadMore?: () => void;
}

/** Observe within the list viewport, not the dashboard/document viewport. */
export function ConversationLoadMore({ hasMore, loading, error, onLoadMore }: ConversationLoadMoreProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasMore || loading || error || !onLoadMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoadMore();
    }, { root: element.closest('[data-radix-scroll-area-viewport]'), rootMargin: '160px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loading, error, onLoadMore]);
  if (!hasMore) return null;
  return <div ref={sentinel} className="p-3 text-center" aria-live="polite">
    {error && <p className="mb-2 text-xs text-destructive" role="alert">{error}</p>}
    <Button variant="ghost" size="sm" disabled={loading} onClick={onLoadMore}>
      {loading ? 'Loading older conversations…' : error ? 'Retry loading conversations' : 'Load more conversations'}
    </Button>
  </div>;
}
