import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CreateAssistant from '@/components/outreach/assistants/CreateAssistant';
import AdminModelCatalog from '@/components/admin/AssistantModelCatalog';
import { platformAIQuotaMessage, type AdminAssistantModelCatalog } from '../../../shared/assistantModelCatalog';
import { setupCatalog } from './fixtures/assistantSetupCatalog';
import { emptyAssistantDraft } from '@/lib/outreach-assistants';
import { recoverableAssistantDraft } from '@/components/outreach/assistants/assistantEditorUtils';

const mocks = vi.hoisted(() => ({ post: vi.fn(), push: vi.fn(), get: vi.fn(), put: vi.fn(), adminPost: vi.fn(), workspace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/api', () => ({ default: { post: mocks.post } }));
vi.mock('@/lib/admin-api', () => ({ default: { get: mocks.get, put: mocks.put, post: mocks.adminPost } }));
vi.mock('@/hooks/use-outreach-assistants', () => ({ ASSISTANT_API: '/api/settings/outreach/assistants', useAssistantWorkspace: mocks.workspace }));
const wrapper = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
const adminCatalog: AdminAssistantModelCatalog = { canManage: true, connections: [
  { id: 1, provider: 'openai', name: 'Primary connection', connected: true },
  { id: 2, provider: 'openrouter', name: 'Router connection', connected: true },
], models: setupCatalog.models.map((model, index) => ({ ...model, id: index + 1, description: model.description || '', enabled: true, connected: true, order: index + 1, credentialId: index + 1, connectionName: 'Primary connection', version: 1 })) };
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.workspace.mockReturnValue({ profileId: 1, scopeKey: ['outreach-assistants', 7, 1], profiles: { isLoading: false, isError: false }, requestOptions: { headers: { 'X-Business-Profile-Id': '1' } }, catalog: { data: setupCatalog, isLoading: false, isError: false } });
  mocks.get.mockResolvedValue(structuredClone(adminCatalog));
  mocks.post.mockImplementation(async (_path, body) => ({ id: 'draft-one', draft: body.draft }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
const identity = () => {
  fireEvent.change(screen.getByLabelText('Assistant name'), { target: { value: 'Customer care' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Hotel Sales Agent' }));
  next();
};
const reviewDraft = () => {
  identity();
  fireEvent.click(screen.getByRole('checkbox', { name: 'WhatsApp: Orchid business line' }));
  next();
  fireEvent.click(screen.getByRole('radio', { name: 'GPT Luna' }));
};

describe('assistant setup', () => {
  it('shows the provider quota notice when no reply models can be selected', () => {
    const notice = platformAIQuotaMessage(['OpenRouter']);
    const workspace = mocks.workspace();
    mocks.workspace.mockReturnValue({ ...workspace, catalog: { ...workspace.catalog, data: { ...setupCatalog, models: [], modelAvailabilityNotice: notice } } });
    wrapper(<CreateAssistant />);
    identity();
    fireEvent.click(screen.getByRole('checkbox', { name: 'WhatsApp: Orchid business line' }));
    next();
    expect(screen.getByText(notice)).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('explains incomplete fields and keeps each step until its required selections are made', () => {
    wrapper(<CreateAssistant />);
    next();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an assistant name.');
    expect(screen.getByRole('heading', { name: '1. Identity' })).toBeVisible();
    identity(); next();
    expect(screen.getByRole('alert')).toHaveTextContent('Select at least one connected receiving account.');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox', { name: /Offline line/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Instagram comments')).not.toBeInTheDocument();
  });

  it('recovers account selections and trusted preset while requiring the missing name', async () => {
    const draft = { ...emptyAssistantDraft(), agentType: 'hotel_sales', bindings: setupCatalog.accounts.filter(account => account.connected && account.surface === 'private').map(({ channel, surface, accountId }) => ({ channel, surface, accountId })), replyModel: { provider: 'openai', model: 'fixture-gpt' } };
    sessionStorage.setItem('assistant-draft:7:1:new', JSON.stringify({ at: Date.now(), version: 0, value: recoverableAssistantDraft(draft) }));
    wrapper(<CreateAssistant />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore configuration' }));
    expect(screen.getByLabelText('Assistant name')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Assistant name'), { target: { value: 'Recovered support' } });
    next();
    expect(screen.getByRole('checkbox', { name: 'WhatsApp: Orchid business line' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Instagram: @orchid.stays' })).toBeChecked();
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/settings/outreach/assistants', { draft: expect.objectContaining({ instructions: 'Hotel starting instructions', bindings: draft.bindings }) }, expect.anything()));
  });

  it('preserves multiple accounts and model selections when going back to change the role', async () => {
    wrapper(<CreateAssistant />); identity();
    for (const name of ['WhatsApp: Orchid business line', 'WhatsApp: Orchid reservations', 'Instagram: @orchid.stays', 'Email: support@orchid.example']) fireEvent.click(screen.getByRole('checkbox', { name }));
    next();
    fireEvent.click(screen.getByRole('radio', { name: 'Gemini 3.5 Plus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('checkbox', { name: 'WhatsApp: Orchid business line' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Technical Support Agent' }));
    next(); next();
    expect(screen.getByRole('radio', { name: 'Gemini 3.5 Plus' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/settings/outreach/assistants', { draft: expect.objectContaining({ name: 'Customer care', agentType: 'technical_support', instructions: 'Technical starting instructions', replyModel: { provider: 'openrouter', model: 'fixture/gemini' }, bindings: [
      { channel: 'whatsapp', surface: 'private', accountId: 'same-id' },
      { channel: 'whatsapp', surface: 'private', accountId: 'second-line' },
      { channel: 'instagram', surface: 'private', accountId: 'same-id' },
      { channel: 'email', surface: 'private', accountId: 'support@orchid.example' },
    ] }) }, expect.objectContaining({ headers: { 'X-Business-Profile-Id': '1' } })));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/dashboard/settings/outreach/assistants/draft-one?tab=knowledge'));
  });

  it('supports email-only setup without an implicit WhatsApp requirement and shows the only model selected', async () => {
    const workspace = mocks.workspace();
    mocks.workspace.mockReturnValue({ ...workspace, catalog: { ...workspace.catalog, data: { ...setupCatalog, models: [setupCatalog.models[0]] } } });
    wrapper(<CreateAssistant />); identity();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email: support@orchid.example' }));
    next();
    expect(screen.getByRole('radio', { name: 'GPT Luna' })).toBeChecked();
    expect(screen.queryByLabelText('Search reply models')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1].draft.bindings).toEqual([{ channel: 'email', surface: 'private', accountId: 'support@orchid.example' }]);
    expect(mocks.post.mock.calls[0][1].draft.knowledge.mode).toBe('unconfigured');
  });

  it('keeps failed drafts editable and permits a retry with the same selections', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Unable to save draft.'));
    wrapper(<CreateAssistant />); reviewDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save draft.');
    expect(screen.getByRole('radio', { name: 'GPT Luna' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('heading', { name: 'Draft created' })).toBeVisible();
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('does not offer another POST when cache refresh fails after creation', async () => {
    const client = new QueryClient();
    vi.spyOn(client, 'invalidateQueries').mockRejectedValue(new Error('Refresh failed'));
    render(<QueryClientProvider client={client}><CreateAssistant /></QueryClientProvider>);
    reviewDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('heading', { name: 'Draft created' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute('href', '/dashboard/settings/outreach/assistants/draft-one?tab=knowledge');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('admits one creation request while a draft is being saved', async () => {
    let resolve!: (value: unknown) => void;
    mocks.post.mockReturnValue(new Promise(done => { resolve = done; }));
    wrapper(<CreateAssistant />); reviewDraft();
    const create = screen.getByRole('button', { name: 'Create draft' });
    fireEvent.click(create); fireEvent.click(create);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Creating draft…' })).toBeDisabled();
    await act(async () => resolve({ id: 'draft-one', draft: mocks.post.mock.calls[0][1].draft }));
    expect(await screen.findByRole('heading', { name: 'Draft created' })).toBeVisible();
  });
});

describe('admin model catalog', () => {
  it('adds a model using an admin connection and display settings', async () => {
    mocks.adminPost.mockResolvedValue({ success: true });
    wrapper(<AdminModelCatalog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add model' }));
    expect(screen.getByRole('button', { name: 'Save model' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New assistant model' } });
    fireEvent.change(screen.getByLabelText('Exact model ID'), { target: { value: 'exact-model-id' } });
    fireEvent.change(screen.getByLabelText('Provider connection'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    await waitFor(() => expect(mocks.adminPost).toHaveBeenCalledWith('/api/admin/assistant-models', { provider: 'openrouter', credentialId: 2, model: 'exact-model-id', label: 'New assistant model', description: '', enabled: true, order: 3, expectedVersion: 0 }));
  });
  it('keeps failed edits in the panel and saves the exact provider/model mapping', async () => {
    mocks.put.mockRejectedValueOnce(new Error('This model changed. Reload the catalog before saving.')).mockResolvedValue({ success: true });
    wrapper(<AdminModelCatalog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit GPT Luna' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Customer GPT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This model changed');
    expect(screen.getByLabelText('Display name')).toHaveValue('Customer GPT');
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    await waitFor(() => expect(mocks.put).toHaveBeenLastCalledWith('/api/admin/assistant-models/1', { provider: 'openai', credentialId: 1, model: 'fixture-gpt', label: 'Customer GPT', description: 'General customer conversations', enabled: true, order: 1, expectedVersion: 1 }));
  });
  it('filters models and excludes disabled or disconnected entries from the assistant preview', async () => {
    const data = structuredClone(adminCatalog); data.models[1].enabled = false;
    mocks.get.mockResolvedValue(data);
    wrapper(<AdminModelCatalog />);
    await screen.findByRole('button', { name: 'Edit GPT Luna' });
    expect(screen.getByRole('radio', { name: 'GPT Luna' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Gemini 3.5 Plus' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter models by status'), { target: { value: 'disabled' } });
    expect(screen.queryByRole('button', { name: 'Edit GPT Luna' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Gemini 3.5 Plus' })).toBeInTheDocument();
  });
});
