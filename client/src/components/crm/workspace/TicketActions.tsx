"use client";

import { useEffect, useRef, useState } from 'react';
import { MessageSquare, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import type { SupportTicket } from '@/lib/crm-workspace';

export function TicketActions({ticket,scope,onChanged}:{ticket:SupportTicket;scope:string;onChanged:()=>unknown}) {
  const {toast} = useToast();
  const [mode,setMode] = useState<'reply'|'note'|null>(null);
  const [content,setContent] = useState('');
  const [status,setStatus] = useState(ticket.status);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [held,setHeld] = useState(false);
  const attempt = useRef<{payload:string;key:string}|null>(null);
  const [draftReady,setDraftReady] = useState(false);
  const draftKey = `crm-ticket-reply:${scope}:${ticket.id}`;
  const alive = useRef(true);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useEffect(()=>{
    try {const saved=JSON.parse(sessionStorage.getItem(draftKey)||'null');if(saved && Date.now()-saved.savedAt<7*24*60*60*1000){setMode(saved.mode==='reply'||saved.mode==='note' ? saved.mode : null);setContent(saved.content || '');setHeld(saved.held===true);attempt.current=saved.attempt || null;if(saved.held)setError('This earlier reply needs a delivery check. Review the ticket before sending again.');}else sessionStorage.removeItem(draftKey);}catch{/* Storage is optional. */}
    setDraftReady(true);
  },[draftKey]);
  useEffect(()=>{
    if(!draftReady)return;
    try {if(content || held)sessionStorage.setItem(draftKey,JSON.stringify({mode,content,held,attempt:attempt.current,savedAt:Date.now()}));else sessionStorage.removeItem(draftKey);}catch{/* Storage is optional. */}
  },[content,held,mode,draftReady,draftKey]);
  const saveStatus = async () => {
    if (busy || status === ticket.status) return;
    setBusy(true);setError('');
    try {await api.put(`/api/support/${ticket.id}`,{status});if(!alive.current)return;toast({title:'Ticket status updated'});void onChanged();}
    catch(cause){if(alive.current)setError(cause instanceof Error ? cause.message : 'Ticket status could not be updated.');}
    finally{if(alive.current)setBusy(false);}
  };
  const send = async (event:React.FormEvent) => {
    event.preventDefault();if (!content.trim() || busy || held || !mode) return;
    setBusy(true);setError('');
    const payload = JSON.stringify({content:content.trim(),isInternal:mode==='note'});
    if (attempt.current?.payload !== payload) attempt.current = {payload,key:crypto.randomUUID()};
    try {sessionStorage.setItem(draftKey,JSON.stringify({mode,content,held,attempt:attempt.current,savedAt:Date.now()}));}catch{/* Storage is optional. */}
    try {
      await api.post(`/api/support/${ticket.id}/messages`,{content:content.trim(),isInternal:mode==='note',...(mode==='reply' ? {idempotencyKey:attempt.current.key} : {})});
      if(!alive.current)return;
      toast({title:mode==='note' ? 'Internal note added' : 'Reply submitted'});setContent('');setMode(null);attempt.current=null;void onChanged();
    } catch(cause) {
      if(!alive.current)return;
      const unknownDelivery = mode==='reply' && (!(cause instanceof ApiError) || !cause.status || cause.status>=500);
      if (unknownDelivery) setHeld(true);
      setError(unknownDelivery ? 'The reply outcome needs checking. Open this ticket to review delivery before sending again.' : cause instanceof Error ? cause.message : 'Message could not be saved.');
    } finally{if(alive.current)setBusy(false);}
  };
  return <div className="space-y-3 border-t border-border bg-card p-4 sm:p-5" aria-label={`Actions for ticket ${ticket.ticketNumber}`}>
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant={mode==='reply' ? 'secondary' : 'outline'} disabled={busy || held} onClick={() => {setMode('reply');setError('');}}><MessageSquare className="mr-1.5 h-3.5 w-3.5" />Reply to customer</Button><Button size="sm" variant={mode==='note' ? 'secondary' : 'outline'} disabled={busy || held} onClick={() => {setMode('note');setError('');}}><StickyNote className="mr-1.5 h-3.5 w-3.5" />Add internal note</Button></div>
    {mode && <form className="space-y-2" onSubmit={send}><Label htmlFor={`crm-ticket-${ticket.id}-message`}>{mode==='note' ? 'Internal note · visible to your team' : 'Reply · sent to the customer'}</Label><Textarea id={`crm-ticket-${ticket.id}-message`} value={content} onChange={event => setContent(event.target.value)} disabled={busy || held} rows={3} maxLength={20000} /><div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setMode(null)}>Cancel</Button><Button type="submit" size="sm" loading={busy} disabled={held || !content.trim()}>{mode==='note' ? 'Add note' : 'Send reply'}</Button></div></form>}
    <div className="flex flex-wrap items-end gap-2"><div className="min-w-[160px] flex-1 space-y-1"><Label htmlFor={`crm-ticket-${ticket.id}-status`} className="text-xs">Ticket status</Label><select id={`crm-ticket-${ticket.id}-status`} disabled={busy} value={status} onChange={event => setStatus(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">{['open','in_progress','waiting_on_customer','resolved','closed'].map(value => <option key={value} value={value}>{value.replaceAll('_',' ')}</option>)}{!['open','in_progress','waiting_on_customer','resolved','closed'].includes(ticket.status) && <option value={ticket.status}>{ticket.status}</option>}</select></div><Button size="sm" variant="outline" disabled={busy || status===ticket.status} onClick={() => void saveStatus()}>Save status</Button></div>
    {status==='closed' && status!==ticket.status && <p className="text-xs text-muted-foreground">Closing the ticket sends its configured closure notification.</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}{held && <a href={`/dashboard/support/${ticket.id}`} className="ml-1 font-medium underline">Review ticket</a>}</p>}
  </div>;
}
