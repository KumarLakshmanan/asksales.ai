"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BarChart3, RefreshCw, ArrowRight, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui/page-header';
import { PageShell } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { LoadingState } from '@/components/ui/loading-state';
import { StatCard, StatGrid } from '@/components/ui/stat-card';
import { CrmNavigation } from '@/components/crm/CrmNavigation';
import { crmSelectClass, useCrmCollectionScope } from '@/components/crm/CrmCollectionFilters';
import { PlatformMultiSelect } from '@/components/crm/PlatformMultiSelect';
import { useCrmConfiguration } from '@/hooks/use-crm-configuration';
import { useCrmAutomationRefresh } from '@/hooks/use-crm-automation-refresh';
import { CRM_DATE_RANGES, CRM_REPORT_PLATFORMS, crmSelectedPlatforms, crmDateRangeLabel, crmPlatformLabel, DEFAULT_CRM_CONFIGURATION, type CrmPreferences, type CrmStage } from '@/lib/crm-configuration';
import { crmContactParams } from '@/lib/crmContactQuery';
import { formatCurrencyBreakdown } from '@/lib/utils';

interface CrmReport {
  stages: (CrmStage & { count: number; stuckCount: number; dealValueByCurrency: Record<string, string> })[];
  winRate: number; totalPipelineValueByCurrency: Record<string, string>; stuckContacts: number;
  preferences: CrmPreferences; flows: { from: string; to: string; count: number }[];
  channels: { channel: string; contacts: number; conversations: number; messages: number; unread: number }[];
  stageDurations: { stageKey: string; label: string; visits: number; averageDays: number | null }[];
  filters: { platforms: string[]; dateRange: string; from?: string; to?: string };
}
// The server stops a slow report at 12 s; the client gives up at 20 s so the
// page shows Try again instead of waiting on a request that will not finish.
const REPORT_REQUEST_TIMEOUT_MS = 20_000;
const reportQuery = (preferences: CrmPreferences) => {
  const query = crmContactParams({ dateRange: preferences.dateRange, from: preferences.dateRange === 'custom' ? preferences.dateStart : undefined, to: preferences.dateRange === 'custom' ? preferences.dateEnd : undefined });
  query.set('platforms', crmSelectedPlatforms(preferences).join(','));
  return query;
};

export default function CRMReportsPage() {
  const { scope } = useCrmCollectionScope();
  const { configuration, loading: configurationLoading, error: configurationError, reload: reloadConfiguration } = useCrmConfiguration();
  const [draft, setDraft] = useState<CrmPreferences>({ ...DEFAULT_CRM_CONFIGURATION.preferences });
  const [applied, setApplied] = useState<CrmPreferences | null>(null);
  const [data, setData] = useState<CrmReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const initialized = useRef<string | null>(null);
  const version = useRef(0);
  const inFlight = useRef(0);
  useEffect(() => { ++version.current; initialized.current = null; setData(null); setApplied(null); setValidation(null); return () => { ++version.current; }; }, [scope]);
  useEffect(() => {
    if (!configuration || configurationLoading || initialized.current === scope) return;
    initialized.current = scope;
    const preferences = { ...configuration.preferences, platform: crmSelectedPlatforms(configuration.preferences) };
    setDraft(preferences); setApplied(preferences);
  }, [configuration, configurationLoading, scope]);
  const refresh = useCallback(async (background = false) => {
    if (!applied) return;
    const current = ++version.current; inFlight.current = current; setError(null); if (!background) setLoading(true);
    try { const result = await api.get<CrmReport | { data: CrmReport }>(`/api/crm/reports?${reportQuery(applied)}`, { timeoutMs: REPORT_REQUEST_TIMEOUT_MS, retryTransient: false }); const report = 'data' in result ? result.data : result; if (!Array.isArray(report.stages) || !Array.isArray(report.channels)) throw new Error('The report response could not be loaded.'); if (current === version.current) setData(report); }
    catch (cause) { if (current === version.current) setError(cause instanceof Error ? cause.message : 'CRM reports could not be loaded.'); }
    finally { if (current === version.current) setLoading(false); if (inFlight.current === current) inFlight.current = 0; }
  }, [applied, scope]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Automatic refreshes (30s poll, socket reconnect) skip while a load is still
  // running; slow CRM reads otherwise overlap and the page never settles.
  useCrmAutomationRefresh(async () => { if (!inFlight.current) await refresh(true); });
  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    if (draft.dateRange === 'custom' && (!draft.dateStart || !draft.dateEnd || draft.dateStart > draft.dateEnd)) { setValidation('Choose a start and end date, with the end on or after the start.'); return; }
    setValidation(null); setApplied({ ...draft, platform: crmSelectedPlatforms(draft) });
  };
  const contactsUrl = (stage?: string, channel?: string) => `/dashboard/crm/contacts?${crmContactParams({ platforms: channel ? [channel] : applied ? crmSelectedPlatforms(applied) : [], dateRange: applied?.dateRange, from: applied?.dateRange === 'custom' ? applied.dateStart : undefined, to: applied?.dateRange === 'custom' ? applied.dateEnd : undefined, pipelineStatus: stage })}`;
  const total = data?.stages.reduce((sum, stage) => sum + stage.count, 0) ?? 0;
  const stageName = (key: string) => data?.stages.find(stage => stage.key === key)?.label || key.replaceAll('_', ' ');
  const hasChanges = applied && JSON.stringify(draft) !== JSON.stringify(applied);

  return <PageShell>
    <PageHeader icon={BarChart3} title="CRM reports" subtitle="See how contacts move through your pipeline and where the next improvement matters." actions={<><Button variant="outline" disabled={loading || !applied} onClick={() => void refresh()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button><Button asChild variant="outline"><Link href="/dashboard/crm/configuration"><Settings2 className="mr-2 h-4 w-4" />Reporting defaults</Link></Button></>} />
    <CrmNavigation current="reports" />
    {configurationError ? <Alert variant="destructive"><AlertTitle>Reporting preferences could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{configurationError}</span><Button variant="outline" size="sm" onClick={reloadConfiguration}>Reload preferences</Button></AlertDescription></Alert> : configurationLoading ? <p role="status" className="text-sm text-muted-foreground">Loading reporting preferences…</p> : <form onSubmit={apply} className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"><div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4"><div><Label htmlFor="report-date-range" className="text-xs">Date range</Label><select id="report-date-range" className={`${crmSelectClass} mt-1.5`} value={draft.dateRange} onChange={event => { setDraft(previous => ({ ...previous, dateRange: event.target.value as CrmPreferences['dateRange'] })); setValidation(null); }}>{CRM_DATE_RANGES.map(range => <option key={range.value} value={range.value}>{range.label}</option>)}</select></div>{draft.dateRange === 'custom' && <><div><Label htmlFor="report-date-start" className="text-xs">Start date (UTC)</Label><Input id="report-date-start" className="mt-1.5 h-10" type="date" value={draft.dateStart || ''} max={draft.dateEnd || undefined} onChange={event => { setDraft(previous => ({ ...previous, dateStart: event.target.value })); setValidation(null); }} /></div><div><Label htmlFor="report-date-end" className="text-xs">End date (UTC, inclusive)</Label><Input id="report-date-end" className="mt-1.5 h-10" type="date" value={draft.dateEnd || ''} min={draft.dateStart || undefined} onChange={event => { setDraft(previous => ({ ...previous, dateEnd: event.target.value })); setValidation(null); }} /></div></>}<Button type="submit" disabled={loading} className="w-fit">Apply report filters</Button></div><details><summary className="cursor-pointer text-sm font-medium">Platforms · {crmPlatformLabel(draft)}</summary><div className="mt-4"><PlatformMultiSelect value={draft.platform} onChange={platform => setDraft(previous => ({ ...previous, platform }))} showConnections={false} description="Compare recorded activity across selected platforms. Contacts present on several selected platforms are counted once in the pipeline totals." /></div></details>{validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}{hasChanges && <p className="text-xs text-muted-foreground">Apply filters to update the report below.</p>}</form>}
    {error ? <Alert variant="destructive"><AlertTitle>CRM reports could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void refresh()}>Try again</Button></AlertDescription></Alert> : configurationError ? null : !applied || loading ? <LoadingState className="min-h-64" label="Loading reports…" showLabel /> : !data ? <Alert variant="destructive"><AlertTitle>CRM reports could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>The report returned no data. Try again.</span><Button variant="outline" size="sm" onClick={() => void refresh()}>Try again</Button></AlertDescription></Alert> : <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p>{crmDateRangeLabel(applied)} · {crmPlatformLabel(applied)}</p><Link href={contactsUrl()} className="font-medium text-primary hover:underline">View matching contacts →</Link></div>
      <StatGrid columns={4}>{[{ label: 'Contacts created in this period', value: total, hint: 'One contact counted once across selected platforms.' }, { label: 'Win rate', value: `${data.winRate}%`, hint: 'Won contacts as a share of won and lost contacts.' }, { label: 'Deal value', value: formatCurrencyBreakdown(data.totalPipelineValueByCurrency, { compact: true }), hint: 'Currencies stay separate.' }, { label: 'Stuck contacts', value: data.stuckContacts, hint: `${data.preferences.stuckThreshold}+ days in the current active stage.` }].map(stat => <StatCard key={stat.label} label={stat.label} value={stat.value} description={stat.hint} />)}</StatGrid>
      <section className="overflow-hidden rounded-xl border border-border bg-card"><div className="border-b border-border px-4 py-4 sm:px-5"><h2 className="text-base font-semibold">Current pipeline position</h2><p className="mt-1 text-xs text-muted-foreground">Current stages of contacts created in the selected period. These shares show distribution, not step-by-step conversion.</p></div>{data.stages.map(stage => <div key={stage.key} className="grid gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[180px_1fr_160px] sm:items-center sm:px-5"><Link href={contactsUrl(stage.key)} className="flex min-h-8 items-center gap-2 text-sm font-medium hover:text-primary"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: stage.color }} />{stage.label}<Badge variant="secondary" className="ml-auto text-xs">{stage.count}</Badge></Link><div className="flex items-center gap-3"><div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${total ? stage.count / total * 100 : 0}%`, backgroundColor: stage.color }} /></div><span className="w-12 text-right font-mono text-xs text-muted-foreground">{total ? (stage.count / total * 100).toFixed(1) : '0'}%</span></div><p className="text-xs text-muted-foreground sm:text-right">{formatCurrencyBreakdown(stage.dealValueByCurrency, { compact: true })}</p></div>)}{total === 0 && <p className="px-5 pb-5 text-sm text-muted-foreground">No contacts were created in this period on the selected platforms. Try a wider date range.</p>}</section>
      <div className="grid gap-5 xl:grid-cols-2"><section className="rounded-xl border border-border bg-card p-4 sm:p-5"><h2 className="text-base font-semibold">Recorded stage transitions</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Moves recorded during the selected period, including existing contacts. Repeated moves are counted. Stages excluded from flow are omitted.</p><div className="mt-4 space-y-2">{data.flows.length ? data.flows.map(flow => <div key={`${flow.from}:${flow.to}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/45 px-3 py-3 text-sm"><span>{stageName(flow.from)}</span><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /><span>{stageName(flow.to)}</span><Badge className="ml-auto" variant="secondary">{flow.count} moves</Badge></div>) : <p className="py-4 text-sm text-muted-foreground">No transitions meet the configured minimum of {data.preferences.minFlowCount} moves.</p>}</div></section><section className="rounded-xl border border-border bg-card p-4 sm:p-5"><h2 className="text-base font-semibold">Time spent in each stage</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Average duration of recorded stage visits, including ongoing visits. Missing transition history is not estimated.</p><div className="mt-4 space-y-3">{data.stageDurations.length ? data.stageDurations.map(stage => <div key={stage.stageKey} className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-0"><div><p className="text-sm font-medium">{stage.label}</p><p className="mt-1 text-xs text-muted-foreground">{stage.visits} recorded visits</p></div><p className="font-mono text-sm font-semibold">{stage.averageDays === null ? '—' : `${Number(stage.averageDays).toFixed(1)} days`}</p></div>) : <p className="py-4 text-sm text-muted-foreground">No stage-duration history is available for this period.</p>}</div></section></div>
      <section className="overflow-hidden rounded-xl border border-border bg-card"><div className="border-b border-border px-4 py-4 sm:px-5"><h2 className="text-base font-semibold">Activity by platform</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Conversation totals for contacts created in this period. A contact can appear in several platform rows. Unread counts reflect the current inbox.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr>{['Platform', 'Contacts', 'Conversations', 'Messages', 'Unread'].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{data.channels.map(channel => <tr key={channel.channel} className="border-t border-border"><th className="px-4 py-3 font-medium"><Link href={contactsUrl(undefined, channel.channel)} className="text-primary hover:underline">{CRM_REPORT_PLATFORMS.find(platform => platform.value === channel.channel)?.label || channel.channel}</Link></th><td className="px-4 py-3 font-mono">{channel.contacts}</td><td className="px-4 py-3 font-mono">{channel.conversations}</td><td className="px-4 py-3 font-mono">{channel.messages}</td><td className="px-4 py-3 font-mono">{channel.unread}</td></tr>)}</tbody></table></div>{!data.channels.length && <p className="px-5 py-6 text-sm text-muted-foreground">No platform activity is recorded for these filters.</p>}</section>
    </>}
  </PageShell>;
}
