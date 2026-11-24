"use client";

import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';

export function AddActivityDialog({contactId,contactName,open,onOpenChange,onAdded}:{contactId:number;contactName:string;open:boolean;onOpenChange:(open:boolean)=>void;onAdded:()=>unknown}) {
  const {toast} = useToast();
  const [form,setForm] = useState({type:'note',subject:'',body:''});
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const dirty = open && !!(form.subject || form.body);
  const confirmDiscard = useUnsavedChanges(dirty && !busy);
  const close = (value:boolean) => {
    if (busy || (!value && !confirmDiscard())) return;
    if (!value) {setForm({type:'note',subject:'',body:''});setError('');}
    onOpenChange(value);
  };
  const save = async (event:React.FormEvent) => {
    event.preventDefault();if(busy || (!form.subject.trim() && !form.body.trim()))return;
    setBusy(true);setError('');
    try {await api.post(`/api/crm/contacts/${contactId}/activities`,{...form,subject:form.subject.trim(),body:form.body.trim()});if(!alive.current)return;setForm({type:'note',subject:'',body:''});onOpenChange(false);toast({title:'Activity added'});void onAdded();}
    catch(cause){if(alive.current)setError(cause instanceof Error ? cause.message : 'Activity could not be added. Your note is still here.');}
    finally{if(alive.current)setBusy(false);}
  };
  return <Dialog open={open} onOpenChange={close}><DialogContent className="max-w-lg"><form className="space-y-5" onSubmit={save}><DialogHeader><DialogTitle>Add activity</DialogTitle><DialogDescription>Record a note, call, or meeting for {contactName}.</DialogDescription></DialogHeader><fieldset disabled={busy} className="space-y-4"><div className="space-y-2"><Label htmlFor="crm-activity-type">Type</Label><select id="crm-activity-type" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.type} onChange={event => setForm({...form,type:event.target.value})}>{['note','call','email','meeting','task'].map(type => <option key={type} value={type}>{type}</option>)}</select></div><div className="space-y-2"><Label htmlFor="crm-activity-subject">Subject</Label><Input id="crm-activity-subject" value={form.subject} maxLength={500} onChange={event => setForm({...form,subject:event.target.value})} placeholder="What happened?" /></div><div className="space-y-2"><Label htmlFor="crm-activity-details">Details</Label><Textarea id="crm-activity-details" rows={4} maxLength={10000} value={form.body} onChange={event => setForm({...form,body:event.target.value})} /></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</fieldset><DialogFooter className="gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>Cancel</Button><Button type="submit" loading={busy} disabled={!form.subject.trim() && !form.body.trim()}>Add activity</Button></DialogFooter></form></DialogContent></Dialog>;
}
