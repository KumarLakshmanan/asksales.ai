"use client";

import {validContactEmail,validContactAmount} from '@/lib/crm-contact-input';

import { contactSavedToast } from '@/lib/crm-mutation-result';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';
import { useCrmConfiguration } from '@/hooks/use-crm-configuration';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { useToast } from '@/hooks/use-toast';
import { crmStagesForStatuses } from '@/lib/crm-configuration';
import type { Contact, CrmAssignee } from '@/lib/crm-workspace';

function initialValues(contact: Contact) {
  return { firstName: contact.firstName || '', lastName: contact.lastName || '', email: contact.email || '',
    phone: contact.phone || '', company: contact.company || '', role: contact.role || '',
    pipelineStatus: contact.pipelineStatus || 'new', priority: contact.priority || 'medium',
    dealValue: contact.dealValue || '', currency: contact.currency || 'USD',
    assignedTo: contact.assignedTo ? String(contact.assignedTo) : 'unassigned',
    tags: (contact.tags || []).join(', '), notes: contact.notes || '' };
}
export type ContactEditValues = ReturnType<typeof initialValues>;
export function validateContactEdit(values: ContactEditValues) {
  const issues: Partial<Record<keyof ContactEditValues, string>> = {};
  if (![values.firstName, values.lastName, values.email, values.phone].some(value => value.trim())) issues.firstName = 'Add a name, email address, or phone number.';
  for (const field of ['firstName','lastName','email','company','role'] as const) if (values[field].trim().length > 255) issues[field] = 'Use 255 characters or fewer.';
  if (!validContactEmail(values.email.trim())) issues.email = 'Enter a valid email address.';
  if (values.phone.trim().length > 50) issues.phone = 'Use 50 characters or fewer.';
  if (!validContactAmount(values.dealValue.trim())) issues.dealValue = 'Enter a non-negative amount with at most two decimal places.';
  if (!/^[A-Z]{3}$/.test(values.currency.trim().toUpperCase())) issues.currency = 'Enter a three-letter currency code, such as INR or USD.';
  const tags = values.tags.split(',').map(value => value.trim()).filter(Boolean);
  if (new Set(tags).size > 20 || tags.some(tag => tag.length > 50)) issues.tags = 'Use up to 20 tags, each with 50 characters or fewer.';
  if (values.notes.length > 10000) issues.notes = 'Use 10,000 characters or fewer.';
  return issues;
}

export function ContactEditForm({ contact, scope, onSaved, onCancel, onDirtyChange, onSavingChange }: {
  contact: Contact; scope: string; onSaved: (contact: Contact) => void | Promise<void>; onCancel: () => void;
  onDirtyChange?: (dirty:boolean) => void; onSavingChange?: (saving:boolean) => void;
}) {
  const { toast } = useToast();
  const configuration = useCrmConfiguration();
  const stages = crmStagesForStatuses(configuration.stages, [contact.pipelineStatus || 'new']);
  const [baseline, setBaseline] = useState(() => initialValues(contact));
  const originalRevision = useRef(contact.updatedAt);
  const alive = useRef(true);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  const [values, setValues] = useState(baseline);
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState('');
  const [conflict,setConflict] = useState(false);
  const [issues,setIssues] = useState<ReturnType<typeof validateContactEdit>>({});
  const callbacks = useRef({onDirtyChange,onSavingChange});
  callbacks.current = {onDirtyChange,onSavingChange};
  const dirty = JSON.stringify(values) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty && !saving);
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onSavingChange?.(saving); }, [saving]);
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false); callbacks.current.onSavingChange?.(false); }, []);
  const assignees = useQuery({ queryKey:['crm-assignees',scope], queryFn:({signal}) => api.get<CrmAssignee[]>('/api/crm/assignees',{signal}), staleTime:60_000,retry:false });
  const change = (field:keyof ContactEditValues, value:string) => {
    setValues(current => ({...current,[field]:value})); setIssues(current => ({...current,[field]:undefined})); setError('');
  };
  const submit = async (event:React.FormEvent) => {
    event.preventDefault();
    if (saving || conflict) return;
    const validation = validateContactEdit(values);
    setIssues(validation);
    if (Object.keys(validation).length) return;
    setSaving(true);setError('');
    const {tags,assignedTo,...fields} = values;
    try {
      const updated = await api.put<Contact>(`/api/crm/contacts/${contact.id}`,{
        ...fields,firstName:fields.firstName.trim(),lastName:fields.lastName.trim(),email:fields.email.trim() || null,
        phone:fields.phone.trim() || null,company:fields.company.trim() || null,role:fields.role.trim() || null,
        notes:fields.notes.trim() || null,dealValue:fields.dealValue.trim() || null,currency:fields.currency.trim().toUpperCase(),
        tags:[...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))],
        assignedTo:assignedTo === 'unassigned' ? null : Number(assignedTo), expectedUpdatedAt:originalRevision.current,
      });
      if(!alive.current)return;
      setBaseline(values);toast(contactSavedToast(updated));await onSaved(updated);
    } catch (cause) {
      if(!alive.current)return;
      const stale = cause instanceof ApiError && cause.status === 409 && /contact.*chang/i.test(cause.message);
      setConflict(stale);
      setError(stale ? 'This contact changed while you were editing. Your draft is still here. Open the latest contact in a new tab to compare, then reopen the editor before saving.' : cause instanceof Error ? cause.message : 'Contact could not be saved. Your changes are still here.');
    } finally {if(alive.current)setSaving(false);}
  };
  const field = (key:keyof ContactEditValues,label:string,type='text',autoComplete?:string) => <div key={key} className="space-y-2"><Label htmlFor={`crm-contact-${key}`}>{label}</Label><Input id={`crm-contact-${key}`} type={type} autoComplete={autoComplete} aria-invalid={!!issues[key]} aria-describedby={issues[key] ? `crm-contact-${key}-error` : undefined} value={values[key]} onChange={event => change(key,event.target.value)} className="h-10" />{issues[key] && <p id={`crm-contact-${key}-error`} className="text-xs text-destructive">{issues[key]}</p>}</div>;

  return <form onSubmit={submit} noValidate className="min-w-0">
    <fieldset disabled={saving} className="min-w-0 space-y-6 p-5 sm:p-6">
      {error && <Alert variant="destructive"><AlertTitle>{conflict ? 'Review the latest changes' : 'Contact could not be saved'}</AlertTitle><AlertDescription>{error}{conflict && <a href={`/dashboard/crm/contacts/${contact.id}`} target="_blank" rel="noopener noreferrer" className="mt-2 block font-medium underline">Open latest contact</a>}</AlertDescription></Alert>}
      <section aria-labelledby="crm-contact-edit-details" className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 id="crm-contact-edit-details" className="text-sm font-semibold">Contact details</h2>{dirty && <Badge variant="secondary" className="text-xs font-normal">Unsaved changes</Badge>}</div><div className="grid gap-4 sm:grid-cols-2">{field('firstName','First Name','text','given-name')}{field('lastName','Last Name','text','family-name')}{field('email','Email','email','email')}{field('phone','Phone','tel','tel')}{field('company','Company','text','organization')}{field('role','Role','text','organization-title')}</div></section>
      <section aria-labelledby="crm-contact-edit-pipeline" className="space-y-4 border-t border-border pt-5"><h2 id="crm-contact-edit-pipeline" className="text-sm font-semibold">Pipeline & deal</h2>
        {configuration.error && <Alert variant="destructive"><AlertDescription>Stage settings could not be loaded. Try again before saving a stage change.<Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => configuration.reload()}>Try again</Button></AlertDescription></Alert>}
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="crm-contact-pipeline-status">Pipeline Status</Label><Select value={values.pipelineStatus} disabled={saving || configuration.loading || !!configuration.error} onValueChange={value => change('pipelineStatus',value)}><SelectTrigger id="crm-contact-pipeline-status" className="h-10"><SelectValue /></SelectTrigger><SelectContent>{stages.map(stage => <SelectItem key={stage.key} value={stage.key}>{stage.label}</SelectItem>)}</SelectContent></Select></div>{field('dealValue',`Deal Value (${values.currency || 'USD'})`)}{field('currency','Currency code')}<div className="space-y-2"><Label htmlFor="crm-contact-priority">Priority</Label><Select value={values.priority} disabled={saving} onValueChange={value => change('priority',value)}><SelectTrigger id="crm-contact-priority" className="h-10 capitalize"><SelectValue /></SelectTrigger><SelectContent>{['low','medium','high'].map(priority => <SelectItem key={priority} value={priority} className="capitalize">{priority}</SelectItem>)}</SelectContent></Select></div></div>
      </section>
      <section aria-labelledby="crm-contact-edit-ownership" className="space-y-4 border-t border-border pt-5"><h2 id="crm-contact-edit-ownership" className="text-sm font-semibold">Ownership & context</h2><div className="space-y-2"><Label htmlFor="crm-contact-owner">Assigned owner</Label><select id="crm-contact-owner" value={values.assignedTo} disabled={saving || assignees.isPending || !!assignees.error} onChange={event => change('assignedTo',event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="unassigned">Unassigned</option>{(assignees.data || []).map(owner => <option key={owner.id} value={owner.id}>{owner.name || owner.email}</option>)}{values.assignedTo !== 'unassigned' && !assignees.data?.some(owner => String(owner.id) === values.assignedTo) && <option value={values.assignedTo}>Previously assigned owner</option>}</select>{assignees.error && <p className="text-xs text-destructive">Owner choices could not be loaded. <button type="button" onClick={() => void assignees.refetch()} className="underline">Try again</button></p>}</div>{field('tags','Tags (comma separated)')}<p className="-mt-2 text-xs text-muted-foreground">Up to 20 tags. Use tags to organize contacts and saved views.</p><div className="space-y-2"><Label htmlFor="crm-contact-notes">Notes</Label><Textarea id="crm-contact-notes" rows={5} value={values.notes} onChange={event => change('notes',event.target.value)} aria-invalid={!!issues.notes} placeholder="Context to remember for the next conversation" />{issues.notes && <p className="text-xs text-destructive">{issues.notes}</p>}</div></section>
    </fieldset>
    <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border bg-card px-5 py-4 sm:px-6"><Button type="button" variant="outline" disabled={saving} onClick={onCancel}>Discard</Button><Button type="submit" loading={saving} disabled={conflict || configuration.loading || !!configuration.error} className="gap-2"><Save className="h-4 w-4" />Save changes</Button></div>
  </form>;
}
