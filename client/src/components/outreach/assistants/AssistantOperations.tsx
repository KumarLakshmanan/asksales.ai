"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/ui/page-header';
import { ASSISTANT_API, useAssistantList, useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import api from '@/lib/api';
import { ASSISTANT_CHANNELS, assistantChannelLabels, type AssistantChannel } from '@/lib/outreach-assistants';
import { AssistantAssignmentRows } from './AssistantAssignmentRows';
import type { AssistantOperationalReport } from '../../../../../shared/assistantOperations';
import { ConfigurationSection, ErrorNotice, Field, RuntimeNotice, WorkspaceGate, nativeSelectClass } from './AssistantShared';
import { assistantConversationHref } from './AssistantSimulator';

const dateLabel = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString();
const formatRecordedCost = (value: number | null, currency: string | null) => {
  if (value == null) return 'Not recorded';
  try { return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value) : `${value.toFixed(4)} · Currency not recorded`; }
  catch { return `${value.toFixed(4)} ${currency}`; }
};
const PAGE_SIZE = 25;
const REVIEW_REFRESH_ERROR = 'Review saved, but the report could not refresh. Your note is kept. Retry the report before reviewing again.';
// Each edit has its own identity, including edits back to the submitted text.
type ReviewNoteDraft = { text: string };
function ReportPagination({ page, count, onChange, label }: { page: number; count: number; onChange: (page: number) => void; label: string }) {
  if (count <= PAGE_SIZE) return null;
  return <Pagination className="mt-4 border-t pt-4" aria-label={label} page={page} pageSize={PAGE_SIZE} totalItems={count} onPageChange={onChange} itemLabel="rows" showEdgeButtons={false} />;
}

export default function AssistantOperations() {
  const workspace = useAssistantWorkspace();
  return <WorkspaceGate workspace={workspace}><OperationsWorkspace key={workspace.scopeKey.join(':')} workspace={workspace} /></WorkspaceGate>;
}
function OperationsWorkspace({ workspace }: { workspace: ReturnType<typeof useAssistantWorkspace> }) {
  const list = useAssistantList(workspace);
  const [days, setDays] = useState('30'); const [assistantId, setAssistantId] = useState('all');
  const [channel, setChannel] = useState('all'); const [accountId, setAccountId] = useState('all');
  const [reviewFilter, setReviewFilter] = useState('open');
  const [metricPage, setMetricPage] = useState(1); const [usagePage, setUsagePage] = useState(1); const [gapPage, setGapPage] = useState(1);
  const [notes, setNotes] = useState<Record<string, ReviewNoteDraft>>({});
  const [reviewing, setReviewing] = useState(''); const [error, setError] = useState('');
  const active = useRef(true); const reviewInFlight = useRef(false); const cache = useQueryClient();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setMetricPage(1); setUsagePage(1); setGapPage(1); }, [days, assistantId, channel, accountId, reviewFilter]);
  const report = useQuery({
    queryKey: [...workspace.scopeKey, 'diagnostics', days, assistantId, channel, accountId],
    queryFn: () => { const params = new URLSearchParams({ days }); if (assistantId !== 'all') params.set('assistantId', assistantId); if (channel !== 'all') params.set('channel', channel); if (accountId !== 'all') params.set('accountId', accountId); return api.get<AssistantOperationalReport>(`${ASSISTANT_API}/diagnostics?${params}`, workspace.requestOptions); },
    enabled: !!workspace.profileId, retry: 1, staleTime: 30_000,
  });
  const accounts = [...new Map((workspace.catalog.data?.accounts || [])
    .filter(item => item.connected && (channel === 'all' || item.channel === channel))
    .map(item => [item.accountId, item])).values()];
  const review = async (key: string, target: 'open' | 'reviewed', ownerId: string) => {
    if (!active.current || reviewInFlight.current || report.isError || !workspace.catalog.data?.permissions.canManage) return;
    reviewInFlight.current = true;
    setReviewing(key); setError('');
    const submittedDraft = notes[key];
    let posted = false;
    try {
      const savedNote = submittedDraft?.text ?? report.data?.knowledgeGaps.find(item => item.key === key)?.note;
      await api.post(`${ASSISTANT_API}/${encodeURIComponent(ownerId)}/knowledge-gaps/review`, { key, review: target, note: savedNote?.trim() || null }, workspace.requestOptions);
      posted = true;
      await cache.invalidateQueries({ queryKey: [...workspace.scopeKey, 'diagnostics'] }, { throwOnError: true });
      if (active.current) setNotes(previous => {
        if (previous[key] !== submittedDraft) return previous;
        const next = { ...previous }; delete next[key]; return next;
      });
    } catch (failure) { if (active.current) setError(posted ? REVIEW_REFRESH_ERROR : failure instanceof Error ? failure.message : 'The review could not be saved. Try again.'); }
    finally { reviewInFlight.current = false; if (active.current) setReviewing(''); }
  };
  const refreshReport = async () => {
    const result = await report.refetch();
    if (active.current && result.isSuccess) setError(previous => previous === REVIEW_REFRESH_ERROR ? '' : previous);
  };
  const data = report.data;
  const assignments = data?.assignments.filter(item => item.connected) || [];
  const gaps = data?.knowledgeGaps.filter(item => reviewFilter === 'all' || item.review === reviewFilter) || [];
  const totals = data?.metrics.reduce((total, item) => ({ replies: total.replies + item.replies, failures: total.failures + item.failures, handoffs: total.handoffs + item.handoffs }), { replies: 0, failures: 0, handoffs: 0 });
  return <div className="mx-auto max-w-[1440px] space-y-6 p-4 sm:p-6 [&_button]:min-h-11">
    <PageHeader icon={Activity} title="Assistant operations" subtitle="Check receiving accounts, recorded reply outcomes and questions that need better answers." actions={<><Button asChild variant="outline"><Link href="/dashboard/settings/outreach">Assistants</Link></Button><Button asChild variant="outline"><Link href="/dashboard/settings/outreach/orchestration">Reply queue <ArrowUpRight className="h-4 w-4" /></Link></Button><Button variant="outline" disabled={report.isFetching} onClick={() => void refreshReport()}><RefreshCw aria-hidden className="h-4 w-4" />{report.isFetching ? 'Refreshing…' : 'Refresh report'}</Button></>} />
    <RuntimeNotice enabled={workspace.catalog.data?.runtimeEnabled || false} />
    <div className="grid gap-4 rounded-[14px] border bg-card p-5 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Reporting period" htmlFor="assistant-report-days"><select id="assistant-report-days" value={days} onChange={event => setDays(event.target.value)} className={nativeSelectClass}>{[7, 14, 30, 90].map(value => <option key={value} value={value}>Last {value} days</option>)}</select></Field>
      <Field label="Assistant" htmlFor="assistant-report-assistant"><select id="assistant-report-assistant" value={assistantId} onChange={event => setAssistantId(event.target.value)} className={nativeSelectClass}><option value="all">All assistants</option>{list.data?.assistants.map(item => <option key={item.id} value={item.id}>{item.published?.name || item.draft.name || 'Unnamed assistant'}</option>)}{assistantId !== 'all' && !list.data?.assistants.some(item => item.id === assistantId) && <option value={assistantId}>Previously selected assistant · {assistantId}</option>}</select>{list.hasNextPage && <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading assistants…' : 'Load more assistant filters'}</Button>}{list.isError && <p className="text-xs text-destructive">Assistant filters could not load. <button className="underline" onClick={() => void list.refetch()}>Retry</button></p>}</Field>
      <Field label="Channel" htmlFor="assistant-report-channel"><select id="assistant-report-channel" value={channel} onChange={event => { setChannel(event.target.value); setAccountId('all'); }} className={nativeSelectClass}><option value="all">All channels</option>{ASSISTANT_CHANNELS.map(value => <option key={value} value={value}>{assistantChannelLabels[value]}</option>)}</select></Field>
      <Field label="Receiving account" htmlFor="assistant-report-account"><select id="assistant-report-account" value={accountId} onChange={event => setAccountId(event.target.value)} className={nativeSelectClass}><option value="all">All accounts</option>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{item.label} · {assistantChannelLabels[item.channel]}{item.label !== item.accountId && ` · ${item.accountId}`}</option>)}{accountId !== 'all' && !accounts.some(item => item.accountId === accountId) && <option value={accountId}>Previously selected account · {accountId}</option>}</select></Field>
    </div>
    <ErrorNotice message={error} />{report.isError && <div><ErrorNotice message={report.error.message || 'Assistant operations could not be loaded.'} /><Button variant="outline" className="mt-2" onClick={() => void refreshReport()}>Retry report</Button></div>}
    {report.isLoading && <p role="status" className="rounded-xl border p-6 text-sm text-muted-foreground">Loading recorded assistant activity…</p>}
    {data && <>
      <ConfigurationSection title="Account assignments & connection health" description="Only currently connected accounts are shown. Review assistant assignments and the revision selected for customer replies.">
        {!assignments.length ? <p className="text-sm text-muted-foreground">No connected receiving accounts match these filters. Connect an account or review the filters.</p> : <AssistantAssignmentRows accounts={assignments} />}
      </ConfigurationSection>
      <ConfigurationSection title="Reply outcomes" description={`Recorded outcomes over the last ${data.days} days. Failures and handoffs are shown separately; a completed generation is not proof of customer delivery.`}>
        {totals && <p className="mb-4 text-sm text-muted-foreground">Recorded totals · <span className="font-medium text-foreground">{totals.replies.toLocaleString()} replies</span> · {totals.failures.toLocaleString()} failures · {totals.handoffs.toLocaleString()} handoffs</p>}
        {!data.metrics.length ? <p className="text-sm text-muted-foreground">No assistant turns were recorded for this period.</p> : <div className="overflow-x-auto"><table aria-label="Recorded reply outcomes" className="w-full min-w-[850px] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr>{['Assistant / channel', 'Account / day (UTC)', 'Replies', 'Failures', 'Handoffs', 'Average processing time', 'Average confidence'].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y">{data.metrics.slice((metricPage - 1) * PAGE_SIZE, metricPage * PAGE_SIZE).map(item => <tr key={JSON.stringify([item.assistantId, item.channel, item.accountId, item.day])}><td className="px-3 py-4"><Link className="text-primary hover:underline" href={`/dashboard/settings/outreach/assistants/${encodeURIComponent(item.assistantId)}`}>{item.name}</Link><p className="mt-1 text-xs text-muted-foreground">{assistantChannelLabels[item.channel as AssistantChannel] || item.channel}</p></td><td className="max-w-56 break-words px-3 py-4"><p>{workspace.catalog.data?.accounts.find(account => account.accountId === item.accountId && account.channel === item.channel)?.label || item.accountId || 'Account not recorded'}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{item.day || 'Day not recorded'}</p></td><td className="px-3 py-4 font-mono tabular-nums">{item.replies.toLocaleString()}</td><td className="px-3 py-4 font-mono tabular-nums">{item.failures.toLocaleString()}</td><td className="px-3 py-4 font-mono tabular-nums">{item.handoffs.toLocaleString()}</td><td className="px-3 py-4 font-mono tabular-nums">{item.averageDurationMs == null ? 'Not recorded' : `${(item.averageDurationMs / 1000).toFixed(2)} s`}</td><td className="px-3 py-4 font-mono tabular-nums">{item.averageConfidence == null ? 'Not recorded' : `${Math.round(item.averageConfidence * 100)}%`}</td></tr>)}</tbody></table></div>}
        <ReportPagination label="Reply outcome pages" page={metricPage} count={data.metrics.length} onChange={setMetricPage} />
      </ConfigurationSection>
      <ConfigurationSection title="Knowledge review queue" description="Review unanswered or uncertain questions, correct the published source or playbook, and rerun a saved scenario before marking a gap reviewed." action={<Button asChild variant="outline"><Link href="/dashboard/knowledge-base">Open knowledge base <ArrowUpRight className="h-4 w-4" /></Link></Button>}>
        <Field label="Knowledge review status" htmlFor="assistant-gap-status"><select id="assistant-gap-status" className={`${nativeSelectClass} sm:max-w-xs`} value={reviewFilter} onChange={event => setReviewFilter(event.target.value)}><option value="open">Open questions</option><option value="reviewed">Reviewed questions</option><option value="all">All questions</option></select></Field>
        {!gaps.length ? <p className="mt-5 text-sm text-muted-foreground">No recorded knowledge gaps match this review status.</p> : <ul className="mt-5 divide-y">{gaps.slice((gapPage - 1) * PAGE_SIZE, gapPage * PAGE_SIZE).map(item => <li key={item.key} className="space-y-3 py-5"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{item.assistantName} · {item.intent.replace(/_/g, ' ')}</h3><span className="font-mono text-xs text-muted-foreground">{item.count} occurrence{item.count === 1 ? '' : 's'} · {item.review}</span></div><p className="text-sm leading-6">{item.reason}</p>{!!item.questionSamples?.length && <details className="text-sm"><summary className="min-h-9 cursor-pointer">Redacted question examples</summary><ul className="space-y-2 rounded-lg border bg-muted/20 p-3">{item.questionSamples.map((question,index)=><li className="whitespace-pre-wrap break-words" key={index}>{question}</li>)}</ul></details>}{!!item.dailyCounts?.length && <p className="text-xs text-muted-foreground">Daily occurrences (UTC) · {item.dailyCounts.map(day=>`${day.day}: ${day.count}`).join(' · ')}</p>}<p className="text-xs text-muted-foreground">Latest · {dateLabel(item.latestAt)}</p><div className="flex flex-wrap gap-3">{(item.conversations || item.conversationIds.map(id => ({ id, channel: '' }))).map(conversation => <Link className="inline-flex min-h-8 items-center text-xs text-primary hover:underline" key={conversation.id} href={conversation.channel ? assistantConversationHref(conversation.channel, conversation.id) : `/dashboard/outreach/inbox?thread=conversation%3A${conversation.id}`}>Conversation {conversation.id}</Link>)}<Link className="inline-flex min-h-8 items-center text-xs text-primary hover:underline" href={`/dashboard/settings/outreach/assistants/${encodeURIComponent(item.assistantId)}?tab=knowledge`}>Review assigned knowledge</Link></div>{item.note && <p className="rounded-lg border bg-muted/30 p-3 text-xs leading-5">Review note · {item.note}</p>}{workspace.catalog.data?.permissions.canManage && <div className="space-y-3"><Field label="Review note" htmlFor={`assistant-gap-note-${item.key}`}><Textarea id={`assistant-gap-note-${item.key}`} maxLength={1000} rows={2} value={notes[item.key]?.text ?? item.note ?? ''} aria-describedby={`assistant-gap-note-status-${item.key}`} onChange={event => { const text = event.target.value; setNotes(previous => ({ ...previous, [item.key]: { text } })); }} placeholder="Source corrected, policy confirmed or playbook updated…" /></Field><p id={`assistant-gap-note-status-${item.key}`} role="status" className="text-xs text-muted-foreground">{reviewing === item.key ? 'Saving the submitted note. You can keep editing.' : notes[item.key] ? 'Unsaved note edits.' : ''}</p><div className="flex flex-wrap gap-3">{item.review === 'reviewed' && notes[item.key] && <Button variant="outline" disabled={!!reviewing || report.isError} onClick={() => void review(item.key, 'reviewed', item.assistantId)}>Save review note</Button>}<Button variant="outline" disabled={!!reviewing || report.isError} onClick={() => void review(item.key, item.review === 'open' ? 'reviewed' : 'open', item.assistantId)}>{reviewing === item.key ? 'Saving review…' : item.review === 'open' ? 'Mark reviewed' : 'Reopen question'}</Button></div></div>}</li>)}</ul>}
        <ReportPagination label="Knowledge review queue pages" page={gapPage} count={gaps.length} onChange={setGapPage} />
      </ConfigurationSection>
      <ConfigurationSection title="Model usage & recorded cost" description="Model calls and tokens come from recorded usage with assistant attribution. Available costs are recorded model-cost estimates in USD, not settled billing or provider invoices. Older reply records are labelled separately; missing costs are not estimated here.">
        {!data.usage.length ? <p className="text-sm text-muted-foreground">No assistant model usage was recorded for these filters.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr>{['Assistant / revision', 'Provider / model', 'Model calls / reply turns', 'Tokens', 'Recorded model-cost estimate'].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y">{data.usage.slice((usagePage - 1) * PAGE_SIZE, usagePage * PAGE_SIZE).map(item => <tr key={`${item.assistantId}-${item.revision}-${item.provider}-${item.model}`}><td className="px-3 py-4"><Link className="text-primary hover:underline" href={`/dashboard/settings/outreach/assistants/${encodeURIComponent(item.assistantId)}`}>{list.data?.assistants.find(assistant => assistant.id === item.assistantId)?.published?.name || list.data?.assistants.find(assistant => assistant.id === item.assistantId)?.draft.name || item.assistantId}</Link><p className="mt-1 text-xs text-muted-foreground">Revision {item.revision}</p></td><td className="max-w-72 break-words px-3 py-4">{item.provider} / {item.model}</td><td className="px-3 py-4 font-mono tabular-nums">{item.calls.toLocaleString()}<p className="mt-1 font-sans text-xs text-muted-foreground">{item.source === 'model_usage' ? 'Model calls' : item.source === 'reply_audit' ? 'Recorded reply turns' : 'Recorded entries'}</p></td><td className="px-3 py-4 font-mono tabular-nums">{item.totalTokens.toLocaleString()}</td><td className="px-3 py-4 font-mono tabular-nums">{formatRecordedCost(item.cost, item.currency)}{item.costRecordedCalls != null && item.costRecordedCalls < item.calls && <p className="mt-1 font-sans text-xs text-muted-foreground">Partial coverage · {item.costRecordedCalls} of {item.calls} calls</p>}</td></tr>)}</tbody></table></div>}
        <ReportPagination label="Model usage pages" page={usagePage} count={data.usage.length} onChange={setUsagePage} />
      </ConfigurationSection>
    </>}
  </div>;
}
