"use client";

import {useCallback,useEffect,useId,useState,useSyncExternalStore,type ReactNode} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Filter, FlaskConical, Info, Play, Plus, Save, Trash2, Zap } from 'lucide-react';
import {Button} from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Label} from '@/components/ui/label';
import {Badge} from '@/components/ui/badge';
import {PageErrorState,PageLoadingState} from '@/components/ui/page-state';
import {useToast} from '@/hooks/use-toast';
import {useCrmConfiguration} from '@/hooks/use-crm-configuration';
import {useUnsavedChanges} from '@/hooks/use-unsaved-changes';
import {selectedBusinessProfileId,subscribeBusinessProfile} from '@/lib/business-profile';
import {api} from '@/lib/api';
import {cn} from '@/lib/utils';
import {AUTOMATION_ACTIONS,AUTOMATION_CONDITION_FIELDS,AUTOMATION_PLACEHOLDERS,AUTOMATION_TRIGGERS,CONTACT_STATUSES,CRM_AUTOMATIONS_API,
  automationOperators,newAutomationDefinition,sampleAutomationEvent,validateAutomationDefinition,
  type AutomationAction,type AutomationActionType,type AutomationCatalog,type AutomationCondition,type AutomationDefinition,type AutomationEvent,type AutomationPreview,type AutomationRule} from '@/lib/crm-automations';
import type {CrmStage} from '@/lib/crm-configuration';

const selectClass='h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
function Field({label,children}:{label:string;children:(id:string)=>ReactNode}) {
  const id=useId();return <div className="space-y-1.5 min-w-0"><Label htmlFor={id}>{label}</Label>{children(id)}</div>;
}
function JsonField({label,value,onChange,onValidity}:{label:string;value:unknown;onChange:(value:Record<string,unknown>)=>void;onValidity:(valid:boolean)=>void}) {
  const [text,setText]=useState(()=>JSON.stringify(value || {},null,2));
  const [error,setError]=useState(false);
  return <Field label={label}>{id=><><Textarea id={id} value={text} rows={5} spellCheck={false} className="font-mono text-xs" aria-invalid={error}
    onChange={e=>{setText(e.target.value);try {const parsed=JSON.parse(e.target.value);if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error();
      onChange(parsed);setError(false);onValidity(true);}catch{setError(true);onValidity(false);}}}/>{error && <p role="alert" className="text-xs text-destructive">Enter a valid JSON object.</p>}</>}</Field>;
}
function Section({number,title,subtitle,children}:{number:number;title:string;subtitle:string;children:ReactNode}) {
  return <section aria-label={title} className="rounded-xl border border-border bg-card">
    <div className="flex items-center gap-3 border-b border-border/60 p-4"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{number}</span>
      <div><h2 className="font-semibold text-sm">{title}</h2><p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p></div></div><div className="p-4 space-y-4">{children}</div>
  </section>;
}
function initialAction(type:AutomationActionType):AutomationAction {
  return {id:crypto.randomUUID(),type,config:type==='create_ticket' ? {subject:'New request from {{contact.name}}',priority:'medium',description:''}
    : type==='update_tags' || type==='remove_tags' ? {tags:[]} : type==='webhook' ? {url:'',headers:{},body:{}}
      : type==='send_notification' ? {channel:'email',recipient:{mode:'contact'},subject:'',message:''} : {}};
}
function TagsField({value,update}:{value:unknown;update:(tags:string[])=>void}) {
  const [text,setText]=useState(Array.isArray(value) ? value.join(', ') : '');
  return <Field label="Tags">{id=><><Input id={id} value={text} placeholder="qualified, priority"
    onChange={e=>{setText(e.target.value);update([...new Set(e.target.value.split(',').map(tag=>tag.trim()).filter(Boolean))]);}}/><p className="text-xs text-muted-foreground">Separate up to 20 tags with commas.</p></>}</Field>;
}

function ActionFields({action,catalog,stages,contactAvailable,update,jsonValidity}:{action:AutomationAction;catalog:AutomationCatalog;stages:CrmStage[];contactAvailable:boolean;
  update:(patch:Record<string,unknown>)=>void;jsonValidity:(key:string,valid:boolean)=>void}) {
  const c=action.config;
  const input=(key:string,label:string,placeholder?:string)=><Field label={label}>{id=><Input id={id} value={String(c[key] || '')} placeholder={placeholder} onChange={e=>update({[key]:e.target.value})}/>}</Field>;
  const text=(key:string,label:string,placeholder?:string)=><Field label={label}>{id=><Textarea id={id} rows={4} value={String(c[key] || '')} placeholder={placeholder} onChange={e=>update({[key]:e.target.value})}/>}</Field>;
  if (action.type==='update_tags' || action.type==='remove_tags') return <TagsField value={c.tags} update={tags=>update({tags})}/>;
  if (action.type==='update_pipeline_status') return <Field label="Destination stage">{id=><select id={id} className={selectClass} value={String(c.pipelineStatus || '')} onChange={e=>update({pipelineStatus:e.target.value})}>
    <option value="">Select a stage</option>{stages.map(stage=><option key={stage.key} value={stage.key}>{stage.label}</option>)}</select>}</Field>;
  if (action.type==='assign_user') return <Field label="Assign to">{id=><select id={id} className={selectClass} value={Number(c.assignedTo) || ''} onChange={e=>update({assignedTo:Number(e.target.value)})}>
    <option value="">Select a workspace member</option>{catalog.members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select>}</Field>;
  if (action.type==='update_status') return <Field label="Contact status">{id=><select id={id} className={selectClass} value={String(c.status || '')} onChange={e=>update({status:e.target.value})}>
    <option value="">Select a status</option>{CONTACT_STATUSES.map(status=><option key={status}>{status}</option>)}</select>}</Field>;
  if (action.type==='create_ticket') return <>{input('subject','Ticket subject')}{text('description','Description')}<Field label="Priority">{id=><select id={id} className={selectClass} value={String(c.priority || 'medium')} onChange={e=>update({priority:e.target.value})}>
    {['low','medium','high','urgent'].map(priority=><option key={priority}>{priority}</option>)}</select>}</Field></>;
  if (action.type==='webhook') return <>{input('url','Webhook URL','https://example.com/events')}<JsonField label="JSON payload" value={c.body} onChange={body=>update({body})} onValidity={valid=>jsonValidity('body',valid)}/>
    <JsonField label="Headers (JSON)" value={c.headers} onChange={headers=>update({headers})} onValidity={valid=>jsonValidity('headers',valid)}/><p className="text-xs text-muted-foreground">Saved header values are hidden. Keep __REDACTED__ to retain a credential.</p></>;
  const channel=String(c.channel || 'email'),recipient=c.recipient as {mode:string;value?:string} || {mode:'contact'};
  const accounts=catalog.accounts.filter(account=>account.channel===channel);
  const account=accounts.find(item=>channel==='email' ? item.senderId===c.senderId : item.id===c.providerAccountId);
  const templates=catalog.whatsappTemplates.filter(item=>item.accountId===c.providerAccountId);
  const template=templates.find(item=>item.id===c.templateId && item.language===c.language);
  const selectAccount=(value:string,forChannel=channel)=>{
    const next=catalog.accounts.find(item=>item.channel===forChannel && item.id===value);
    update({...(forChannel==='email' ? {senderId:next?.senderId} : {providerAccountId:next?.id}),flowId:next?.flowId,templateId:undefined,templateHash:undefined,variables:{}});
  };
  return <><div className="grid gap-4 sm:grid-cols-2"><Field label="Notification channel">{id=><select id={id} className={selectClass} value={channel} onChange={e=>{
    update({channel:e.target.value,senderId:undefined,providerAccountId:undefined,flowId:undefined,templateId:undefined,language:undefined,variables:{}});
  }}>{['email','whatsapp','sms'].map(value=><option key={value} value={value}>{value==='sms' ? 'SMS' : value==='whatsapp' ? 'WhatsApp' : 'Email'}</option>)}</select>}</Field>
    <Field label={channel==='email' ? 'Verified sender' : 'Sending account'}>{id=><select id={id} className={selectClass} value={account?.id || ''} onChange={e=>selectAccount(e.target.value)}>
      <option value="">Select a sender</option>{accounts.map(item=><option key={item.id} value={item.id}>{item.label}{!item.ready ? ' · Needs attention' : ''}</option>)}</select>}</Field></div>
    {(!accounts.length || account && !account.ready) && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{account?.reason || 'Connect a sending account to use this channel.'} <Link href="/dashboard/integrations" className="underline">Open integrations</Link></p>}
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Recipient">{id=><select id={id} className={selectClass} value={recipient.mode} onChange={e=>update({recipient:{mode:e.target.value,value:''}})}>
      <option value="contact" disabled={!contactAvailable}>Triggering contact</option><option value="fixed">Specified address / number</option></select>}</Field>
      {recipient.mode==='fixed' && <Field label={channel==='email' ? 'Recipient email' : 'Recipient phone'}>{id=><Input id={id} type={channel==='email' ? 'email' : 'tel'} value={recipient.value || ''}
        placeholder={channel==='email' ? 'manager@example.com' : '+919876543210'} onChange={e=>update({recipient:{mode:'fixed',value:e.target.value}})}/>}</Field>}</div>
    {recipient.mode==='contact' && <p className="text-xs text-muted-foreground">Uses the triggering contact’s {channel==='email' ? 'email address' : 'phone number'}. A missing destination fails this step.</p>}
    {channel==='email' ? <>{input('subject','Email subject')}{text('message','Email message','Hello {{contact.name}}, your stage is {{contact.pipelineStatus}}.')}</>
      : channel==='sms' ? <><Field label="Configured SMS flow / template">{id=><Input id={id} readOnly value={account?.flowId || ''} placeholder="Select a configured MSG91 sender"/>}</Field>{text('message','Template message variable','Contact {{contact.name}} entered {{contact.pipelineStatus}}.')}
          {account?.messageVariable && <p className="text-xs text-muted-foreground">This value maps to the configured MSG91 variable <code>{account.messageVariable}</code>.</p>}</>
        : <><Field label="Approved WhatsApp template">{id=><select id={id} className={selectClass} value={template ? `${template.id}:${template.language}` : ''} onChange={e=>{
          const chosen=templates.find(item=>`${item.id}:${item.language}`===e.target.value);update({templateId:chosen?.id,language:chosen?.language,templateHash:chosen?.hash,variables:Object.fromEntries((chosen?.variables || []).map(key=>[key,'']))});
        }}><option value="">Select a template</option>{templates.map(item=><option key={`${item.id}:${item.language}`} value={`${item.id}:${item.language}`} disabled={!item.ready}>{item.name} · {item.language}{!item.ready ? ' · Unavailable' : ''}</option>)}</select>}</Field>
          {template && <div className="space-y-3"><p className="text-xs text-muted-foreground">Language: {template.language}. Map each template variable.</p>{template.variables.map(key=><Field key={key} label={`Variable ${key}`}>{id=><Input id={id}
            value={String((c.variables as Record<string,unknown> || {})[key] || '')} placeholder="{{contact.name}}" onChange={e=>update({variables:{...(c.variables as Record<string,unknown> || {}),[key]:e.target.value}})}/>}</Field>)}</div>}</>}
  </>;
}

export function AutomationBuilder({automationId}:{automationId?:number}) {
  const router=useRouter(),{toast}=useToast(),{stages,loading:configurationLoading,error:configurationError}=useCrmConfiguration();
  const profileId=useSyncExternalStore(subscribeBusinessProfile,selectedBusinessProfileId,()=>null);
  const [catalog,setCatalog]=useState<AutomationCatalog|null>(null),[rule,setRule]=useState<AutomationRule|null>(null);
  const [definition,setDefinition]=useState<AutomationDefinition>(newAutomationDefinition),[name,setName]=useState(''),[description,setDescription]=useState(''),[priority,setPriority]=useState(0);
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[errors,setErrors]=useState<string[]>([]),[busy,setBusy]=useState<'save'|'test'|null>(null);
  const [step,setStep]=useState(1),[triggerGroup,setTriggerGroup]=useState('CRM');
  const [search,setSearch]=useState(''),[catalogOpen,setCatalogOpen]=useState(true),[testOpen,setTestOpen]=useState(false),[sample,setSample]=useState(''),[preview,setPreview]=useState<AutomationPreview|null>(null);
  const [invalidJson,setInvalidJson]=useState<Record<string,boolean>>({});
  const [baseline,setBaseline]=useState<string|null>(null);
  const dirty=baseline!==null && (JSON.stringify({name,description,priority,definition})!==baseline || Object.values(invalidJson).some(Boolean));
  const {confirmLeave,clearGuard}=useUnsavedChanges(dirty,'Discard your unsaved automation changes?');
  const load=useCallback(async(signal?:AbortSignal)=>{
    const requestedProfile=selectedBusinessProfileId();
    setLoading(true);setLoadError('');setCatalog(null);setRule(null);setPreview(null);
    try {const [nextCatalog,nextRule]=await Promise.all([api.get<AutomationCatalog>(`${CRM_AUTOMATIONS_API}/catalog`,{signal}),automationId ? api.get<AutomationRule>(`${CRM_AUTOMATIONS_API}/${automationId}`,{signal}) : Promise.resolve(null)]);
      if (signal?.aborted || selectedBusinessProfileId()!==requestedProfile) return;const nextDefinition=nextRule?.definition || newAutomationDefinition();setCatalog(nextCatalog);setRule(nextRule);setDefinition(nextDefinition);setName(nextRule?.name || '');setDescription(nextRule?.description || '');setPriority(nextRule?.priority || 0);setCatalogOpen(!nextRule);setStep(1);setTriggerGroup(AUTOMATION_TRIGGERS.find(item=>item.type===nextDefinition.trigger.type)?.group || 'CRM');setInvalidJson({});setBaseline(JSON.stringify({name:nextRule?.name || '',description:nextRule?.description || '',priority:nextRule?.priority || 0,definition:nextDefinition}));
    }catch(error){if (!signal?.aborted && selectedBusinessProfileId()===requestedProfile) setLoadError(error instanceof Error ? error.message : 'Unable to load the builder.');}finally{if (!signal?.aborted && selectedBusinessProfileId()===requestedProfile) setLoading(false);}
  },[automationId]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);return ()=>controller.abort();},[load,profileId]);
  const change=(next:AutomationDefinition)=>{setDefinition(next);setPreview(null);};
  const trigger=AUTOMATION_TRIGGERS.find(item=>item.type===definition.trigger.type),contactAvailable=trigger?.contact!==false;
  const patchAction=(id:string,patch:Record<string,unknown>)=>change({...definition,actions:definition.actions.map(action=>action.id===id ? {...action,config:{...action.config,...patch}} : action)});
  const validation=()=>{
    const issues=validateAutomationDefinition(definition);
    if (!name.trim()) issues.unshift('Enter an automation name.');
    if (definition.actions.some(action=>Object.entries(invalidJson).some(([key,invalid])=>key.startsWith(`${action.id}:`) && invalid))) issues.push('Correct the invalid JSON fields.');
    setErrors(issues);return issues.length===0;
  };
  const save=async()=>{if (busy || !validation()) return;const requestedProfile=selectedBusinessProfileId();setBusy('save');try {
    const payload={name:name.trim(),description,priority,definition,...(rule ? {revision:rule.revision} : {})};
    if (rule) await api.put(`${CRM_AUTOMATIONS_API}/${rule.id}`,payload);else await api.post(CRM_AUTOMATIONS_API,payload);
    if(selectedBusinessProfileId()!==requestedProfile) return;
    clearGuard();
    toast({title:rule ? 'Automation updated' : 'Automation saved paused',description:rule ? 'Changes apply to future runs.' : 'Activate it from the automation list when ready.'});router.push('/dashboard/crm/automations');
  }catch(error){if(selectedBusinessProfileId()===requestedProfile) setErrors([error instanceof Error ? error.message : 'Unable to save the automation.']);}finally{setBusy(null);}};
  const openTest=()=>{
    const event=sampleAutomationEvent(definition.trigger.type);
    if (!contactAvailable) {delete event.contactId;delete event.context.contact;}
    event.context.event={...event.context.event,...(definition.trigger.config.accountId ? {accountId:definition.trigger.config.accountId} : {}),
      oldValue:definition.trigger.config.fromStatus || stages[0]?.key || 'new',newValue:definition.trigger.config.toStatus || stages.find(stage=>stage.type==='active')?.key || 'contacted'};
    if (event.context.contact) event.context.contact.pipelineStatus=event.context.event.newValue;
    if (definition.trigger.config.campaignId) {event.campaignId=definition.trigger.config.campaignId;event.context.campaign=catalog?.campaigns.find(item=>item.id===event.campaignId);}
    setSample(JSON.stringify(event,null,2));setTestOpen(true);setStep(4);setPreview(null);
  };
  const test=async()=>{if (busy || !validation()) return;setBusy('test');try {
    const event=JSON.parse(sample) as AutomationEvent;setPreview(await api.post<AutomationPreview>(`${CRM_AUTOMATIONS_API}/test`,{definition,event}));
  }catch(error){setErrors([error instanceof Error ? error.message : 'Unable to preview this event.']);}finally{setBusy(null);}};
  if (loading || configurationLoading) return <PageLoadingState label="Loading automation builder…"/>;
  if (loadError || configurationError || !catalog) return <PageErrorState title="Automation builder could not be loaded" description={loadError || configurationError || ''} reset={()=>void load()}/>;
  const filtered=catalog.triggers.filter(item=>search.trim() ? `${item.group} ${item.label} ${item.description}`.toLowerCase().includes(search.trim().toLowerCase()) : item.group===triggerGroup);
  const groups=[...new Set(catalog.triggers.map(item=>item.group))];
  const steps=[{title:'Trigger',description:'Choose when this runs'},{title:'Conditions',description:'Add filters (optional)'},{title:'Actions',description:'Choose what happens'},{title:'Test & review',description:'Check and confirm'}];
  const sourceChannel=definition.trigger.type.startsWith('whatsapp_') ? 'whatsapp' : definition.trigger.type.startsWith('instagram_') ? 'instagram' : definition.trigger.type.startsWith('facebook_') ? 'facebook' : '';
  const updateCondition=(id:string,patch:Partial<AutomationCondition>)=>change({...definition,conditions:{...definition.conditions,rules:definition.conditions.rules.map(item=>item.id===id ? {...item,...patch} : item)}});
  const move=(index:number,offset:number)=>{const actions=[...definition.actions];[actions[index],actions[index+offset]]=[actions[index+offset],actions[index]];change({...definition,actions});};
  return <div className="mx-auto w-full max-w-[1600px] space-y-5 p-4 sm:p-6">
    <div className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <Button variant="ghost" size="icon" aria-label="Back to automations" onClick={()=>{if(confirmLeave()) router.push('/dashboard/crm/automations');}}><ArrowLeft className="h-4 w-4"/></Button>
      <div className="mr-auto"><h1 className="text-2xl font-semibold tracking-tight">{rule ? 'Edit automation' : 'New automation'}</h1><p className="text-xs text-muted-foreground">{rule?.isActive && !catalog?.runtimeEnabled
        ? 'Pause this rule in the list before changing its steps during the engine rollout'
        : rule?.isActive ? 'Active · edits apply to future runs' : 'Saves paused · activate from the list'}</p></div>
      <Button variant="outline" disabled={!!busy || !trigger} onClick={openTest}><FlaskConical className="mr-2 h-4 w-4"/>Test</Button>
    </div>
    {errors.length>0 && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"><ul className="list-disc space-y-1 pl-4">{errors.map(error=><li key={error}>{error}</li>)}</ul></div>}
    {dirty && <p role="status" className="text-xs text-muted-foreground">Unsaved changes · Test previews this draft without sending messages.</p>}
    <Field label="Automation name">{id=><Input id={id} value={name} maxLength={255} onChange={e=>setName(e.target.value)} placeholder="Name this automation" className="h-11 bg-card"/>}</Field>
    <div className="grid items-start gap-5 lg:grid-cols-[180px_minmax(0,1fr)] xl:grid-cols-[180px_minmax(0,1fr)_300px]">
      <nav aria-label="Automation setup steps" className="grid grid-cols-2 gap-2 rounded-xl border bg-card p-2 sm:grid-cols-4 lg:sticky lg:top-5 lg:grid-cols-1 lg:gap-3 lg:p-3">{steps.map((item,index)=><button type="button" key={item.title} aria-current={step===index+1 ? 'step' : undefined} className={cn('flex min-h-14 items-start gap-3 rounded-lg p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',step===index+1 ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50')} onClick={()=>setStep(index+1)}><span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',step===index+1 && 'border-primary bg-primary text-primary-foreground')}>{index+1}</span><span><span className="block text-sm font-semibold">{item.title}</span><span className="mt-1 hidden text-xs leading-5 text-muted-foreground lg:block">{item.description}</span></span></button>)}</nav>
      <div className="min-w-0 space-y-5">
      <div hidden={step!==1}><Section number={1} title="Choose a trigger" subtitle="Select the event that starts this automation.">
        {trigger && <div className="flex items-center gap-3 rounded-lg border border-primary/25 bg-primary/5 p-3"><Zap className="h-5 w-5 shrink-0 text-primary"/><div className="mr-auto"><p className="text-sm font-medium">{trigger.group} · {trigger.label}</p><p className="text-xs text-muted-foreground">{trigger.description}</p></div>
          <Button variant="ghost" size="sm" aria-expanded={catalogOpen} onClick={()=>setCatalogOpen(!catalogOpen)}>Change</Button></div>}
        {catalogOpen && <><SearchInput aria-label="Search triggers" placeholder="Search triggers…" value={search} onValueChange={setSearch}/>
          <div role="group" aria-label="Trigger categories" className="flex flex-wrap gap-2 border-b pb-3">{groups.map(group=><button type="button" key={group} aria-pressed={!search && triggerGroup===group} onClick={()=>{setTriggerGroup(group);setSearch('');}} className={cn('min-h-10 rounded-lg px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',!search && triggerGroup===group ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>{group}</button>)}</div>
          <div className="space-y-2">{filtered.map(item=><button type="button" key={item.type}
            aria-pressed={definition.trigger.type===item.type} className={cn('w-full rounded-lg border p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',definition.trigger.type===item.type ? 'border-primary bg-primary/5' : 'border-border bg-muted/20')}
            onClick={()=>{change({...definition,trigger:{type:item.type,config:{}}});setCatalogOpen(false);setSearch('');}}><p className="text-sm font-medium">{item.label}</p><p className="mt-1 text-xs text-muted-foreground">{item.description}</p></button>)}{!filtered.length && <p className="py-6 text-center text-sm text-muted-foreground">No triggers match your search.</p>}</div></>}
        {sourceChannel && <Field label="Receiving / sending account">{id=><select id={id} className={selectClass} value={definition.trigger.config.accountId || ''} onChange={e=>change({...definition,trigger:{...definition.trigger,config:{...definition.trigger.config,accountId:e.target.value || undefined}}})}>
          <option value="">Any account in this profile</option>{catalog.accounts.filter(item=>item.channel===sourceChannel).map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select>}</Field>}
        {definition.trigger.type.startsWith('campaign_') && <Field label="Campaign">{id=><select id={id} className={selectClass} value={definition.trigger.config.campaignId || ''} onChange={e=>change({...definition,trigger:{...definition.trigger,config:{...definition.trigger.config,campaignId:Number(e.target.value) || undefined}}})}>
          <option value="">Any campaign</option>{catalog.campaigns.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}</Field>}
        {['pipeline_status_change','status_change','ticket_status_changed','conversation_status_changed'].includes(definition.trigger.type) && <div className="grid gap-4 sm:grid-cols-2">{(['fromStatus','toStatus'] as const).map(key=><Field key={key} label={`${key==='fromStatus' ? 'From' : 'To'} ${definition.trigger.type==='pipeline_status_change' ? 'stage' : 'status'}`}>{id=>definition.trigger.type==='pipeline_status_change' || definition.trigger.type==='status_change'
          ? <select id={id} className={selectClass} value={definition.trigger.config[key] || ''} onChange={e=>change({...definition,trigger:{...definition.trigger,config:{...definition.trigger.config,[key]:e.target.value || undefined}}})}><option value="">Any</option>
            {(definition.trigger.type==='pipeline_status_change' ? stages.map(stage=>({key:stage.key,label:stage.label})) : CONTACT_STATUSES.map(status=>({key:status,label:status}))).map(item=><option key={item.key} value={item.key}>{item.label}</option>)}</select>
          : <Input id={id} value={definition.trigger.config[key] || ''} placeholder="Any status" onChange={e=>change({...definition,trigger:{...definition.trigger,config:{...definition.trigger.config,[key]:e.target.value || undefined}}})}/>}</Field>)}</div>}
      </Section></div>
      <div hidden={step!==2}><Section number={2} title="Conditions" subtitle={!definition.conditions.rules.length ? 'Every matching trigger event qualifies.' : 'Filter the event or the triggering contact.'}>
        <Field label="Match conditions">{id=><select id={id} className={selectClass} value={definition.conditions.match} onChange={e=>change({...definition,conditions:{...definition.conditions,match:e.target.value as 'all'|'any'}})}><option value="all">All conditions</option><option value="any">Any condition</option></select>}</Field>
        {definition.conditions.rules.map((condition,index)=>{const field=AUTOMATION_CONDITION_FIELDS.find(item=>item.key===condition.field)!;return <div key={condition.id} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_150px_1fr_40px]">
          <Field label={`Condition ${index+1} field`}>{id=><select id={id} className={selectClass} value={condition.field} onChange={e=>{const next=AUTOMATION_CONDITION_FIELDS.find(item=>item.key===e.target.value)!;updateCondition(condition.id,{field:next.key,operator:automationOperators(next.kind)[0],value:''});}}>
            {catalog.fields.filter(item=>contactAvailable || !item.key.startsWith('contact.')).map(item=><option key={item.key} value={item.key}>{item.label}</option>)}</select>}</Field>
          <Field label={`Condition ${index+1} operator`}>{id=><select id={id} className={selectClass} value={condition.operator} onChange={e=>updateCondition(condition.id,{operator:e.target.value as AutomationCondition['operator']})}>{automationOperators(field.kind).map(operator=><option key={operator} value={operator}>{operator.replaceAll('_',' ')}</option>)}</select>}</Field>
          {condition.operator!=='exists' && <Field label={`Condition ${index+1} value`}>{id=>condition.field==='contact.pipelineStatus' ? <select id={id} className={selectClass} value={condition.value || ''} onChange={e=>updateCondition(condition.id,{value:e.target.value})}><option value="">Select stage</option>{stages.map(stage=><option key={stage.key} value={stage.key}>{stage.label}</option>)}</select>
            : <Input id={id} type={field.kind==='number' ? 'number' : 'text'} value={condition.value ?? ''} onChange={e=>updateCondition(condition.id,{value:e.target.value})}/>}</Field>}
          <Button className="self-end" variant="ghost" size="icon" aria-label={`Remove condition ${index+1}`} onClick={()=>change({...definition,conditions:{...definition.conditions,rules:definition.conditions.rules.filter(item=>item.id!==condition.id)}})}><Trash2 className="h-4 w-4"/></Button>
        </div>;})}
        <Button variant="outline" size="sm" disabled={definition.conditions.rules.length>=30 || !trigger} onClick={()=>change({...definition,conditions:{...definition.conditions,rules:[...definition.conditions.rules,{id:crypto.randomUUID(),field:'event.channel',operator:'equals',value:''}]}})}><Plus className="mr-2 h-4 w-4"/>Add condition</Button>
      </Section></div>
      <div hidden={step!==3}><Section number={3} title="Actions" subtitle="Steps run in order. A failed or uncertain step stops the remaining steps.">
        {definition.actions.map((action,index)=><div key={action.id} className="rounded-lg border border-border bg-background p-4 space-y-4" data-testid={`automation-action-${index}`}>
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{index+1}.</span><h3 className="mr-auto text-sm font-semibold">{AUTOMATION_ACTIONS.find(item=>item.type===action.type)?.label || 'Update contact status'}</h3>
            <Button variant="ghost" size="icon" disabled={index===0} aria-label={`Move action ${index+1} up`} onClick={()=>move(index,-1)}><ArrowUp className="h-4 w-4"/></Button>
            <Button variant="ghost" size="icon" disabled={index===definition.actions.length-1} aria-label={`Move action ${index+1} down`} onClick={()=>move(index,1)}><ArrowDown className="h-4 w-4"/></Button>
            <Button variant="ghost" size="icon" aria-label={`Remove action ${index+1}`} onClick={()=>change({...definition,actions:definition.actions.filter(item=>item.id!==action.id)})}><Trash2 className="h-4 w-4"/></Button></div>
          <ActionFields action={action} catalog={catalog} stages={stages} contactAvailable={contactAvailable} update={patch=>patchAction(action.id,patch)} jsonValidity={(key,valid)=>setInvalidJson(old=>({...old,[`${action.id}:${key}`]:!valid}))}/>
        </div>)}
        <Field label="Add action">{id=><select id={id} className={selectClass} value="" disabled={!trigger || definition.actions.length>=20} onChange={e=>{if (e.target.value) {const action=initialAction(e.target.value as AutomationActionType);
          if (!contactAvailable && action.type==='send_notification') action.config.recipient={mode:'fixed',value:''};change({...definition,actions:[...definition.actions,action]});}}}>
          <option value="">Choose an action…</option>{catalog.actions.map(item=><option key={item.type} value={item.type} disabled={item.contact && !contactAvailable}>{item.label}{item.contact && !contactAvailable ? ' · Requires a contact' : ''}</option>)}</select>}</Field>
        <details className="rounded-lg bg-muted/30 p-3 text-xs"><summary className="cursor-pointer font-medium">Supported placeholders</summary><div className="mt-3 flex flex-wrap gap-2">{AUTOMATION_PLACEHOLDERS.filter(value=>contactAvailable || !value.startsWith('contact.')).map(value=><code key={value} className="rounded border border-border bg-background px-2 py-1">{'{{'+value+'}}'}</code>)}</div></details>
      </Section></div>
      <div hidden={step!==4} className="space-y-5"><Section number={4} title="Test & review" subtitle="Check this draft before saving. New automations start paused.">
        <Field label="Description (optional)">{id=><Textarea id={id} value={description} maxLength={2000} onChange={e=>setDescription(e.target.value)}/>}</Field>
        <Field label="Priority">{id=><Input id={id} type="number" min={0} max={100} value={priority} onChange={e=>setPriority(Math.min(100,Math.max(0,Number(e.target.value))))}/>}</Field>
        <p className="text-sm leading-6 text-muted-foreground">Test with a sample event to check conditions, recipients, and action readiness. Preview does not send messages or change records.</p>
        {!testOpen && <Button variant="outline" onClick={openTest} disabled={!trigger}><FlaskConical aria-hidden className="mr-2 h-4 w-4"/>Prepare test preview</Button>}
      </Section>
    {testOpen && <section aria-label="Test preview" className="space-y-4 rounded-xl border border-primary/30 bg-card p-4 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Test preview</h2><p className="text-sm text-muted-foreground">Edit the sample event. Preview never sends, calls webhooks, bills, or changes CRM data.</p></div>
      <Button variant="outline" loading={busy==='test'} disabled={busy==='save'} onClick={()=>void test()}><FlaskConical className="mr-2 h-4 w-4"/>Run preview</Button></div>
      <Field label="Sample event (JSON)">{id=><Textarea id={id} rows={10} spellCheck={false} value={sample} onChange={e=>{setSample(e.target.value);setPreview(null);}} className="font-mono text-xs"/>}</Field>
      {preview && <div aria-live="polite" className="space-y-3"><p className="flex items-center gap-2 font-medium"><Check className="h-4 w-4 text-primary"/>{preview.matches ? 'This event qualifies' : 'This event does not qualify'}</p>
        <p className="text-sm">Trigger: {preview.triggerMatches ? 'matches' : 'does not match'}</p>{preview.conditions.map((item,index)=><p key={item.id} className="text-sm">Condition {index+1}: {item.matches ? 'matches' : 'does not match'}</p>)}
        {preview.actions.map((action,index)=><div key={action.id} className="rounded-lg border border-border p-3"><div className="flex items-center gap-2"><span className="text-sm font-medium">Step {index+1} · {AUTOMATION_ACTIONS.find(item=>item.type===action.type)?.label || action.type}</span><Badge variant={action.ready ? 'secondary' : 'destructive'}>{action.ready ? 'Ready' : 'Unavailable'}</Badge></div>
          {action.error && <p className="mt-2 text-sm text-destructive">{action.error}</p>}{action.recipient && <p className="mt-2 text-sm">To: {action.recipient}</p>}{action.rendered && <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(action.rendered,null,2)}</pre>}</div>)}
        {preview.warnings.map(warning=><p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}</div>}
    </section>}</div>
      </div>
      <aside aria-label="Rule preview" className="min-w-0 rounded-xl border bg-card p-5 lg:col-span-2 xl:sticky xl:top-5 xl:col-span-1">
        <h2 className="text-lg font-semibold">Rule preview</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">A live summary of your automation rule.</p>
        <div className="mt-5 space-y-3">
          <div className="rounded-lg border p-4"><div className="flex items-center gap-2 text-xs font-semibold text-primary"><Zap aria-hidden className="h-4 w-4"/>WHEN</div><p className="mt-3 text-sm font-semibold">{trigger?.label || 'Choose a trigger'}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{trigger?.description || 'Select the event that starts this rule.'}</p></div>
          <ArrowDown aria-hidden className="mx-auto h-4 w-4 text-muted-foreground"/>
          <div className="rounded-lg border p-4"><div className="flex items-center gap-2 text-xs font-semibold text-primary"><Filter aria-hidden className="h-4 w-4"/>IF</div><p className="mt-3 text-sm font-semibold">{definition.conditions.rules.length ? `Match ${definition.conditions.match} conditions` : 'No conditions added'}</p>{definition.conditions.rules.length ? <ul className="mt-2 space-y-2">{definition.conditions.rules.map(condition=><li key={condition.id} className="break-words text-xs leading-5 text-muted-foreground">{AUTOMATION_CONDITION_FIELDS.find(item=>item.key===condition.field)?.label || condition.field} {condition.operator.replaceAll('_',' ')} {String(condition.value ?? '')}</li>)}</ul> : <p className="mt-1 text-xs leading-5 text-muted-foreground">Every matching event will continue.</p>}</div>
          <ArrowDown aria-hidden className="mx-auto h-4 w-4 text-muted-foreground"/>
          <div className="rounded-lg border p-4"><div className="flex items-center gap-2 text-xs font-semibold text-primary"><Play aria-hidden className="h-4 w-4"/>THEN</div>{definition.actions.length ? <ol className="mt-3 list-inside list-decimal space-y-2 text-sm">{definition.actions.map(action=><li key={action.id}>{AUTOMATION_ACTIONS.find(item=>item.type===action.type)?.label || 'Update contact status'}</li>)}</ol> : <><p className="mt-3 text-sm font-semibold">Choose an action</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Add at least one action.</p></>}</div>
        </div>
      </aside>
    </div>
    <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"><p className="flex max-w-prose items-start gap-2 text-xs leading-5 text-muted-foreground"><Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0"/>{rule?.isActive ? 'Changes apply to future runs of this active automation.' : 'New automations are saved paused and do not run until you activate them.'}</p><div className="flex flex-wrap gap-2">{step>1 && <Button variant="outline" onClick={()=>setStep(step-1)}>Back</Button>}<Button variant={step===4 ? 'default' : 'outline'} loading={busy==='save'} disabled={busy==='test'} onClick={()=>void save()}><Save aria-hidden className="mr-2 h-4 w-4"/>{rule ? 'Save changes' : 'Save paused draft'}</Button>{step<4 && <Button disabled={step===1 && !trigger} onClick={()=>setStep(step+1)}>Continue to {steps[step].title.toLowerCase()}<ArrowRight aria-hidden className="ml-2 h-4 w-4"/></Button>}</div></footer>
  </div>;
}
