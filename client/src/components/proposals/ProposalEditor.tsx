"use client";
import styles from "@/components/proposals/proposals.module.css";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, Download, Eye, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useUnsavedChanges, type UnsavedNavigationIntent } from '@/hooks/use-unsaved-changes';
import { useAuth } from '@/contexts/AuthContext';
import { readProposalContext } from '@/lib/proposalContextHandoff';
import { creatorSessionScope } from '@/lib/creator-session';
import { businessProfileHeaders, subscribeBusinessProfile } from '@/lib/business-profile';
import { usePreferences } from '@/contexts/PreferencesContext';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Spinner } from '@/components/ui/spinner';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ProposalSourcePicker, type ProposalSource } from './ProposalSourcePicker';
import { ProposalDocument, downloadProposalPdf, type ProposalBrand } from './ProposalDocument';
import { ProposalTextEditor, ProposalSectionEditor } from './ProposalSectionEditor';
import { ProposalCommercialEditor, type ProposalCatalogItem } from './ProposalCommercialEditor';
import { fillProposalFields, getProposalReadiness, materializeProposalTemplate, missingProposalRequirements, missingProposalTemplateFields, compareProposalVersions, type ProposalSection, type ProposalLineItem, type ProposalCommercial, type ProposalRequirements, type ProposalSourceReference, type ProposalChannel, type ProposalOnboardingPlan, type ProposalDocumentMetadata, PROPOSAL_CHANNEL_LABELS } from '../../../../shared/proposals';

type Template = { id: number; name: string; description?: string; category?: string; userId?: number | null; coverNote?: string; termsAndConditions?: string; lineItems?: ProposalLineItem[]; templateContent?: { sections: ProposalSection[]; requiredFields?: string[] } };
export type ProposalEditorDraft = ProposalSource & {
  draftKey: string; title: string; coverNote: string; recipientName: string; recipientEmail: string;
  currency: string; validUntil: string; signatureRequired: boolean; showTermsAndConditions: boolean;
  termsAndConditions: string; discountType: 'fixed' | 'percentage' | null; discountValue: number; taxRate: number;
  templateId?: number; lineItems: ProposalLineItem[]; generatedSections: ProposalSection[];
  commercial: ProposalCommercial; requirements: ProposalRequirements; assumptions: string[];
  templateValues: Record<string,string>; approvalRequired: boolean; autoOnboard: boolean;
  onboardingPlan: ProposalOnboardingPlan;
};
type StoredDraft = { version: 1; draft: ProposalEditorDraft; id?: number; revision?: number; savedAt: string };
type EditorSession = { active: boolean; ready: boolean };
// A flush cannot run forever if the user keeps editing between responses.
const MAX_FLUSH_SAVES = 5;
type ProposalRecord = Partial<ProposalEditorDraft> & { id: number; revision: number; status: string; metadata?: { generatedSections?: ProposalSection[]; commercial?: ProposalCommercial; requirements?: ProposalRequirements; assumptions?: string[]; sources?: ProposalSourceReference[]; approvalRequired?: boolean; autoOnboard?: boolean; onboardingPlan?: ProposalOnboardingPlan; supportTicketId?: number; templateValues?: Record<string,string> } };
type Suggestion = Partial<ProposalEditorDraft> & { metadata?: {generatedSections?: ProposalSection[]; sources?: ProposalSourceReference[]} };
const steps = ['Customer', 'Template', 'Scope and pricing', 'Review', 'Send'];
const requirementLabels: Record<keyof ProposalRequirements,string> = {objectives:'Customer objectives',deliverables:'Deliverables and exclusions',timeline:'Timeline and start date',responsibilities:'Customer and team responsibilities',budget:'Budget and payment expectations'};
type OnboardingResources = { teams: Array<{id:number;name:string}>; members: Array<{id:number;teamId:number;name:string|null;email:string|null;timezone:string}> };
const emptyDraft = (): ProposalEditorDraft => ({ draftKey:'',title:'',coverNote:'',recipientName:'',recipientEmail:'',currency:'USD',validUntil:'',signatureRequired:false,showTermsAndConditions:true,termsAndConditions:'',discountType:null,discountValue:0,taxRate:0,lineItems:[],generatedSections:[],commercial:{},requirements:{},assumptions:[],templateValues:{},approvalRequired:true,autoOnboard:true,onboardingPlan:{teamId:null,assignedMemberId:null,dueDate:null,checklist:[]} });
const documentOf = (draft: ProposalEditorDraft, metadata: ProposalDocumentMetadata = {}) => ({...draft,metadata:{...metadata,generatedSections:draft.generatedSections,commercial:draft.commercial,requirements:draft.requirements,assumptions:draft.assumptions,approvalRequired:draft.approvalRequired,autoOnboard:draft.autoOnboard,onboardingPlan:draft.onboardingPlan,templateValues:draft.templateValues}});
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to save this proposal.';
function fromRecord(record: ProposalRecord): ProposalEditorDraft {
  const draft = {...emptyDraft(), ...Object.fromEntries(Object.entries(record).filter(([key]) => key in emptyDraft() || ['contactId','leadId','outreachConversationId','supportTicketId','chatThreadId','templateId'].includes(key)))} as ProposalEditorDraft;
  return {...draft,draftKey:record.draftKey || crypto.randomUUID(),coverNote:record.coverNote || '',recipientName:record.recipientName || '',recipientEmail:record.recipientEmail || '',currency:record.currency || 'USD',validUntil:record.validUntil ? String(record.validUntil).slice(0,10) : '',termsAndConditions:record.termsAndConditions || '',discountValue:Number(record.discountValue || 0),taxRate:Number(record.taxRate || 0),lineItems:record.lineItems || [],generatedSections:record.metadata?.generatedSections || [],commercial:record.metadata?.commercial || {},requirements:record.metadata?.requirements || {},assumptions:record.metadata?.assumptions || [],approvalRequired:record.metadata?.approvalRequired !== false,autoOnboard:record.metadata?.autoOnboard !== false,onboardingPlan:record.metadata?.onboardingPlan || {teamId:null,assignedMemberId:null,dueDate:null,checklist:[]},supportTicketId:record.metadata?.supportTicketId,templateValues:record.metadata?.templateValues || {}};
}

function OnboardingEditor({ plan, resources, onChange }: { plan: ProposalOnboardingPlan; resources: OnboardingResources; onChange: (plan: ProposalOnboardingPlan) => void }) {
  const checklist = plan.checklist || [];
  const members = resources.members.filter(member => member.teamId === plan.teamId);
  const updateItem = (index: number, values: Partial<(typeof checklist)[number]>) => onChange({...plan,checklist:checklist.map((item,itemIndex)=>itemIndex===index?{...item,...values}:item)});
  return <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
    <div><h3 className="text-sm font-semibold">Acceptance handoff</h3><p className="mt-1 text-xs text-muted-foreground">The accepted scope, owner, dates, and checklist become a tracked onboarding ticket.</p></div>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-1 text-sm">Team<select className="h-10 w-full rounded-md border bg-background px-2" value={plan.teamId || ''} onChange={event=>onChange({...plan,teamId:event.target.value?Number(event.target.value):null,assignedMemberId:null})}><option value="">Default support team</option>{resources.teams.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
      <label className="space-y-1 text-sm">Owner<select className="h-10 w-full rounded-md border bg-background px-2" disabled={!plan.teamId} value={plan.assignedMemberId || ''} onChange={event=>onChange({...plan,assignedMemberId:event.target.value?Number(event.target.value):null})}><option value="">Auto-assign on acceptance</option>{members.map(member=><option key={member.id} value={member.id}>{member.name || member.email || `Member ${member.id}`}</option>)}</select></label>
      <label className="space-y-1 text-sm">Overall due date<Input type="date" value={plan.dueDate || ''} min={new Date().toISOString().slice(0,10)} onChange={event=>onChange({...plan,dueDate:event.target.value || null})}/></label>
    </div>
    <div className="space-y-3"><div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">Onboarding checklist</p><Button type="button" size="sm" variant="outline" className="min-h-10" onClick={()=>onChange({...plan,checklist:[...checklist,{id:crypto.randomUUID(),title:'',deliverable:'',dueDate:null}]})}><Plus className="mr-1 h-4 w-4"/>Add item</Button></div>
      {checklist.map((item,index)=><div className="grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px_40px]" key={item.id}>
        <label className="space-y-1 text-xs">Task<Input value={item.title} maxLength={500} onChange={event=>updateItem(index,{title:event.target.value})} placeholder="Kickoff call"/></label>
        <label className="space-y-1 text-xs">Deliverable<Input value={item.deliverable || ''} maxLength={2000} onChange={event=>updateItem(index,{deliverable:event.target.value})} placeholder="Signed project brief"/></label>
        <label className="space-y-1 text-xs">Due<Input type="date" value={item.dueDate || ''} min={new Date().toISOString().slice(0,10)} onChange={event=>updateItem(index,{dueDate:event.target.value || null})}/></label>
        <Button type="button" size="icon" variant="ghost" className="mt-5" aria-label={`Remove ${item.title || `onboarding item ${index+1}`}`} onClick={()=>onChange({...plan,checklist:checklist.filter((_,itemIndex)=>itemIndex!==index)})}><Trash2 className="h-4 w-4"/></Button>
      </div>)}
      {!checklist.length && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">Add the concrete tasks and deliverables the team should receive after acceptance.</p>}
    </div>
  </div>;
}

export function ProposalEditor({ proposalId }: { proposalId?: number }) {
  const {user} = useAuth();
  const scope = useSyncExternalStore(subscribeBusinessProfile, creatorSessionScope, () => 'anonymous');
  return <ProposalEditorSession key={`${user?.id}:${scope}:${proposalId || 'new'}`} proposalId={proposalId} scope={scope} />;
}

function ProposalEditorSession({ proposalId, scope }: { proposalId?: number; scope: string }) {
  const router = useRouter(); const {user} = useAuth(); const {preferences} = usePreferences();
  const [draft,setDraft] = useState<ProposalEditorDraft>(emptyDraft), [initialized,setInitialized] = useState(false), [step,setStep] = useState(0);
  const [templates,setTemplates] = useState<Template[]>([]), [catalog,setCatalog] = useState<ProposalCatalogItem[]>([]), [brand,setBrand] = useState<ProposalBrand>();
  const [onboardingResources,setOnboardingResources] = useState<OnboardingResources>({teams:[],members:[]});
  const [recovery,setRecovery] = useState<StoredDraft>(), [saveStatus,setSaveStatus] = useState('Loading…'), [error,setError] = useState(''), [loadError,setLoadError] = useState('');
  const [generating,setGenerating] = useState(false), [suggestion,setSuggestion] = useState<Suggestion>(), [generationMode,setGenerationMode] = useState<'fill_missing'|'replace_selected'>('fill_missing'), [generationSections,setGenerationSections] = useState<number[]>([]), [generationContext,setGenerationContext] = useState('');
  const [sources,setSources] = useState<ProposalSourceReference[]>([]), [preview,setPreview] = useState(false), [mobilePreview,setMobilePreview] = useState(false), [exporting,setExporting] = useState(false), [channel,setChannel] = useState<ProposalChannel>('email');
  const [savedId,setSavedId] = useState(proposalId), [saveTick,setSaveTick] = useState(0), [conflict,setConflict] = useState(false);
  const [loadAttempt,setLoadAttempt] = useState(0), [openingReview,setOpeningReview] = useState(false);
  const reviewContext = useRef({templates,brand,channel});
  const sessionRef = useRef<EditorSession>({active:false,ready:false}), reviewRequest = useRef(0), restoreRequest = useRef(0), conflictRef = useRef(false), recoveryRef = useRef<StoredDraft | undefined>(undefined);
  const draftRef = useRef(draft), idRef = useRef(proposalId), revisionRef = useRef<number | undefined>(undefined), savedHash = useRef(''), savingRef = useRef<Promise<number | undefined> | null>(null), documentRef = useRef<HTMLDivElement>(null), pendingTemplate = useRef<number | undefined>(undefined);
  const storageKey = user?.id ? `proposal-draft:v4:${scope}:${proposalId || 'new'}` : null;
  const preferencesRef = useRef(preferences.currency);
  const isCurrent = useCallback((session: EditorSession) => session.active && sessionRef.current === session && creatorSessionScope() === scope, [scope]);
  const retainDraft = useCallback(() => {
    if (!storageKey || !isCurrent(sessionRef.current) || !sessionRef.current.ready || recoveryRef.current) return;
    try { localStorage.setItem(storageKey,JSON.stringify({version:1,draft:draftRef.current,id:idRef.current,revision:revisionRef.current,savedAt:new Date().toISOString()} satisfies StoredDraft)); }
    catch { setSaveStatus('Browser recovery unavailable'); }
  }, [storageKey,isCurrent]);
  const patch = useCallback((data: Partial<ProposalEditorDraft>) => {
    if (!isCurrent(sessionRef.current)) return;
    draftRef.current = {...draftRef.current,...data};
    setDraft(draftRef.current); retainDraft();
    if (!conflictRef.current) setError('');
    if (!savingRef.current) setSaveStatus('Unsaved changes');
  }, [isCurrent,retainDraft]);

  useEffect(() => { preferencesRef.current = preferences.currency; }, [preferences.currency]);
  useEffect(() => { reviewContext.current = {templates,brand,channel}; }, [templates,brand,channel]);

  useEffect(() => {
    if (!storageKey) return;
    const session: EditorSession = {active:true,ready:false};
    sessionRef.current = session;
    let active = true;
    setError(''); setSaveStatus('Loading…');
    const initialize = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        let next = {...emptyDraft(),draftKey:crypto.randomUUID(),currency:preferencesRef.current || 'USD'};
        if (proposalId) {
          const record = await api.get<ProposalRecord>(`/api/proposals/${proposalId}`);
          if (!active || !isCurrent(session)) return;
          if (record.status !== 'draft') { router.replace(`/dashboard/proposals/${record.id}`); return; }
          next = fromRecord(record); idRef.current=record.id; revisionRef.current=record.revision; setSources(record.metadata?.sources || []);
        } else {
          next.title = (params.get('title') || '').slice(0, 500);
          setGenerationContext(readProposalContext(params));
          const source: ProposalSource = {};
          for (const key of ['contactId','outreachConversationId','supportTicketId','chatThreadId'] as const) { const value=Number(params.get(key)); if (Number.isSafeInteger(value) && value > 0) source[key]=value; }
          const templateId=Number(params.get('templateId')); if (Number.isSafeInteger(templateId) && templateId > 0) { next.templateId=templateId; pendingTemplate.current=templateId; }
          next={...next,...source};
          if (Object.keys(source).length) {
            const resolved=await api.get<{refs:ProposalSource;recipientName:string;recipientEmail:string}>(`/api/proposals/resolve-source?${new URLSearchParams(Object.entries(source).map(([key,value])=>[key,String(value)]))}`);
            next={...next,...resolved.refs,recipientName:resolved.recipientName,recipientEmail:resolved.recipientEmail};
          }
        }
        if (!active || !isCurrent(session)) return;
        savedHash.current=JSON.stringify(next);
        draftRef.current=next; setDraft(next); setSaveStatus(proposalId ? 'Saved' : 'Draft on this device');
        try { const stored=JSON.parse(localStorage.getItem(storageKey) || 'null') as StoredDraft | null; if (stored?.version === 1 && stored.draft?.draftKey && JSON.stringify(stored.draft) !== JSON.stringify(next)) { recoveryRef.current=stored; setRecovery(stored); } } catch { /* A broken browser copy never replaces the server document. */ }
        session.ready=true;
        setInitialized(true);
      } catch (failure) { if (active && isCurrent(session)) { setError(errorMessage(failure)); setSaveStatus('Unable to load'); } }
    };
    void initialize();
    const requests = [api.get<Template[]>('/api/proposals/templates').then(data=>{if(active)setTemplates(data || []);}),api.get<ProposalCatalogItem[]>('/api/proposals/catalog').then(data=>{if(active)setCatalog(data || []);}),api.get<ProposalBrand>(proposalId ? `/api/proposals/brand?proposalId=${proposalId}` : '/api/proposals/brand').then(data=>{if(active)setBrand(data);}),api.get<OnboardingResources>('/api/proposals/onboarding-resources').then(data=>{if(active)setOnboardingResources(data);})];
    void Promise.allSettled(requests).then(results => {if(active && results.some(result=>result.status === 'rejected')) setLoadError('Some templates, catalog items or branding could not load. Refresh before relying on the preview.');});
    return () => {active=false;session.active=false;};
  },[storageKey,proposalId,router,loadAttempt,isCurrent]);

  const save = useCallback((): Promise<number | undefined> => {
    const session=sessionRef.current;
    if (!isCurrent(session) || !session.ready || recoveryRef.current || conflictRef.current) return Promise.reject(new Error('Resolve the current draft before saving.'));
    // Every caller joins the same bounded flush, including edits made after it started.
    if (savingRef.current) return savingRef.current;
    const headers=businessProfileHeaders();
    const assertCurrent=()=>{if(!isCurrent(session))throw new Error('Proposal editor context changed. Your browser draft is retained.');};
    // A completed request may belong to an editor that has since closed. Retain its
    // receipt on that editor's recovery copy without replacing any newer input.
    const retainReceipt=(record:ProposalRecord,snapshot:ProposalEditorDraft)=>{
      if(!storageKey)return;
      try {
        const stored=JSON.parse(localStorage.getItem(storageKey) || 'null') as StoredDraft | null;
        if(stored?.version===1 && stored.draft.draftKey===snapshot.draftKey && (!stored.revision || stored.revision<=record.revision)) {
          localStorage.setItem(storageKey,JSON.stringify({...stored,id:record.id,revision:record.revision}));
        }
      } catch { /* Never discard the browser copy on a storage failure. */ }
    };
    const operation=Promise.resolve().then(async()=>{
      try {
        setSaveStatus('Saving…');
        for(let attempt=0;attempt<MAX_FLUSH_SAVES;attempt++) {
          assertCurrent();
          const snapshot=draftRef.current, serialized=JSON.stringify(snapshot);
          if (!snapshot.title.trim()) {setSaveStatus('Add a title to save online');return undefined;}
          if (snapshot.lineItems.some(item=>!item.name.trim() && !!item.description?.trim())) {setSaveStatus('Name each item to save online');return undefined;}
          if (savedHash.current === serialized && idRef.current) {setSaveStatus('Saved');return idRef.current;}
          retainDraft();
          const lineItems=snapshot.lineItems.filter(item=>item.name.trim()).map(({id:_id,total:_total,...item})=>({...item,quantity:Number(item.quantity ?? 1),unitPrice:Number(item.unitPrice ?? 0),discount:Number(item.discount ?? 0)}));
          const onboardingPlan={...snapshot.onboardingPlan,dueDate:snapshot.onboardingPlan.dueDate || null,checklist:(snapshot.onboardingPlan.checklist || []).filter(item=>item.title.trim()).map(item=>({...item,title:item.title.trim(),deliverable:item.deliverable?.trim() || undefined,dueDate:item.dueDate || null}))};
          const payload={...snapshot,onboardingPlan,validUntil:snapshot.validUntil ? `${snapshot.validUntil}T23:59:59.999Z` : null,lineItems};
          if (!idRef.current) {
            const created=await api.post<ProposalRecord>('/api/proposals',payload,{headers});
            retainReceipt(created,snapshot); assertCurrent();
            if(created.status!=='draft')throw new ApiError('This proposal is no longer a draft. Reload before saving.',409);
            idRef.current=created.id;revisionRef.current=created.revision;setSavedId(created.id);
            retainDraft();
          }
          assertCurrent();
          const {draftKey:_draftKey,...update}=payload;
          const result=await api.put<ProposalRecord>(`/api/proposals/${idRef.current}`,{...update,templateId:snapshot.templateId || null,contactId:snapshot.contactId || null,leadId:snapshot.leadId || null,outreachConversationId:snapshot.outreachConversationId || null,supportTicketId:snapshot.supportTicketId || null,chatThreadId:snapshot.chatThreadId || null,expectedRevision:revisionRef.current},{headers});
          retainReceipt(result,snapshot); assertCurrent();
          revisionRef.current=result.revision;savedHash.current=serialized;
          retainDraft();setError('');setSaveTick(tick=>tick+1);
          if(JSON.stringify(draftRef.current)===serialized) {setSaveStatus('Saved');return idRef.current;}
        }
        throw new Error('The proposal kept changing during save. Your latest edits are retained; pause editing and save again before delivery review.');
      } catch(failure) {
        if(isCurrent(session)) {
          retainDraft();setError(errorMessage(failure));setSaveStatus('Online save incomplete · latest edits retained');
          if(failure instanceof ApiError && failure.status === 409){conflictRef.current=true;setConflict(true);}
        }
        throw failure;
      } finally {if(savingRef.current===operation)savingRef.current=null;}
    });
    savingRef.current=operation;
    return operation;
  },[isCurrent,retainDraft,storageKey]);

  useEffect(()=>{
    if(!initialized || !storageKey || recovery)return;
    retainDraft();
    if(conflict || generating || savedHash.current === JSON.stringify(draft) || error)return;
    const timer=setTimeout(()=>{void save().catch(()=>{});},1200);
    return()=>clearTimeout(timer);
  },[draft,initialized,storageKey,recovery,conflict,generating,save,saveTick,retainDraft,error]);

  const hasUnsavedDraft = useCallback(() => initialized && savedHash.current !== JSON.stringify(draftRef.current), [initialized]);
  const leaveEditor = useCallback((intent: UnsavedNavigationIntent = 'navigation') => {
    retainDraft(); reviewRequest.current++;
    // Route departure stops the pending save loop immediately. A workspace
    // request can fail before changing context, so its editor remains usable;
    // the existing scope check retires it once the switch actually succeeds.
    if (intent === 'navigation') sessionRef.current.active = false;
  }, [retainDraft]);
  const confirmLeave = useUnsavedChanges(hasUnsavedDraft, 'This proposal has unsaved changes. Leave this page? A browser recovery copy will be retained.', leaveEditor);
  const navigateAway = (path: string) => {
    if (!confirmLeave()) return;
    confirmLeave.clearGuard(); leaveEditor(); router.push(path);
  };

  const fieldValues = useCallback(() => ({...draft.templateValues,client_name:draft.recipientName,customer_name:draft.recipientName,client_email:draft.recipientEmail,recipient_email:draft.recipientEmail,company_name:brand?.companyName,proposal_title:draft.title,currency:draft.currency,valid_until:draft.validUntil,today:new Date().toISOString().slice(0,10),...draft.requirements}), [brand?.companyName,draft]);
  const applyTemplate = useCallback((template:Template) => {
    const values=fieldValues();const materialized=materializeProposalTemplate(template.templateContent?.sections || [],values);
    patch({templateId:template.id,generatedSections:materialized.sections,coverNote:draft.coverNote || fillProposalFields(template.coverNote || '',values),termsAndConditions:draft.termsAndConditions || fillProposalFields(template.termsAndConditions || '',values),lineItems:draft.lineItems.length ? draft.lineItems : template.lineItems || []});setGenerationSections([]);
  }, [draft.coverNote,draft.lineItems,draft.termsAndConditions,fieldValues,patch]);
  useEffect(()=>{if(!initialized || !pendingTemplate.current)return;const template=templates.find(item=>item.id===pendingTemplate.current);if(template){pendingTemplate.current=undefined;applyTemplate(template);}},[applyTemplate,initialized,templates]);
  const fillFields = () => {const values=fieldValues();patch({generatedSections:materializeProposalTemplate(draft.generatedSections,values).sections,coverNote:fillProposalFields(draft.coverNote,values),termsAndConditions:fillProposalFields(draft.termsAndConditions,values)});};
  const generate = async () => {
    if(!draft.title.trim()){setError('Add a title before generating content.');return;}
    if(generationMode === 'replace_selected' && !generationSections.length){setError('Select the sections you want AI to revise.');return;}
    setGenerating(true);setError('');
    try{const lineItems=draft.lineItems.filter(item=>item.name.trim()).map(({id:_id,total:_total,...item})=>({...item,quantity:Number(item.quantity ?? 1),unitPrice:Number(item.unitPrice ?? 0),discount:Number(item.discount ?? 0)}));const onboardingPlan={...draft.onboardingPlan,checklist:(draft.onboardingPlan.checklist || []).filter(item=>item.title.trim())};const result=await api.post<Suggestion>('/api/proposals/suggest',{...draft,onboardingPlan,lineItems,validUntil:draft.validUntil ? `${draft.validUntil}T23:59:59.999Z` : null,generationMode,generationSections,context:generationContext});setSuggestion(result);}catch(failure){setError(errorMessage(failure));}finally{setGenerating(false);}
  };
  const applySuggestion = () => {if(!suggestion)return;patch({coverNote:suggestion.coverNote ?? draft.coverNote,termsAndConditions:suggestion.termsAndConditions ?? draft.termsAndConditions,generatedSections:suggestion.generatedSections || suggestion.metadata?.generatedSections || draft.generatedSections,lineItems:suggestion.lineItems?.length && !draft.lineItems.length ? suggestion.lineItems : draft.lineItems});setSources(suggestion.metadata?.sources || sources);setSuggestion(undefined);};
  const restore = async () => {
    const selected=recoveryRef.current;
    if(!selected)return;
    const session=sessionRef.current, request=++restoreRequest.current;
    // A read belongs to this restore attempt and this recovery choice. Choosing
    // the current version or retrying retires its result, error and navigation.
    const isCurrentRestore=()=>isCurrent(session) && restoreRequest.current===request && recoveryRef.current===selected;
    if(!isCurrentRestore())return;
    setError('');
    try {
      if(selected.id) {
        const record=await api.get<ProposalRecord>(`/api/proposals/${selected.id}`);
        if(!isCurrentRestore())return;
        if(record.status !== 'draft'){router.push(`/dashboard/proposals/${record.id}`);return;}
        idRef.current=record.id;setSavedId(record.id);revisionRef.current=selected.revision ?? record.revision;
        if(selected.revision && selected.revision !== record.revision) {
          conflictRef.current=true;setConflict(true);
          setError('The saved proposal has a newer version. Your recovered edits are shown here; reload the current draft before choosing what to copy.');
        }
      }
      if(!isCurrentRestore())return;
      draftRef.current=selected.draft;setDraft(selected.draft);recoveryRef.current=undefined;setRecovery(undefined);
      retainDraft();setSaveStatus('Recovered edits · not saved online');
    } catch(failure) {if(isCurrentRestore())setError(errorMessage(failure));}
  };
  const exportPdf = async()=>{if(!documentRef.current?.firstElementChild)return;setExporting(true);try{await downloadProposalPdf(documentRef.current.firstElementChild as HTMLElement,draft.title);}catch(failure){setError(errorMessage(failure));}finally{setExporting(false);}};
  const advance = async()=>{const session=sessionRef.current;try{await save();if(isCurrent(session))setStep(current=>Math.min(4,current+1));}catch{/* Retain recoverable input. */}};
  const selectedTemplate=templates.find(template=>template.id === draft.templateId);
  const requiredTemplateFields=selectedTemplate?.templateContent?.requiredFields || [];
  const missingTemplateFields=missingProposalTemplateFields(requiredTemplateFields,fieldValues());
  const currentDocument=documentOf(draft,{requiredTemplateFields,missingTemplateFields});
  const readiness=getProposalReadiness(currentDocument,{channel,includeApproval:false});
  const reviewWarnings=readiness.issues.filter(issue=>issue.severity==='warning');
  const missing=missingProposalRequirements(draft.requirements);
  const suggestionDraft=suggestion ? {...draft,...suggestion,generatedSections:suggestion.generatedSections || suggestion.metadata?.generatedSections || draft.generatedSections} : draft;
  const suggestionChanges=suggestion ? compareProposalVersions(documentOf(draft),documentOf(suggestionDraft)) : [];
  const reusable=templates.flatMap(template=>(template.templateContent?.sections || []).map(section=>({...section,title:`${template.name}: ${section.title}`})));
  const openReview = async()=>{
    const session=sessionRef.current, request=++reviewRequest.current;
    setOpeningReview(true);
    try {
      const id=await save();
      if(!isCurrent(session) || request!==reviewRequest.current || !id)return;
      const latest=draftRef.current;
      if(savedHash.current!==JSON.stringify(latest)) {setError('Your proposal changed. Save the latest edits before delivery review.');return;}
      // Recheck fields edited while the flush was pending before leaving the editor.
      const context=reviewContext.current;
      const required=context.templates.find(template=>template.id===latest.templateId)?.templateContent?.requiredFields || [];
      const values={...latest.templateValues,client_name:latest.recipientName,customer_name:latest.recipientName,client_email:latest.recipientEmail,recipient_email:latest.recipientEmail,company_name:context.brand?.companyName,proposal_title:latest.title,currency:latest.currency,valid_until:latest.validUntil,today:new Date().toISOString().slice(0,10),...latest.requirements};
      if(!getProposalReadiness(documentOf(latest,{requiredTemplateFields:required,missingTemplateFields:missingProposalTemplateFields(required,values)}),{channel:context.channel,includeApproval:false}).ready){setError('Complete the current document checks before delivery review.');return;}
      try {if(storageKey)localStorage.removeItem(storageKey);}catch{/* The confirmed draft can still be reviewed if browser storage is unavailable. */}
      session.active=false;
      router.push(`/dashboard/proposals/${id}?send=1&channel=${context.channel}`);
    }catch{/* Save errors keep the latest browser draft and stay in this editor. */}
    finally{if(isCurrent(session) && request===reviewRequest.current)setOpeningReview(false);}
  };

  if(!initialized)return <div className={`page-shell ${styles.workspace}`}><p role="status" className="flex items-center gap-2">{!error && <Spinner label={null} />}{saveStatus}</p>{error && <><p role="alert" className="text-sm text-destructive">{error}</p><p className="text-sm text-muted-foreground">Retry loading the proposal and linked customer. Any browser recovery draft will be retained.</p><Button variant="outline" onClick={()=>setLoadAttempt(attempt=>attempt+1)}>Retry loading proposal</Button><Button variant="ghost" onClick={()=>navigateAway('/dashboard/proposals')}>Back to proposals</Button></>}</div>;
  return <div className={`page-shell ${styles.workspace} ${styles.editorShell} pb-28 [&_button]:min-h-10 [&_button]:min-w-10`} data-creator-composer>
    <header className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-start gap-3"><Button variant="ghost" size="icon" className="h-10 w-10" aria-label="Back to proposals" onClick={()=>navigateAway('/dashboard/proposals')}><ArrowLeft className="h-4 w-4" /></Button><div><p className="eyebrow">{proposalId ? 'Edit proposal' : 'New proposal'}</p><h1 className="page-title">{draft.title || 'Build an offer your customer can review'}</h1><p role="status" aria-live="polite" className="mt-1 text-xs text-muted-foreground">{saveStatus}{savedId ? ` · Draft #${savedId}` : ''}</p></div></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>setPreview(!preview)} aria-pressed={preview}><Eye className="mr-2 h-4 w-4" />{preview ? 'Close preview' : 'Customer preview'}</Button><Button disabled={saveStatus === 'Saving…' || conflict || !!recovery} onClick={()=>void save().catch(()=>{})}><Save className="mr-2 h-4 w-4" />Save draft</Button></div></header>
    {recovery && <Callout tone="warning" actions={<><Button variant="outline" onClick={()=>void restore()}>Restore draft</Button><Button variant="ghost" onClick={()=>{restoreRequest.current++;recoveryRef.current=undefined;setRecovery(undefined);setError('');}}>Use current version</Button></>}>An unfinished draft from {new Date(recovery.savedAt).toLocaleString()} is available: <strong>{recovery.draft.title || 'Untitled proposal'}</strong>.</Callout>}
    {error && <Callout tone="danger" actions={conflict && <Button variant="outline" onClick={()=>window.location.reload()}>Reload current draft</Button>}>{error}</Callout>}
    {loadError && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{loadError}</p>}
    <nav aria-label="Proposal creation steps" className={styles.steps}>{steps.map((label,index)=><button key={label} type="button" aria-current={step===index ? 'step' : undefined} onClick={()=>setStep(index)} className={styles.step}><span className={styles.stepNumber}>{index+1}</span><span>{label}</span></button>)}</nav>
    <div className={`${styles.editorGrid} ${preview || step===3 ? styles.previewLayout : ''}`}>
      <fieldset disabled={generating || !!suggestion || !!recovery} className={`${styles.editorFields} space-y-6`}>
        {step===0 && <><section className="space-y-4 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">Who is this offer for?</h2>{<ProposalSourcePicker value={{contactId:draft.contactId,outreachConversationId:draft.outreachConversationId,supportTicketId:draft.supportTicketId,chatThreadId:draft.chatThreadId}} onChange={source=>patch({contactId:undefined,leadId:undefined,outreachConversationId:undefined,supportTicketId:undefined,chatThreadId:draft.chatThreadId,...source})} onRecipient={(recipientName,recipientEmail)=>patch({recipientName,recipientEmail})} />}
          <label className="block space-y-2 text-sm">Proposal title <span className="text-destructive">*</span><Input value={draft.title} onChange={event=>patch({title:event.target.value})} placeholder="Website launch for Acme" /></label><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-sm">Customer name<Input value={draft.recipientName} onChange={event=>patch({recipientName:event.target.value})} autoComplete="name" /></label><label className="space-y-2 text-sm">Customer email<Input type="email" value={draft.recipientEmail} onChange={event=>patch({recipientEmail:event.target.value})} autoComplete="email" /><span className="text-xs text-muted-foreground">Required when delivering by email.</span></label></div>
          <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-sm">Currency<select className="h-10 w-full rounded-md border bg-background px-3" value={draft.currency} onChange={event=>patch({currency:event.target.value})}>{['USD','EUR','GBP','INR','CAD','AUD','JPY','SGD','AED'].map(value=><option key={value}>{value}</option>)}</select></label><label className="space-y-2 text-sm">Valid until<Input type="date" value={draft.validUntil} min={new Date().toISOString().slice(0,10)} onChange={event=>patch({validUntil:event.target.value})} /></label></div>
        </section><section className="space-y-4 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">Requirements</h2><p className="text-sm text-muted-foreground">Give AI the agreed facts. Leave unknowns blank so they can be identified for review.</p>{(Object.keys(requirementLabels) as Array<keyof ProposalRequirements>).map(field=><label key={field} className="block space-y-2 text-sm">{requirementLabels[field]}<Textarea rows={2} value={draft.requirements[field] || ''} onChange={event=>patch({requirements:{...draft.requirements,[field]:event.target.value}})} /></label>)}</section></>}
        {step===1 && <section className="space-y-4"><div><h2 className="text-lg font-semibold">Choose a starting point</h2><p className="mt-1 text-sm text-muted-foreground">Applying a template replaces document sections. Your entered cover note, prices and terms are retained.</p></div><div className="grid gap-3 sm:grid-cols-2"><button type="button" className={`min-h-32 rounded-xl border p-4 text-left ${!draft.templateId ? 'border-primary bg-primary/5' : 'bg-card'}`} onClick={()=>patch({templateId:undefined})}><strong>Start with your own scope</strong><p className="mt-2 text-xs text-muted-foreground">Keep the current document and create your own sections.</p></button>{templates.map(template=><button type="button" key={template.id} className={`space-y-3 rounded-xl border p-4 text-left ${draft.templateId===template.id ? 'border-primary bg-primary/5' : 'bg-card hover:border-primary/40'}`} onClick={()=>applyTemplate(template)}><span className="block text-xs text-muted-foreground">{template.userId ? 'My template' : 'Standard template'} · {template.category || 'General'}</span><strong className="block">{template.name}</strong><p className="text-sm text-muted-foreground">{template.description}</p><div className="flex flex-wrap gap-1">{template.templateContent?.sections.slice(0,4).map((section,index)=><span key={index} className="rounded bg-muted px-2 py-1 text-xs">{section.title}</span>)}</div></button>)}</div>
          {selectedTemplate && <><p className="text-xs text-muted-foreground">Selected: {selectedTemplate.name}. Apply it above to load its content into this draft.</p>{!!selectedTemplate.templateContent?.requiredFields?.length && <div className="space-y-3 rounded-xl border bg-card p-4"><h3 className="text-sm font-semibold">Template fields</h3>{selectedTemplate.templateContent.requiredFields.map(field=><label key={field} className="block space-y-1 text-sm">{field.replaceAll('_',' ')}<Input value={draft.templateValues[field] || ''} onChange={event=>patch({templateValues:{...draft.templateValues,[field]:event.target.value}})} /></label>)}<Button type="button" variant="outline" onClick={fillFields}>Fill known fields in document</Button></div>}</>}
        </section>}
        {step===2 && <><ProposalTextEditor id="proposal-cover" label="Cover note and introduction" value={draft.coverNote} onChange={coverNote=>patch({coverNote})} rows={5}/><ProposalSectionEditor sections={draft.generatedSections} onChange={generatedSections=>{patch({generatedSections});setGenerationSections([]);}} reusable={reusable}/><ProposalCommercialEditor items={draft.lineItems} commercial={draft.commercial} currency={draft.currency} discountType={draft.discountType} discountValue={draft.discountValue} taxRate={draft.taxRate} catalog={catalog} onItems={lineItems=>patch({lineItems})} onCommercial={commercial=>patch({commercial})} onDiscount={(discountType,discountValue)=>patch({discountType,discountValue})} onTax={taxRate=>patch({taxRate})}/><ProposalTextEditor id="proposal-terms" label="Terms and conditions" value={draft.termsAndConditions} onChange={termsAndConditions=>patch({termsAndConditions,showTermsAndConditions:true})}/><label className="flex min-h-10 items-center gap-3 text-sm"><Checkbox checked={draft.signatureRequired} onCheckedChange={checked=>patch({signatureRequired:checked===true})}/>Require a typed signature when accepting</label></>}
        {step===3 && <section className="space-y-4 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">Review before sending</h2><p className="text-sm text-muted-foreground">Check the document, all offered prices and the delivery recipient. Account and approval checks happen in the delivery review.</p><label className="block space-y-2 text-sm">Planned delivery channel<select className="h-10 w-full rounded-md border bg-background px-3" value={channel} onChange={event=>setChannel(event.target.value as ProposalChannel)}>{Object.entries(PROPOSAL_CHANNEL_LABELS).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
          {readiness.ready ? <><Callout tone="success" icon={Check}>Content checks passed. This does not send or approve the proposal; approval and account checks happen in the delivery review.</Callout>{reviewWarnings.length>0 && <Callout tone="warning" announce title="Confirm before sending"><ul className="space-y-1">{reviewWarnings.map(issue=><li key={issue.code}>{issue.message}</li>)}</ul></Callout>}</> : <ul className="space-y-2">{readiness.issues.map(issue=><li key={issue.code} className="rounded-lg border p-3 text-sm"><button type="button" className="text-left underline underline-offset-4" onClick={()=>setStep(['recipientName','recipientEmail','title','currency','validUntil'].includes(issue.field)?0:2)}>{issue.message}</button></li>)}</ul>}
          <label className="block space-y-2 text-sm">Assumptions to verify<Textarea value={draft.assumptions.join('\n')} onChange={event=>patch({assumptions:event.target.value.split('\n').filter(Boolean)})} placeholder="One assumption per line" rows={3}/></label><label className="flex min-h-10 items-center gap-2 text-sm"><Checkbox checked={draft.approvalRequired} onCheckedChange={checked=>patch({approvalRequired:checked===true})}/>Require review before sending</label><label className="flex min-h-10 items-center gap-2 text-sm"><Checkbox checked={draft.autoOnboard} onCheckedChange={checked=>patch({autoOnboard:checked===true})}/>Create onboarding on acceptance</label>
          {draft.autoOnboard && <OnboardingEditor plan={draft.onboardingPlan} resources={onboardingResources} onChange={onboardingPlan=>patch({onboardingPlan})}/>}
          <Button variant="outline" disabled={exporting} onClick={()=>void exportPdf()}><Download className="mr-2 h-4 w-4"/>{exporting?'Preparing PDF…':'Download preview PDF'}</Button>
        </section>}
        {step===4 && <section className="space-y-4 rounded-xl border bg-card p-6"><p className="eyebrow">Final step</p><h2 className="text-xl font-semibold">Review the delivery</h2><p className="text-sm text-muted-foreground">Choose a connected account and the customer conversation, review the message and approve this version before sending.</p>{!readiness.ready && <p className="text-sm text-amber-700 dark:text-amber-400">Complete {readiness.issues.filter(issue=>issue.severity==='error').length} document checks on the Review step before delivery.</p>}<Button disabled={!readiness.ready || conflict || openingReview} onClick={()=>void openReview()}>Open delivery review<ArrowRight className="ml-2 h-4 w-4"/></Button>{openingReview && <><p role="status" className="text-sm text-muted-foreground">Saving the latest draft before opening delivery review…</p><Button variant="outline" onClick={()=>{reviewRequest.current++;setOpeningReview(false);}}>Cancel delivery review</Button></>}</section>}
      </fieldset>
      <aside className={`${styles.editorAside} space-y-4`}>{preview || step===3 ? <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Customer preview</h2><Button variant="outline" size="sm" className="min-h-10" aria-pressed={mobilePreview} onClick={()=>setMobilePreview(!mobilePreview)}>{mobilePreview?'Desktop width':'Mobile width'}</Button></div><div ref={documentRef} className={`${styles.previewPaper} ${mobilePreview?'mx-auto max-w-[390px]':''}`}><ProposalDocument proposal={currentDocument} brand={brand}/></div></div> : <><div className="space-y-3 rounded-xl border bg-card p-4"><h2 className="text-sm font-semibold">{readiness.ready ? 'Ready to send' : 'Send readiness'}</h2><dl className="space-y-2 border-b pb-3 text-xs text-muted-foreground">{[['Subtotal',readiness.pricing.subtotal],['Discount',-readiness.pricing.discount],['Tax',readiness.pricing.tax]].map(([label,amount])=><div key={String(label)} className="flex justify-between gap-3"><dt>{label}</dt><dd className="font-medium tabular-nums text-foreground">{draft.currency} {Number(amount).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}</dd></div>)}</dl><p className="text-2xl font-semibold tabular-nums">{draft.currency} {readiness.pricing.total.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}</p><p className="text-xs text-muted-foreground">Initial total · includes selected options, discount and tax</p><p className="text-sm">{readiness.ready?'Content checks passed':`${readiness.issues.filter(issue=>issue.severity==='error').length} items need attention`}</p><Button variant="outline" className="w-full" onClick={()=>setStep(3)}>Review checklist</Button></div><div className="space-y-3 rounded-xl border bg-card p-4"><h2 className="text-sm font-semibold">Requirements and sources</h2>{missing.length ? <ul className="space-y-2 text-xs text-muted-foreground">{missing.map(field=><li key={field}>Confirm {requirementLabels[field].toLowerCase()}.</li>)}</ul> : <p className="text-xs text-muted-foreground">All requirement fields have been provided.</p>}{sources.length ? <ul className="space-y-1 border-t pt-3 text-xs">{sources.map((source,index)=><li key={index}>{source.label}</li>)}</ul> : <p className="text-xs text-muted-foreground">Source references appear after loading or generating from linked customer records.</p>}</div></>}
        <div className="space-y-3 rounded-xl border bg-card p-4"><h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4"/>Draft with AI</h2><select aria-label="AI editing mode" className="h-10 w-full rounded-md border bg-background px-2 text-sm" value={generationMode} onChange={event=>setGenerationMode(event.target.value as typeof generationMode)}><option value="fill_missing">Fill missing content</option><option value="replace_selected">Revise selected sections</option></select>{generationMode==='replace_selected' && <div className="space-y-2">{draft.generatedSections.map((section,index)=><label className="flex min-h-10 items-center gap-2 text-sm" key={index}><Checkbox checked={generationSections.includes(index)} onCheckedChange={checked=>setGenerationSections(current=>checked===true?[...current,index]:current.filter(value=>value!==index))}/>{section.title}</label>)}</div>}<Textarea aria-label="AI revision instructions" rows={3} placeholder="For example: shorten the scope and use a two-phase timeline." value={generationContext} onChange={event=>setGenerationContext(event.target.value)}/><Button variant="outline" className="w-full" loading={generating} loadingText="Preparing suggestions…" disabled={!!suggestion || !draft.title.trim()} onClick={()=>void generate()}><Sparkles className="mr-2 h-4 w-4"/>Generate for review</Button><p className="text-xs text-muted-foreground">Entered prices, terms and completed sections are preserved unless selected for revision.</p>{generating && <p role="status" className="text-xs text-muted-foreground">Using the business profile, linked conversation and knowledge base. Your current inputs are retained if generation fails.</p>}</div>
      </aside>
    </div>
    {suggestion && <section className="space-y-4 rounded-xl border border-primary/40 bg-card p-5" aria-label="Review AI suggestions"><h2 className="text-lg font-semibold">Review AI suggestions</h2><p className="text-sm text-muted-foreground">Check the proposed wording and any unresolved fields before applying it to this draft.</p>{suggestionChanges.length ? suggestionChanges.map((change,index)=><details key={index} className="rounded-lg border p-3" open={index===0}><summary className="cursor-pointer font-medium">{change.field}</summary><div className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><div><p className="mb-2 text-xs text-muted-foreground">Current</p><pre className="whitespace-pre-wrap font-sans">{change.before || 'Empty'}</pre></div><div><p className="mb-2 text-xs text-muted-foreground">Suggested</p><pre className="whitespace-pre-wrap font-sans">{change.after || 'Empty'}</pre></div></div></details>):<p>No customer-facing changes were suggested.</p>}<div className="flex flex-wrap gap-2"><Button onClick={applySuggestion}>Apply suggestions</Button><Button variant="outline" onClick={()=>setSuggestion(undefined)}>Keep current draft</Button></div></section>}
    <footer className={styles.editorFooter}><Button variant="outline" disabled={step===0} onClick={()=>setStep(current=>Math.max(0,current-1))}>Previous</Button>{step<4 && <Button disabled={generating || !!suggestion || conflict || recovery!==undefined} onClick={()=>void advance()} data-creator-action>Continue to {steps[step+1]}<ArrowRight className="ml-2 h-4 w-4"/></Button>}</footer>
  </div>;
}
