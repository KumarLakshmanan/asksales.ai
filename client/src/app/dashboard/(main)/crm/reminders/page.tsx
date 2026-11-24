"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, Bell, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { PageErrorState, PageLoadingState } from '@/components/ui/page-state';
import { PageHeader } from '@/components/ui/page-header';
import { ContactReminderDialog, ReminderList, reminderDueDate, reminderIsOpen, CRM_REMINDER_TYPES, type CrmReminder } from '@/components/crm/ContactReminders';
import { api } from '@/lib/api';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { useCrmAutomationRefresh } from '@/hooks/use-crm-automation-refresh';
import { cn } from '@/lib/utils';

type QueueFilter = 'all' | 'pending' | 'overdue' | 'completed';
export default function CRMRemindersPage() {
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const [reminders, setReminders] = useState<CrmReminder[]>([]);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [assignee, setAssignee] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [contact, setContact] = useState<{ id: number; name: string } | null>(null);
  const inFlight = useRef(false);
  const background = useRef(false);
  const refresh = useCallback(() => { setVersion(value => value + 1); }, []);
  // Automatic refreshes (30s poll, socket reconnect) must not abort a load that
  // is still running: a slow request would otherwise restart forever.
  const autoRefresh = useCallback(() => {
    if (inFlight.current) return;
    background.current = true; setVersion(value => value + 1);
  }, []);
  useCrmAutomationRefresh(autoRefresh);

  useEffect(() => {
    const controller = new AbortController();
    inFlight.current = true;
    if (!background.current) setLoading(true);
    background.current = false; setError('');
    void api.get<CrmReminder[]>('/api/crm/reminders', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setReminders(result || []);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Reminders could not be loaded.'); })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); inFlight.current = false; } });
    return () => { controller.abort(); inFlight.current = false; };
  }, [profileId, version]);
  useEffect(() => {
    setReminders([]); setSearch(''); setAssignee('all'); setCreating(false); setContact(null);
    const params = new URLSearchParams(window.location.search);
    const contactId = Number(params.get('contactId'));
    if (Number.isSafeInteger(contactId) && contactId !== 0) { setContact({ id: contactId, name: params.get('contactName') || 'Selected contact' }); setCreating(true); }
  }, [profileId]);

  const overdue = (reminder: CrmReminder) => reminderIsOpen(reminder) && new Date(reminderDueDate(reminder)).getTime() < Date.now();
  const counts = {
    all: reminders.length,
    pending: reminders.filter(reminderIsOpen).length,
    overdue: reminders.filter(overdue).length,
    completed: reminders.filter(reminder => reminder.status === 'completed').length,
  };
  const members = [...new Map(reminders.filter(reminder => reminder.assignedTo || reminder.metadata?.assignedTo).map(reminder => [String(reminder.assignedTo || reminder.metadata?.assignedTo), reminder.assignedName || 'Assigned member'])).entries()];
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = reminders.filter(reminder => {
    if (filter === 'pending' && !reminderIsOpen(reminder) || filter === 'overdue' && !overdue(reminder) || filter === 'completed' && reminder.status !== 'completed') return false;
    if (assignee !== 'all' && String(reminder.assignedTo || reminder.metadata?.assignedTo || 'owner') !== assignee) return false;
    const type = CRM_REMINDER_TYPES.find(item => item.value === reminder.reminderType)?.label || reminder.reminderType;
    const text = [reminder.title, reminder.description, reminder.contactName, reminder.contactEmail, reminder.assignedName, type, reminder.status, reminder.priority].filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
  if (loading && !reminders.length) return <PageLoadingState label="Loading reminders…" />;
  if (error && !reminders.length) return <PageErrorState title="Reminders could not be loaded" description={error} reset={refresh} />;
  return <div className="mx-auto max-w-screen-xl space-y-5 p-4 sm:p-5">
    <PageHeader icon={Bell} title="Reminders" subtitle="Follow-ups, assignments, and deadlines for this business profile" actions={<div className="flex flex-wrap items-center gap-2">{counts.overdue > 0 && <Badge variant="outline" className="text-rose-600 dark:text-rose-400"><AlertTriangle className="mr-1 h-3 w-3" />{counts.overdue} overdue</Badge>}<Button size="sm" onClick={() => { setContact(null); setCreating(true); }}><Plus className="mr-1.5 h-3.5 w-3.5" />Add reminder</Button></div>} />
    {error && <PageErrorState title="Reminders could not be refreshed" description={error} reset={refresh} />}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-muted/30 p-1" aria-label="Reminder status">{(['all','pending','overdue','completed'] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={cn('whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium capitalize', filter === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{value} ({counts[value]})</button>)}</div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row"><select aria-label="Filter reminders by assignee" value={assignee} onChange={event => setAssignee(event.target.value)} className="h-9 rounded-lg border border-input bg-background px-3 text-xs"><option value="all">All assignees</option><option value="owner">Workspace owner</option>{members.map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select><SearchInput size="sm" value={search} onValueChange={setSearch} aria-label="Search reminders" placeholder="Search reminders or contacts…" clearLabel="Clear reminder search" wrapperClassName="sm:w-72" /></div>
    </div>
    <p role="status" className="text-xs text-muted-foreground">{filtered.length} reminder{filtered.length === 1 ? '' : 's'}{loading ? ' · Refreshing…' : ''}</p>
    <div className="overflow-hidden rounded-xl border border-border bg-card">{filtered.length ? <ReminderList reminders={filtered} onChanged={refresh} /> : <div className="space-y-3 p-10 text-center"><Bell className="mx-auto h-6 w-6 text-muted-foreground" /><p className="text-sm font-medium">{search || assignee !== 'all' ? 'No matching reminders' : 'No reminders in this view'}</p><p className="text-xs text-muted-foreground">{search || assignee !== 'all' ? 'Try another search or assignee.' : 'Add a reminder to plan a follow-up or deadline.'}</p><Button size="sm" variant="outline" onClick={() => { if (search || assignee !== 'all') { setSearch(''); setAssignee('all'); } else { setContact(null); setCreating(true); } }}>{search || assignee !== 'all' ? 'Clear filters' : 'New Reminder'}</Button></div>}</div>
    <ContactReminderDialog open={creating} onOpenChange={setCreating} contactId={contact?.id} contactName={contact?.name} onSaved={refresh} />
  </div>;
}
