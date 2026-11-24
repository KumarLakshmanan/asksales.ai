'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { ASSISTANT_API, type useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import type { AssistantOperationalReport } from '../../../../../shared/assistantOperations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNotice } from './AssistantShared';
import { AssistantAssignmentRows } from './AssistantAssignmentRows';

export function AssistantAssignments({ workspace }: { workspace: ReturnType<typeof useAssistantWorkspace> }) {
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: [...workspace.scopeKey, 'diagnostics'], queryFn: () => api.get<AssistantOperationalReport>(`${ASSISTANT_API}/diagnostics`, workspace.requestOptions), staleTime: 30000, retry: 1 });
  const accounts = query.data?.assignments.filter(item => `${item.label} ${item.channel} ${item.assistantName || ''}`.toLowerCase().includes(search.toLowerCase())).map(item => ({ ...item, state: item.state === 'live' && (!item.connected || !item.runtimeEnabled || !item.revision) ? 'needs_attention' as const : item.state })) || [];
  return <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Account assignments</h2><p className="mt-1 text-sm text-muted-foreground">Each receiving account and surface has one enabled assistant. Connection health and live configuration are shown separately.</p></div><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Checking…' : 'Refresh assignments'}</Button></div><Input aria-label="Search account assignments" value={search} placeholder="Search account, channel or assistant" onChange={e => setSearch(e.target.value)} />{query.isLoading && <p role="status" className="text-sm">Loading account assignments…</p>}{query.isError && <ErrorNotice message={query.error.message} />}<AssistantAssignmentRows accounts={accounts} />{query.data && !accounts.length && <p className="p-4 text-sm text-muted-foreground">{search ? 'No accounts match this search.' : 'No receiving accounts are available in this business.'}</p>}</section>;
}
