import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AssistantActivityList, AssistantDeliveryHistory, AssistantSimulator, assistantConversationHref } from '@/components/outreach/assistants/AssistantSimulator';
import { AssistantTestDrawer } from '@/components/outreach/assistants/AssistantTestDrawer';
import AssistantOperations from '@/components/outreach/assistants/AssistantOperations';
import { AssistantTraceView } from '@/components/outreach/assistants/AssistantTraceView';
import { advancePreviewSession, emptyPreviewSession, scenarioAssertions, type AssistantTrace } from '@/lib/assistant-simulator';
import { emptyAssistantDraft, type OutreachAssistant } from '@/lib/outreach-assistants';
import type { useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import api from '@/lib/api';

const mocks = vi.hoisted(() => ({ workspace: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/hooks/use-outreach-assistants', () => ({ ASSISTANT_API: '/api/settings/outreach/assistants', useAssistantWorkspace: mocks.workspace, useAssistantList: mocks.list }));
const draft = { ...emptyAssistantDraft(), name: 'Guest support', bindings: [{ channel: 'whatsapp' as const, surface: 'private' as const, accountId: 'line-a' }] };
const assistant: OutreachAssistant = { id: 'assistant-one', businessProfileId: 1, state: 'live', draft, draftVersion: 2, publishedRevision: 1, published: draft, updatedAt: '2026-10-03T10:00:00Z', readiness: { ready: true, checks: [] } };
const workspace = {
  profileId: 1, scopeKey: ['outreach-assistants', 1, 1], requestOptions: { headers: { 'X-Business-Profile-Id': '1' } },
  profiles: { isLoading: false, isError: false }, catalog: { isLoading: false, isError: false, data: { runtimeEnabled: true, accounts: [{ channel: 'whatsapp', surface: 'private', accountId: 'line-a', label: 'Hotel line', connected: true }], permissions: { canManage: true } } },
} as unknown as ReturnType<typeof useAssistantWorkspace>;
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>; }
const preview = (reply: string, id = -9, token = 'signed'): AssistantTrace => ({ reply, outcome: 'auto_sent', conversationId: id, previewSessionToken: token, sideEffectsSuppressed: true, privacyOutcome: { mandatory: true, redactedInput: 'Safe customer message' }, resolvedAssistant: { assistantId: 'assistant-one', revision: 2 }, stages: [{ stage: 'agent_configuration', status: 'executed', durationMs: 3 }] });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue({ items: [] }); mocks.workspace.mockReturnValue(workspace); mocks.list.mockReturnValue({ data: { assistants: [assistant] }, isError: false }); });
afterEach(cleanup);

describe('isolated scenario playback', () => {
  it('loads tests only when the drawer opens and discards a pending preview when it closes', async () => {
    let resolve!: (value: AssistantTrace) => void;
    vi.mocked(api.post).mockImplementation(() => new Promise(done => { resolve = done; }));
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open preview</button><AssistantTestDrawer open={open} onOpenChange={setOpen} assistant={assistant} workspace={workspace} dirty={false} /></>;
    }
    render(<Harness />, { wrapper });
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Test customer message')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    const drawer = await screen.findByRole('dialog', { name: 'Test assistant' });
    expect(within(drawer).getByLabelText('Version to test')).toHaveAccessibleDescription(/latest saved changes/);
    fireEvent.change(within(drawer).getByLabelText('Test customer message'), { target: { value: 'Hi' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Test saved configuration' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Done' }));
    await act(async () => resolve(preview('Closed preview result')));
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(await screen.findByLabelText('Test customer message')).toHaveValue('');
    expect(screen.queryByText('Closed preview result')).not.toBeInTheDocument();
    expect(screen.getByText('New isolated preview conversation.')).toBeVisible();
  });
  it('uses the latest saved draft without a version selector when nothing has been published', async () => {
    vi.mocked(api.post).mockResolvedValue(preview('Draft preview'));
    render(<AssistantSimulator assistant={{ ...assistant, publishedRevision: null, published: null }} workspace={workspace} dirty={false} />, { wrapper });
    expect(screen.queryByLabelText('Version to test')).not.toBeInTheDocument();
    expect(screen.getByText('Testing your latest saved draft.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await screen.findByText('Draft preview');
    expect(api.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ revision: 'draft' }), workspace.requestOptions);
  });
  it('requires signed negative-ID previews and carries only bounded redacted history', () => {
    expect(() => advancePreviewSession(emptyPreviewSession(), 'raw email', { ...preview('Reply'), conversationId: 4 })).toThrow('isolated preview');
    expect(() => advancePreviewSession(emptyPreviewSession(), 'raw email', { ...preview('Reply'), previewSessionToken: '' })).toThrow('ownership');
    const session = advancePreviewSession({ ...emptyPreviewSession(), history: Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'old' })) }, 'Private customer email', preview('Reply'));
    expect(session.history).toHaveLength(20); expect(session.history.at(-2)?.content).toBe('Safe customer message');
    expect(scenarioAssertions({ replyIncludes: ['reply'], outcome: 'blocked', playbookId: 7 }, { ...preview('Reply'), playbook: { playbookId: 7 } }).map(item => item.passed)).toEqual([true, false, true]);
    expect(assistantConversationHref('web', -18)).toBe('/dashboard/support-ai/reports?tab=conversations&sessionId=18');
    expect(assistantConversationHref('web', 18)).toBe('/dashboard/support-ai/reports?tab=conversations');
  });
  it('replays each revision in an independent signed session and checks the final response', async () => {
    vi.mocked(api.post).mockImplementation(async (_path, body) => { const request = body as { revision: string; message: string }; return preview(request.message === 'Hi' ? 'Welcome' : 'Support can confirm', request.revision === 'draft' ? -10 : -20, `${request.revision}-signed`); });
    render(<AssistantSimulator assistant={assistant} workspace={workspace} dirty={false} />, { wrapper });
    fireEvent.change(screen.getByLabelText('Customer messages (one per line)'), { target: { value: 'Hi\nCan you confirm breakfast?' } });
    fireEvent.change(screen.getByLabelText('Final reply must include (one phrase per line)'), { target: { value: 'support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare draft & published' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(4));
    const requests = vi.mocked(api.post).mock.calls.map(call => call[1]);
    expect(requests[0]).toEqual(expect.objectContaining({ revision: 'draft', conversationHistory: [] }));
    expect(requests[1]).toEqual(expect.objectContaining({ revision: 'draft', conversationId: -10, previewSessionToken: 'draft-signed', conversationHistory: [{ role: 'user', content: 'Safe customer message' }, { role: 'assistant', content: 'Welcome' }] }));
    expect(requests[2]).toEqual(expect.objectContaining({ revision: 'published', conversationHistory: [] }));
    expect(requests[2]).not.toHaveProperty('conversationId');
    expect(requests[3]).toEqual(expect.objectContaining({ revision: 'published', conversationId: -20, previewSessionToken: 'published-signed' }));
    expect(await screen.findAllByText('Passed · Final reply includes “support”')).toHaveLength(2);
    expect(screen.getAllByText('Select assistant')).toHaveLength(4);
  });
  it('ignores a pending result after reset and after a draft version change', async () => {
    let resolve!: (value: AssistantTrace) => void;
    vi.mocked(api.post).mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = render(<AssistantSimulator assistant={assistant} workspace={workspace} dirty={false} />, { wrapper });
    fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset test conversation' }));
    await act(async () => resolve(preview('Stale reply')));
    expect(screen.queryByText('Stale reply')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    view.rerender(<AssistantSimulator assistant={{ ...assistant, draftVersion: 3 }} workspace={workspace} dirty={false} />);
    await act(async () => resolve(preview('Old draft reply')));
    expect(screen.queryByText('Old draft reply')).not.toBeInTheDocument();
    vi.mocked(api.post).mockResolvedValue(preview('Fresh reply'));
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await screen.findByText('Fresh reply');
    expect(api.post).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ conversationHistory: [] }), workspace.requestOptions);
  });
  it('halts playback on an unsafe preview without presenting later assertions as passed', async () => {
    vi.mocked(api.post).mockResolvedValue({ ...preview('Claimed delivery'), sideEffectsSuppressed: false });
    render(<AssistantSimulator assistant={assistant} workspace={workspace} dirty={false} />, { wrapper });
    fireEvent.change(screen.getByLabelText('Customer messages (one per line)'), { target: { value: 'First\nSecond' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run scenario' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not confirm side-effect suppression');
    expect(api.post).toHaveBeenCalledTimes(1); expect(screen.queryByText('Claimed delivery')).not.toBeInTheDocument();
  });
  it('keeps the requested primary distinct from an unrecorded executed model', () => {
    render(<AssistantTraceView trace={{ ...preview('A reply'), resolvedAssistant: { replyModel: { provider: 'openai', model: 'requested-only' } } }} />);
    expect(screen.getByText('Reply model').nextElementSibling).toHaveTextContent('Not recorded');
    expect(screen.getByText('Requested primary model').nextElementSibling).toHaveTextContent('openai / requested-only');
  });
  it('uses the redacted saved scenario returned by the server and hides writes from read-only staff', async () => {
    vi.mocked(api.post).mockResolvedValue({ id: 'saved-one', name: 'Contact check', channel: 'whatsapp', messages: ['Email: [EMAIL_1]'], expected: { replyIncludes: [], outcome: null, playbookId: null }, updatedAt: '2026-10-03T00:00:00Z' });
    const view = render(<AssistantSimulator assistant={assistant} workspace={workspace} dirty={false} />, { wrapper });
    fireEvent.change(screen.getByLabelText('Scenario name'), { target: { value: 'Contact check' } });
    fireEvent.change(screen.getByLabelText('Customer messages (one per line)'), { target: { value: 'Email: person@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scenario' }));
    expect(await screen.findByText(/Test scenario saved/)).toBeInTheDocument();
    expect(screen.getByLabelText('Customer messages (one per line)')).toHaveValue('Email: [EMAIL_1]');
    expect(api.post).toHaveBeenCalledWith('/api/settings/outreach/assistants/assistant-one/scenarios', expect.objectContaining({ name: 'Contact check', messages: ['Email: person@example.com'] }), workspace.requestOptions);
    const readOnly = { ...workspace, catalog: { ...workspace.catalog, data: { ...workspace.catalog.data, permissions: { canManage: false } } } } as typeof workspace;
    view.rerender(<AssistantSimulator assistant={assistant} workspace={readOnly} dirty={false} />);
    expect(screen.queryByRole('button', { name: 'Save scenario' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove saved scenario' })).not.toBeInTheDocument();
  });
});

describe('paginated follow-up activity', () => {
  const activity = (key: string, reason: string) => ({ key, id: 1, kind: 'schedule' as const, conversationId: 18, channel: 'whatsapp', accountId: 'line-a', status: 'cancelled', createdAt: '2026-10-03T10:00:00Z', scheduledAt: null, content: null, reason, providerMessageId: null, assistantId: 'assistant-one', assistantRevision: 2, step: 1 });
  it('explains unverified follow-up stops while retaining the recorded identity and history link', () => {
    const record = activity('schedule:1', 'assistant_or_template_unavailable');
    render(<AssistantActivityList items={[record]} timezone="Asia/Kolkata" />);
    expect(screen.getByText(/follow-up stopped.*assistant or template.*verified/i)).toBeInTheDocument();
    expect(screen.queryByText('assistant_or_template_unavailable')).not.toBeInTheDocument();
    expect(screen.getByText('Account · line-a')).toBeInTheDocument();
    expect(screen.getByText('Revision · 2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open conversation 18' })).toHaveAttribute('href', '/dashboard/outreach/inbox?channel=whatsapp&thread=conversation%3A18');
    expect(record.reason).toBe('assistant_or_template_unavailable');
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
  it('preserves distinct event types, follows cursor pages and resets the page on filtering', async () => {
    vi.mocked(api.get).mockImplementation(async path => path.includes('cursor=next') ? { history: [activity('schedule:1', 'Customer replied'), activity('delivery:1', 'Provider rejected')], nextCursor: null } : path.includes('status=failed') ? { history: [], nextCursor: null } : { history: [activity('schedule:1', 'Customer replied')], nextCursor: 'next' });
    render(<AssistantDeliveryHistory assistantId="assistant-one" workspace={workspace} active timezone="Asia/Kolkata" />, { wrapper });
    expect(await screen.findByText('Customer replied')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
    await screen.findByText('Provider rejected');
    expect(screen.getAllByText('Customer replied')).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('cursor=next'), workspace.requestOptions);
    expect(screen.getAllByRole('link', { name: 'Open conversation 18' })[0]).toHaveAttribute('href', '/dashboard/outreach/inbox?channel=whatsapp&thread=conversation%3A18');
    fireEvent.change(screen.getByLabelText('Delivery status'), { target: { value: 'failed' } });
    await screen.findByText('No recorded activity matches these filters.');
    expect(screen.queryByText('Provider rejected')).not.toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith(expect.stringMatching(/history\?limit=25&status=failed$/), workspace.requestOptions);
  });
});

describe('assistant operations reporting', () => {
  it('disambiguates identically named accounts while preserving exact IDs and channel filters', async () => {
    const firstId = '1192128430651379';
    const secondId = '27374899432141745';
    const accounts = [
      { channel: 'facebook', surface: 'private', accountId: firstId, label: 'Aimplify', connected: true },
      { channel: 'facebook', surface: 'private', accountId: secondId, label: 'Aimplify', connected: true },
      { channel: 'email', surface: 'private', accountId: 'email-account', label: 'Aimplify', connected: true },
    ];
    mocks.workspace.mockReturnValue({ ...workspace, catalog: { ...workspace.catalog,
      data: { ...workspace.catalog.data, accounts },
    } });
    vi.mocked(api.get).mockResolvedValue({ days: 30, assignments: [], metrics: [], usage: [], knowledgeGaps: [] });
    render(<AssistantOperations />, { wrapper });
    const account = await screen.findByLabelText('Receiving account');
    expect(within(account).getByRole('option', { name: `Aimplify · Facebook Messenger · ${firstId}` })).toHaveValue(firstId);
    expect(within(account).getByRole('option', { name: `Aimplify · Facebook Messenger · ${secondId}` })).toHaveValue(secondId);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'facebook' } });
    expect(within(account).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['all', firstId, secondId]);
    for (const id of [firstId, secondId]) {
      fireEvent.change(account, { target: { value: id } });
      await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining(`channel=facebook&accountId=${id}`), workspace.requestOptions));
      expect(account).toHaveValue(id);
    }
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'email' } });
    expect(account).toHaveValue('all');
    expect(within(account).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['all', 'email-account']);
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(expect.stringMatching(/diagnostics\?days=30&channel=email$/), workspace.requestOptions));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('excludes disconnected assignments and historical accounts from current account choices without hiding activity history', async () => {
    const oldAccount = { channel: 'facebook', surface: 'private', accountId: 'historical-page', label: 'Disconnected old page', connected: false };
    mocks.workspace.mockReturnValue({ ...workspace, catalog: { ...workspace.catalog,
      data: { ...workspace.catalog.data, accounts: [...workspace.catalog.data!.accounts, oldAccount] },
    } });
    const assignment = { assistantId: null, assistantName: null, revision: null, state: 'unassigned', runtimeEnabled: true, checks: [] };
    vi.mocked(api.get).mockResolvedValue({ days: 30, assignments: [
      { ...workspace.catalog.data!.accounts[0], ...assignment }, { ...oldAccount, ...assignment },
    ], metrics: [{
      assistantId: 'assistant-one', name: 'Guest support', channel: 'facebook', accountId: 'historical-page', day: '2026-10-03', replies: 0, failures: 1, handoffs: 0,
    }], usage: [], knowledgeGaps: [] });
    render(<AssistantOperations />, { wrapper });
    const history = await screen.findByRole('table', { name: 'Recorded reply outcomes' });
    expect(within(history).getByText('Disconnected old page')).toBeInTheDocument();
    const assignments = screen.getByRole('heading', { name: 'Account assignments & connection health' }).closest('section')!;
    expect(within(assignments).queryByText('Disconnected old page')).not.toBeInTheDocument();
    const account = screen.getByLabelText('Receiving account');
    expect(within(account).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['all', 'line-a']);
    expect(screen.getByText('Connected', { exact: true })).toBeInTheDocument();
  });

  it('shows the connection prompt when all saved assignments are disconnected', async () => {
    vi.mocked(api.get).mockResolvedValue({ days: 30, assignments: [{
      channel: 'facebook', surface: 'private', accountId: 'old-page', label: 'Old page', connected: false,
      assistantId: 'assistant-one', assistantName: 'Guest support', revision: 1, state: 'live', runtimeEnabled: true, checks: [],
    }], metrics: [], usage: [], knowledgeGaps: [] });
    render(<AssistantOperations />, { wrapper });
    expect(await screen.findByText('No connected receiving accounts match these filters. Connect an account or review the filters.')).toBeInTheDocument();
    expect(screen.queryByText('Old page')).not.toBeInTheDocument();
  });

  it('shows daily account rows, sums recorded totals, applies account filters and does not invent costs', async () => {
    vi.mocked(api.get).mockResolvedValue({ days: 30, assignments: [], metrics: [
      { assistantId: 'assistant-one', name: 'Guest support', channel: 'whatsapp', accountId: 'line-a', day: '2026-10-02', replies: 2, failures: 1, handoffs: 0, averageDurationMs: 2000, averageConfidence: .9 },
      { assistantId: 'assistant-one', name: 'Guest support', channel: 'whatsapp', accountId: 'line-a', day: '2026-10-03', replies: 3, failures: 0, handoffs: 1, averageDurationMs: null, averageConfidence: null },
    ], knowledgeGaps: [], usage: [{ assistantId: 'assistant-one', revision: 2, provider: 'openai', model: 'recorded-model', calls: 5, totalTokens: 1000, cost: null, currency: null }] });
    render(<AssistantOperations />, { wrapper });
    await screen.findByText('5 replies');
    const table = screen.getByRole('table', { name: 'Recorded reply outcomes' });
    expect(within(table).getByText('2026-10-02')).toBeInTheDocument(); expect(within(table).getByText('2026-10-03')).toBeInTheDocument();
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThan(1);
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Receiving account'), { target: { value: 'line-a' } });
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining('accountId=line-a'), workspace.requestOptions));
  });
  it('links gaps to the recorded channel, preserves existing review notes and offers more assistant filters', async () => {
    const fetchNextPage = vi.fn();
    mocks.list.mockReturnValue({ data: { assistants: [assistant] }, isError: false, hasNextPage: true, fetchNextPage });
    vi.mocked(api.get).mockResolvedValue({ days: 30, assignments: [], metrics: [], usage: [], knowledgeGaps: [{ key: 'gap-one', assistantId: 'assistant-one', assistantName: 'Guest support', intent: 'breakfast', count: 2, latestAt: '2026-10-03T10:00:00Z', conversationIds: [8], conversations: [{ id: 8, channel: 'instagram' }], reason: 'Conflicting published hours', review: 'open', note: 'Waiting for approved hours' }] });
    vi.mocked(api.post).mockResolvedValue({ review: 'reviewed' });
    render(<AssistantOperations />, { wrapper });
    expect(await screen.findByRole('link', { name: 'Conversation 8' })).toHaveAttribute('href', '/dashboard/outreach/inbox?channel=instagram&thread=conversation%3A8');
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/settings/outreach/assistants/assistant-one/knowledge-gaps/review', { key: 'gap-one', review: 'reviewed', note: 'Waiting for approved hours' }, workspace.requestOptions));
    fireEvent.click(screen.getByRole('button', { name: 'Load more assistant filters' }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
  it('labels recorded model-cost estimates and partial attribution separately from reply turns', async () => {
    vi.mocked(api.get).mockResolvedValue({ days: 30, assignments: [], metrics: [], knowledgeGaps: [], usage: [
      { assistantId: 'assistant-one', revision: 2, provider: 'openai', model: 'executed-model', calls: 4, totalTokens: 250, cost: .015, currency: 'USD', source: 'model_usage', costRecordedCalls: 3 },
      { assistantId: 'assistant-one', revision: 1, provider: 'openai', model: 'legacy-model', calls: 8, totalTokens: 400, cost: null, currency: null, source: 'reply_audit', costRecordedCalls: 0 },
    ] });
    render(<AssistantOperations />, { wrapper });
    expect(await screen.findByText('Model calls')).toBeInTheDocument();
    expect(screen.getByText('Recorded reply turns')).toBeInTheDocument();
    expect(screen.getByText('Partial coverage · 3 of 4 calls')).toBeInTheDocument();
    expect(screen.getByText(/not settled billing or provider invoices/)).toBeInTheDocument();
  });
});
