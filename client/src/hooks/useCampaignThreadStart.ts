import { useCallback, useRef } from 'react';
import api from '@/lib/api';

/** Create one durable conversation before its first explicit agent action. */
export function useCampaignThreadStart({ currentThreadIdRef, pendingNewThreadRef, navigationVersionRef, businessProfileId, onCreated }: {
  currentThreadIdRef: { current: number | null };
  pendingNewThreadRef: { current: boolean };
  navigationVersionRef: { current: number };
  businessProfileId?: string;
  onCreated: (id: number) => void;
}) {
  const creation = useRef<Promise<number> | null>(null);
  return useCallback(async () => {
    if (currentThreadIdRef.current) return currentThreadIdRef.current;
    if (creation.current) return creation.current;
    if (pendingNewThreadRef.current) throw new Error('Your conversation is starting. Wait for it to open before starting an agent.');
    const version = navigationVersionRef.current;
    const request = (async () => {
      const thread = await api.post<{ id: number }>('/api/chat/threads', {
        title: 'New campaign',
        ...(businessProfileId ? { businessProfileId: Number(businessProfileId) } : {}),
      });
      if (!Number.isSafeInteger(thread?.id) || thread.id <= 0) throw new Error('The conversation could not be created. Please retry.');
      if (navigationVersionRef.current !== version || currentThreadIdRef.current !== null) throw new Error('The conversation changed while the agent was starting. Start it from the current conversation.');
      currentThreadIdRef.current = thread.id;
      onCreated(thread.id);
      return thread.id;
    })();
    creation.current = request;
    try { return await request; }
    finally { if (creation.current === request) creation.current = null; }
  }, [currentThreadIdRef, pendingNewThreadRef, navigationVersionRef, businessProfileId, onCreated]);
}
