import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OwnerChat from '@/app/dashboard/(main)/support-ai/chat/page';
import { emptyAssistantDraft, type OutreachAssistant } from '@/lib/outreach-assistants';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), runtimeEnabled: true as boolean | undefined, assistants: [] as unknown[], profileId: 1, isError: false, isFetching: false, refetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-outreach-assistants', () => ({
  useAssistantWorkspace: () => ({ profileId: mocks.profileId, scopeKey: ['outreach-assistants', 1, mocks.profileId], requestOptions: { headers: { 'X-Business-Profile-Id': String(mocks.profileId) } }, profiles: { isLoading: false, refetch: mocks.refetch }, catalog: { data: { runtimeEnabled: mocks.runtimeEnabled } } }),
  useAssistantList: () => ({ data: { runtimeEnabled: mocks.runtimeEnabled, assistants: mocks.assistants }, isError: mocks.isError, isFetching: mocks.isFetching, refetch: mocks.refetch }),
}));

function assistant(id = 'assistant-one', draftVersion = 1): OutreachAssistant {
  const draft = { ...emptyAssistantDraft(), name: id === 'assistant-one' ? 'Guest support' : 'Sales support' };
  return { id, businessProfileId: 1, state: 'live', draft, draftVersion, publishedRevision: 3, published: draft, readiness: { ready: true, checks: [] }, updatedAt: '2026-09-29T12:00:00Z' };
}
beforeEach(() => {
  window.history.replaceState({}, '', '/dashboard/support-ai/chat');
  vi.clearAllMocks();
  mocks.runtimeEnabled = true; mocks.profileId = 1; mocks.isError = false; mocks.isFetching = false; mocks.assistants = [assistant(), assistant('assistant-two')];
  mocks.get.mockResolvedValue({ data: [], total: 0 });
  mocks.post.mockImplementation(async (_url: string, body: { message: string }) => ({ sessionId: 10,
    userMessage: { id: 11, sessionId: 10, role: 'user', content: body.message, createdAt: '2026-09-29T12:00:00Z' },
    assistantMessage: { id: 12, sessionId: 10, role: 'assistant', content: 'Verified reply', createdAt: '2026-09-29T12:00:00Z', metadata: { provenance: { assistant: { assistantId: 'assistant-one', revision: 3 } } } },
    response: { answer: 'Verified reply', confidence: 0.9, sources: [] },
  }));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); sessionStorage.clear(); });

describe('owner Support-AI assistant selection', () => {
  it('requires an explicit assistant and sends its profile-scoped configuration choice', async () => {
    render(<OwnerChat />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Assistant for this chat' })).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant for this chat' }), { target: { value: 'assistant-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Saved changes · Settings' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Live version' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Brochure options?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/support/ai/chat', expect.objectContaining({ assistantId: 'assistant-one', assistantRevision: 'published', sessionId: null }), { headers: { 'X-Business-Profile-Id': '1' } }));
    expect(await screen.findByText('Verified reply')).toBeVisible();
    fireEvent.click(screen.getByText('How this answer was produced'));
    expect(screen.getByText('assistant-one · Published r3')).toBeVisible();
  });
  it.each([undefined, false, true])('blocks submission when runtime is %s and no assistant is available', runtime => {
    mocks.runtimeEnabled = runtime; mocks.assistants = [];
    render(<OwnerChat />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Find a product answer/ })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Manage assistants' })).toHaveAttribute('href', '/dashboard/settings/outreach');
    if (runtime === false) expect(screen.getByText('AI replies are disabled. Review assistant setup.')).toBeVisible();
    if (runtime === true) expect(screen.getByText('No assistants are available. Create one to start chatting.')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('retains an existing draft and prevents button and Enter submission when runtime turns off', async () => {
    const view = render(<OwnerChat />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant for this chat' }), { target: { value: 'assistant-one' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Opening hours?' } });
    mocks.runtimeEnabled = false;
    view.rerender(<OwnerChat />);
    expect(screen.getByText('AI replies are disabled. Review assistant setup.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Opening hours?');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.runtimeEnabled = true;
    view.rerender(<OwnerChat />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Opening hours?');
  });
  it('replaces the loading alert with actionable runtime-off guidance instead of hiding it', () => {
    mocks.runtimeEnabled = undefined; mocks.isFetching = true; mocks.assistants = [];
    const view = render(<OwnerChat />);
    expect(screen.getByText('Loading assistants…')).toBeVisible();
    mocks.runtimeEnabled = false; mocks.isFetching = false;
    view.rerender(<OwnerChat />);
    expect(screen.queryByText('Loading assistants…')).not.toBeInTheDocument();
    expect(screen.getByText('AI replies are disabled. Review assistant setup.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Assistant setup required' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Manage assistants' })).toHaveAttribute('href', '/dashboard/settings/outreach');
    expect(screen.getByRole('button', { name: /Find a product answer/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('still opens existing history with runtime off and no assistants', async () => {
    mocks.runtimeEnabled = false; mocks.assistants = [];
    const saved = { id: 88, title: 'Saved QA chat', metadata: null, createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' };
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/88')
      ? { ...saved, messages: [{ id: 1, sessionId: 88, role: 'user', content: 'Historical question', createdAt: saved.createdAt }] }
      : { data: [saved], total: 1 });
    render(<OwnerChat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat Saved QA chat' }));
    expect(await screen.findByText('Historical question')).toBeVisible();
    expect(screen.getByText('AI replies are disabled. Review assistant setup.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('clears selection and history on profile switches instead of choosing a different assistant', async () => {
    const view = render(<OwnerChat />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant for this chat' }), { target: { value: 'assistant-one' } });
    mocks.profileId = 2; mocks.assistants = [assistant('assistant-two')];
    view.rerender(<OwnerChat />);
    expect(screen.getByRole('combobox', { name: 'Assistant for this chat' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('starts a new test session when the selected saved draft changes', async () => {
    const view = render(<OwnerChat />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant for this chat' }), { target: { value: 'assistant-one' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Verified reply');
    mocks.assistants = [assistant('assistant-one', 2), assistant('assistant-two')];
    await act(async () => view.rerender(<OwnerChat />));
    expect(screen.queryByText('Verified reply')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Fresh question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/api/support/ai/chat', expect.objectContaining({ message: 'Fresh question', sessionId: null, assistantRevision: 'draft' }), { headers: { 'X-Business-Profile-Id': '1' } }));
  });
});
