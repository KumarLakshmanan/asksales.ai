"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Bell, Calendar, Check, CheckCircle2, Clock, Edit, MoreHorizontal, Plus, Trash2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Callout } from '@/components/ui/callout';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { useToast } from '@/hooks/use-toast';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { cn } from '@/lib/utils';
import { deviceTimeZone } from '../../../../shared/timeZones';

export interface CrmReminder {
  id: number; contactId: number | null; contactName: string | null; contactEmail?: string | null;
  title: string; description: string | null; dueDate: string; reminderType: string; priority: string; status: string;
  createdAt: string; snoozedUntil?: string | null; assignedTo?: number | null; assignedName?: string | null;
  metadata?: { notifyContact?: boolean; assignedTo?: number | null; [key: string]: unknown };
}

export const CRM_REMINDER_TYPES = [
  { value: 'followup', label: 'Follow Up' }, { value: 'ticket_open', label: 'Ticket Open' },
  { value: 'ticket_close', label: 'Ticket Close' }, { value: 'proposal_sent', label: 'Proposal Sent' },
  { value: 'proposal_expiry', label: 'Proposal Expiry' }, { value: 'meeting', label: 'Meeting' },
  { value: 'call', label: 'Call' }, { value: 'task', label: 'Task' }, { value: 'custom', label: 'Custom' },
];
export const reminderIsOpen = (reminder: CrmReminder) => !['completed', 'cancelled'].includes(reminder.status);
export const reminderDueDate = (reminder: CrmReminder) => reminder.snoozedUntil || reminder.dueDate;
export function toLocalDateTimeInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

interface ReminderForm {
  title: string; description: string; dueDate: string; priority: string; reminderType: string; notifyContact: boolean; assignedTo: string;
}
const emptyForm = (): ReminderForm => ({ title: '', description: '', dueDate: '', priority: 'medium', reminderType: 'followup', notifyContact: false, assignedTo: 'owner' });
const reminderForm = (reminder?: CrmReminder | null): ReminderForm => reminder ? {
  title: reminder.title || '', description: reminder.description || '', dueDate: toLocalDateTimeInput(reminderDueDate(reminder)),
  priority: reminder.priority || 'medium', reminderType: reminder.reminderType || 'followup', notifyContact: reminder.metadata?.notifyContact === true,
  assignedTo: String(reminder.assignedTo || reminder.metadata?.assignedTo || 'owner'),
} : emptyForm();

export interface ContactReminderDialogProps {
  open: boolean; onOpenChange: (open: boolean) => void; contactId?: number; contactName?: string;
  reminder?: CrmReminder | null; onSaved?: () => void;
}

export function ContactReminderDialog({ open, onOpenChange, contactId, contactName, reminder, onSaved }: ContactReminderDialogProps) {
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const { toast } = useToast();
  const id = useId();
  const [form, setForm] = useState<ReminderForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof ReminderForm | 'save', string>>>({});
  const [members, setMembers] = useState<Array<{ id: number; name: string; email?: string }>>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const [memberReload, setMemberReload] = useState(0);
  const initializedProfile = useRef(profileId);
  const draftDirty = JSON.stringify(form) !== JSON.stringify(reminderForm(reminder));
  const { confirmLeave, clearGuard } = useUnsavedChanges(open && draftDirty, 'Discard your unsaved reminder changes?');

  useEffect(() => {
    if (!open) return;
    initializedProfile.current = profileId;
    setForm(reminderForm(reminder)); setErrors({});
  }, [open, reminder, profileId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setMembers([]); setMembersError(false); setMembersLoading(true);
    void api.get<unknown>('/api/crm/assignees', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const response = result as { users?: unknown; data?: unknown };
      const users = Array.isArray(result) ? result : response?.users || response?.data;
      if (!Array.isArray(users)) throw new Error('Assignees unavailable');
      setMembers(users.filter((user: { id?: unknown; name?: unknown }) => Number.isSafeInteger(user?.id) && typeof user.name === 'string'));
    }).catch(() => { if (!controller.signal.aborted) setMembersError(true); })
      .finally(() => { if (!controller.signal.aborted) setMembersLoading(false); });
    return () => controller.abort();
  }, [open, profileId, memberReload]);

  const update = (key: keyof ReminderForm, value: string | boolean) => {
    setForm(previous => ({ ...previous, [key]: value }));
    setErrors(previous => ({ ...previous, [key]: undefined, save: undefined }));
  };
  const close = (next: boolean) => {
    if (saving) return;
    if (!next && !confirmLeave()) return;
    onOpenChange(next);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || initializedProfile.current !== selectedBusinessProfileId()) return;
    const invalid: typeof errors = {};
    const dateChanged = !reminder || toLocalDateTimeInput(reminderDueDate(reminder)) !== form.dueDate;
    if (!form.title.trim()) invalid.title = 'Enter a reminder title.';
    if (!form.dueDate || !Number.isFinite(new Date(form.dueDate).getTime())) invalid.dueDate = 'Choose a valid due date and time.';
    else if (dateChanged && new Date(form.dueDate).getTime() <= Date.now() + 60_000) invalid.dueDate = 'Choose a time at least one minute from now.';
    if (form.notifyContact && !form.description.trim()) invalid.description = 'Add the message to email to this contact.';
    if (Object.keys(invalid).length) { setErrors(invalid); return; }
    setSaving(true); setErrors({});
    const requestedProfile = selectedBusinessProfileId();
    try {
      const originalAssignment = String(reminder?.assignedTo || reminder?.metadata?.assignedTo || 'owner');
      const payload = {
        title: form.title.trim(), description: form.description.trim(), priority: form.priority, reminderType: form.reminderType,
        notifyContact: form.notifyContact,
        ...(!reminder && contactId !== undefined ? { contactId } : {}),
        ...(dateChanged ? { dueDate: new Date(form.dueDate).toISOString() } : {}),
        ...(!reminder || form.assignedTo !== originalAssignment ? { assignedTo: form.assignedTo === 'owner' ? null : Number(form.assignedTo) } : {}),
      };
      if (reminder) await api.put(`/api/crm/reminders/${reminder.id}`, payload);
      else await api.post('/api/crm/reminders', payload);
      if (selectedBusinessProfileId() !== requestedProfile) return;
      toast({ title: reminder ? 'Reminder updated' : 'Reminder created' });
      clearGuard();
      onOpenChange(false); onSaved?.();
    } catch (cause) {
      if (selectedBusinessProfileId() === requestedProfile) setErrors({ save: cause instanceof Error ? cause.message : 'The reminder could not be saved. Keep your draft and try again.' });
    } finally { setSaving(false); }
  };
  const linkedContactName = contactName || reminder?.contactName || (contactId !== undefined || reminder?.contactId ? 'this contact' : undefined);
  return <Dialog open={open} onOpenChange={close}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader>
    <DialogTitle className="flex items-center gap-2"><Bell className="h-4 w-4 text-primary" />{reminder ? 'Edit Reminder' : 'Add Reminder'}</DialogTitle>
    <DialogDescription>{linkedContactName ? `Follow-up for ${linkedContactName}. ` : ''}{reminder ? 'Changing the due time schedules a new notification.' : 'Choose a due time and the person responsible.'}</DialogDescription>
  </DialogHeader><form onSubmit={save} className="space-y-4" noValidate><fieldset disabled={saving} className="space-y-4">
    <div className="space-y-2"><Label htmlFor={`${id}-title`}>Title *</Label><Input id={`${id}-title`} value={form.title} maxLength={200} onChange={event => update('title', event.target.value)} aria-invalid={!!errors.title} aria-describedby={errors.title ? `${id}-title-error` : undefined} placeholder="Follow up about the proposal" />{errors.title && <p id={`${id}-title-error`} role="alert" className="text-xs text-destructive">{errors.title}</p>}</div>
    <div className="space-y-2"><Label htmlFor={`${id}-description`}>Description</Label><Textarea id={`${id}-description`} value={form.description} onChange={event => update('description', event.target.value)} rows={3} aria-invalid={!!errors.description} />{errors.description && <p role="alert" className="text-xs text-destructive">{errors.description}</p>}</div>
    <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-due`}>Due Date *</Label><Input id={`${id}-due`} type="datetime-local" value={form.dueDate} min={!reminder || form.dueDate !== toLocalDateTimeInput(reminderDueDate(reminder)) ? toLocalDateTimeInput(new Date(Date.now() + 120000).toISOString()) : undefined} onChange={event => update('dueDate', event.target.value)} aria-invalid={!!errors.dueDate} />{errors.dueDate && <p role="alert" className="text-xs text-destructive">{errors.dueDate}</p>}<p className="text-[11px] text-muted-foreground">Your local time · {deviceTimeZone()}</p></div>
    <div className="space-y-2"><Label htmlFor={`${id}-priority`}>Priority</Label><select id={`${id}-priority`} value={form.priority} onChange={event => update('priority', event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div></div>
    <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-type`}>Type</Label><select id={`${id}-type`} value={form.reminderType} onChange={event => update('reminderType', event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">{CRM_REMINDER_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></div>
    <div className="space-y-2"><Label htmlFor={`${id}-owner`}>Assigned to</Label><select id={`${id}-owner`} value={form.assignedTo} onChange={event => update('assignedTo', event.target.value)} disabled={membersLoading || membersError} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"><option value="owner">Workspace owner</option>{form.assignedTo !== 'owner' && !members.some(member => String(member.id) === form.assignedTo) && <option value={form.assignedTo}>{reminder?.assignedName || 'Previously assigned member'}</option>}{members.map(member => <option key={member.id} value={member.id}>{member.name || member.email}</option>)}</select>{membersLoading && <p className="text-xs text-muted-foreground">Loading workspace members…</p>}{membersError && <p className="text-xs text-muted-foreground">Assignees could not be loaded. <button type="button" onClick={() => setMemberReload(value => value + 1)} className="underline">Try again</button></p>}</div></div>
    {linkedContactName && <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-muted/30 p-3"><div><Label htmlFor={`${id}-notify`}>Email {linkedContactName}</Label><p className="mt-1 text-xs leading-5 text-muted-foreground">Off by default. Enabling this sends the description to the contact at the due time.</p></div><Switch id={`${id}-notify`} checked={form.notifyContact} onCheckedChange={value => update('notifyContact', value)} /></div>}
  </fieldset>{errors.save && <Callout tone="danger">{errors.save}</Callout>}<DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => close(false)}>Cancel</Button><Button type="submit" loading={saving}>{reminder ? 'Update Reminder' : 'Add Reminder'}</Button></DialogFooter></form></DialogContent></Dialog>;
}

export function ReminderList({ reminders, onChanged, compact, showContact = true }: { reminders: CrmReminder[]; onChanged?: () => void; compact?: boolean; showContact?: boolean }) {
  const { toast } = useToast();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const [editing, setEditing] = useState<CrmReminder | null>(null);
  const [pending, setPending] = useState<number[]>([]);
  useEffect(() => { setEditing(null); setPending([]); }, [profileId]);
  const change = async (reminder: CrmReminder, payload: Record<string, unknown>, label: string, remove = false) => {
    if (pending.includes(reminder.id)) return;
    const requestedProfile = selectedBusinessProfileId();
    setPending(ids => [...ids, reminder.id]);
    try {
      if (remove) await api.delete(`/api/crm/reminders/${reminder.id}`);
      else await api.put(`/api/crm/reminders/${reminder.id}`, payload);
      if (selectedBusinessProfileId() !== requestedProfile) return;
      toast({ title: label }); onChanged?.();
    } catch (cause) { if (selectedBusinessProfileId() === requestedProfile) toast({ title: 'Reminder was not updated', description: cause instanceof Error ? cause.message : 'Try again. Your reminder is unchanged.', variant: 'destructive' }); }
    finally { setPending(ids => ids.filter(id => id !== reminder.id)); }
  };
  return <><div className="divide-y divide-border">{reminders.map(reminder => {
    const due = new Date(reminderDueDate(reminder));
    const open = reminderIsOpen(reminder), overdue = open && due.getTime() < Date.now();
    const type = CRM_REMINDER_TYPES.find(item => item.value === reminder.reminderType)?.label || reminder.reminderType.replaceAll('_', ' ');
    return <div key={reminder.id} className={cn('flex items-start gap-3 py-3', !compact && 'px-4', !open && 'opacity-60')}>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" loading={pending.includes(reminder.id)} disabled={!open} aria-label={`Mark ${reminder.title} complete`} onClick={() => void change(reminder, { status: 'completed' }, 'Marked as complete')}>{!open ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Check className="h-4 w-4" />}</Button>
      <div className="min-w-0 flex-1"><div className="mb-1 flex flex-wrap gap-1.5"><Badge variant="secondary" className={cn('text-[10px]', reminder.priority === 'high' && 'bg-rose-500/10 text-rose-600 dark:text-rose-400')}>{reminder.priority}</Badge><span className="text-[11px] text-muted-foreground">{type}</span>{overdue && <span className="text-[11px] font-medium text-rose-600 dark:text-rose-400">Overdue</span>}{reminder.status === 'snoozed' && <Badge variant="outline" className="text-[10px]">Snoozed</Badge>}{reminder.status === 'sent' && <Badge variant="outline" className="text-[10px]">Notification sent</Badge>}{reminder.metadata?.notifyContact && <Badge variant="outline" className="text-[10px]">Emails contact</Badge>}</div>
        <p className={cn('break-words text-sm font-medium', !open && 'line-through')}>{reminder.title}</p>{reminder.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{reminder.description}</p>}
        <div className={cn('mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground', overdue && 'text-rose-600 dark:text-rose-400')}><span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3" />{due.toLocaleDateString(undefined, { dateStyle: 'medium' })}</span><span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{due.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span><span className="inline-flex items-center gap-1 text-muted-foreground"><UserRound className="h-3 w-3" />{reminder.assignedName || (reminder.assignedTo || reminder.metadata?.assignedTo ? 'Assigned member' : 'Workspace owner')}</span></div>
        {reminder.status === 'failed' && <p className="mt-2 text-xs leading-5 text-destructive">Notification delivery failed. Review the sending connection, then edit the due time to schedule another notification.</p>}
        {showContact && reminder.contactId && <Link className="mt-2 inline-block text-xs text-primary hover:underline" href={`/dashboard/crm/contacts/${reminder.contactId}`}>{reminder.contactName || 'Open contact'}</Link>}
      </div><div className="flex shrink-0 items-center"><Button type="button" variant="ghost" size="icon" disabled={pending.includes(reminder.id)} className="h-8 w-8" onClick={() => setEditing(reminder)} aria-label={`Edit ${reminder.title}`}><Edit className="h-3.5 w-3.5" /></Button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" disabled={pending.includes(reminder.id)} className="h-8 w-8" aria-label={`More actions for ${reminder.title}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{open && <><DropdownMenuItem onSelect={() => void change(reminder, { snoozedUntil: new Date(Date.now() + 3600000).toISOString() }, 'Reminder snoozed for one hour')}>Snooze one hour</DropdownMenuItem><DropdownMenuItem onSelect={() => void change(reminder, { snoozedUntil: new Date(Date.now() + 86400000).toISOString() }, 'Reminder snoozed until tomorrow')}>Snooze until tomorrow</DropdownMenuItem><DropdownMenuItem onSelect={() => void change(reminder, { snoozedUntil: new Date(Date.now() + 7 * 86400000).toISOString() }, 'Reminder snoozed for one week')}>Snooze one week</DropdownMenuItem></>}<DropdownMenuItem className="text-destructive" onSelect={() => { if (window.confirm('Delete this reminder? This action cannot be undone.')) void change(reminder, {}, 'Reminder deleted', true); }}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete reminder</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
    </div>;
  })}</div><ContactReminderDialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null); }} reminder={editing} onSaved={onChanged} /></>;
}

export function ContactReminderList({ contactId, contactName, onChanged, compact = true }: { contactId: number; contactName?: string; onChanged?: () => void; compact?: boolean }) {
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const [reminders, setReminders] = useState<CrmReminder[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setReminders([]);
    void api.get<CrmReminder[]>(`/api/crm/reminders?contactId=${contactId}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setReminders(result.filter(reminderIsOpen));
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Follow-ups could not be loaded.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [contactId, profileId, version]);
  useEffect(() => { setCreating(false); }, [contactId, profileId]);
  const changed = useCallback(() => { setVersion(value => value + 1); onChanged?.(); }, [onChanged]);
  return <section className="space-y-3" aria-label="Contact follow-ups"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Follow-ups {!loading && !error && <span className="text-muted-foreground">({reminders.length})</span>}</h3><Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus className="mr-1 h-3.5 w-3.5" />Add reminder</Button></div>
    {loading ? <p role="status" className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><Spinner size="xs" label={null} />Loading follow-ups…</p> : error ? <Callout tone="danger" size="sm" actions={<Button variant="outline" size="sm" onClick={() => setVersion(value => value + 1)}>Try again</Button>}>{error}</Callout> : !reminders.length ? <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">No upcoming follow-ups. Add a reminder to plan the next action.</p> : <ReminderList reminders={reminders} compact={compact} showContact={false} onChanged={changed} />}
    <ContactReminderDialog open={creating} onOpenChange={setCreating} contactId={contactId} contactName={contactName} onSaved={changed} /></section>;
}
