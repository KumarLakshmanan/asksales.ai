"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Clock3, MessageSquareReply, Pause, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { compareProposalVersions, type ProposalDocument, type ProposalDocumentMetadata } from "../../../../shared/proposals";
import { DEFAULT_BUSINESS_TIMEZONE } from "@/lib/timezoneDefaults";

type WorkflowProposal = ProposalDocument & {
  id: number;
  revision: number;
  status: string;
  metadata?: ProposalDocumentMetadata | null;
};
type Event = { id:number;kind:string;createdAt:string;processedAt:string|null;lastError:string|null };
type Version = { id:number;createdAt:string;snapshot:ProposalDocument };
type Feedback = { id:number;kind:"question"|"change_request"|"seller_reply";authorName:string|null;content:string;parentFeedbackId:number|null;resolvedAt:string|null;createdAt:string };
type Reminder = { id:number;reminderDueAt:string;reminderType:string;status:string;metadata?:{timezone?:string;localDate?:string;localTime?:string;subject?:string;message?:string;pauseReason?:string} };
type Approval = { id:number;reviewerName:string;decision:string;comment:string|null;fingerprint:string;createdAt:string;reviewedAt:string|null };
type FollowupStep = { afterDays:number;localTime:string;subject:string;message:string };
type FollowupSchedule = { timezone:string;scheduled:Array<{reminderDueAt:string;metadata:{timezone:string;localDate:string;localTime:string;subject:string;message:string}}> };

const defaultSteps = (title:string):FollowupStep[] => [
  {afterDays:3,localTime:"10:00",subject:`Following up: ${title}`,message:`I wanted to make sure you received the proposal for ${title}. Reply if you have questions or would like any changes.`},
  {afterDays:7,localTime:"10:00",subject:`Any questions about ${title}?`,message:`I’m checking in on the proposal for ${title}. I’m happy to clarify the scope, timing, or next steps.`},
];

export function ProposalWorkflowPanel({ proposal, onRefresh }: { proposal: WorkflowProposal; onRefresh: () => void }) {
  const router=useRouter();
  const [events,setEvents]=useState<Event[]>([]),[versions,setVersions]=useState<Version[]>([]),[feedback,setFeedback]=useState<Feedback[]>([]),[reminders,setReminders]=useState<Reminder[]>([]),[approvals,setApprovals]=useState<Approval[]>([]);
  const [timezone,setTimezone]=useState(DEFAULT_BUSINESS_TIMEZONE);
  const [steps,setSteps]=useState<FollowupStep[]>(()=>defaultSteps(proposal.title));
  const [schedulePreview,setSchedulePreview]=useState<{signature:string;data:FollowupSchedule}>();
  const [reply,setReply]=useState<Record<number,string>>({}),[deliveryNote,setDeliveryNote]=useState("");
  const [busy,setBusy]=useState(""),[error,setError]=useState("");
  const load=useCallback(async()=>{
    const results=await Promise.allSettled([
      api.get<Event[]>(`/api/proposals/${proposal.id}/timeline`),
      api.get<Version[]>(`/api/proposals/${proposal.id}/versions`),
      api.get<Feedback[]>(`/api/proposals/${proposal.id}/feedback`),
      api.get<Reminder[]>(`/api/proposals/${proposal.id}/reminders`),
      api.get<Approval[]>(`/api/proposals/${proposal.id}/approvals`),
    ]);
    if(results[0].status==="fulfilled")setEvents(results[0].value);
    if(results[1].status==="fulfilled")setVersions(results[1].value);
    if(results[2].status==="fulfilled")setFeedback(results[2].value);
    if(results[3].status==="fulfilled")setReminders(results[3].value);
    if(results[4].status==="fulfilled")setApprovals(results[4].value);
    if(results.some(result=>result.status==="rejected"))setError("Some workflow history could not be loaded. Refresh before taking action.");
  },[proposal.id]);
  useEffect(()=>{void load();},[load,proposal.status,proposal.revision]);
  useEffect(()=>{if(!events.some(event=>!event.processedAt))return;const timer=setInterval(()=>{if(!document.hidden){void load();onRefresh();}},30000);return()=>clearInterval(timer);},[events,load,onRefresh]);
  const customerFeedback=useMemo(()=>feedback.filter(item=>item.kind!=="seller_reply"),[feedback]);
  const repliesByParent=useMemo(()=>new Map(customerFeedback.map(item=>[item.id,feedback.filter(replyItem=>replyItem.parentFeedbackId===item.id)])),[customerFeedback,feedback]);
  const customerFollowups=reminders.filter(item=>item.reminderType==="customer_followup" && item.status!=="cancelled");
  const anyFollowupsActive=customerFollowups.some(item=>["pending","snoozed"].includes(item.status));
  const anyFollowupsPaused=customerFollowups.some(item=>item.status==="paused");
  const scheduleSignature=JSON.stringify({timezone,steps});
  const visibleSchedulePreview=schedulePreview?.signature===scheduleSignature?schedulePreview.data:undefined;

  const action=async(key:string,operation:()=>Promise<unknown>,after?:()=>void)=>{setBusy(key);setError("");try{await operation();after?.();await load();onRefresh();}catch(failure){setError(failure instanceof ApiError?failure.message:failure instanceof Error?failure.message:"Unable to complete proposal action");}finally{setBusy("");}};
  const updateStep=(index:number,values:Partial<FollowupStep>)=>setSteps(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,...values}:item));
  const previewSchedule=async()=>{setBusy("preview");setError("");try{const data=await api.post<FollowupSchedule>(`/api/proposals/${proposal.id}/followups/preview`,{timezone,steps});setSchedulePreview({signature:scheduleSignature,data});}catch(failure){setError(failure instanceof ApiError?failure.message:failure instanceof Error?failure.message:"Unable to preview this follow-up schedule");}finally{setBusy("");}};

  return <div className="space-y-5">
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">Customer discussion</h2><p className="mt-1 text-sm text-muted-foreground">Questions and requested changes pause customer follow-ups. A revision remains a separate draft until it is reviewed and delivered.</p></div><Button variant="outline" disabled={!!busy || proposal.status==="sending"} onClick={()=>void action("revision",async()=>{const revised=await api.post<{id:number}>(`/api/proposals/${proposal.id}/revise`,{expectedRevision:proposal.revision});router.push(`/dashboard/proposals/${revised.id}/edit`);})}>Create revision</Button></div>
      {!customerFeedback.length?<p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No customer questions or change requests yet.</p>:<ol className="space-y-3">{customerFeedback.map(item=><li key={item.id} className="rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">{item.kind==="question"?"Question":"Change request"} from {item.authorName||"customer"}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()} · {item.resolvedAt?"Addressed":"Open"}</p></div><div className="flex flex-wrap gap-2">{item.kind==="change_request"&&<Button size="sm" variant="outline" className="min-h-10" disabled={!!busy} onClick={()=>void action(`revise-${item.id}`,async()=>{const revised=await api.post<{id:number}>(`/api/proposals/${proposal.id}/revise`,{expectedRevision:proposal.revision,feedbackId:item.id,draftKey:`feedback-${proposal.id}-${item.id}`});router.push(`/dashboard/proposals/${revised.id}/edit`);})}><RotateCcw className="mr-1 h-3.5 w-3.5"/>Create revision</Button>}<Button size="sm" variant="ghost" className="min-h-10" disabled={!!busy} onClick={()=>void action(`resolve-${item.id}`,()=>api.patch(`/api/proposals/${proposal.id}/feedback/${item.id}`,{resolved:!item.resolvedAt}))}>{item.resolvedAt?"Reopen":"Mark addressed"}</Button></div></div>
        <p className="mt-3 whitespace-pre-wrap text-sm">{item.content}</p>
        {(repliesByParent.get(item.id)||[]).map(response=><div key={response.id} className="ml-5 mt-3 rounded-lg bg-muted/50 p-3 text-sm"><p className="font-medium">{response.authorName||"Seller"}</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{response.content}</p></div>)}
        <div className="mt-3 flex gap-2"><Input aria-label={`Reply to feedback ${item.id}`} value={reply[item.id]||""} onChange={event=>setReply(current=>({...current,[item.id]:event.target.value}))} placeholder="Reply to the customer on this proposal"/><Button size="icon" aria-label="Send reply" disabled={!!busy||!reply[item.id]?.trim()} onClick={()=>void action(`reply-${item.id}`,()=>api.post(`/api/proposals/${proposal.id}/feedback/${item.id}/reply`,{content:reply[item.id]}),()=>setReply(current=>({...current,[item.id]:""}))) }><MessageSquareReply className="h-4 w-4"/></Button></div>
      </li>)}</ol>}
    </section>

    {(["sent","viewed"].includes(proposal.status)||customerFollowups.length>0)&&<section className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">Customer follow-ups</h2><p className="mt-1 text-sm text-muted-foreground">Each message uses the customer’s original email and its own local delivery time. Replies and change requests pause the sequence.</p></div><div className="flex gap-2">{anyFollowupsActive&&<Button size="sm" variant="outline" className="min-h-10" disabled={!!busy} onClick={()=>void action("pause",()=>api.patch(`/api/proposals/${proposal.id}/followups`,{paused:true}))}><Pause className="mr-1 h-3.5 w-3.5"/>Pause</Button>}{anyFollowupsPaused&&<Button size="sm" variant="outline" className="min-h-10" disabled={!!busy} onClick={()=>void action("resume",()=>api.patch(`/api/proposals/${proposal.id}/followups`,{paused:false}))}><Play className="mr-1 h-3.5 w-3.5"/>Resume</Button>}</div></div>
      {["sent","viewed"].includes(proposal.status)&&<><label className="block max-w-sm space-y-1 text-sm">Customer timezone<Input aria-label="Customer timezone" value={timezone} onChange={event=>setTimezone(event.target.value)} placeholder="Asia/Kolkata"/><span className="text-xs text-muted-foreground">Use an IANA timezone such as America/New_York.</span></label><div className="space-y-3">{steps.map((item,index)=><div className="grid gap-2 rounded-lg border p-3 md:grid-cols-[90px_110px_minmax(180px,1fr)_minmax(220px,1.4fr)_40px]" key={index}><label className="space-y-1 text-xs">Days after send<Input type="number" min={1} max={90} value={item.afterDays} onChange={event=>updateStep(index,{afterDays:Number(event.target.value)})}/></label><label className="space-y-1 text-xs">Local time<Input type="time" value={item.localTime} onChange={event=>updateStep(index,{localTime:event.target.value})}/></label><label className="space-y-1 text-xs">Subject<Input value={item.subject} onChange={event=>updateStep(index,{subject:event.target.value})}/></label><label className="space-y-1 text-xs">Message<Textarea rows={2} value={item.message} onChange={event=>updateStep(index,{message:event.target.value})}/></label><Button size="icon" variant="ghost" className="mt-5" aria-label={`Remove follow-up ${index+1}`} onClick={()=>setSteps(current=>current.filter((_,itemIndex)=>itemIndex!==index))}><Trash2 className="h-4 w-4"/></Button></div>)}</div><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={()=>setSteps(current=>[...current,{afterDays:Math.min(90,(current.at(-1)?.afterDays||0)+3),localTime:"10:00",subject:`Following up: ${proposal.title}`,message:"I wanted to check whether you have any questions about the proposal."}])}><Plus className="mr-1 h-4 w-4"/>Add follow-up</Button><Button type="button" variant="outline" loading={busy==="preview"} disabled={(!!busy&&busy!=="preview")||!steps.length} onClick={()=>void previewSchedule()}>Preview schedule</Button><Button loading={busy==="schedule"} disabled={(!!busy&&busy!=="schedule")||!steps.length} onClick={()=>void action("schedule",()=>api.post(`/api/proposals/${proposal.id}/followups`,{timezone,steps}))}>Save schedule</Button></div>{visibleSchedulePreview&&<section className="rounded-lg border bg-muted/30 p-4" aria-labelledby="followup-preview-title"><h3 id="followup-preview-title" className="text-sm font-semibold">Schedule preview</h3><p className="mt-1 text-xs text-muted-foreground">These times are calculated from the latest delivery using {visibleSchedulePreview.timezone}.</p><ol className="mt-3 space-y-2">{visibleSchedulePreview.scheduled.map((item,index)=><li className="flex flex-wrap justify-between gap-2 text-sm" key={`${item.reminderDueAt}-${index}`}><span>{item.metadata.localDate} at {item.metadata.localTime} · {item.metadata.timezone}</span><span className="text-muted-foreground">{item.metadata.subject}</span></li>)}</ol></section>}</>}
      {!!customerFollowups.length&&<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">When</th><th className="p-2">Subject</th><th className="p-2">Status</th></tr></thead><tbody>{customerFollowups.map(item=><tr className="border-t" key={item.id}><td className="p-2">{new Date(item.reminderDueAt).toLocaleString(undefined,{timeZone:item.metadata?.timezone})}{item.metadata?.timezone?` · ${item.metadata.timezone}`:""}</td><td className="p-2">{item.metadata?.subject||"Proposal follow-up"}</td><td className="p-2 capitalize">{item.status}{item.metadata?.pauseReason?` · ${item.metadata.pauseReason.replaceAll("_"," ")}`:""}</td></tr>)}</tbody></table></div>}
    </section>}

    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div><h2 className="font-semibold">Review, handoff, and history</h2><p className="mt-1 text-sm text-muted-foreground">Approval decisions are tied to the exact proposal fingerprint. Accepted proposals show the onboarding integration outcome here.</p></div>
      {approvals.length>0&&<div className="space-y-2"><h3 className="text-sm font-medium">Assigned reviews</h3>{approvals.map(item=><div key={item.id} className="rounded-lg border p-3 text-sm"><div className="flex justify-between gap-3"><span>{item.reviewerName}</span><span className="capitalize">{item.decision.replaceAll("_"," ")}</span></div>{item.comment&&<p className="mt-2 text-muted-foreground">{item.comment}</p>}</div>)}</div>}
      {proposal.metadata?.revisionOf&&<Link className="inline-flex text-sm text-primary underline underline-offset-4" href={`/dashboard/proposals/${proposal.metadata.revisionOf}`}>Open previous proposal</Link>}
      {proposal.metadata?.onboarding&&<div className={`rounded-lg border p-4 text-sm ${proposal.metadata.onboarding.status==="failed"?"border-destructive/30":"border-emerald-500/30"}`}><p className="font-medium">Onboarding: {proposal.metadata.onboarding.status}</p>{proposal.metadata.onboarding.lastError&&<p className="mt-1 text-destructive">{proposal.metadata.onboarding.lastError}</p>}{proposal.metadata.onboarding.supportTicketId&&<Link className="mt-2 inline-block text-primary underline" href={`/dashboard/support/${proposal.metadata.onboarding.supportTicketId}`}>Open onboarding ticket</Link>}</div>}
      {proposal.status==="delivery_unknown"&&<div className="space-y-3 rounded-lg border border-amber-500/40 p-4"><p className="text-sm">Check the provider history before resolving this uncertain delivery. A second send remains blocked.</p><Input aria-label="Delivery reconciliation evidence" value={deliveryNote} onChange={event=>setDeliveryNote(event.target.value)} placeholder="Provider receipt, message ID, or investigation note"/><div className="flex flex-wrap gap-2">{(["delivered","not_delivered"] as const).map(outcome=><Button key={outcome} variant="outline" disabled={!!busy||deliveryNote.trim().length<5} onClick={()=>void action(`recover-${outcome}`,()=>api.post(`/api/proposals/${proposal.id}/recover-delivery`,{outcome,note:deliveryNote}))}>{outcome==="delivered"?"Confirm delivered":"Confirm not delivered"}</Button>)}</div></div>}
      <details><summary className="cursor-pointer text-sm font-medium">Revision comparison ({versions.length})</summary><div className="mt-3 space-y-3">{versions.map(version=>{const changes=compareProposalVersions(version.snapshot,proposal);return <details key={version.id} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">Saved {new Date(version.createdAt).toLocaleString()} · {changes.length} current changes</summary><div className="mt-3 space-y-3">{changes.slice(0,20).map((change,index)=><div key={index} className="grid gap-2 text-xs sm:grid-cols-2"><div className="rounded bg-muted/50 p-2"><strong>Before · {change.field}</strong><p className="mt-1 whitespace-pre-wrap">{change.before||"Empty"}</p></div><div className="rounded bg-primary/5 p-2"><strong>Current</strong><p className="mt-1 whitespace-pre-wrap">{change.after||"Empty"}</p></div></div>)}{!changes.length&&<p className="text-sm text-muted-foreground">This snapshot matches the current customer document.</p>}</div></details>})}{!versions.length&&<p className="text-sm text-muted-foreground">Saved snapshots appear after the first edit.</p>}</div></details>
      <details><summary className="cursor-pointer text-sm font-medium">Activity timeline ({events.length})</summary><ol className="mt-3 space-y-2">{events.map(event=><li className="flex items-start gap-2 text-sm" key={event.id}>{event.processedAt?<Check className="mt-0.5 h-4 w-4 text-emerald-600"/>:<Clock3 className="mt-0.5 h-4 w-4 text-amber-600"/>}<span><span className="capitalize">{event.kind.replaceAll("_"," ")}</span> · {new Date(event.createdAt).toLocaleString()}{event.lastError&&<span className="block text-destructive">{event.lastError}</span>}</span></li>)}</ol></details>
      {error&&<Callout tone="danger">{error}</Callout>}
    </section>
  </div>;
}
