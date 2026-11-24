"use client";

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { FileText, Images } from 'lucide-react';
import api from '@/lib/api';
import { ASSISTANT_API, useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Spinner } from '@/components/ui/spinner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { AssistantBindingInput, AssistantCatalog, AssistantChannel } from '@/lib/outreach-assistants';
import type { AssistantPickerItem, AssistantResourceCategory, AssistantResourcePage } from '../../../../../shared/assistantResourcePicker';

// Where an owner creates and publishes each resource type.
const resourceHomes: Partial<Record<AssistantResourceCategory, { href: string; label: string }>> = {
  knowledge: { href: '/dashboard/knowledge-base', label: 'Open Knowledge base' },
  documents: { href: '/dashboard/knowledge-base/documents', label: 'Open Documents' },
  galleries: { href: '/dashboard/knowledge-base/media', label: 'Open Media galleries' },
  playbooks: { href: '/dashboard/settings/outreach/playbooks', label: 'Open Playbooks' },
};

export function AssistantResourceDrawer({ open, onOpenChange, title, category, selectedIds, onApply, multiple = true, required = false, agentType = '', channels = [], bindings = [] }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; category: AssistantResourceCategory;
  selectedIds: string[]; onApply: (ids: string[], items: AssistantPickerItem[]) => void; multiple?: boolean; required?: boolean;
  agentType?: string; channels?: AssistantChannel[]; bindings?: AssistantBindingInput[];
}) {
  const workspace = useAssistantWorkspace();
  const cache = useQueryClient();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ search: '', page: 1 });
  const [pending, setPending] = useState(selectedIds);
  const [known, setKnown] = useState<Record<string, AssistantPickerItem>>({});
  // Each opening starts a fresh transaction. Cancel and Escape never change the draft.
  useEffect(() => { if (open) { setPending(selectedIds); setSearch(''); setFilters({ search: '', page: 1 }); setKnown({}); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setTimeout(() => setFilters(previous => previous.search === search.trim() ? previous : { search: search.trim(), page: 1 }), 250); return () => window.clearTimeout(timer); }, [search]);
  const channelKey = [...new Set(channels)].sort().join(',');
  const bindingKey = [...new Set(bindings.map(binding => `${binding.channel}:${binding.surface}`))].sort().join(',');
  const query = useQuery({
    queryKey: [...workspace.scopeKey, 'resource-picker', category, agentType, channelKey, bindingKey, filters.search, filters.page],
    queryFn: ({ signal }) => api.get<AssistantResourcePage>(`${ASSISTANT_API}/resources/${category}`, { ...workspace.requestOptions, signal, params: { ...filters, pageSize: 20, agentType, channels: channelKey, bindings: bindingKey } }),
    enabled: open && !!workspace.profileId, staleTime: 0, retry: 1,
  });
  useEffect(() => {
    if (query.data) setKnown(previous => ({ ...previous, ...Object.fromEntries(query.data.items.map(item => [item.id, item])) }));
  }, [query.data]);
  const toggle = (item: AssistantPickerItem) => {
    setKnown(previous => ({ ...previous, [item.id]: item }));
    setPending(previous => previous.includes(item.id) ? previous.filter(id => id !== item.id) : multiple ? [...previous, item.id] : [item.id]);
  };
  const apply = () => {
    if (!workspace.catalog.data?.permissions.canManage || query.isFetching || query.isError || (required && !pending.length)) return;
    const items = Object.values({ ...known, ...Object.fromEntries((query.data?.items || []).map(item => [item.id, item])) }).filter(item => pending.includes(item.id));
    // Fresh resources must be available to the draft summary and local validation too.
    cache.setQueryData<AssistantCatalog>([...workspace.scopeKey, 'catalog'], current => {
      if (!current) return current;
      if (category === 'tools') {
        const tools = new Map(current.tools.map(tool => [tool.name, tool]));
        for (const item of items) tools.set(item.id, { name: item.id, label: item.name, approvalRequired: item.approvalRequired === true });
        return { ...current, tools: [...tools.values()] };
      }
      const resources = new Map(current[category].map(resource => [resource.id, resource]));
      for (const item of items) resources.set(Number(item.id), { ...item, id: Number(item.id) });
      return { ...current, [category]: [...resources.values()] };
    });
    onApply(pending, items); onOpenChange(false);
  };
  const Icon = category === 'galleries' ? Images : FileText;
  const unavailableTemplates = category === 'templates' ? workspace.catalog.data?.unavailableResources?.filter(item => item.category === 'templates' && (!channels.length || channels.some(channel => item.channels.includes(channel)))) || [] : [];
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="right" className="ak-drawer flex h-dvh w-full flex-col gap-0 p-0 sm:max-w-xl">
    <SheetHeader className="shrink-0 border-b px-5 pb-5 pt-6 pr-12 text-left"><SheetTitle>{title}</SheetTitle><SheetDescription>{category === 'templates' ? 'Choose an approved message from your content library. WhatsApp platform template approvals are managed separately in Integrations.' : 'Choose published, permitted resources for this assistant. Apply your selection to the draft when ready.'}</SheetDescription></SheetHeader>
    <div className="shrink-0 space-y-3 border-b px-5 py-4"><SearchInput aria-label={`Search ${title.toLowerCase()}`} placeholder="Search by name or content…" value={search} onValueChange={setSearch} className="min-h-11" /><div className="flex items-center justify-between text-xs text-muted-foreground"><span aria-live="polite">{pending.length} selected{query.data ? ` · ${query.data.total} available` : ''}</span><Button type="button" variant="ghost" className="h-8 min-h-8 px-2 text-xs" disabled={!pending.length} onClick={() => setPending([])}>Clear selection</Button></div></div>
    <div aria-busy={query.isFetching} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
      {(query.isLoading || search.trim() !== filters.search) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" label={null} />Loading resources…</p>}
      {query.isError && <Callout tone="danger" actions={<Button type="button" variant="outline" onClick={() => void query.refetch()}>Try again</Button>}>Resources could not be loaded. Your selection is retained.</Callout>}
      {!query.isError && search.trim() === filters.search && query.data?.items.map(item => <div key={item.id} className={`rounded-xl border bg-card p-4 ${pending.includes(item.id) ? 'border-primary bg-primary/5' : ''}`}>
        <label className="flex cursor-pointer items-start gap-3"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={pending.includes(item.id)} onChange={() => toggle(item)} /><Icon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block break-words text-sm font-medium">{item.name}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.channels.join(' · ') || 'Business tool'}{item.sourceVersion ? ` · Version ${item.sourceVersion}` : ''}{item.approvalRequired ? ' · Approval required' : ''}{item.recommended ? ' · Recommended for this role' : ''}</span></span></label>
        {item.preview && <details className="ml-7 mt-3 text-xs"><summary className="min-h-9 cursor-pointer py-2 text-primary">Preview {item.name}</summary><p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 leading-6">{item.preview}</p></details>}
      </div>)}
      {!query.isFetching && !query.isError && query.data?.total === 0 && <p role="status" className="rounded-xl border border-dashed p-6 text-sm leading-6 text-muted-foreground">{filters.search ? 'No resources match your search. Selections from other searches are retained.' : 'No published, permitted resources are available. Publish a resource first, or leave this category unused.'}{!filters.search && resourceHomes[category] && <> <Link className="font-medium text-primary underline" href={resourceHomes[category]!.href}>{resourceHomes[category]!.label}</Link></>}</p>}
      {!query.isFetching && !query.isError && category === 'templates' && !filters.search && unavailableTemplates.length > 0 && <div className="space-y-3 rounded-xl border p-4"><p className="text-sm font-medium">Messages needing review</p>{unavailableTemplates.map(item => <div key={item.id} className="text-xs leading-6 text-muted-foreground"><p className="font-medium text-foreground">{item.name}</p><p>{item.availabilityReason || 'Review and approve this message in your content library.'}</p></div>)}</div>}
    </div>
    {query.data && <Pagination className="shrink-0 border-t px-5 py-3" aria-label={`${title} pages`} page={query.data.page} pageSize={query.data.pageSize} totalItems={query.data.total} onPageChange={page => setFilters(previous => ({ ...previous, page }))} itemLabel="resources" disabled={query.isFetching} showEdgeButtons={false} />}
    <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" onClick={apply} disabled={query.isFetching || query.isError || !workspace.catalog.data?.permissions.canManage || (required && !pending.length)}>Apply selection{pending.length ? ` (${pending.length})` : ''}</Button></div>
  </SheetContent></Sheet>;
}
