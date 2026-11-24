import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { assistantBindingKey, assistantDraftIssues, assistantListBindings, displayedAssistantState, emptyAssistantDraft, type AssistantCatalog, type AssistantDraft, type OutreachAssistant } from '@/lib/outreach-assistants';
import AssistantList from '@/components/outreach/assistants/AssistantList';
import AssistantEditor from '@/components/outreach/assistants/AssistantEditor';
import { ResourceSelection, RuntimeNotice } from '@/components/outreach/assistants/AssistantShared';
import { ToolsConfiguration } from '@/components/outreach/assistants/AssistantJourneys';
import { AssistantSimulator } from '@/components/outreach/assistants/AssistantSimulator';
import { AvailabilityConfiguration } from '@/components/outreach/assistants/AssistantAvailability';
import { BasicConfiguration } from '@/components/outreach/assistants/AssistantConfiguration';
import { useAssistantDetail, useAssistantList, useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import api, { ApiError } from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ApiError, default: { post: vi.fn(), get: vi.fn().mockResolvedValue({ items: [] }), put: vi.fn(), delete: vi.fn() } };
});
vi.mock('@/hooks/use-outreach-assistants', () => ({ ASSISTANT_API: '/api/settings/outreach/assistants', useAssistantDetail: vi.fn(), useAssistantList: vi.fn(), useAssistantWorkspace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-business-profiles', () => ({ useBusinessProfiles: () => ({ activeProfile: { id: 1, companyName: 'Assistant test workspace', role: 'owner' }, isLoading: false, isError: false }), businessProfileName: (profile: { companyName: string }) => profile.companyName }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function TestQueryProvider({ children }: { children: ReactNode }) { const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } })); return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
const withQuery = (children: ReactNode) => <TestQueryProvider>{children}</TestQueryProvider>;

const catalog: AssistantCatalog = {
  runtimeEnabled: true,
  presets: [{ agentType: 'hotel_sales', name: 'Hotel sales', description: '', instructions: '', tools: [], policies: {} }],
  accounts: [{ channel: 'whatsapp', surface: 'private', accountId: 'verified-line', label: 'Hotel line', connected: true }],
  models: [{ provider: 'openai', model: 'catalog-model', label: 'Configured model', controls: [] }],
  knowledge: [{ id: 10, name: 'Published policies', channels: ['whatsapp'] }], playbooks: [], templates: [], documents: [], galleries: [],
  tools: [{ name: 'create_proposal', label: 'Create proposal', approvalRequired: true }],
  permissions: { canManage: true, description: 'Business owner only.' },
};
function readyDraft(): AssistantDraft {
  const draft = emptyAssistantDraft();
  return { ...draft, name: 'Guest support', agentType: 'hotel_sales', bindings: [{ channel: 'whatsapp', surface: 'private', accountId: 'verified-line' }], replyModel: { provider: 'openai', model: 'catalog-model' }, knowledge: { mode: 'none', ids: [] }, playbooks: { mode: 'none', assignments: [] }, followUps: { mode: 'none', sequences: [] }, documents: { mode: 'none', ids: [] }, galleries: { mode: 'none', ids: [] }, tools: { mode: 'none', names: [], approvalRequired: [] } };
}
function assistant(draft = readyDraft()): OutreachAssistant {
  return { id: 'assistant-one', businessProfileId: 1, state: 'live', draft, draftVersion: 1, publishedRevision: 1, published: draft, readiness: { ready: true, checks: [] }, updatedAt: '2026-09-29T12:00:00Z' };
}
describe('assistant selections and routing presentation', () => {
  it('hides unassigned disconnected accounts while keeping disconnected assignments visible', () => {
    const draft = readyDraft();
    const assigned = { channel: 'facebook' as const, surface: 'private' as const, accountId: 'assigned-page' };
    const unrelated = { channel: 'facebook' as const, surface: 'private' as const, accountId: 'old-page' };
    draft.bindings = [...draft.bindings, assigned];
    const accountCatalog = { ...catalog, accounts: [...catalog.accounts,
      { ...assigned, label: 'Assigned page', connected: false },
      { ...unrelated, label: 'Old page', connected: false }] };
    render(<BasicConfiguration draft={draft} catalog={accountCatalog} onChange={vi.fn()} assistantId="assistant-one" />);
    expect(screen.getByText(/Hotel line/)).toBeInTheDocument();
    expect(screen.getByText(/Assigned page/)).toBeInTheDocument();
    expect(screen.queryByText(/Old page/)).not.toBeInTheDocument();
    expect(screen.getByText(/Disconnected · Reconnect/)).toBeInTheDocument();
  });
  it('explains that disabled assistant runtime blocks all customer delivery', () => {
    const { rerender } = render(<RuntimeNotice enabled={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Customer delivery is blocked: assistant runtime is disabled.');
    expect(screen.getByRole('status')).toHaveTextContent('Prepare drafts or simulations');
    expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', '/documentation/assistants#delivery-block');
    rerender(<RuntimeNotice enabled />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each([false, true])('shows truthful empty-assistant setup guidance with runtime enabled=%s', runtimeEnabled => {
    const emptyCatalog = { ...catalog, runtimeEnabled };
    vi.mocked(useAssistantWorkspace).mockReturnValue({ profileId: 1, scopeKey: ['outreach-assistants', 1, 1], profiles: { isLoading: false, isError: false }, catalog: { data: emptyCatalog, isLoading: false, isError: false } } as unknown as ReturnType<typeof useAssistantWorkspace>);
    vi.mocked(useAssistantList).mockReturnValue({ data: { assistants: [], runtimeEnabled, nextCursor: null }, isLoading: false, isError: false } as unknown as ReturnType<typeof useAssistantList>);
    render(withQuery(<AssistantList />));
    expect(screen.getByRole('heading', { name: 'Create your first assistant' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read the setup guide' })).toHaveAttribute('href', '/documentation/assistants#configure-draft');
    expect(screen.getByText(/Your assistant stays a draft/)).toBeInTheDocument();
    if (!runtimeEnabled) expect(screen.getByRole('status')).toHaveTextContent('Customer delivery is blocked: assistant runtime is disabled.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('starts every optional category undecided rather than inheriting resources', () => {
    const issues = assistantDraftIssues(emptyAssistantDraft(), catalog);
    expect(issues).toContain('Choose resources or None for knowledge sources.');
    expect(emptyAssistantDraft().knowledge.ids).toEqual([]);
    expect(assistantDraftIssues(readyDraft(), catalog)).toEqual([]);
  });
  it('never presents an unconnected or unpublished assistant as Live', () => {
    expect(displayedAssistantState(assistant(), catalog)).toBe('live');
    expect(displayedAssistantState(assistant(), { ...catalog, accounts: [] })).toBe('needs_attention');
    expect(displayedAssistantState({ ...assistant(), publishedRevision: null }, catalog)).toBe('needs_attention');
    expect(displayedAssistantState(assistant(), { ...catalog, runtimeEnabled: false })).toBe('needs_attention');
    expect(displayedAssistantState({ ...assistant(), readiness: { ready: false, checks: [] }, draft: emptyAssistantDraft() }, catalog)).toBe('live');
    expect(displayedAssistantState({ ...assistant(), enabledBindings: [] }, catalog)).toBe('needs_attention');
  });
  it('shows and searches only remaining enabled accounts after partial reassignment', () => {
    const draft = readyDraft();
    const formerBinding = { channel: 'whatsapp' as const, surface: 'private' as const, accountId: 'former-line' };
    draft.bindings = [...draft.bindings, formerBinding];
    const partiallyReassigned = { ...assistant(draft), enabledBindings: [draft.bindings[0]] };
    const listCatalog: AssistantCatalog = { ...catalog, accounts: [...catalog.accounts, { ...formerBinding, label: 'Former hotel line', connected: false, assignedAssistantId: 'assistant-two' }] };
    const workspace = { profileId: 1, scopeKey: ['outreach-assistants', 1, 1], profiles: { isLoading: false, isError: false }, catalog: { data: listCatalog, isLoading: false, isError: false } } as unknown as ReturnType<typeof useAssistantWorkspace>;
    vi.mocked(useAssistantWorkspace).mockReturnValue(workspace);
    vi.mocked(useAssistantList).mockReturnValue({ data: { assistants: [partiallyReassigned], runtimeEnabled: true }, isLoading: false, isError: false } as ReturnType<typeof useAssistantList>);
    render(<QueryClientProvider client={new QueryClient()}><AssistantList /></QueryClientProvider>);
    expect(screen.getByRole('link', { name: 'Follow-ups' })).toHaveAttribute('href', '/dashboard/outreach/follow-ups');
    expect(screen.getByRole('link', { name: 'Reply operations' })).toHaveAttribute('href', '/dashboard/settings/outreach/operations');
    expect(screen.getByText('Receiving accounts · 1')).toBeInTheDocument();
    expect(screen.getByText('Hotel line · Private messages')).toBeInTheDocument();
    expect(screen.queryByText('Former hotel line · Private messages')).not.toBeInTheDocument();
    expect(screen.getByText('Live', { selector: 'span' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search assistants' }), { target: { value: 'Former hotel line' } });
    expect(screen.getByText('No assistants match these filters. Try another name or status.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search assistants' }), { target: { value: 'Hotel line' } });
    expect(screen.getByRole('heading', { name: 'Guest support' })).toBeInTheDocument();
    expect(assistantListBindings({ ...partiallyReassigned, state: 'draft' })).toEqual(draft.bindings);
    expect(assistantListBindings({ ...partiallyReassigned, state: 'needs_attention', draft: emptyAssistantDraft() })).toEqual([draft.bindings[0]]);
    expect(partiallyReassigned.published?.bindings).toHaveLength(2);
  });
  it('keeps publish review open and requires explicit reassignment for server-discovered conflicts', async () => {
    const workspace = { profileId: 1, scopeKey: ['outreach-assistants', 1, 1], requestOptions: { headers: { 'X-Business-Profile-Id': '1' } }, profiles: { isLoading: false, isError: false }, catalog: { data: catalog, isLoading: false, isError: false } } as unknown as ReturnType<typeof useAssistantWorkspace>;
    let current = assistant();
    vi.mocked(useAssistantWorkspace).mockReturnValue(workspace);
    vi.mocked(useAssistantDetail).mockImplementation(() => ({ data: current, isLoading: false, isError: false }) as ReturnType<typeof useAssistantDetail>);
    let publishAttempts = 0;
    vi.mocked(api.post).mockImplementation(async path => {
      if (path.endsWith('/readiness')) return { ready: true, checks: [] };
      if (path.endsWith('/publish')) {
        if (publishAttempts++ === 0) throw new ApiError('These accounts already have an assistant. Confirm reassignment to replace it.', 409, { details: { bindings: [{ channel: 'whatsapp', surface: 'private', accountId: 'verified-line', assistantId: 'assistant-two' }, { channel: 'facebook', surface: 'private', accountId: 'outside-reviewed-draft', assistantId: 'assistant-three' }] } });
        current = { ...current, publishedRevision: 2, updatedAt: '2026-09-29T14:00:00Z' };
        return current;
      }
      throw new Error('Unexpected assistant API operation');
    });
    render(<QueryClientProvider client={new QueryClient()}><AssistantEditor assistantId="assistant-one" /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }));
    const review = await screen.findByRole('dialog', { name: 'Review assistant assignments' });
    expect(within(review).queryByRole('checkbox', { name: /Replace existing assistant assignments/ })).not.toBeInTheDocument();
    fireEvent.click(within(review).getByRole('button', { name: 'Publish assistant' }));
    const confirmation = await within(review).findByRole('checkbox', { name: /Replace existing assistant assignments/ });
    expect(confirmation).not.toBeChecked();
    expect(within(review).getByText(/WhatsApp \/ Hotel line · Private messages currently use another assistant/)).toBeInTheDocument();
    expect(within(review).queryByText(/outside-reviewed-draft/)).not.toBeInTheDocument();
    expect(within(review).getByRole('button', { name: 'Publish assistant' })).toBeDisabled();
    expect(publishAttempts).toBe(1);
    expect(api.post).toHaveBeenLastCalledWith('/api/settings/outreach/assistants/assistant-one/publish', { expectedDraftVersion: 1, confirmAssignments: true, reassign: false }, workspace.requestOptions);
    fireEvent.click(confirmation);
    fireEvent.click(within(review).getByRole('button', { name: 'Publish assistant' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/settings/outreach/assistants/assistant-one/publish', { expectedDraftVersion: 1, confirmAssignments: true, reassign: true }, workspace.requestOptions));
    expect(await screen.findByText('Published revision 2. The assigned accounts will use this configuration on their next turn.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Review assistant assignments' })).not.toBeInTheDocument();
  });
  it('distinguishes accounts and private/public surfaces', () => {
    expect(assistantBindingKey({ channel: 'instagram', surface: 'private', accountId: 'same-account' })).not.toBe(assistantBindingKey({ channel: 'instagram', surface: 'public_comment', accountId: 'same-account' }));
  });
  it('does not allow selected empty resources or unapproved model fallback', () => {
    const draft = readyDraft(); draft.knowledge = { mode: 'selected', ids: [] }; draft.fallbackModels = [{ provider: 'openai', model: 'not-in-catalog' }];
    expect(assistantDraftIssues(draft, catalog)).toContain('Select at least one item for knowledge sources, or choose None.');
    expect(assistantDraftIssues(draft, catalog)).toContain('Remove an unavailable or duplicate fallback model.');
  });
  it('validates stored overlaps and timezone even for 24/7 and permits midnight as an end', () => {
    const draft = readyDraft(); draft.availability = { enabled: true, timezone: 'not-a-timezone', awayMessage: null, weekly: [{ day: 1, ranges: [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '18:00' }] }] };
    expect(assistantDraftIssues(draft, catalog)).toContain('Choose a valid timezone.');
    expect(assistantDraftIssues(draft, catalog)).toContain('Availability ranges must not overlap or cross midnight.');
    draft.availability.enabled = false;
    expect(assistantDraftIssues(draft, catalog)).toContain('Choose a valid timezone.');
    expect(assistantDraftIssues(draft, catalog)).toContain('Availability ranges must not overlap or cross midnight.');
    draft.availability.timezone = 'UTC';
    draft.availability.weekly = [{ day: 1, ranges: [{ start: '00:00', end: '24:00' }] }];
    expect(assistantDraftIssues(draft, catalog)).toEqual([]);
    draft.availability.weekly = [{ day: 1, ranges: [{ start: '24:00', end: '24:00' }] }];
    expect(assistantDraftIssues(draft, catalog)).toContain('Availability ranges must not overlap or cross midnight.');
  });
  it('exposes repair controls for inactive invalid availability settings', () => {
    const draft = readyDraft();
    draft.availability = { enabled: false, timezone: 'invalid-zone', awayMessage: null, weekly: [{ day: 1, ranges: [{ start: '09:00', end: '08:00' }] }] };
    render(<AvailabilityConfiguration draft={draft} catalog={catalog} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Timezone')).toHaveValue('invalid-zone');
    expect(screen.getByRole('alert')).toHaveTextContent('Repair the stored availability settings');
    expect(screen.getByRole('button', { name: 'Clear stored weekly hours' })).toBeInTheDocument();
    expect(screen.getByText('Stored weekly hours · Inactive').closest('details')).toHaveAttribute('open');
  });
  it('requires a deliberate None and clears the previous allowlist', () => {
    const update = vi.fn();
    render(<ResourceSelection label="Knowledge sources" resources={catalog.knowledge} value={{ mode: 'selected', ids: [10] }} onChange={update} />);
    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    expect(update).toHaveBeenCalledWith({ mode: 'none', ids: [] });
  });
  it('keeps mandatory proposal approvals enforced after applying the tool drawer', async () => {
    const workspace = { profileId: 1, scopeKey: ['outreach-assistants', 1, 1], catalog: { data: catalog }, requestOptions: { headers: { 'X-Business-Profile-Id': '1' } } } as unknown as ReturnType<typeof useAssistantWorkspace>;
    vi.mocked(useAssistantWorkspace).mockReturnValue(workspace);
    vi.mocked(api.get).mockResolvedValue({ items: [{ id: 'create_proposal', name: 'Create proposal', channels: [], approvalRequired: true }], total: 1, page: 1, pageSize: 20, hasMore: false });
    function Harness() { const [draft, setDraft] = useState({ ...readyDraft(), tools: { mode: 'selected' as const, names: [] as string[], approvalRequired: [] as string[] } }); return <ToolsConfiguration draft={draft} catalog={catalog} onChange={next => setDraft({ ...next, tools: { ...next.tools, mode: 'selected' } })} />; }
    render(withQuery(<Harness />));
    fireEvent.click(screen.getByRole('button', { name: 'Choose tools' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Create proposal/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selection (1)' }));
    expect(screen.getByRole('checkbox', { name: 'Approval mandatory' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Approval mandatory' })).toBeDisabled();
  });
});
describe('assistant simulator', () => {
  const workspace = { scopeKey: ['outreach-assistants', 1, 1], catalog: { data: catalog }, requestOptions: { headers: { 'X-Business-Profile-Id': '1' } } } as unknown as ReturnType<typeof useAssistantWorkspace>;
  it('sends the explicit assistant and revision and rejects missing side-effect suppression', async () => {
    vi.mocked(api.post).mockResolvedValue({ reply: 'Sent the proposal.', sideEffectsSuppressed: false });
    render(withQuery(<AssistantSimulator assistant={assistant()} workspace={workspace} dirty={false} />));
    fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'Please share the brochure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/settings/outreach/assistants/assistant-one/simulate', { message: 'Please share the brochure', channel: 'whatsapp', revision: 'draft', conversationHistory: [] }, workspace.requestOptions));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not confirm side-effect suppression');
    expect(screen.queryByText('Sent the proposal.')).not.toBeInTheDocument();
  });
  it('blocks testing unsaved edits', () => {
    render(withQuery(<AssistantSimulator assistant={assistant()} workspace={workspace} dirty />));
    fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'Hi' } });
    expect(screen.getByRole('button', { name: 'Test saved configuration' })).toBeDisabled();
  });
  it('continues only the signed isolated preview and resets it for configuration or channel changes', async () => {
    vi.mocked(api.post).mockResolvedValue({ reply: 'How many rooms?', sideEffectsSuppressed: true, conversationId: -5_000_001, previewSessionToken: 'signed-session', privacyOutcome: { redactedInput: 'Two guests' } });
    const view = render(withQuery(<AssistantSimulator assistant={assistant()} workspace={workspace} dirty={false} />));
    fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'Two guests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await screen.findByText('How many rooms?');
    fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'One room' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/settings/outreach/assistants/assistant-one/simulate', expect.objectContaining({ conversationId: -5_000_001, previewSessionToken: 'signed-session', conversationHistory: [{ role: 'user', content: 'Two guests' }, { role: 'assistant', content: 'How many rooms?' }] }), workspace.requestOptions));
    await screen.findByText('How many rooms?');
    view.rerender(withQuery(<AssistantSimulator assistant={{ ...assistant(), draftVersion: 2 }} workspace={workspace} dirty={false} />));
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/settings/outreach/assistants/assistant-one/simulate', { message: 'One room', channel: 'whatsapp', revision: 'draft', conversationHistory: [] }, workspace.requestOptions));
    await screen.findByText('How many rooms?');
    fireEvent.change(screen.getByLabelText('Test channel'), { target: { value: 'email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/settings/outreach/assistants/assistant-one/simulate', { message: 'One room', channel: 'email', revision: 'draft', conversationHistory: [] }, workspace.requestOptions));
  });
});
