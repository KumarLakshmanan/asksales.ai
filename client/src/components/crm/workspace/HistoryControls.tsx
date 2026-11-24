"use client";

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { CHANNEL_CONFIG } from './presentation';
import { EMPTY_HISTORY_FILTERS, type CrmHistoryFilters, type CrmHistoryTab, type CrmPagination } from '@/lib/crm-workspace';

export function HistoryHeading({ title, description, badge, action }: { title: string; description: string; badge?: string; action?: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{title}</h2>{badge && <Badge variant="secondary" className="text-xs font-normal">{badge}</Badge>}</div><p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p></div>{action}</div>;
}
export function EmptyHistory({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: string; action?: ReactNode }) {
  return <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-8 text-center"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted"><Icon className="h-5 w-5 text-muted-foreground" /></div><h3 className="text-sm font-semibold">{title}</h3><p className="max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>{action}</div>;
}
export function HistoryLoadError({ message, onRetry }: { message: string; onRetry: () => unknown }) {
  return <Alert variant="destructive"><AlertTitle>{message}</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>Try again to see this contact’s history.</span><Button variant="outline" size="sm" onClick={() => void onRetry()}>Try again</Button></AlertDescription></Alert>;
}
export function HistoryLoading() {
  return <div role="status" className="flex items-center gap-2 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground"><Spinner size="sm" label={null} /> Loading history…</div>;
}

export function ContactHistoryToolbar({ tab, value, onChange }: { tab: CrmHistoryTab; value: CrmHistoryFilters; onChange: (value: CrmHistoryFilters) => void }) {
  const change = (changes: Partial<CrmHistoryFilters>) => onChange({ ...value, ...changes, page: 1 });
  const selectClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const dirty = Object.keys(EMPTY_HISTORY_FILTERS).some(key => key !== 'page' && value[key as keyof CrmHistoryFilters] !== EMPTY_HISTORY_FILTERS[key as keyof CrmHistoryFilters]);
  const types = tab === 'timeline' ? ['activity', 'conversation', 'ticket', 'reminder', 'automation'] : ['note', 'call', 'email', 'meeting', 'task', 'pipeline_change'];
  return <div className="space-y-3 rounded-xl border border-border bg-card p-3" aria-label="History filters">
    <div className="flex flex-wrap items-center gap-2">
      <SearchInput size="sm" aria-label="Search contact history" placeholder="Search this history…" value={value.search} onValueChange={search => change({search})} wrapperClassName="min-w-[180px] flex-1" className="text-sm" />
      {(tab === 'conversations' || tab === 'sent-messages') && <select aria-label="History channel" className={selectClass} value={value.channel} onChange={e => change({channel:e.target.value})}><option value="all">All channels</option>{Object.entries(CHANNEL_CONFIG).map(([key,item]) => <option key={key} value={key}>{item.label}</option>)}</select>}
      {tab === 'conversations' && <label className="flex min-h-9 items-center gap-2 rounded-md border border-input px-3 text-xs"><input type="checkbox" checked={value.unread} onChange={e => change({unread:e.target.checked})} className="h-4 w-4 accent-primary" />Unread only</label>}
      {(tab === 'timeline' || tab === 'activity') && <select aria-label="History type" className={selectClass} value={value.type} onChange={e => change({type:e.target.value})}><option value="all">All types</option>{types.map(type => <option key={type} value={type}>{type.replaceAll('_',' ')}</option>)}</select>}
      {tab === 'tickets' && <select aria-label="Ticket status filter" className={selectClass} value={value.status} onChange={e => change({status:e.target.value})}><option value="all">All statuses</option>{['open','in_progress','waiting_on_customer','resolved','closed'].map(status => <option key={status} value={status}>{status.replaceAll('_',' ')}</option>)}</select>}
      {dirty && <Button type="button" size="sm" variant="ghost" onClick={() => onChange({...EMPTY_HISTORY_FILTERS})}><X className="mr-1 h-3.5 w-3.5" />Clear</Button>}
    </div>
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <label className="flex items-center gap-2">From date<Input type="date" aria-label="History from date" className="h-8 w-36 text-xs" value={value.from} max={value.to || undefined} onChange={e => change({from:e.target.value})} /></label>
      <label className="flex items-center gap-2">To date<Input type="date" aria-label="History to date" className="h-8 w-36 text-xs" value={value.to} min={value.from || undefined} onChange={e => change({to:e.target.value})} /></label>
    </div>
  </div>;
}

export function HistoryPagination({ pagination, pending, onPage }: { pagination?: CrmPagination; pending: boolean; onPage: (page:number) => void }) {
  if (!pagination || pagination.totalPages < 2) return null;
  return <Pagination aria-label="History pages" page={pagination.page} pageSize={pagination.limit} totalItems={pagination.total} onPageChange={onPage} disabled={pending} className="border-t border-border pt-4" />;
}
