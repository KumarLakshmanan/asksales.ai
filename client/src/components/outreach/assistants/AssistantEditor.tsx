"use client";

import { EmailDesignDefaults } from '../EmailDesignPicker';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, CheckCircle2, Pause, Play, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import api, { ApiError } from '@/lib/api';
import { ASSISTANT_API, useAssistantDetail, useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { PageErrorState, PageLoadingState } from '@/components/ui/page-state';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { assistantBindingKey, assistantDraftIssues, displayedAssistantState, type AssistantBindingInput, type AssistantCatalog, type AssistantDraft, type AssistantReadiness, type OutreachAssistant } from '@/lib/outreach-assistants';
import { AvailabilityConfiguration } from './AssistantAvailability';
import { BasicConfiguration, ModelConfiguration, PrivacyConfiguration } from './AssistantConfiguration';
import { FollowUpsConfiguration, PlaybooksConfiguration, ToolsConfiguration } from './AssistantJourneys';
import { AssistantDeliveryHistory } from './AssistantSimulator';
import { ConfigurationSection, ErrorNotice, RuntimeNotice, StateBadge, WorkspaceGate } from './AssistantShared';
import { AssistantRevisionHistory } from './AssistantRevisionHistory';
import { AssistantTestDrawer } from './AssistantTestDrawer';
import { AssistantSetupGuide } from './AssistantSetupGuide';
import { AssistantEditorStepper } from './AssistantEditorStepper';
import { AssistantPublishReview } from './AssistantPublishReview';
import { AssistantResourceSelection } from './AssistantResourceSelection';
import { assistantSetupSections } from './assistantEditorUtils';
import { useAssistantDraftRecovery } from './useAssistantDraftRecovery';
import { useAssistantEditorGuard } from './useAssistantEditorGuard';
import { assistantFollowUpSaveIssues } from '@/lib/outreach-assistants';

const tabDefinitions = [
  ['basic', 'Basic & channels'], ['ai', 'AI configuration'], ['knowledge', 'Knowledge'], ['privacy', 'Privacy & policies'],
  ['playbooks', 'Playbooks'], ['followups', 'Follow-ups'], ['tools', 'Tools & media'], ['availability', 'Availability & access'],
] as const;
const DRAFT_SAVED_NOTICE = 'Draft saved. Customer replies keep using the published configuration.';
const cloneDraft = (draft: AssistantDraft): AssistantDraft => JSON.parse(JSON.stringify(draft)) as AssistantDraft;
function publishConflictBindings(failure: unknown, draft: AssistantDraft): AssistantBindingInput[] {
  if (!(failure instanceof ApiError) || failure.status !== 409) return [];
  const bindings = (failure.data as { details?: { bindings?: unknown } } | null)?.details?.bindings;
  if (!Array.isArray(bindings)) return [];
  // Only expose conflicts on the reviewed draft's exact account/surface tuple.
  // Server details must never broaden the accounts the user is confirming.
  return draft.bindings.filter(binding => bindings.some(conflict => conflict && typeof conflict === 'object'
    && conflict.channel === binding.channel && conflict.surface === binding.surface && conflict.accountId === binding.accountId));
}

export default function AssistantEditor({ assistantId }: { assistantId: string }) {
  const workspace = useAssistantWorkspace();
  const detail = useAssistantDetail(workspace, assistantId);
  return <WorkspaceGate workspace={workspace}>{detail.isLoading ? <PageLoadingState label="Loading assistant configuration…" /> : detail.isError ? <PageErrorState title="Assistant could not be loaded" description={detail.error.message} reset={() => void detail.refetch()} /> : detail.data && workspace.catalog.data && <AssistantEditorWorkspace key={`${workspace.profileId}:${assistantId}`} assistant={detail.data} catalog={workspace.catalog.data} workspace={workspace} />}</WorkspaceGate>;
}
function AssistantEditorWorkspace({ assistant, catalog, workspace }: { assistant: OutreachAssistant; catalog: AssistantCatalog; workspace: ReturnType<typeof useAssistantWorkspace> }) {
  const cache = useQueryClient();
  const router = useRouter();
  const [saved, setSaved] = useState(assistant);
  const [draft, setDraft] = useState(() => cloneDraft(assistant.draft));
  const [tab, setTab] = useState('basic');
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const navigate = (next: string) => {
    setTab(next);
    // Keep the address on the visible step so a refresh or shared link reopens it.
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    requestAnimationFrame(() => stepHeading.current?.focus());
  };
  const stepIndex = tabDefinitions.findIndex(([value]) => value === tab);
  const setup = assistantSetupSections(draft, catalog);
  useEffect(() => { const requested = new URLSearchParams(window.location.search).get('tab'); if (requested && tabDefinitions.some(([value]) => value === requested)) setTab(requested); }, [assistant.id]);
  const [busy, setBusy] = useState<'save' | 'readiness' | 'publish' | 'pause' | 'resume' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reassign, setReassign] = useState(false);
  const [publishConflicts, setPublishConflicts] = useState<AssistantBindingInput[]>([]);
  const [readiness, setReadiness] = useState<AssistantReadiness>(assistant.readiness);
  const [policyValid, setPolicyValid] = useState(true);
  const [resetEpoch, setResetEpoch] = useState(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.draft) || !policyValid;
  // A save confirmation must not stay on screen beside newer unsaved edits.
  useEffect(() => { if (dirty) setNotice(current => current === DRAFT_SAVED_NOTICE ? '' : current); }, [dirty]);
  const canManage = catalog.permissions.canManage;
  const canDelete = canManage && ['draft', 'paused'].includes(saved.state) && saved.publishedRevision === null && saved.published === null;
  const issues = assistantDraftIssues(draft, catalog);
  const recovery = useAssistantDraftRecovery({ scope: workspace.scopeKey, assistantId: saved.id, version: saved.draftVersion, draft, saved: saved.draft, dirty, onRestore: next => { setDraft(next); setResetEpoch(value => value + 1); setNotice('Recovered configuration selections. Review and save before publishing.'); } });
  useAssistantEditorGuard(dirty, !!busy);
  const conflicts = draft.bindings.filter(binding => {
    const account = catalog.accounts.find(item => assistantBindingKey(item) === assistantBindingKey(binding));
    return (account?.assignedAssistantId && account.assignedAssistantId !== saved.id)
      || publishConflicts.some(conflict => assistantBindingKey(conflict) === assistantBindingKey(binding));
  });
  const conflictSignature = conflicts.map(assistantBindingKey).join('|');
  useEffect(() => { setReassign(false); }, [conflictSignature]);
  useEffect(() => {
    if (!dirty && (assistant.draftVersion !== saved.draftVersion || assistant.updatedAt !== saved.updatedAt)) {
      setSaved(assistant); setDraft(cloneDraft(assistant.draft)); setReadiness(assistant.readiness); setResetEpoch(value => value + 1);
    }
  }, [assistant, dirty, saved.draftVersion, saved.updatedAt]);
  const path = `${ASSISTANT_API}/${encodeURIComponent(saved.id)}`;
  const accept = async (next: OutreachAssistant) => {
    recovery.clear();
    setSaved(next); setDraft(cloneDraft(next.draft)); setReadiness(next.readiness); setPolicyValid(true); setPublishConflicts([]); setResetEpoch(value => value + 1);
    cache.setQueryData([...workspace.scopeKey, saved.id], next);
    await cache.invalidateQueries({ queryKey: workspace.scopeKey });
  };
  const execute = async (operation: Exclude<typeof busy, null>, action: () => Promise<void>) => {
    if (busy || !canManage) return;
    setBusy(operation); setError(''); setNotice('');
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'The assistant could not be updated. Try again.'); } finally { setBusy(null); }
  };
  const save = () => execute('save', async () => {
    const followUpIssues = assistantFollowUpSaveIssues(draft.followUps);
    if (followUpIssues.length) { navigate('followups'); setError(followUpIssues.join(' ')); return; }
    const result = await api.put<OutreachAssistant>(path, { draft, expectedDraftVersion: saved.draftVersion }, workspace.requestOptions);
    await accept(result); setNotice(DRAFT_SAVED_NOTICE);
  });
  const review = () => execute('readiness', async () => {
    const result = await api.post<AssistantReadiness>(`${path}/readiness`, {}, workspace.requestOptions);
    setReadiness(result); setPublishConflicts([]); setReassign(false); setReviewOpen(true);
  });
  const publish = () => execute('publish', async () => {
    let result: OutreachAssistant;
    try {
      result = await api.post<OutreachAssistant>(`${path}/publish`, { expectedDraftVersion: saved.draftVersion, confirmAssignments: true, reassign }, workspace.requestOptions);
    } catch (failure) {
      const detected = publishConflictBindings(failure, draft);
      if (detected.length) { setPublishConflicts(detected); setReassign(false); }
      throw failure;
    }
    await accept(result); setReviewOpen(false); setNotice(catalog.runtimeEnabled
      ? `Published revision ${result.publishedRevision}. The assigned accounts will use this configuration on their next turn.`
      : `Published revision ${result.publishedRevision}. Customer delivery remains blocked until assistant runtime is enabled.`);
  });
  const discard = () => { recovery.clear(); setDraft(cloneDraft(saved.draft)); setPolicyValid(true); setResetEpoch(value => value + 1); setError(''); setNotice('Unsaved changes discarded.'); };
  const state = displayedAssistantState(saved, catalog);
  return <div className="ak-workspace ak-editor [&_button]:min-h-11"><Link href="/dashboard/settings/outreach" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Assistants</Link><div className="ak-editor-layout"><AssistantEditorStepper steps={setup} current={tab} onChange={navigate} /><div className="ak-editor-content"><PageHeader className="ak-page-header" icon={Bot} title={saved.draft.name || 'Configure assistant'} subtitle={`Saved draft v${saved.draftVersion}${saved.publishedRevision ? ` · Published revision ${saved.publishedRevision}` : ' · Not published'}. Saving a draft never changes customer replies.`} actions={<><StateBadge state={state} /><Button type="button" variant="outline" disabled={!!busy} onClick={() => setTestOpen(true)}>Test assistant</Button>{canManage && ['live', 'needs_attention'].includes(saved.state) && saved.publishedRevision && <Button variant="outline" disabled={!!busy || dirty} onClick={() => void execute('pause', async () => { await accept(await api.post<OutreachAssistant>(`${path}/pause`, {}, workspace.requestOptions)); setNotice('Assistant paused. Unsent automated replies and support follow-ups are cancelled.'); })}><Pause className="h-4 w-4" />Pause</Button>}{canManage && saved.state === 'paused' && saved.publishedRevision && <Button variant="outline" disabled={!!busy || dirty || !catalog.runtimeEnabled} onClick={() => void execute('resume', async () => { await accept(await api.post<OutreachAssistant>(`${path}/resume`, {}, workspace.requestOptions)); setNotice('Assistant resumed after readiness checks.'); })}><Play className="h-4 w-4" />Resume</Button>}{canManage && <Button disabled={!!busy || dirty} onClick={() => void review()}>{busy === 'readiness' ? 'Checking readiness…' : 'Review & publish'}</Button>}</>} /><RuntimeNotice enabled={catalog.runtimeEnabled} /><ErrorNotice message={error} />{notice && <p role="status" className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />{notice}</p>}{!canManage && <p className="text-sm text-muted-foreground">Read-only configuration. {catalog.permissions.description}</p>}
    {recovery.banner}<AssistantSetupGuide draft={draft} catalog={catalog} disabled={!canManage || !!busy} onChange={setDraft} onNavigate={navigate} onTest={() => setTestOpen(true)} history={<AssistantRevisionHistory assistant={saved} catalog={catalog} workspace={workspace} disabled={dirty || !!busy} onAccept={accept} />} />
    {!policyValid && <p role="alert" className="text-sm text-destructive">Repair the policy JSON in Privacy & policies before saving.</p>}
    {dirty && <p className="text-sm text-muted-foreground">Save your draft to test it or review publishing.</p>}
    <div className="min-w-0 space-y-4"><h2 ref={stepHeading} tabIndex={-1} className="text-lg font-semibold outline-none">{stepIndex + 1}. {setup[stepIndex]?.label}</h2><fieldset disabled={!canManage || !!busy} className="min-w-0">
      <div hidden={tab !== 'basic'}><BasicConfiguration draft={draft} catalog={catalog} onChange={setDraft} assistantId={saved.id} /></div>
      <div hidden={tab !== 'ai'}><ModelConfiguration draft={draft} catalog={catalog} onChange={setDraft} onTest={() => setTestOpen(true)} />{tab === 'ai' && <div className="mt-4"><EmailDesignDefaults /></div>}</div>
      <div hidden={tab !== 'knowledge'}><ConfigurationSection title="Published knowledge sources" description="Choose the published sources this assistant can use to answer customer questions."><AssistantResourceSelection category="knowledge" label="Knowledge sources" resources={catalog.knowledge} unavailableResources={catalog.unavailableResources?.filter(resource => resource.category === 'knowledge')} value={draft.knowledge} onChange={knowledge => setDraft({ ...draft, knowledge })} /></ConfigurationSection></div>
      <div hidden={tab !== 'privacy'}><PrivacyConfiguration key={resetEpoch} draft={draft} catalog={catalog} onChange={setDraft} onPolicyValidity={setPolicyValid} /></div>
      <div hidden={tab !== 'playbooks'}><PlaybooksConfiguration draft={draft} catalog={catalog} onChange={setDraft} /></div>
      <div hidden={tab !== 'followups'}><FollowUpsConfiguration draft={draft} catalog={catalog} onChange={setDraft} history={<AssistantDeliveryHistory assistantId={saved.id} workspace={workspace} active={tab === 'followups'} timezone={(saved.published || draft).availability.timezone} />} /></div>
      <div hidden={tab !== 'tools'}><ToolsConfiguration draft={draft} catalog={catalog} onChange={setDraft} /></div>
      <div hidden={tab !== 'availability'}><AvailabilityConfiguration draft={draft} catalog={catalog} onChange={setDraft} /></div>
    </fieldset><div className="ak-save-bar"><div className="ak-step-navigation flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={stepIndex === 0 || !!busy} onClick={() => navigate(tabDefinitions[stepIndex - 1][0])}>Previous step</Button>{stepIndex < tabDefinitions.length - 1 ? <Button type="button" variant="outline" disabled={!!busy} onClick={() => navigate(tabDefinitions[stepIndex + 1][0])}>Next: {setup[stepIndex + 1].label}</Button> : <Button type="button" variant="outline" disabled={!!busy} onClick={() => setTestOpen(true)}>Test assistant</Button>}</div><div className="ak-save-status"><div className="ak-save-copy"><p className="text-sm font-medium">{dirty ? 'Unsaved draft changes' : 'Draft saved'}</p><p className="mt-1 text-xs text-muted-foreground">{saved.publishedRevision ? `Live replies retain revision ${saved.publishedRevision} until you publish.` : 'No customer replies are enabled by this draft.'}</p></div><div className="ak-save-actions"><Button variant="outline" disabled={!dirty || !!busy || !canManage} onClick={discard}><RotateCcw className="h-4 w-4" />Discard</Button><Button disabled={!dirty || !policyValid || !!busy || !canManage} onClick={() => void save()}><Save className="h-4 w-4" />{busy === 'save' ? 'Saving…' : 'Save draft'}</Button></div></div></div></div>

    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground"><span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Privacy, encryption and approval checks stay mandatory.</span>{canDelete && <Button variant="ghost" className="text-destructive" disabled={dirty || !!busy} onClick={() => setDeleteOpen(true)}>Delete assistant</Button>}</div>
    </div></div>
    <AssistantTestDrawer key={resetEpoch} open={testOpen} onOpenChange={setTestOpen} assistant={saved} workspace={workspace} dirty={dirty} />
    <AssistantPublishReview open={reviewOpen} onClose={() => setReviewOpen(false)} draft={draft} draftVersion={saved.draftVersion} catalog={catalog} readiness={readiness} issues={issues} conflicts={conflicts} reassign={reassign} onReassign={setReassign} busy={!!busy} publishing={busy === 'publish'} error={error} onPublish={() => void publish()} />
    <Dialog open={deleteOpen && canDelete} onOpenChange={open => { if (!busy) setDeleteOpen(open); }}><DialogContent><DialogHeader><DialogTitle>Delete {saved.draft.name}?</DialogTitle><DialogDescription>Only an unpublished draft can be deleted. The draft and assignments will be removed; customer conversation history stays in the CRM. Assistants with published history must be retained and can be paused instead.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setDeleteOpen(false)}>Keep assistant</Button><Button variant="destructive" disabled={!!busy || !canDelete} onClick={() => void execute('delete', async () => { await api.delete(path, workspace.requestOptions); await cache.invalidateQueries({ queryKey: workspace.scopeKey }); router.push('/dashboard/settings/outreach'); })}>{busy === 'delete' ? 'Deleting…' : 'Delete assistant'}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
