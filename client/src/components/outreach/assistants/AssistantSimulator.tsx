"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ASSISTANT_API, type useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import api from '@/lib/api';
import { assistantChannelLabels, ASSISTANT_CHANNELS, type AssistantChannel, type OutreachAssistant } from '@/lib/outreach-assistants';
import { advancePreviewSession, emptyPreviewSession, previewRequest, scenarioAssertions, selectedPreviewConfigurationLabel, simulatedOutcomeLabel, type AssistantTrace, type PreviewSession } from '@/lib/assistant-simulator';
import type { AssistantActivity, AssistantTestScenario } from '../../../../../shared/assistantOperations';
import { AssistantTraceView } from './AssistantTraceView';
import { ConfigurationSection, ErrorNotice, Field, nativeSelectClass } from './AssistantShared';
import { deviceTimeZone } from '../../../../../shared/timeZones';

type Workspace = ReturnType<typeof useAssistantWorkspace>;
type PlaybackResult = { revision: 'draft' | 'published'; traces: AssistantTrace[]; total: number; expected: AssistantTestScenario['expected'] };
export function AssistantSimulator({ assistant, workspace, dirty }: { assistant: OutreachAssistant; workspace: Workspace; dirty: boolean }) {
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState<AssistantChannel>(assistant.draft.bindings[0]?.channel || 'web');
  const [revision, setRevision] = useState<'draft' | 'published'>('draft');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [trace, setTrace] = useState<AssistantTrace | null>(null);
  const session = useRef<PreviewSession>(emptyPreviewSession());
  const previewGeneration = useRef(0);
  const [scenarioId, setScenarioId] = useState('');
  const [scenarioName, setScenarioName] = useState('');
  const [messages, setMessages] = useState('');
  const [expectedReply, setExpectedReply] = useState('');
  const [expectedOutcome, setExpectedOutcome] = useState('');
  const [expectedPlaybook, setExpectedPlaybook] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [playback, setPlayback] = useState<PlaybackResult[]>([]);
  const cache = useQueryClient();
  const scenarioKey = [...(workspace.scopeKey || []), assistant.id, 'scenarios'];
  const scenarios = useQuery({ queryKey: scenarioKey, queryFn: () => api.get<{ items: AssistantTestScenario[] }>(`${ASSISTANT_API}/${encodeURIComponent(assistant.id)}/scenarios`, workspace.requestOptions), enabled: !!workspace.profileId, retry: 1 });
  const reset = () => { previewGeneration.current++; session.current = emptyPreviewSession(); setTrace(null); setPlayback([]); setError(''); setBusy(false); };
  useEffect(() => { reset(); }, [assistant.id, assistant.draftVersion, assistant.publishedRevision, workspace.profileId, channel, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setScenarioId(''); setScenarioName(''); setMessages(''); setExpectedReply(''); setExpectedOutcome(''); setExpectedPlaybook(''); setNotice(''); }, [assistant.id, workspace.profileId]);
  useEffect(() => () => { previewGeneration.current++; }, []);
  const request = async (text: string, target: 'draft' | 'published', previous: PreviewSession) => {
    const selectedConfiguration = { assistantId: assistant.id, revision: target, version: target === 'draft' ? assistant.draftVersion : assistant.publishedRevision };
    const result = await api.post<AssistantTrace>(`${ASSISTANT_API}/${encodeURIComponent(assistant.id)}/simulate`, previewRequest(text, channel, target, previous), workspace.requestOptions);
    const next = advancePreviewSession(previous, text, result);
    return { result: { ...result, selectedConfiguration }, next };
  };
  const simulate = async () => {
    if (!message.trim() || dirty || busy) return;
    const generation = previewGeneration.current;
    setError(''); setTrace(null); setPlayback([]); setBusy(true);
    try {
      const { result, next } = await request(message, revision, session.current);
      if (generation !== previewGeneration.current) return;
      session.current = next; setTrace(result);
    } catch (failure) { if (generation === previewGeneration.current) setError(failure instanceof Error ? failure.message : 'The simulator could not run. Check readiness and try again.'); }
    finally { if (generation === previewGeneration.current) setBusy(false); }
  };
  const expected = { replyIncludes: expectedReply.split('\n').map(text => text.trim()).filter(Boolean), outcome: expectedOutcome.trim() || null, playbookId: expectedPlaybook.trim() ? Number(expectedPlaybook) : null };
  const scenarioMessages = messages.split('\n').map(text => text.trim()).filter(Boolean);
  const scenarioValid = scenarioMessages.length > 0 && scenarioMessages.length <= 20 && scenarioMessages.every(text => text.length <= 8000) && (expected.playbookId === null || (Number.isSafeInteger(expected.playbookId) && expected.playbookId > 0));
  const selectScenario = (id: string) => {
    const selected = scenarios.data?.items.find(item => item.id === id);
    reset(); setScenarioId(id); setNotice('');
    setScenarioName(selected?.name || ''); setMessages(selected?.messages.join('\n') || '');
    setExpectedReply(selected?.expected.replyIncludes.join('\n') || ''); setExpectedOutcome(selected?.expected.outcome || ''); setExpectedPlaybook(selected?.expected.playbookId == null ? '' : String(selected.expected.playbookId));
    if (selected) setChannel(selected.channel);
  };
  const saveScenario = async () => {
    if (!scenarioValid || !scenarioName.trim() || saving || !workspace.catalog.data?.permissions.canManage) return;
    const generation = previewGeneration.current;
    setSaving(true); setError('');
    try {
      const saved = await api.post<{ item?: AssistantTestScenario; scenario?: AssistantTestScenario } | AssistantTestScenario>(`${ASSISTANT_API}/${encodeURIComponent(assistant.id)}/scenarios`, { ...(scenarioId ? { id: scenarioId } : {}), name: scenarioName.trim(), channel, messages: scenarioMessages, expected }, workspace.requestOptions);
      await cache.invalidateQueries({ queryKey: scenarioKey });
      if (generation !== previewGeneration.current) return;
      const item = 'id' in saved ? saved : saved.item ?? saved.scenario;
      if (item) { setScenarioId(item.id); setScenarioName(item.name); setMessages(item.messages.join('\n')); setExpectedReply(item.expected.replyIncludes.join('\n')); setExpectedOutcome(item.expected.outcome || ''); }
      setNotice('Test scenario saved. Personal data is redacted by the server before storage.');
    } catch (failure) { if (generation === previewGeneration.current) setError(failure instanceof Error ? failure.message : 'The test scenario could not be saved.'); }
    finally { setSaving(false); }
  };
  const deleteScenario = async () => {
    if (!scenarioId || saving || !workspace.catalog.data?.permissions.canManage) return;
    const generation = previewGeneration.current; setSaving(true); setError('');
    try { await api.delete(`${ASSISTANT_API}/${encodeURIComponent(assistant.id)}/scenarios/${encodeURIComponent(scenarioId)}`, workspace.requestOptions); await cache.invalidateQueries({ queryKey: scenarioKey }); if (generation === previewGeneration.current) { selectScenario(''); setNotice('Saved scenario removed.'); } }
    catch (failure) { if (generation === previewGeneration.current) setError(failure instanceof Error ? failure.message : 'The scenario could not be removed.'); }
    finally { setSaving(false); }
  };
  const replay = async (compare: boolean) => {
    if (!scenarioValid || dirty || busy || (compare && !assistant.publishedRevision)) return;
    reset(); const generation = previewGeneration.current;
    setBusy(true); setNotice('');
    try {
      for (const target of compare ? ['draft', 'published'] as const : [revision]) {
        let current = emptyPreviewSession(); const traces: AssistantTrace[] = [];
        for (const text of scenarioMessages) {
          const { result, next } = await request(text, target, current);
          if (generation !== previewGeneration.current) return;
          current = next; traces.push(result);
          setPlayback(previous => [...previous.filter(item => item.revision !== target), { revision: target, traces: [...traces], total: scenarioMessages.length, expected }]);
          if (result.error) break;
        }
      }
    } catch (failure) { if (generation === previewGeneration.current) setError(failure instanceof Error ? failure.message : 'Scenario playback could not finish. Retry from a new test conversation.'); }
    finally { if (generation === previewGeneration.current) setBusy(false); }
  };
  return <div className="space-y-5">
    <p className="rounded-xl border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">Preview only. No customer messages, CRM records, approvals or tool actions are created.</p>
    <Field label="Test channel" htmlFor="assistant-test-channel"><select aria-describedby="assistant-test-channel-note" id="assistant-test-channel" disabled={busy} className={nativeSelectClass} value={channel} onChange={event => setChannel(event.target.value as AssistantChannel)}>{ASSISTANT_CHANNELS.map(value => <option key={value} value={value}>{assistantChannelLabels[value]}</option>)}</select></Field>
    <p className="text-xs leading-5 text-muted-foreground">{revision === 'published' ? 'Testing the published settings approved for customer replies.' : 'Testing your latest saved draft.'}</p>
    {!!assistant.publishedRevision && <details className="rounded-xl border px-4"><summary className="min-h-11 cursor-pointer py-3 text-sm">Advanced test options</summary><div className="space-y-3 pb-4"><Field label="Version to test" htmlFor="assistant-test-revision"><select aria-describedby="assistant-test-version-note" id="assistant-test-revision" disabled={busy} className={nativeSelectClass} value={revision} onChange={event => setRevision(event.target.value as 'draft' | 'published')}><option value="draft">Latest saved draft</option><option value="published">Published settings</option></select></Field><p id="assistant-test-version-note" className="text-xs leading-5 text-muted-foreground">Saved draft uses your latest saved changes. Published settings are the version approved for customer replies. Choosing here only changes this preview.</p></div></details>}
    <p id="assistant-test-channel-note" className="text-xs text-muted-foreground">Simulates channel behavior; account connections and assignments are not verified.</p>
    <Field label="Test customer message" htmlFor="assistant-test-message"><Textarea id="assistant-test-message" rows={3} value={message} onChange={event => setMessage(event.target.value)} placeholder="Type a question a customer might ask…" /></Field>
    <ErrorNotice message={error} />{dirty && <p className="text-sm text-amber-700 dark:text-amber-400">Save your draft before testing so the trace matches the reviewed configuration.</p>}
    <p className="text-xs text-muted-foreground">{session.current.conversationId === null ? 'New isolated preview conversation.' : 'Successive test messages use this isolated preview history.'}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void simulate()} disabled={!message.trim() || dirty || busy}>{busy ? 'Testing…' : 'Test saved configuration'}</Button><Button variant="ghost" disabled={!busy && session.current.conversationId === null && !playback.length} onClick={reset}>Reset test conversation</Button></div>
    {trace && <AssistantTraceView trace={trace} />}
    <details className="rounded-xl border p-4"><summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">Saved scenarios & version comparison</summary><div className="mt-4 space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">Replay a sequence of customer messages, then check the final reply, outcome and playbook. Draft and published tests always start in separate preview conversations. Delivery and proposal execution must also be verified with approved live test contacts.</p>
      {scenarios.isError && <div><ErrorNotice message="Saved scenarios could not be loaded." /><Button variant="outline" className="mt-2" onClick={() => void scenarios.refetch()}>Retry scenarios</Button></div>}
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Saved scenario" htmlFor="assistant-scenario-select"><select id="assistant-scenario-select" className={nativeSelectClass} disabled={busy || saving || scenarios.isLoading} value={scenarioId} onChange={event => selectScenario(event.target.value)}><option value="">New scenario</option>{scenarios.data?.items.map(item => <option key={item.id} value={item.id}>{item.name} · {assistantChannelLabels[item.channel]}</option>)}</select></Field><Field label="Scenario name" htmlFor="assistant-scenario-name"><Input id="assistant-scenario-name" disabled={busy || saving} maxLength={120} value={scenarioName} onChange={event => setScenarioName(event.target.value)} placeholder="Booking correction / brochure request" /></Field></div>
      <Field label="Customer messages (one per line)" htmlFor="assistant-scenario-messages" hint="Use 1–20 messages. Each line is a separate turn, processed in order."><Textarea id="assistant-scenario-messages" disabled={busy || saving} value={messages} onChange={event => setMessages(event.target.value)} rows={5} placeholder={'Hi, I need a room\nTwo adults and two children\nActually, make that three adults'} /></Field>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Final reply must include (one phrase per line)" htmlFor="assistant-scenario-expected"><Textarea id="assistant-scenario-expected" disabled={busy || saving} value={expectedReply} onChange={event => setExpectedReply(event.target.value)} rows={3} placeholder="Would you like me to connect you with support?" /></Field><div className="space-y-4"><Field label="Expected final outcome (optional)" htmlFor="assistant-scenario-outcome"><Input id="assistant-scenario-outcome" disabled={busy || saving} value={expectedOutcome} onChange={event => setExpectedOutcome(event.target.value)} placeholder="Raw outcome from Advanced trace details" /></Field><Field label="Expected final playbook ID (optional)" htmlFor="assistant-scenario-playbook"><Input id="assistant-scenario-playbook" disabled={busy || saving} type="number" min={1} value={expectedPlaybook} onChange={event => setExpectedPlaybook(event.target.value)} /></Field></div></div>
      {!scenarioValid && messages.trim() && <p role="alert" className="text-sm text-destructive">Use 1–20 non-empty messages, up to 8,000 characters per message, and a valid playbook ID.</p>}
      {notice && <p role="status" className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">{notice}</p>}
      <div className="flex flex-wrap gap-2"><Button disabled={dirty || busy || !scenarioValid} onClick={() => void replay(false)}>Run scenario</Button><Button variant="outline" disabled={dirty || busy || !scenarioValid || !assistant.publishedRevision} onClick={() => void replay(true)}>Compare draft & published</Button>{workspace.catalog.data?.permissions.canManage && <><Button variant="outline" disabled={busy || saving || !scenarioValid || !scenarioName.trim() || scenarios.isError} onClick={() => void saveScenario()}>{saving ? 'Saving…' : 'Save scenario'}</Button>{scenarioId && <Button variant="ghost" disabled={busy || saving} onClick={() => void deleteScenario()}>Remove saved scenario</Button>}</>}</div>
      {playback.length > 0 && <div className="grid gap-4 xl:grid-cols-2">{playback.map(run => { const last = run.traces.at(-1); const checks = last ? scenarioAssertions(run.expected, last) : []; return <section key={run.revision} className="space-y-4 rounded-xl border p-4"><h3 className="font-semibold">{run.traces[0]?.selectedConfiguration ? selectedPreviewConfigurationLabel(run.traces[0].selectedConfiguration) : 'Selected configuration not recorded'}</h3><p className="text-xs text-muted-foreground">{run.traces.length} of {run.total} messages processed · {last?.error ? 'Playback failed' : run.traces.length < run.total ? 'Playback incomplete' : checks.length ? `${checks.filter(check => check.passed).length} of ${checks.length} checks passed${run.traces.length < run.total ? ' · Playback incomplete' : ''}` : 'No assertions configured'}</p>{run.traces.map((item, index) => <details key={index} open={index === run.traces.length - 1}><summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">Message {index + 1} · {simulatedOutcomeLabel(item.outcome)} · Simulated</summary><AssistantTraceView trace={item} assertions={index === run.traces.length - 1 && run.traces.length === run.total && !last?.error ? checks : []} /></details>)}</section>; })}</div>}
    </div></details>
  </div>;
}

export function assistantConversationHref(channel: string, conversationId: number): string {
  if (channel === 'web') return conversationId < 0
    ? `/dashboard/support-ai/reports?tab=conversations&sessionId=${Math.abs(conversationId)}`
    : '/dashboard/support-ai/reports?tab=conversations';
  return `/dashboard/outreach/inbox?${new URLSearchParams({ channel, thread: `conversation:${conversationId}` })}`;
}
const activityKindLabels: Record<AssistantActivity['kind'], string> = { message: 'Follow-up message', schedule: 'Support check-in schedule', delivery: 'Delivery attempt', playbook: 'Playbook run', approval: 'Approval', proposal: 'Proposal', session: 'Conversation session' };
const activityReasons: Record<string, string> = {
  customer_replied: 'The customer replied.', human_takeover: 'A support agent took over this conversation.',
  conversation_closed: 'The conversation was closed.', assistant_paused: 'The assigned assistant was paused.',
  account_reassigned: 'This account was assigned to a different assistant.', opt_out: 'The customer opted out.',
  template_unavailable: 'The selected template is no longer available.', template_approval_withdrawn: 'Approval was withdrawn for the selected template.',
  assistant_or_template_unavailable: 'The follow-up stopped because the assistant or template could not be verified.',
  outside_availability: 'The next send is deferred until the assistant is available.',
};
export function AssistantActivityList({ items, timezone }: { items: AssistantActivity[]; timezone?: string }) {
  const date = (value: string) => { if (Number.isNaN(Date.parse(value))) return value; try { return new Date(value).toLocaleString(undefined, { timeZone: timezone }); } catch { return new Date(value).toLocaleString(); } };
  return <ul className="divide-y">{items.map(item => <li key={item.key || `${item.kind}-${item.id}`} className="space-y-2 py-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><span className="text-xs font-semibold">{assistantChannelLabels[item.channel as AssistantChannel] || item.channel} · {item.status.replace(/_/g, ' ')}</span><span className="ml-2 text-xs text-muted-foreground">{activityKindLabels[item.kind] || 'Follow-up message'}</span></div><time className="font-mono text-xs text-muted-foreground" dateTime={item.createdAt}>{date(item.createdAt)}</time></div>{item.reason && <p className="rounded-lg border bg-muted/30 p-3 text-sm leading-6">{activityReasons[item.reason] || item.reason}</p>}{item.content && <p className="whitespace-pre-wrap text-sm leading-6">{item.content}</p>}<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>Account · {item.accountId || 'Not recorded'}</span><span>Revision · {item.assistantRevision ?? 'Not recorded'}</span>{item.scheduledAt && <span>Scheduled · {date(item.scheduledAt)}</span>}{item.step != null && <span>Step · {item.step}</span>}{item.providerMessageId && <span className="break-all">Provider receipt · {item.providerMessageId}</span>}{(item.conversationId > 0 || (item.channel === 'web' && item.conversationId < 0)) && <Link className="inline-flex min-h-8 items-center text-primary hover:underline" href={assistantConversationHref(item.channel, item.conversationId)}>{item.channel === 'web' && item.conversationId < 0 ? `Open web session ${Math.abs(item.conversationId)}` : `Open conversation ${item.conversationId}`}</Link>}</div></li>)}</ul>;
}
export function AssistantDeliveryHistory({ assistantId, workspace, active, timezone }: { assistantId: string; workspace: Workspace; active: boolean; timezone?: string }) {
  const [channel, setChannel] = useState('all'); const [status, setStatus] = useState('all');
  const history = useInfiniteQuery({
    queryKey: [...workspace.scopeKey, assistantId, 'history', channel, status], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => { const search = new URLSearchParams({ limit: '25' }); if (pageParam) search.set('cursor', pageParam); if (channel !== 'all') search.set('channel', channel); if (status !== 'all') search.set('status', status); return api.get<{ history: AssistantActivity[]; nextCursor?: string | null }>(`${ASSISTANT_API}/${encodeURIComponent(assistantId)}/history?${search}`, workspace.requestOptions); },
    getNextPageParam: last => last.nextCursor || undefined, enabled: active && !!workspace.profileId, retry: 1,
  });
  const items = [...new Map((history.data?.pages.flatMap(page => page.history) || []).map(item => [item.key || `${item.kind}-${item.id}`, item])).values()];
  return <ConfigurationSection title="Follow-up delivery history" description="Support check-ins, scheduled sends and delivery attempts are shown with recorded outcomes. Campaign reminders stop when the customer replies; support check-ins follow delivered assistant replies." action={<Button type="button" variant="outline" disabled={history.isFetching} onClick={() => void history.refetch()}>Refresh history</Button>}>
    <div className="mb-4 grid gap-3 sm:grid-cols-2"><Field label="History channel" htmlFor="assistant-history-channel"><select id="assistant-history-channel" className={nativeSelectClass} value={channel} onChange={event => setChannel(event.target.value)}><option value="all">All channels</option>{ASSISTANT_CHANNELS.filter(value => value !== 'web').map(value => <option key={value} value={value}>{assistantChannelLabels[value]}</option>)}</select></Field><Field label="Delivery status" htmlFor="assistant-history-status"><select id="assistant-history-status" className={nativeSelectClass} value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{['active', 'queued', 'completed', 'scheduled', 'pending', 'sent', 'delivered', 'deferred', 'blocked', 'stopped', 'cancelled', 'superseded', 'failed', 'uncertain'].map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></Field></div>
    <p className="mb-4 text-xs leading-5 text-muted-foreground">Times shown in {timezone || deviceTimeZone()}. Web chat follow-ups are unavailable until a delivery mechanism is supported. <Link className="text-primary hover:underline" href="/dashboard/outreach/follow-ups">Campaign reminders have separate settings and history.</Link></p>
    {history.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading delivery history…</p> : history.isError && !items.length ? <div><ErrorNotice message={history.error.message} /><Button className="mt-3" variant="outline" onClick={() => void history.refetch()}>Try again</Button></div> : !items.length ? <p className="text-sm text-muted-foreground">No recorded activity matches these filters.</p> : <AssistantActivityList items={items} timezone={timezone} />}
    {history.isError && items.length > 0 && <ErrorNotice message="More activity could not be loaded. Previously loaded records are still available; retry loading below." />}
    {history.hasNextPage && <Button className="mt-4" variant="outline" disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? 'Loading more…' : 'Load older activity'}</Button>}
  </ConfigurationSection>;
}
