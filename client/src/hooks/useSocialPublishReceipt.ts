import { useEffect, useState } from 'react';
import api from '@/lib/api';

export type SocialPublishReceipt = { assetId?: number; scheduled?: boolean; accepted?: boolean; partialSuccess?: boolean; status?: string; results?: Record<string, { assetId?: number; attemptId?: number; status?: string; success?: boolean; error?: string; postUrl?: string }> };

export function useSocialPublishReceipt(initial: SocialPublishReceipt | undefined) {
  const [receipt, setReceipt] = useState(initial);
  useEffect(() => setReceipt(initial), [initial]);
  useEffect(() => {
    if (!receipt?.results || !Object.values(receipt.results).some(entry => ['pending', 'claimed', 'provider_succeeded', 'retryable_failed', 'ambiguous'].includes(entry.status || ''))) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || refreshing) return;
      refreshing = true;
      const ids = [...new Set(Object.values(receipt.results || {}).map(entry => entry.assetId || receipt.assetId).filter(Boolean))];
      const responses = await Promise.allSettled(ids.map(id => api.get<{ attempts: Array<{ id: number; status: string; errorMessage?: string; providerPostUrl?: string }> }>(`/api/content/assets/${id}/publish-attempts`)));
      refreshing = false;
      if (cancelled) return;
      const attempts = responses.flatMap(response => response.status === 'fulfilled' ? response.value.attempts || [] : []);
      setReceipt(current => {
        if (!current?.results) return current;
        const results = Object.fromEntries(Object.entries(current.results).map(([platform, entry]) => {
          const attempt = attempts.find(value => value.id === entry.attemptId);
          return [platform, attempt ? { ...entry, status: attempt.status, success: attempt.status === 'succeeded', error: attempt.errorMessage, postUrl: attempt.providerPostUrl || entry.postUrl } : entry];
        }));
        const entries = Object.values(results);
        const partialSuccess = entries.some(entry => entry.status === 'succeeded') && entries.some(entry => entry.status !== 'succeeded');
        const pending = entries.some(entry => ['pending', 'claimed', 'provider_succeeded', 'retryable_failed'].includes(entry.status || ''));
        return { ...current, results, partialSuccess, scheduled: current.scheduled && entries.every(entry => entry.status === 'pending'), accepted: pending,
          status: partialSuccess ? 'partial_success' : pending ? 'pending' : entries.every(entry => entry.status === 'succeeded') ? 'succeeded' : 'failed' };
      });
    };
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [receipt]);
  return receipt;
}
