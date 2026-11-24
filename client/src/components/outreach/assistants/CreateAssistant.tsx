"use client";

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Plus } from 'lucide-react';
import api from '@/lib/api';
import { ASSISTANT_API, useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { assistantBindingKey, assistantChannelLabels, ASSISTANT_CHANNELS, emptyAssistantDraft, type AssistantCatalog, type AssistantDraft, type OutreachAssistant } from '@/lib/outreach-assistants';
import { ConfigurationSection, ErrorNotice, Field, RuntimeNotice, WorkspaceGate } from './AssistantShared';
import { AssistantPresetPicker } from './AssistantPresetPicker';
import { AssistantModelPicker } from './AssistantModelPicker';
import { assistantCreationIssues } from './assistantCreateUtils';
import { useAssistantDraftRecovery } from './useAssistantDraftRecovery';
import { useAssistantEditorGuard } from './useAssistantEditorGuard';

const steps = ['Identity', 'Receiving accounts', 'Model & review'];

export default function CreateAssistant() {
  const workspace = useAssistantWorkspace();
  return <WorkspaceGate workspace={workspace}>{workspace.catalog.data && <CreateAssistantForm key={workspace.profileId} catalog={workspace.catalog.data} workspace={workspace} />}</WorkspaceGate>;
}

function CreateAssistantForm({ catalog, workspace }: { catalog: AssistantCatalog; workspace: ReturnType<typeof useAssistantWorkspace> }) {
  const [baseline] = useState<AssistantDraft>(() => {
    const initial = emptyAssistantDraft();
    if (catalog.models.length === 1) initial.replyModel = { provider: catalog.models[0].provider, model: catalog.models[0].model };
    return initial;
  });
  const [draft, setDraft] = useState(baseline);
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<OutreachAssistant | null>(null);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const router = useRouter();
  const cache = useQueryClient();
  const dirty = !created && JSON.stringify(draft) !== JSON.stringify(baseline);
  const recovery = useAssistantDraftRecovery({ scope: workspace.scopeKey, assistantId: 'new', version: 0, draft, saved: baseline, dirty, onRestore: next => {
    const preset = catalog.presets.find(item => item.agentType === next.agentType);
    setDraft({ ...next, instructions: preset?.instructions || '', policies: preset?.policies || {} });
    setStep(0);
  } });
  useAssistantEditorGuard(dirty, busy);
  const issues = assistantCreationIssues(draft, catalog);
  const selectedAccounts = catalog.accounts.filter(account => draft.bindings.some(binding => assistantBindingKey(account) === assistantBindingKey(binding)));
  const unavailable = draft.bindings.filter(binding => !catalog.accounts.some(account => account.connected && account.surface === 'private' && assistantBindingKey(account) === assistantBindingKey(binding)));
  const selectStep = (next: number) => {
    setStep(next); setAttempted(false); setError('');
    requestAnimationFrame(() => heading.current?.focus());
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || created || !catalog.permissions.canManage) return;
    setAttempted(true);
    const firstIncomplete = issues.findIndex(items => items.length > 0);
    if (firstIncomplete !== -1 && firstIncomplete <= step) {
      if (firstIncomplete !== step) { setStep(firstIncomplete); requestAnimationFrame(() => heading.current?.focus()); }
      return;
    }
    if (step < steps.length - 1) { selectStep(step + 1); return; }
    submitting.current = true; setError(''); setBusy(true);
    let assistant: OutreachAssistant;
    try {
      assistant = await api.post<OutreachAssistant>(ASSISTANT_API, { draft }, workspace.requestOptions);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The draft could not be created. Try again.');
      submitting.current = false; setBusy(false); return;
    }
    // A refresh failure must never turn a successful POST into a retry.
    setCreated(assistant); recovery.clear(); setBusy(false);
    cache.setQueryData([...workspace.scopeKey, assistant.id], assistant);
    void cache.invalidateQueries({ queryKey: workspace.scopeKey }).catch(() => undefined);
    try { router.push(`/dashboard/settings/outreach/assistants/${encodeURIComponent(assistant.id)}?tab=knowledge`); }
    catch { setError('Your draft is saved. Use Continue setup to open it.'); }
  };
  return <div className="ak-workspace max-w-6xl space-y-6 pb-28">
    <header className="space-y-3">
      <Link href="/dashboard/settings/outreach" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft aria-hidden className="h-4 w-4" />Assistants</Link>
      <div><h1 className="text-2xl font-semibold tracking-tight">Create assistant</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Choose its role and accounts, then review the draft. Add knowledge and tools next.</p></div>
    </header>
    <RuntimeNotice enabled={catalog.runtimeEnabled} /><ErrorNotice message={error} />
    {!catalog.permissions.canManage && <p role="alert" className="text-sm text-muted-foreground">The business owner manages assistants. {catalog.permissions.description}</p>}
    {recovery.banner}
    {created ? <section role="status" className="space-y-3 rounded-xl border bg-card p-6"><h2 className="font-semibold">Draft created</h2><p className="text-sm text-muted-foreground">{created.draft.name} is saved. Continue with its knowledge and tools.</p><Button asChild><Link href={`/dashboard/settings/outreach/assistants/${encodeURIComponent(created.id)}?tab=knowledge`}>Continue setup<ArrowRight aria-hidden className="h-4 w-4" /></Link></Button></section> : <form onSubmit={event => void create(event)} noValidate className="space-y-5">
      <ol aria-label="Creation progress" className="grid grid-cols-3 gap-2 rounded-xl border bg-card p-3">
        {steps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined} className={`flex items-center gap-2 rounded-lg px-2 py-2 text-xs sm:text-sm ${step === index ? 'bg-primary/10 font-semibold text-primary' : 'text-muted-foreground'}`}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border" aria-hidden>{index < step ? <Check className="h-3.5 w-3.5" /> : index + 1}</span><span>{label}</span></li>)}
      </ol>
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">{step + 1}. {steps[step]}</h2>
      <fieldset disabled={busy || !catalog.permissions.canManage} className="min-w-0 space-y-5">
        {step === 0 && <ConfigurationSection title="Who will help your customers?">
          <div className="space-y-6"><Field label="Assistant name" htmlFor="new-assistant-name"><Input id="new-assistant-name" maxLength={120} autoComplete="off" placeholder="e.g. Hotel front desk" value={draft.name} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} className="min-h-12 text-base" /></Field>
            <AssistantPresetPicker presets={catalog.presets} value={draft.agentType} onChange={value => {
              const preset = catalog.presets.find(item => item.agentType === value);
              if (preset) setDraft(previous => ({ ...previous, agentType: preset.agentType, instructions: preset.instructions, policies: preset.policies }));
            }} />
          </div>
        </ConfigurationSection>}
        {step === 1 && <ConfigurationSection title="Where should this assistant reply?" description="Select connected accounts across any channels. Existing assignments are reviewed when publishing.">
          <div className="space-y-5">{ASSISTANT_CHANNELS.map(channel => {
            const accounts = catalog.accounts.filter(account => account.channel === channel && account.surface === 'private' && account.connected);
            if (!accounts.length) return null;
            return <fieldset key={channel} className="min-w-0 space-y-2"><legend className="mb-2 text-sm font-semibold">{assistantChannelLabels[channel]}</legend>
              {accounts.map(account => {
                const key = assistantBindingKey(account);
                const selected = draft.bindings.some(binding => assistantBindingKey(binding) === key);
                return <label key={key} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                  <input type="checkbox" aria-label={`${assistantChannelLabels[channel]}: ${account.label}`} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={selected} disabled={draft.bindings.length >= 100 && !selected} onChange={event => {
                    const checked = event.target.checked;
                    setDraft(previous => ({ ...previous, bindings: checked ? [...previous.bindings.filter(binding => assistantBindingKey(binding) !== key), { channel: account.channel, surface: account.surface, accountId: account.accountId }] : previous.bindings.filter(binding => assistantBindingKey(binding) !== key) }));
                  }} />
                  <span className="min-w-0"><span className="block break-words text-sm font-medium">{account.label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{account.assignedAssistantId ? 'Assigned to another assistant. Publishing requires reassignment review.' : 'Connected · Private messages'}</span></span>
                </label>;
              })}
            </fieldset>;
          })}</div>
          {!catalog.accounts.some(account => account.connected && account.surface === 'private') && <p role="status" className="text-sm leading-6 text-muted-foreground">No connected receiving accounts are available. Connect an account to continue.</p>}
          {unavailable.map(binding => <p key={assistantBindingKey(binding)} role="alert" className="mt-3 text-sm text-destructive">A selected account is unavailable. <button type="button" className="underline" onClick={() => setDraft(previous => ({ ...previous, bindings: previous.bindings.filter(item => assistantBindingKey(item) !== assistantBindingKey(binding)) }))}>Remove account</button></p>)}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{draft.bindings.length} receiving {draft.bindings.length === 1 ? 'account' : 'accounts'} selected</p><Button asChild variant="outline" className="min-h-11"><Link href="/dashboard/settings/integrations"><Plus aria-hidden className="h-4 w-4" />Connect account</Link></Button></div>
        </ConfigurationSection>}
        {step === 2 && <div className="grid items-start gap-5 md:grid-cols-2">
          <ConfigurationSection title="Reply model"><AssistantModelPicker hideLabel models={catalog.models} availabilityNotice={catalog.modelAvailabilityNotice} value={draft.replyModel} onChange={replyModel => setDraft(previous => ({ ...previous, replyModel }))} /></ConfigurationSection>
          <ConfigurationSection title="Review your draft"><dl className="space-y-4 text-sm"><div><dt className="text-muted-foreground">Name</dt><dd className="mt-1 break-words font-medium">{draft.name}</dd></div><div><dt className="text-muted-foreground">Role</dt><dd className="mt-1">{catalog.presets.find(preset => preset.agentType === draft.agentType)?.name}</dd></div><div><dt className="text-muted-foreground">Receiving accounts</dt><dd><ul className="mt-1 space-y-2">{selectedAccounts.map(account => <li key={assistantBindingKey(account)}>{assistantChannelLabels[account.channel]} · {account.label}</li>)}</ul></dd></div></dl><p className="mt-5 border-t pt-4 text-sm leading-6 text-muted-foreground">Next: choose knowledge, playbooks and tools, then test the assistant before publishing.</p></ConfigurationSection>
        </div>}
      </fieldset>
      {issues[step].length > 0 && <Callout id="creation-requirements" tone="warning" role={attempted ? 'alert' : undefined} title="To continue"><ul className="list-disc space-y-1 pl-5">{issues[step].map(issue => <li key={issue}>{issue}</li>)}</ul></Callout>}
      <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 shadow-sm"><p className="text-xs leading-5 text-muted-foreground">Saves as a draft. Review before publishing.</p><div className="flex gap-2">{step > 0 && <Button type="button" variant="outline" disabled={busy} onClick={() => selectStep(step - 1)}><ArrowLeft aria-hidden className="h-4 w-4" />Back</Button>}<Button type="submit" className="min-h-11" disabled={busy || !catalog.permissions.canManage} aria-describedby={issues[step].length ? 'creation-requirements' : undefined}>{busy ? 'Creating draft…' : step === 2 ? 'Create draft' : 'Continue'}<ArrowRight aria-hidden className="h-4 w-4" /></Button></div></div>
    </form>}
  </div>;
}
