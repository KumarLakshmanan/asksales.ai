"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Callout } from '@/components/ui/callout';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PageErrorState, PageLoadingState } from '@/components/ui/page-state';
import { useCrmAutomationRefresh } from '@/hooks/use-crm-automation-refresh';
import { useCrmConfiguration } from '@/hooks/use-crm-configuration';
import { api } from '@/lib/api';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { crmRunHelp } from '@/lib/crm-run-help';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, CRM_AUTOMATIONS_API, type AutomationRun, type AutomationRunStep } from '@/lib/crm-automations';

function RunHelp({ message, status }: { message?: string | null; status?: string }) {
  const help = crmRunHelp(message, status);
  return <Callout tone="warning" size="sm" actions={help.href ? <Link className="text-xs text-primary hover:underline" href={help.href}>{help.action}</Link> : undefined}><h3 className="text-sm font-medium text-foreground">{help.title}</h3><p className="leading-5">{help.description}</p></Callout>;
}
function StepResult({ step, stageLabel }: { step: AutomationRunStep; stageLabel?: string }) {
  const result = step.result;
  if (!result) return null;
  const tags = Array.isArray(result.tags) ? result.tags.filter(tag => typeof tag === 'string').join(', ') : '';
  return <div className="space-y-1 text-xs text-muted-foreground">
    {tags && <p>Tags: {tags}</p>}
    {typeof result.pipelineStatus === 'string' && <p>Stage: {stageLabel || result.pipelineStatus.replaceAll('_', ' ')}</p>}
    {typeof result.providerStatus === 'string' && <p>Delivery: {result.providerStatus}</p>}
    {typeof result.ticketId === 'number' && <Link className="inline-block text-primary hover:underline" href={`/dashboard/support/${result.ticketId}`}>Open ticket {typeof result.ticketNumber === 'string' ? result.ticketNumber : ''}</Link>}
    {step.providerMessageId && <p className="break-all">Delivery reference: {step.providerMessageId}</p>}
  </div>;
}

export function AutomationRuns({ automationId, initialRunId }: { automationId: number; initialRunId?: number }) {
  const configuration=useCrmConfiguration();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const [runs, setRuns] = useState<AutomationRun[]>([]), [next, setNext] = useState<number | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [detail, setDetail] = useState<(AutomationRun & { steps: AutomationRunStep[] }) | null>(null), [detailError, setDetailError] = useState(''), [loadingMore, setLoadingMore] = useState(false), [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState(''), [status, setStatus] = useState('all');
  const requestVersion = useRef(0), selectionVersion = useRef(0), loadVersion = useRef(0), loadInFlight = useRef(0), detailInFlight = useRef(0);
  const select = useCallback(async (id: number, quiet = false) => {
    const version = requestVersion.current, selection = ++selectionVersion.current, requestedProfile = selectedBusinessProfileId();
    detailInFlight.current = selection;
    // A quiet (automatic) refresh keeps the open detail on screen.
    if (!quiet) { setDetailError(''); setDetailLoading(true); setDetail(null); }
    try {
      const result = await api.get<AutomationRun & { steps: AutomationRunStep[] }>(`${CRM_AUTOMATIONS_API}/runs/${id}`);
      if (version === requestVersion.current && selection === selectionVersion.current && selectedBusinessProfileId() === requestedProfile) setDetail(result);
    } catch (cause) { if (version === requestVersion.current && selection === selectionVersion.current && selectedBusinessProfileId() === requestedProfile) setDetailError(cause instanceof Error ? cause.message : 'Unable to load step details.'); }
    finally {
      if (version === requestVersion.current && selection === selectionVersion.current && selectedBusinessProfileId() === requestedProfile) setDetailLoading(false);
      if (detailInFlight.current === selection) detailInFlight.current = 0;
    }
  }, []);
  const load = useCallback(async (cursor?: number) => {
    const version = requestVersion.current, request = ++loadVersion.current, requestedProfile = selectedBusinessProfileId();
    loadInFlight.current = request;
    try {
      const result = await api.get<{ runs: AutomationRun[]; nextCursor: number | null }>(`${CRM_AUTOMATIONS_API}/${automationId}/runs${cursor ? `?cursor=${cursor}` : ''}`);
      if (version !== requestVersion.current || request !== loadVersion.current || selectedBusinessProfileId() !== requestedProfile) return;
      setRuns(old => cursor ? [...old, ...result.runs.filter(run => !old.some(existing => existing.id === run.id))] : result.runs); setNext(result.nextCursor); setError('');
    } catch (cause) { if (version === requestVersion.current && request === loadVersion.current && selectedBusinessProfileId() === requestedProfile) setError(cause instanceof Error ? cause.message : 'Unable to load run history.'); }
    finally {
      if (version === requestVersion.current && request === loadVersion.current && selectedBusinessProfileId() === requestedProfile) { setLoading(false); setLoadingMore(false); }
      if (loadInFlight.current === request) loadInFlight.current = 0;
    }
  }, [automationId]);
  useEffect(() => { requestVersion.current++; selectionVersion.current++; setRuns([]); setDetail(null); setDetailError(''); setLoading(true); setSearch(''); setStatus('all'); void load(); }, [load, profileId]);
  useEffect(() => { if (initialRunId) void select(initialRunId); }, [initialRunId, select, profileId]);
  // Automatic refreshes skip reads still running (a slow first load or "Load
  // older runs" is not discarded) and refresh an open detail without blanking it.
  useCrmAutomationRefresh(async () => { if (!loadInFlight.current) await load(); if (detail && !detailInFlight.current) await select(detail.id, true); });
  const filtered = runs.filter(run => (status === 'all' || run.status === status) && `${run.id} ${run.contactName || ''} ${run.eventType} ${run.automationName}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  if (loading) return <PageLoadingState label="Loading automation runs…" />;
  return <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><Link href="/dashboard/crm/automations" className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft className="h-4 w-4" />Automations</Link><Link href={`/dashboard/crm/automations/${automationId}`} className="text-sm text-primary hover:underline">Review rule and test</Link></div>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">Run history</h1><p className="text-sm text-muted-foreground">{runs[0]?.automationName || 'Automation'} · Completed steps are retained when a later step stops.</p></div><Button variant="outline" size="sm" onClick={() => { void load(); if (detail) void select(detail.id); }}><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh</Button></div>
    {error && <PageErrorState title="History could not be loaded" description={error} reset={() => void load()} />}
    <div className="flex flex-col gap-2 sm:flex-row"><Input type="search" value={search} onChange={event => setSearch(event.target.value)} aria-label="Search loaded runs" placeholder="Search loaded runs by contact, event, or run number" className="sm:max-w-md" /><select aria-label="Filter runs by status" value={status} onChange={event => setStatus(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All statuses</option>{['queued','running','retry','success','failed','skipped','cancelled','uncertain'].map(value => <option key={value} value={value}>{value}</option>)}</select></div>
    {!runs.length && !error && <p className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">No runs yet. Activate the rule and perform a matching event.</p>}
    <div className="grid gap-5 lg:grid-cols-2"><div className="space-y-2">{!!runs.length && <p className="text-xs text-muted-foreground">{filtered.length} of {runs.length} loaded runs{next ? ' · Load older runs to search more history.' : ''}</p>}{filtered.map(run => <button type="button" key={run.id} onClick={() => void select(run.id)} aria-pressed={detail?.id === run.id}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:border-primary/50"><div className="mr-auto min-w-0"><p className="text-sm font-medium">Run #{run.id} · revision {run.revision}</p><p className="mt-1 text-xs text-muted-foreground">{run.contactName || run.eventType.replaceAll('_',' ')} · {new Date(run.createdAt).toLocaleString()}</p></div><Badge variant={run.status === 'failed' ? 'destructive' : 'secondary'}>{run.status}</Badge><ChevronRight className="h-4 w-4 shrink-0" /></button>)}
      {!!runs.length && !filtered.length && <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No loaded runs match these filters.</p>}{next && <Button variant="outline" loading={loadingMore} onClick={() => { setLoadingMore(true); void load(next); }}>Load older runs</Button>}</div>
      <div aria-live="polite">{detailLoading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" label={null} />Loading run details…</p>}{detailError && <p role="alert" className="text-sm text-destructive">{detailError}</p>}{detail && <section className="space-y-4 rounded-xl border border-border bg-card p-4" aria-label="Run step details"><h2 className="font-semibold">Run #{detail.id} · {detail.status}</h2><div className="space-y-2 rounded-lg bg-muted/30 p-3"><h3 className="text-sm font-medium">Why this run started</h3><p className="text-xs leading-5 text-muted-foreground">{AUTOMATION_TRIGGERS.find(trigger => trigger.type === detail.eventType)?.label || detail.eventType.replaceAll('_',' ')} was evaluated using revision {detail.revision} of this rule on {new Date(detail.createdAt).toLocaleString()}.</p>{detail.contactId && <Link className="inline-block text-xs text-primary hover:underline" href={`/dashboard/crm/contacts/${detail.contactId}?tab=activity`}>Open {detail.contactName || 'contact'} activity</Link>}</div>
        {(detail.errorMessage || ['failed','uncertain','retry','cancelled','skipped'].includes(detail.status)) && <RunHelp message={detail.errorMessage} status={detail.status} />}
        {detail.steps.map((step,index) => <div key={step.id} className="space-y-2 rounded-lg border border-border p-3"><div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto text-sm font-medium">{index + 1}. {AUTOMATION_ACTIONS.find(item => item.type === step.actionType)?.label || step.actionType.replaceAll('_', ' ')}</h3><Badge variant={step.status === 'failed' ? 'destructive' : 'secondary'}>{step.status}</Badge></div><p className="text-xs text-muted-foreground">{step.attempts} attempt{step.attempts === 1 ? '' : 's'}{step.providerStatus ? ` · Delivery: ${step.providerStatus}` : ''}</p>{step.errorMessage && <RunHelp message={step.errorMessage} status={step.status} />}<StepResult step={step} stageLabel={configuration.stages.find(stage=>stage.key===step.result?.pipelineStatus)?.label} /></div>)}</section>}</div></div>
  </div>;
}
