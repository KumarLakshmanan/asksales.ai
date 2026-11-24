"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Clock, ListTodo, RefreshCw, ArrowUpRight, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useCrmAutomationRefresh } from '@/hooks/use-crm-automation-refresh';
import { useCrmCollectionFilters } from '@/hooks/use-crm-collection-filters';
import { PageHeader } from '@/components/ui/page-header';
import { PageShell } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CrmNavigation } from '@/components/crm/CrmNavigation';
import { crmSelectClass, useCrmAssignees, useCrmCollectionScope } from '@/components/crm/CrmCollectionFilters';
import { ContactReminderDialog } from '@/components/crm/ContactReminders';

const WORK_TYPES = [
  { key: 'all', label: 'All work' }, { key: 'reminder', label: 'Follow-ups' },
  { key: 'conversation', label: 'Unanswered conversations' }, { key: 'stuck_contact', label: 'Stuck contacts' }, { key: 'ticket', label: 'Tickets needing attention' },
] as const;
type WorkType = typeof WORK_TYPES[number]['key'];
interface WorkItem {
  id: string; entityId: number; type: Exclude<WorkType, 'all'>; title: string; description: string | null;
  contactId: number | null; contactName: string | null; ownerUserId: number | null;
  dueAt: string | null; priority: string | null; status: string; url: string;
}
// The server stops a slow queue at 12 s; the client gives up at 20 s and offers Try again.
const WORK_REQUEST_TIMEOUT_MS = 20_000;
interface WorkResponse { items: WorkItem[]; counts: Record<string, number>; total: number; page: number; limit: number; totalPages: number }

export default function CRMWorkPage() {
  const { scope, userId } = useCrmCollectionScope();
  const { assignees, error: assigneeError } = useCrmAssignees(scope);
  const { toast } = useToast();
  const [type, setType] = useState<WorkType>('all');
  const [owner, setOwner] = useState('all');
  const [search, setSearch] = useState('');
  const searchFilters = useCrmCollectionFilters({ search }, scope);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<WorkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reminderOpen, setReminderOpen] = useState(false);
  const version = useRef(0);
  const inFlight = useRef(0);
  const scopeGeneration = useRef(0);
  const refreshCurrent = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    ++version.current; ++scopeGeneration.current; setData(null); setOwner('all'); setSearch(''); setPage(1); setBusy(null); setReminderOpen(false);
    const initial = new URLSearchParams(window.location.search).get('type');
    setType(WORK_TYPES.some(item => item.key === initial) ? initial as WorkType : 'all');
    return () => { ++version.current; ++scopeGeneration.current; };
  }, [scope]);
  const refresh = useCallback(async (background = false) => {
    const current = ++version.current; inFlight.current = current; setError(null); if (!background) setLoading(true);
    const query = new URLSearchParams({ page: String(page), limit: '20' });
    if (type !== 'all') query.set('type', type);
    if (owner !== 'all') query.set('ownerUserId', owner);
    if (searchFilters.search?.trim()) query.set('search', searchFilters.search.trim());
    try {
      const result = await api.get<WorkResponse>(`/api/crm/work?${query}`, { timeoutMs: WORK_REQUEST_TIMEOUT_MS, retryTransient: false });
      if (current !== version.current) return;
      const pages = Math.max(result.totalPages, 1);
      if (page > pages) { setPage(pages); return; }
      setData(result);
    } catch (cause) { if (current === version.current) setError(cause instanceof Error ? cause.message : 'Your work queue could not be loaded.'); }
    finally { if (current === version.current) setLoading(false); if (inFlight.current === current) inFlight.current = 0; }
  }, [page, type, owner, searchFilters, scope]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { refreshCurrent.current = async () => { await refresh(true); }; }, [refresh]);
  // Automatic refreshes (30s poll, socket reconnect) skip while a load is still
  // running; slow CRM reads otherwise overlap and the page never settles.
  useCrmAutomationRefresh(async () => { if (!inFlight.current) await refresh(true); });
  const updateReminder = async (item: WorkItem, action: 'complete' | 'snooze') => {
    if (busy) return;
    const current = scopeGeneration.current; setBusy(item.id);
    try {
      await api.put(`/api/crm/reminders/${item.entityId}`, action === 'complete' ? { status: 'completed' } : { snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() });
      if (current !== scopeGeneration.current) return;
      toast({ title: action === 'complete' ? 'Reminder completed' : 'Reminder snoozed for one day' }); await refreshCurrent.current();
    } catch (cause) { if (current === scopeGeneration.current) toast({ title: 'Reminder could not be updated', description: cause instanceof Error ? cause.message : 'Try again.', variant: 'destructive' }); }
    finally { if (current === scopeGeneration.current) setBusy(null); }
  };
  const countAll = data ? Object.values(data.counts).reduce((sum, count) => sum + Number(count || 0), 0) : null;

  return <PageShell>
    <PageHeader icon={ListTodo} title="My work" subtitle="Follow-ups, unanswered conversations, stalled deals, and support that needs attention." actions={<><Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button><Button onClick={() => setReminderOpen(true)}><Plus className="mr-2 h-4 w-4" />Add reminder</Button></>} />
    <CrmNavigation current="work" />
    <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 xl:grid-cols-[1fr_240px_auto]"><div><Label htmlFor="work-search" className="text-xs">Search work</Label><SearchInput id="work-search" aria-label="Search work" wrapperClassName="mt-1.5" value={search} placeholder="Contact or action" onValueChange={value => { setSearch(value); setPage(1); }} /></div><div><Label htmlFor="work-owner" className="text-xs">Assigned to</Label><select id="work-owner" className={`${crmSelectClass} mt-1.5`} value={owner} onChange={event => { setOwner(event.target.value); setPage(1); }}><option value="all">Everyone in this business</option><option value="unassigned">Unassigned</option>{assignees.map(user => <option key={user.id} value={user.id}>{user.name || user.email}</option>)}</select></div><Button className="self-end" variant={owner === String(userId) ? 'default' : 'outline'} disabled={!userId} onClick={() => { setOwner(owner === String(userId) ? 'all' : String(userId)); setPage(1); }}>Assigned to me</Button>{assigneeError && <p className="text-xs text-destructive sm:col-span-2" role="status">Team assignments could not be loaded. Refresh this page to retry.</p>}</div>
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5" aria-label="Work categories">{WORK_TYPES.map(category => <button key={category.key} type="button" aria-pressed={type === category.key} onClick={() => { setType(category.key); setPage(1); }} className={`flex min-h-16 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${type === category.key ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted/40'}`}><span>{category.label}</span>{data ? <span className="font-mono text-lg font-semibold">{category.key === 'all' ? countAll : data.counts[category.key] ?? 0}</span> : <span role="status" className="flex items-center gap-2 text-xs font-normal text-muted-foreground"><span aria-hidden="true" className="h-5 w-10 animate-pulse rounded bg-muted" />Counting…</span>}</button>)}</div>
    <p className="text-xs text-muted-foreground">Counts follow your search and assignment filter. Follow-ups include all overdue reminders and those due within the next 7 days, until completed or cancelled. Items are ordered by urgency. Open a contact to review the full history before replying.</p>
    {error ? <Alert variant="destructive"><AlertTitle>Work queue could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void refresh()}>Try again</Button></AlertDescription></Alert> : loading ? <LoadingState className="min-h-64" label="Loading work…" showLabel /> : !data?.items.length ? <div className="rounded-xl border border-dashed border-border p-12 text-center"><Check className="mx-auto mb-3 h-6 w-6 text-primary" /><h2 className="text-sm font-semibold">No work matches these filters</h2><p className="mt-2 text-sm text-muted-foreground">Choose another category or assignment to see other actions.</p><Button variant="outline" className="mt-4" onClick={() => { setType('all'); setOwner('all'); setSearch(''); setPage(1); }}>Clear filters</Button></div> : <div className="overflow-hidden rounded-xl border border-border bg-card">{data.items.map(item => {
      const assigned = assignees.find(user => user.id === item.ownerUserId);
      const due = item.dueAt ? new Date(item.dueAt) : null;
      const validDue = due && Number.isFinite(due.getTime());
      const overdue = item.type !== 'conversation' && validDue && due.getTime() < Date.now();
      const url = typeof item.url === 'string' && item.url.startsWith('/dashboard/') ? item.url : item.contactId ? `/dashboard/crm/contacts/${item.contactId}` : '/dashboard/crm/reminders';
      return <article key={item.id} className="flex flex-col gap-4 border-b border-border p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="text-[10px]">{WORK_TYPES.find(category => category.key === item.type)?.label || item.type}</Badge>{item.priority === 'high' && <Badge variant="destructive" className="text-[10px]">High priority</Badge>}{overdue && <span className="text-xs font-medium text-destructive">Overdue</span>}</div><h2 className="mt-2 text-sm font-semibold">{item.title}</h2>{item.description && <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p>}<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{item.contactId && <Link className="text-primary hover:underline" href={`/dashboard/crm/contacts/${item.contactId}`}>{item.contactName || 'View contact'}</Link>}<span>{assigned?.name || (item.ownerUserId ? 'Assigned team member' : 'Unassigned')}</span>{validDue && <span className={overdue ? 'text-destructive' : ''}>{item.type === 'conversation' ? 'Last message' : item.type === 'stuck_contact' ? 'Stuck since' : 'Due'} {due.toLocaleString()}</span>}</div></div><div className="flex shrink-0 flex-wrap items-center gap-2">{item.type === 'reminder' && Number.isSafeInteger(item.entityId) && <><Button variant="outline" size="sm" loading={busy === item.id} disabled={Boolean(busy) && busy !== item.id} onClick={() => void updateReminder(item, 'complete')}><Check className="mr-2 h-4 w-4" />Complete</Button><Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void updateReminder(item, 'snooze')}><Clock className="mr-2 h-4 w-4" />Snooze 1 day</Button></>}<Button asChild size="sm" variant="outline"><Link href={url}>{item.type === 'conversation' ? 'Review conversation' : item.type === 'ticket' ? 'Review ticket' : item.type === 'stuck_contact' ? 'Review contact' : 'Open reminder'}<ArrowUpRight className="ml-2 h-4 w-4" /></Link></Button></div></article>;
    })}<Pagination className="border-t border-border px-4 py-3" page={page} pageSize={20} totalItems={data.total} onPageChange={setPage} itemLabel="actions" /></div>}
    <ContactReminderDialog open={reminderOpen} onOpenChange={setReminderOpen} onSaved={() => void refresh(true)} />
  </PageShell>;
}
