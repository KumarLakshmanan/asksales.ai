import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AssistantEditor from '@/components/outreach/assistants/AssistantEditor';
import { emptyAssistantDraft, type AssistantCatalog, type AssistantReadiness, type OutreachAssistant } from '@/lib/outreach-assistants';
import { useAssistantDetail, useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import api, { ApiError } from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ApiError, default: { post: vi.fn(), get: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});
vi.mock('@/hooks/use-outreach-assistants', () => ({ ASSISTANT_API: '/api/settings/outreach/assistants', useAssistantDetail: vi.fn(), useAssistantWorkspace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/outreach/assistants/AssistantConfiguration', () => ({ BasicConfiguration: () => null, ModelConfiguration: () => null, PrivacyConfiguration: () => null }));
vi.mock('@/components/outreach/assistants/AssistantJourneys', () => ({ FollowUpsConfiguration: () => null, PlaybooksConfiguration: () => null, ToolsConfiguration: () => null }));
vi.mock('@/components/outreach/assistants/AssistantAvailability', () => ({ AvailabilityConfiguration: () => null }));
vi.mock('@/components/outreach/assistants/AssistantSimulator', () => ({ AssistantSimulator: () => null, AssistantDeliveryHistory: () => null }));
vi.mock('@/components/outreach/assistants/AssistantRevisionHistory', () => ({ AssistantRevisionHistory: () => null }));
vi.mock('@/components/outreach/assistants/useAssistantDraftRecovery', () => ({ useAssistantDraftRecovery: () => ({ clear: vi.fn(), banner: null }) }));
vi.mock('@/components/outreach/assistants/useAssistantEditorGuard', () => ({ useAssistantEditorGuard: () => undefined }));

let current: OutreachAssistant;
let catalog: AssistantCatalog;
let readiness: AssistantReadiness;
const requestOptions = { headers: { 'X-Business-Profile-Id': '1' } };
const apiPath = '/api/settings/outreach/assistants/assistant-fixture';
beforeEach(() => {
  vi.resetAllMocks();
  const draft = emptyAssistantDraft();
  draft.name = 'Synthetic support'; draft.agentType = 'general_service';
  draft.bindings = [{ channel: 'email', surface: 'private', accountId: 'support@example.invalid' }];
  draft.replyModel = { provider: 'openai', model: 'fixture-model' };
  for (const key of ['knowledge', 'documents', 'galleries', 'playbooks', 'followUps', 'tools'] as const) draft[key].mode = 'none';
  readiness = { ready: true, checks: [] };
  current = { id: 'assistant-fixture', businessProfileId: 1, draft, draftVersion: 2, state: 'draft',
    publishedRevision: null, published: null, readiness, updatedAt: '2026-10-27T01:00:00Z' };
  catalog = { runtimeEnabled: false, accounts: [{ ...draft.bindings[0], label: 'Synthetic sender', connected: true }],
    presets: [{ agentType: 'general_service', name: 'Service', description: '', instructions: '', tools: [], policies: {} }],
    models: [{ ...draft.replyModel, label: 'Synthetic model', controls: [] }],
    knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [],
    permissions: { canManage: true, description: 'Owner' } };
  vi.mocked(useAssistantWorkspace).mockImplementation(() => ({ profileId: 1, scopeKey: ['outreach-assistants', 1, 1], requestOptions,
    profiles: { isLoading: false, isError: false }, catalog: { data: catalog, isLoading: false, isError: false } }) as unknown as ReturnType<typeof useAssistantWorkspace>);
  vi.mocked(useAssistantDetail).mockImplementation(() => ({ data: current, isLoading: false, isError: false }) as ReturnType<typeof useAssistantDetail>);
  vi.mocked(api.post).mockImplementation(async path => {
    if (path.endsWith('/readiness')) return readiness;
    if (path.endsWith('/publish')) {
      current = { ...current, publishedRevision: 1, published: current.draft,
        enabledBindings: current.draft.bindings, state: 'needs_attention', updatedAt: '2026-10-27T02:00:00Z' };
      return current;
    }
    throw new Error('Unexpected request');
  });
});
afterEach(cleanup);
const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AssistantEditor assistantId="assistant-fixture" /></QueryClientProvider>);
const review = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }));
  return within(await screen.findByRole('dialog', { name: 'Review assistant assignments' }));
};

describe('publishing a reviewed assistant before runtime activation', () => {
  it('opens assistant testing from the checklist and last step without leaving the current setup step', async () => {
    show();
    fireEvent.click(screen.getAllByRole('button', { name: 'Test assistant' })[1]);
    let drawer = await screen.findByRole('dialog', { name: 'Test assistant' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('heading', { name: '1. Identity & accounts' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Step 8: Availability' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Test assistant' }).at(-1)!);
    drawer = await screen.findByRole('dialog', { name: 'Test assistant' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('heading', { name: '8. Availability' })).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });
  it('keeps incomplete follow-up placeholders out of the save API and navigates to actionable guidance', async () => {
    current.draft.followUps = { mode: 'selected', sequences: [{ channel: 'whatsapp', steps: [{ delayMinutes: 60, templateId: 0 }] }] };
    current.draft.knowledge.mode = 'unconfigured';
    show();
    fireEvent.click(screen.getByText('Leave optional resources unused'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave these unused' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('whatsapp message 1: choose an approved template before saving.')).toBeVisible();
    expect(screen.getByRole('heading', { name: '6. Follow-ups' })).toBeVisible();
    expect(api.put).not.toHaveBeenCalled();
  });
  it('saves an AI check-in without requiring an approved template or resolving other optional draft choices', async () => {
    current.draft.bindings = [{ channel: 'whatsapp', surface: 'private', accountId: 'test-line' }];
    current.draft.followUps = { mode: 'selected', sequences: [{ channel: 'whatsapp', steps: [{ delayMinutes: 60, templateId: 0, messageMode: 'ai' }] }] };
    current.draft.knowledge.mode = 'unconfigured';
    vi.mocked(api.put).mockImplementation(async (_path, body) => ({ ...current, draft: (body as { draft: OutreachAssistant['draft'] }).draft, draftVersion: 3 }));
    show();
    fireEvent.click(screen.getByText('Leave optional resources unused'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave these unused' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(apiPath, expect.objectContaining({ draft: expect.objectContaining({ followUps: current.draft.followUps }) }), requestOptions));
    expect(await screen.findByText(/Draft saved. Customer replies/)).toBeVisible();
  });
  it('permits an explicit ready publication while stating that customer delivery stays blocked', async () => {
    show();
    const dialog = await review();
    expect(dialog.getByText(/Customer delivery also requires enabled runtime/)).toBeVisible();
    const publish = dialog.getByRole('button', { name: 'Publish assistant' });
    expect(publish).toBeEnabled();
    fireEvent.click(publish);
    expect(await screen.findByText('Published revision 1. Customer delivery remains blocked until assistant runtime is enabled.')).toBeVisible();
    expect(api.post).toHaveBeenCalledWith(`${apiPath}/publish`, { expectedDraftVersion: 2, confirmAssignments: true, reassign: false }, requestOptions);
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(catalog.runtimeEnabled).toBe(false);
    expect(screen.queryByText(/The assigned accounts will use this configuration on their next turn/)).not.toBeInTheDocument();
  });

  it('keeps failed server readiness blocked while runtime is off', async () => {
    readiness = { ready: false, checks: [{ key: 'classifier', label: 'Intent classifier', ok: false, detail: 'A validated classifier is required.' }] };
    show();
    const dialog = await review();
    expect(dialog.getByText('A validated classifier is required.')).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Publish assistant' })).toBeDisabled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('keeps disconnected exact account assignments blocked', async () => {
    catalog.accounts[0].connected = false;
    show();
    const dialog = await review();
    expect(dialog.getByRole('button', { name: 'Publish assistant' })).toBeDisabled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('requires explicit confirmation for server-discovered reassignment conflicts', async () => {
    let attempts = 0;
    vi.mocked(api.post).mockImplementation(async path => {
      if (path.endsWith('/readiness')) return readiness;
      if (path.endsWith('/publish')) {
        attempts += 1;
        if (attempts === 1) throw new ApiError('Review reassignment.', 409, { details: { bindings: [{ ...current.draft.bindings[0], assistantId: 'other-assistant' }] } });
        current = { ...current, publishedRevision: 1, published: current.draft, state: 'needs_attention', updatedAt: '2026-10-27T02:00:00Z' };
        return current;
      }
      throw new Error('Unexpected request');
    });
    show();
    const dialog = await review();
    fireEvent.click(dialog.getByRole('button', { name: 'Publish assistant' }));
    const confirm = await dialog.findByRole('checkbox', { name: /Replace existing assistant assignments/ });
    expect(dialog.getByRole('button', { name: 'Publish assistant' })).toBeDisabled();
    expect(attempts).toBe(1);
    fireEvent.click(confirm);
    fireEvent.click(dialog.getByRole('button', { name: 'Publish assistant' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(`${apiPath}/publish`, { expectedDraftVersion: 2, confirmAssignments: true, reassign: true }, requestOptions));
    expect(await screen.findByText(/Published revision 1. Customer delivery remains blocked/)).toBeVisible();
  });

  it('keeps publishing unavailable to read-only users', () => {
    catalog.permissions.canManage = false;
    show();
    expect(screen.queryByRole('button', { name: 'Review & publish' })).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('preserves the existing enabled-runtime success wording', async () => {
    catalog.runtimeEnabled = true;
    show();
    const dialog = await review();
    fireEvent.click(dialog.getByRole('button', { name: 'Publish assistant' }));
    expect(await screen.findByText('Published revision 1. The assigned accounts will use this configuration on their next turn.')).toBeVisible();
  });
});
