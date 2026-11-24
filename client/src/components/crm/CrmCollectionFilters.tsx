"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { useAuth } from '@/contexts/AuthContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import { type CrmContactFilters, DEFAULT_CONTACT_FILTERS } from '@/lib/crmContactQuery';
import { type CrmStage } from '@/lib/crm-configuration';
import { cn } from '@/lib/utils';

export interface CrmAssignee { id: number; name: string; email: string; role?: string }
export const crmSelectClass = 'h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function useCrmCollectionScope() {
  const { user } = useAuth();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  return { userId: user?.id, scope: `${user?.id ?? 'signed-out'}:${profileId ?? user?.businessProfileId ?? 'default'}` };
}

export function useCrmAssignees(scope: string) {
  const [assignees, setAssignees] = useState<CrmAssignee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setAssignees([]); setError(null); setLoading(true);
    void api.get<CrmAssignee[] | { data: CrmAssignee[] }>('/api/crm/assignees', { signal: controller.signal }).then(result => {
      const members = Array.isArray(result) ? result : result.data;
      if (!Array.isArray(members)) throw new Error('Team assignments could not be loaded.');
      if (!controller.signal.aborted) setAssignees(members);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Assignments could not be loaded.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [scope]);
  return { assignees, error, loading };
}

export function CrmCollectionFilters({ value, onChange, stages, assignees, showStages = true, showSort = true, showSearch = true, ownerError }: {
  value: CrmContactFilters; onChange: (value: CrmContactFilters) => void; stages?: CrmStage[]; assignees: CrmAssignee[]; showStages?: boolean; showSort?: boolean; showSearch?: boolean; ownerError?: string | null;
}) {
  const update = (field: keyof CrmContactFilters, next: string) => onChange({ ...value, [field]: next });
  const id = showStages ? 'contacts-filter' : 'pipeline-filter';
  return <div className="space-y-3 rounded-xl border border-border bg-card p-4">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {showSearch && <div className="sm:col-span-2"><Label htmlFor={`${id}-search`} className="text-xs">Search contacts</Label><SearchInput id={`${id}-search`} aria-label="Search contacts" wrapperClassName="mt-1.5" value={value.search || ''} placeholder="Name, email or company" onValueChange={next => update('search', next)} /></div>}
      {showStages && <div><Label htmlFor={`${id}-stage`} className="text-xs">Pipeline stage</Label><select id={`${id}-stage`} aria-label="Filter by pipeline stage" className={`${crmSelectClass} mt-1.5`} value={value.pipelineStatus || 'all'} onChange={event => update('pipelineStatus', event.target.value)}><option value="all">All contacts</option>{stages?.map(stage => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></div>}
      <div><Label htmlFor={`${id}-priority`} className="text-xs">Priority</Label><select id={`${id}-priority`} className={`${crmSelectClass} mt-1.5`} value={value.priority || 'all'} onChange={event => update('priority', event.target.value)}><option value="all">Any priority</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
      <div><Label htmlFor={`${id}-owner`} className="text-xs">Assigned to</Label><select id={`${id}-owner`} className={`${crmSelectClass} mt-1.5`} value={value.ownerUserId || 'all'} onChange={event => update('ownerUserId', event.target.value)}><option value="all">Everyone</option><option value="unassigned">Unassigned</option>{assignees.map(user => <option key={user.id} value={user.id}>{user.name || user.email}</option>)}</select>{ownerError && <p role="status" className="mt-1 text-xs text-destructive">Team assignments are unavailable. Refresh to try again.</p>}</div>
      <div><Label htmlFor={`${id}-followup`} className="text-xs">Follow-up</Label><select id={`${id}-followup`} className={`${crmSelectClass} mt-1.5`} value={value.followup || 'all'} onChange={event => update('followup', event.target.value)}><option value="all">Any follow-up</option><option value="overdue">Overdue</option><option value="upcoming">Upcoming</option><option value="none">No pending follow-up</option></select></div>
      <div><Label htmlFor={`${id}-tag`} className="text-xs">Tag</Label><Input id={`${id}-tag`} className="mt-1.5 h-10" value={value.tag || ''} placeholder="Match a tag" onChange={event => update('tag', event.target.value)} /></div>
      {showSort && <div><Label htmlFor={`${id}-sort`} className="text-xs">Sort contacts</Label><div className="mt-1.5 flex gap-2"><select id={`${id}-sort`} className={crmSelectClass} value={value.sortBy || 'lastActivityAt'} onChange={event => update('sortBy', event.target.value)}><option value="lastActivityAt">Last activity</option><option value="createdAt">Created date</option><option value="name">Name</option><option value="dealValue">Deal value</option><option value="priority">Priority</option><option value="nextFollowUpAt">Next follow-up</option></select><select aria-label="Sort direction" className={cn(crmSelectClass,'w-24 shrink-0')} value={value.sortOrder || 'desc'} onChange={event => update('sortOrder', event.target.value)}><option value="desc">↓ Desc</option><option value="asc">↑ Asc</option></select></div></div>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">Filters search the full contact list.</p><Button variant="ghost" size="sm" onClick={() => onChange({ ...DEFAULT_CONTACT_FILTERS })}>Clear filters</Button></div>
  </div>;
}
