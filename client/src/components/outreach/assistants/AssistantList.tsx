"use client";

import { useEffect, useState } from 'react';
import { AssistantAssignments } from './AssistantAssignments';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Clock3, Plus, Settings2, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { PageHeader } from '@/components/ui/page-header';
import { WorkspaceSettingsScope } from '@/components/settings/WorkspaceSettingsScope';
import { PageLoadingState, PageErrorState } from '@/components/ui/page-state';
import { useAssistantList, useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import { ASSISTANT_API } from '@/hooks/use-outreach-assistants';
import api from '@/lib/api';
import { accountLabel, assistantBindingKey, assistantListBindings, assistantStateLabels, displayedAssistantState, draftResourceSummary, type AssistantState } from '@/lib/outreach-assistants';
import { ChannelBadge, ErrorNotice, RuntimeNotice, StateBadge, WorkspaceGate, nativeSelectClass } from './AssistantShared';

export default function AssistantList() {
  const workspace = useAssistantWorkspace();
  const [search, setSearch] = useState('');
  const [state, setState] = useState<AssistantState | 'all'>('all');
  const [view, setView] = useState<'assistants' | 'accounts'>('assistants');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search), 250); return () => clearTimeout(timer); }, [search]);
  const query = useAssistantList(workspace, { search: debouncedSearch, state });
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const cache = useQueryClient();
  const catalog = workspace.catalog.data;
  const entries = query.data?.assistants || [];
  const runtimeEnabled = query.data?.runtimeEnabled ?? catalog?.runtimeEnabled ?? false;
  const filtered = catalog ? entries.filter(assistant => {
    const active = ['live', 'needs_attention'].includes(assistant.state) && assistant.published ? assistant.published : assistant.draft;
    const searchable = [active.name, active.description, active.replyModel?.model, ...assistantListBindings(assistant).map(binding => catalog.accounts.find(account => assistantBindingKey(account) === assistantBindingKey(binding))?.label || binding.accountId)].join(' ').toLowerCase();
    return searchable.includes(search.toLowerCase()) && (state === 'all' || displayedAssistantState(assistant, catalog) === state);
  }) : [];
  const importLegacy = async () => {
    if (!catalog?.permissions.canManage || importing) return;
    setImporting(true); setError(''); setNotice('');
    try {
      const result = await api.post<{ assistants: typeof entries }>(`${ASSISTANT_API}/migrate`, {}, workspace.requestOptions);
      await cache.invalidateQueries({ queryKey: workspace.scopeKey });
      setNotice(`${result.assistants.length} assistant${result.assistants.length === 1 ? '' : 's'} available from existing settings. Imported assistants remain paused for review; no customer routing was changed.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Existing settings could not be imported. Try again.'); } finally { setImporting(false); }
  };
  return <WorkspaceGate workspace={workspace}>{query.isLoading ? <PageLoadingState label="Loading assistants…" /> : query.isError && !query.data ? <PageErrorState title="Assistants could not be loaded" description={query.error.message} reset={() => void query.refetch()} /> : catalog && <div className="ak-workspace [&_button]:min-h-11">
    <PageHeader className="ak-page-header" icon={Bot} title="Assistants" subtitle="Choose who replies on each account. Knowledge, privacy, journeys and follow-ups stay with the assigned assistant." actions={<><Button asChild variant="outline"><Link href="/dashboard/outreach/follow-ups"><Clock3 className="h-4 w-4" />Follow-ups</Link></Button><Button asChild variant="outline"><Link href="/dashboard/settings/outreach/operations"><Workflow className="h-4 w-4" />Reply operations</Link></Button>{catalog.permissions.canManage && <Button asChild><Link href="/dashboard/settings/outreach/new"><Plus className="h-4 w-4" />Create assistant</Link></Button>}</>} />
    <WorkspaceSettingsScope detail="Reply behavior belongs to this workspace. Each assignment affects its selected receiving account, channel and message surface." />
    <RuntimeNotice enabled={runtimeEnabled} /><div className="flex flex-wrap gap-2" role="group" aria-label="Assistant workspace view"><Button variant={view === 'assistants' ? 'default' : 'outline'} aria-pressed={view === 'assistants'} onClick={() => setView('assistants')}>Assistants</Button><Button variant={view === 'accounts' ? 'default' : 'outline'} aria-pressed={view === 'accounts'} onClick={() => setView('accounts')}>Account assignments</Button></div>{view === 'accounts' && <AssistantAssignments workspace={workspace} />}
    <ErrorNotice message={error} />{notice && <p role="status" className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm">{notice}</p>}
    <div className={view === 'accounts' ? 'hidden' : 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'}><SearchInput aria-label="Search assistants" placeholder="Search name, account or model" value={search} onValueChange={setSearch} wrapperClassName="max-w-md" className="min-h-11" /><div className="flex items-center gap-3"><span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{filtered.length} of {entries.length}</span><select aria-label="Filter assistant status" className={`${nativeSelectClass} sm:w-48`} value={state} onChange={event => setState(event.target.value as AssistantState | 'all')}><option value="all">All statuses</option>{Object.entries(assistantStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
    <section hidden={view !== 'assistants'}>{!entries.length ? <section className="rounded-[14px] border bg-card p-8 sm:p-10"><h2 className="text-lg font-semibold">Create your first assistant</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Your assistant stays a draft until you configure, test and publish it. Customer delivery requires a published, active, ready assistant assigned to the exact account.</p><p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground"><Link className="text-primary underline" href="/documentation/assistants#configure-draft">Read the setup guide</Link>.</p>{catalog.permissions.canManage && <Button asChild className="mt-5"><Link href="/dashboard/settings/outreach/new">Create assistant</Link></Button>}</section> : !filtered.length ? <p className="rounded-xl border p-6 text-sm text-muted-foreground">No assistants match these filters. Try another name or status.</p> : <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">{filtered.map(assistant => {
      const active = ['live', 'needs_attention'].includes(assistant.state) && assistant.published ? assistant.published : assistant.draft;
      const bindings = assistantListBindings(assistant);
      const displayState = displayedAssistantState(assistant, catalog);
      const resources = draftResourceSummary(active);
      return <article key={assistant.id} className="flex flex-col overflow-hidden rounded-[14px] border bg-card"><div className="flex items-start justify-between gap-3 p-5"><div className="min-w-0"><h2 className="truncate text-base font-semibold">{active.name || 'Unnamed assistant'}</h2><p className="mt-1 text-xs text-muted-foreground">{catalog.presets.find(preset => preset.agentType === active.agentType)?.name || active.agentType}</p></div><StateBadge state={displayState} /></div><div className="mx-5 border-l-2 border-primary/25 pl-3"><p className="mb-2 text-xs font-medium text-muted-foreground">Receiving accounts · {bindings.length}</p>{bindings.length ? <ul className="space-y-2">{bindings.map(binding => { const account = catalog.accounts.find(item => assistantBindingKey(item) === assistantBindingKey(binding)); return <li key={assistantBindingKey(binding)}><ChannelBadge channel={binding.channel} publicComment={binding.surface === 'public_comment'} /><p className="mt-1 truncate text-xs text-muted-foreground">{account ? accountLabel(account) : 'Account unavailable'}{account && !account.connected && ' · Disconnected'}</p></li>; })}</ul> : <p className="text-sm text-muted-foreground">No account connected</p>}</div><div className="space-y-3 p-5 text-sm"><p className="truncate"><span className="text-muted-foreground">Reply model · </span>{active.replyModel ? `${active.replyModel.provider} / ${active.replyModel.model}` : 'Not selected'}</p><div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">{resources.map(resource => <p key={resource.label} className="flex items-center justify-between gap-2 text-muted-foreground"><span>{resource.label}</span><span className="font-mono text-foreground">{resource.mode === 'none' ? 'None' : resource.mode === 'unconfigured' ? '—' : resource.count}</span></p>)}</div>{displayState === 'needs_attention' && <p className="text-xs text-amber-700 dark:text-amber-400">{assistant.readiness.checks.find(check => !check.ok)?.detail || 'Review account connections and readiness before activating.'}</p>}</div><footer className="mt-auto flex items-center justify-between gap-2 border-t px-5 py-4"><span className="text-xs text-muted-foreground">{assistant.publishedRevision ? `Published r${assistant.publishedRevision}` : 'Not published'}</span><Button asChild variant="outline" size="sm"><Link href={`/dashboard/settings/outreach/assistants/${encodeURIComponent(assistant.id)}`}><Settings2 className="h-4 w-4" />Configure</Link></Button></footer></article>;
    })}</div>}{query.isError && <ErrorNotice message={query.error.message} />}{query.hasNextPage && <div className="mt-5 flex justify-center"><Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading assistants…' : 'Load more assistants'}</Button></div>}</section>
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground"><p>{catalog.permissions.description}</p><div className="flex flex-wrap items-center gap-3">{catalog.permissions.canManage && <Button variant="outline" disabled={importing} onClick={() => void importLegacy()}>{importing ? 'Importing settings…' : 'Import existing settings'}</Button>}</div></footer>
  </div>}</WorkspaceGate>;
}
