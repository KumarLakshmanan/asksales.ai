"use client";

import { useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { useCrmAutomationRefresh } from '@/hooks/use-crm-automation-refresh';
import { historyQuery, type Contact, type CrmActivity, type CrmHistoryFilters, type CrmHistoryTab,
  type CrmPagination, type CrmTimelineItem, type CrmWorkspaceSummary, type OutreachConversation,
  type SentMessage, type SupportTicket } from '@/lib/crm-workspace';

interface HistoryResult {
  conversations?: OutreachConversation[];
  sentMessages?: SentMessage[];
  tickets?: SupportTicket[];
  data?: CrmActivity[] | CrmTimelineItem[];
  pagination?: CrmPagination;
  sentPagination?: CrmPagination;
}

/** Each business/contact/section has its own cancellable cache. Hidden tabs never fetch. */
export function useContactWorkspace(contactId: number, tab: CrmHistoryTab, filters: CrmHistoryFilters) {
  const { user } = useAuth();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const client = useQueryClient();
  const base = ['crm-contact-workspace', user?.id ?? null, profileId, contactId] as const;
  const enabled = !!user && Number.isSafeInteger(contactId) && contactId !== 0;
  const contact = useQuery({
    queryKey: [...base, 'contact'],
    queryFn: ({ signal }) => api.get<Contact>(`/api/crm/contacts/${contactId}`, { signal }),
    enabled, staleTime: 30_000, retry: false,
  });
  const summary = useQuery({
    queryKey: [...base, 'summary'],
    queryFn: ({ signal }) => api.get<CrmWorkspaceSummary>(`/api/crm/contacts/${contactId}/workspace-summary`, { signal }),
    enabled: enabled && !!contact.data, staleTime: 30_000, retry: false,
  });
  const section = tab === 'sent-messages' ? 'conversations' : tab === 'activity' ? 'activities' : tab;
  const history = useQuery({
    queryKey: [...base, 'history', tab, filters],
    queryFn: ({ signal }) => api.get<HistoryResult | CrmActivity[] | CrmTimelineItem[]>(
      `/api/crm/contacts/${contactId}/${section}?${historyQuery(filters, tab)}`, { signal }),
    enabled: enabled && !!contact.data, staleTime: 30_000, retry: false,
  });
  const refresh = () => client.invalidateQueries({ queryKey: base });
  useCrmAutomationRefresh(refresh);
  const result = Array.isArray(history.data) ? { data: history.data } : history.data;
  const pagination = tab === 'sent-messages' ? result?.sentPagination : result?.pagination;
  return { contact, summary, history, result, pagination, refresh,
    scope: `${user?.id ?? 'anonymous'}:${profileId ?? user?.businessProfileId ?? 'default'}:${contactId}` };
}
