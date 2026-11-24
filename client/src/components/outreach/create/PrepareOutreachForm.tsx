"use client";
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useRouter,useSearchParams} from 'next/navigation';
import api from '@/lib/api';
import {creatorSessionScope} from '@/lib/creator-session';
import {subscribeBusinessProfile} from '@/lib/business-profile';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Textarea} from '@/components/ui/textarea';
import {PageHeader} from '@/components/ui/page-header';
import {Send} from 'lucide-react';
import {WhatsAppTemplateEditor} from './WhatsAppTemplateEditor';
import {OutreachFollowUpEditor} from './OutreachFollowUpEditor';
import {INBOX_CHANNELS,type InboxChannel} from '../../../../../shared/outreachInbox';
import type {OutreachCreationOptions,OutreachTemplate} from '../../../../../shared/outreachCompose';
import {localFollowUpMinutes,type OutreachLocalFollowUps} from '../../../../../shared/outreachLocalFollowUps';
import type {PreparedOutreach} from '../../../../../shared/preparedOutreach';
import type {OutreachImportSources} from '../../../../../shared/outreachImportSources';
import type {DashboardOperation} from '../../../../../shared/dashboardOperations';
const selectClass='h-10 w-full rounded-md border bg-background px-3 text-sm';
export function PrepareOutreachForm() {
  const scope=useSyncExternalStore(subscribeBusinessProfile,creatorSessionScope,()=> 'anonymous');
  return <Preparation key={scope} scope={scope}/>;
}
function Preparation({scope}:{scope:string}) {
  const params=useSearchParams(),router=useRouter();
  const [operationId]=useState(params.get('importOperationId') || '');
  const [name,setName]=useState('Outreach to imported contacts'),[channel,setChannel]=useState<InboxChannel>('whatsapp');
  const [sources,setSources]=useState<OutreachImportSources>(),[sourceError,setSourceError]=useState(''),[imported,setImported]=useState<DashboardOperation>();
  const [audience,setAudience]=useState(''),[options,setOptions]=useState<OutreachCreationOptions>(),[accountId,setAccountId]=useState('');
  const [templates,setTemplates]=useState<OutreachTemplate[]>([]),[templateId,setTemplateId]=useState(''),[templateValues,setTemplateValues]=useState<Record<string,string>>({});
  const [body,setBody]=useState(''),[subject,setSubject]=useState(''),[scheduledFor,setScheduledFor]=useState('');
  const [followUps,setFollowUps]=useState<OutreachLocalFollowUps>({enabled:false,steps:[]});
  const [error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const pending=useRef(false),request=useRef({fingerprint:'',key:''});
  const account=options?.accounts.find(item=>item.id===accountId);
  useEffect(()=>{
    const controller=new AbortController();setSourceError('');
    if(operationId)api.get<DashboardOperation>(`/api/crm/contact-analysis/${encodeURIComponent(operationId)}`,{signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted && creatorSessionScope()===scope)setImported(result);
    }).catch(reason=>{if(!controller.signal.aborted)setSourceError(reason instanceof Error ? reason.message : 'Import could not be loaded.');});
    else api.get<OutreachImportSources>('/api/outreach-conversations/compose/import-sources',{signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted && creatorSessionScope()===scope)setSources(result);
    }).catch(()=>{if(!controller.signal.aborted)setSourceError('Imported audiences could not be loaded.');});
    return ()=>controller.abort();
  },[operationId,scope,refresh]);
  useEffect(()=>{
    const controller=new AbortController();setOptions(undefined);setAccountId('');setError('');setLoading(true);
    api.get<OutreachCreationOptions>(`/api/outreach-conversations/compose/options?channel=${channel}`,{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted || creatorSessionScope()!==scope)return;setOptions(result);
      if(result.accounts.length===1)setAccountId(result.accounts[0].id);
    }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error ? reason.message : 'Accounts could not be loaded.');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[channel,scope,refresh]);
  useEffect(()=>{
    const controller=new AbortController();setTemplates([]);setTemplateId('');setTemplateValues({});
    if(channel==='whatsapp' && account?.providerAccountId)api.get<{templates:OutreachTemplate[]}>(`/api/outreach-conversations/compose/templates?providerAccountId=${encodeURIComponent(account.providerAccountId)}`,{signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted && creatorSessionScope()===scope)setTemplates(result.templates);
    }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error ? reason.message : 'Approved templates could not be loaded.');});
    return ()=>controller.abort();
  },[channel,account?.providerAccountId,scope]);
  const availableImport=operationId ? imported?.kind==='contact_import' && imported.status==='completed' : !!audience;
  async function prepare() {
    if(pending.current || !account || !availableImport)return;
    const [source,importId]=audience.split(':');
    const payload={name,channel,audience:operationId ? {importOperationId:operationId} : {source,importId:Number(importId)},providerAccountId:account.providerAccountId,
      ...(account.senderId ? {senderId:account.senderId} : {}),...(channel==='whatsapp' ? {templateId,templateValues} : {body,subject}),
      ...(scheduledFor ? {scheduledFor:new Date(scheduledFor).toISOString()} : {}),
      followUps:followUps.enabled ? followUps.steps.map(step=>({delayMinutes:localFollowUpMinutes(step),templateId:step.templateId || undefined,templateValues:step.templateValues,message:step.message,subject:step.subject})) : []};
    const fingerprint=JSON.stringify(payload);if(request.current.fingerprint!==fingerprint)request.current={fingerprint,key:crypto.randomUUID()};
    pending.current=true;setBusy(true);setError('');
    try {const prepared=await api.post<PreparedOutreach>('/api/outreach/prepared',{...payload,requestKey:request.current.key});if(creatorSessionScope()===scope)router.push(`/dashboard/outreach/prepared/${prepared.id}`);}
    catch(reason) {if(creatorSessionScope()===scope)setError(reason instanceof Error ? reason.message : 'Outreach could not be prepared.');}
    finally {pending.current=false;if(creatorSessionScope()===scope)setBusy(false);}
  }
  const batches=[...(sources?.crmImports || []).map(batch=>({...batch,key:`crm:${batch.id}`})),...(sources?.campaigns || []).flatMap(campaign=>campaign.uploads.map(batch=>({...batch,key:`campaign:${batch.id}`})))];
  return <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6"><PageHeader icon={Send} title="Prepare outreach" subtitle="Choose the imported audience, message and timings, then open the populated composer review."/>
    <div className="grid gap-5 lg:grid-cols-2"><section className="space-y-4 rounded-xl border bg-card p-5"><h2 className="font-semibold">Audience and sending account</h2>
      <div className="space-y-2"><Label htmlFor="prepared-name">Campaign name</Label><Input id="prepared-name" value={name} onChange={event=>setName(event.target.value)} maxLength={160}/></div>
      {operationId ? <p className="text-sm">{imported ? imported.status==='completed' ? `${imported.total.toLocaleString()} reviewed import rows. The saved import determines available recipients.` : `Import is ${imported.status}. Wait for completion before preparing outreach.` : 'Loading imported audience…'}</p> : <div className="space-y-2"><Label htmlFor="prepared-audience">Imported audience</Label><select id="prepared-audience" className={selectClass} value={audience} onChange={event=>setAudience(event.target.value)}><option value="">Choose an import</option>{batches.map(batch=><option key={batch.key} value={batch.key}>{batch.fileName} · {batch.count.toLocaleString()} contacts</option>)}</select></div>}
      {sourceError && <p role="alert" className="text-sm text-destructive">{sourceError}</p>}
      <div className="space-y-2"><Label htmlFor="prepared-channel">Channel</Label><select id="prepared-channel" className={selectClass} value={channel} onChange={event=>{setChannel(event.target.value as InboxChannel);setFollowUps({enabled:false,steps:[]});}}>{INBOX_CHANNELS.map(value=><option key={value} value={value}>{value==='facebook' ? 'Facebook Messenger' : value==='whatsapp' ? 'WhatsApp' : value==='sms' ? 'SMS' : value.charAt(0).toUpperCase()+value.slice(1)}</option>)}</select></div>
      <div className="space-y-2"><Label htmlFor="prepared-account">Sending account</Label><select id="prepared-account" className={selectClass} value={accountId} disabled={loading} onChange={event=>{setAccountId(event.target.value);setFollowUps({enabled:false,steps:[]});}}><option value="">{loading ? 'Loading accounts…' : 'Choose an account'}</option>{options?.accounts.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select>{account?.reason && <p className="text-xs text-muted-foreground">{account.reason}</p>}</div>
      <Button type="button" variant="outline" size="sm" onClick={()=>setRefresh(value=>value+1)} disabled={busy || loading}>Refresh choices</Button>
    </section><section className="space-y-4 rounded-xl border bg-card p-5"><h2 className="font-semibold">Message and send time</h2>
      {channel==='whatsapp' ? <WhatsAppTemplateEditor templates={templates} templateId={templateId} values={templateValues} onTemplateChange={setTemplateId} onValuesChange={setTemplateValues} providerAccountId={account?.providerAccountId}/> : <>{channel==='email' && <div className="space-y-2"><Label htmlFor="prepared-subject">Email subject</Label><Input id="prepared-subject" value={subject} onChange={event=>setSubject(event.target.value)}/></div>}<div className="space-y-2"><Label htmlFor="prepared-message">Message</Label><Textarea id="prepared-message" value={body} onChange={event=>setBody(event.target.value)} rows={7}/></div></>}
      <div className="space-y-2"><Label htmlFor="prepared-schedule">Send time (optional)</Label><Input type="datetime-local" id="prepared-schedule" value={scheduledFor} onChange={event=>setScheduledFor(event.target.value)}/><p className="text-xs text-muted-foreground">Shown in your browser’s local timezone. Leave empty to send when you confirm the review.</p></div>
    </section></div>
    <OutreachFollowUpEditor channel={channel} value={followUps} onChange={setFollowUps} templates={templates} providerAccountId={account?.providerAccountId}/>
    {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap items-center gap-3"><Button disabled={busy || !availableImport || !account || !name.trim() || (channel==='whatsapp' ? !templateId : !body.trim())} onClick={()=>void prepare()}>{busy ? 'Preparing review…' : 'Prepare and review outreach'}</Button><p className="text-xs text-muted-foreground">Recipient consent and sending are confirmed in the next review.</p></div>
  </main>;
}
