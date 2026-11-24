import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AssistantOperations from '@/components/outreach/assistants/AssistantOperations';
import type { useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import type { AssistantOperationalReport } from '../../../shared/assistantOperations';
import api from '@/lib/api';

const mocks = vi.hoisted(() => ({ workspace: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/use-outreach-assistants', () => ({ ASSISTANT_API: '/api/settings/outreach/assistants', useAssistantWorkspace: mocks.workspace, useAssistantList: mocks.list }));

const workspace = {
  profileId: 4102, scopeKey: ['outreach-assistants', 4101, 4102], requestOptions: { headers: { 'X-Business-Profile-Id': '4102' } },
  profiles: { isLoading: false, isError: false },
  catalog: { isLoading: false, isError: false, data: { runtimeEnabled: true, accounts: [], permissions: { canManage: true } } },
} as unknown as ReturnType<typeof useAssistantWorkspace>;
const gap = (key: string, assistantId = 'assistant-one') => ({ key, assistantId, assistantName: assistantId, intent: 'hours', reason: 'Synthetic review question', count: 1, latestAt: '2026-10-11T00:00:00Z', conversationIds: [], review: 'open' as const, note: null });
const initial: AssistantOperationalReport = { days: 30, assignments: [], metrics: [], usage: [], knowledgeGaps: [gap('gap-one'), gap('gap-two', 'assistant-two')] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><AssistantOperations /></QueryClientProvider>);
  return { client, ...view, rerenderOperations: () => view.rerender(<QueryClientProvider client={client}><AssistantOperations /></QueryClientProvider>) };
}
const note = (index = 0) => screen.getAllByLabelText('Review note')[index];
const change = (value: string, index = 0) => fireEvent.change(note(index), { target: { value } });
const save = () => fireEvent.click(screen.getAllByRole('button', { name: 'Mark reviewed' })[0]);
const saved = (text: string): AssistantOperationalReport => ({ ...initial, knowledgeGaps: [{ ...initial.knowledgeGaps[0], review: 'reviewed', note: text }, initial.knowledgeGaps[1]] });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockReturnValue(workspace);
  mocks.list.mockReturnValue({ data: { assistants: [{ id: 'assistant-one', draft: { name: 'Assistant one' } }, { id: 'assistant-two', draft: { name: 'Assistant two' } }] } });
  vi.mocked(api.get).mockResolvedValue(initial);
});
afterEach(cleanup);

describe('review note request lifecycle with synthetic APIs', () => {
  it.each(['POST', 'diagnostics refresh'])('retains newer typing during the %s', async stage => {
    const post = deferred<unknown>(); const refresh = deferred<AssistantOperationalReport>();
    vi.mocked(api.post).mockReturnValue(post.promise);
    vi.mocked(api.get).mockResolvedValueOnce(initial).mockReturnValue(refresh.promise);
    mount();
    await screen.findAllByLabelText('Review note');
    fireEvent.change(screen.getByLabelText('Knowledge review status'), { target: { value: 'all' } });
    change('Synthetic A'); save();
    expect(api.post).toHaveBeenCalledWith('/api/settings/outreach/assistants/assistant-one/knowledge-gaps/review', { key: 'gap-one', review: 'reviewed', note: 'Synthetic A' }, workspace.requestOptions);
    if (stage === 'POST') change('Synthetic B');
    await act(async () => post.resolve({ review: 'reviewed' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    if (stage === 'diagnostics refresh') change('Synthetic B');
    await act(async () => refresh.resolve(saved('Synthetic A')));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving review…' })).not.toBeInTheDocument());
    expect(note()).toHaveValue('Synthetic B');
    expect(note()).toHaveAccessibleDescription('Unsaved note edits.');
    vi.mocked(api.post).mockResolvedValue({ review: 'reviewed' });
    vi.mocked(api.get).mockResolvedValue(saved('Synthetic B'));
    fireEvent.click(screen.getByRole('button', { name: 'Save review note' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenLastCalledWith('/api/settings/outreach/assistants/assistant-one/knowledge-gaps/review', { key: 'gap-one', review: 'reviewed', note: 'Synthetic B' }, workspace.requestOptions);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save review note' })).not.toBeInTheDocument());
    expect(note()).toHaveValue('Synthetic B');
  });

  it('clears only the submitted draft and preserves unrelated row edits', async () => {
    const post = deferred<unknown>();
    vi.mocked(api.post).mockReturnValue(post.promise);
    mount(); await screen.findAllByLabelText('Review note');
    fireEvent.change(screen.getByLabelText('Knowledge review status'), { target: { value: 'all' } });
    change('  Synthetic A  '); save(); change('Unrelated draft', 1);
    vi.mocked(api.get).mockResolvedValue(saved('Synthetic A'));
    await act(async () => post.resolve({ review: 'reviewed' }));
    await waitFor(() => expect(note()).toHaveValue('Synthetic A'));
    expect(note(1)).toHaveValue('Unrelated draft');
    expect(note()).toHaveAccessibleDescription('');
    expect(note(1)).toHaveAccessibleDescription('Unsaved note edits.');
  });

  it('keeps the edit revision even after typing back to the submitted text', async () => {
    const post = deferred<unknown>(); vi.mocked(api.post).mockReturnValue(post.promise);
    mount(); await screen.findAllByLabelText('Review note');
    fireEvent.change(screen.getByLabelText('Knowledge review status'), { target: { value: 'all' } });
    change('Synthetic A'); save(); change('Synthetic B'); change('Synthetic A');
    vi.mocked(api.get).mockResolvedValue(saved('Synthetic A'));
    await act(async () => post.resolve({ review: 'reviewed' }));
    await screen.findByRole('button', { name: 'Save review note' });
    expect(note()).toHaveValue('Synthetic A');
    expect(note()).toHaveAccessibleDescription('Unsaved note edits.');
  });

  it('keeps the latest draft after rejection and retries that draft with the same scope', async () => {
    const post = deferred<unknown>(); vi.mocked(api.post).mockReturnValue(post.promise);
    mount(); await screen.findAllByLabelText('Review note');
    change('Synthetic A'); save(); change('Synthetic B'); change('Other draft', 1);
    await act(async () => post.reject(new Error('Synthetic save rejected')));
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic save rejected');
    expect(note()).toHaveValue('Synthetic B'); expect(note(1)).toHaveValue('Other draft');
    expect(api.get).toHaveBeenCalledTimes(1);
    vi.mocked(api.post).mockResolvedValue({ review: 'reviewed' });
    vi.mocked(api.get).mockResolvedValue(saved('Synthetic B'));
    save();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving review…' })).not.toBeInTheDocument());
    expect(api.post).toHaveBeenLastCalledWith('/api/settings/outreach/assistants/assistant-one/knowledge-gaps/review', { key: 'gap-one', review: 'reviewed', note: 'Synthetic B' }, workspace.requestOptions);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps drafts after a failed report refresh and prevents a stale status toggle until retry', async () => {
    const post = deferred<unknown>(); vi.mocked(api.post).mockReturnValue(post.promise);
    const { client } = mount(); await screen.findAllByLabelText('Review note');
    // Keep the production retry setting, but eliminate its backoff in this synthetic test.
    client.setQueryDefaults([...workspace.scopeKey, 'diagnostics'], { retryDelay: 0 });
    change('Synthetic A'); save(); change('Synthetic B');
    vi.mocked(api.get).mockRejectedValue(new Error('Synthetic report unavailable'));
    await act(async () => post.resolve({ review: 'reviewed' }));
    await screen.findByText('Review saved, but the report could not refresh. Your note is kept. Retry the report before reviewing again.');
    expect(note()).toHaveValue('Synthetic B');
    expect(screen.getAllByRole('button', { name: 'Mark reviewed' })[0]).toBeDisabled();
    expect(api.post).toHaveBeenCalledTimes(1);
    vi.mocked(api.get).mockResolvedValue(saved('Synthetic A'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry report' }));
    fireEvent.change(screen.getByLabelText('Knowledge review status'), { target: { value: 'all' } });
    expect(await screen.findByRole('button', { name: 'Save review note' })).toBeEnabled();
    expect(note()).toHaveValue('Synthetic B');
    expect(screen.queryByText('Review saved, but the report could not refresh. Your note is kept. Retry the report before reviewing again.')).not.toBeInTheDocument();
  });

  it('guards repeated submissions synchronously, including another row and a pending refresh', async () => {
    const post = deferred<unknown>(); const refresh = deferred<AssistantOperationalReport>();
    vi.mocked(api.post).mockReturnValue(post.promise);
    vi.mocked(api.get).mockResolvedValueOnce(initial).mockReturnValue(refresh.promise);
    mount(); await screen.findAllByLabelText('Review note');
    const buttons = screen.getAllByRole('button', { name: 'Mark reviewed' });
    change('Synthetic A');
    act(() => { buttons[0].click(); buttons[0].click(); buttons[1].click(); });
    expect(api.post).toHaveBeenCalledTimes(1);
    await act(async () => post.resolve({ review: 'reviewed' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(buttons[1]).toBeDisabled(); fireEvent.click(buttons[1]);
    expect(api.post).toHaveBeenCalledTimes(1);
    await act(async () => refresh.resolve(saved('Synthetic A')));
    await waitFor(() => expect(buttons[1]).toBeEnabled());
  });

  it('preserves hidden drafts across status, assistant and report filter changes', async () => {
    const post = deferred<unknown>(); vi.mocked(api.post).mockReturnValue(post.promise);
    mount(); await screen.findAllByLabelText('Review note');
    change('Synthetic A'); save(); change('Synthetic B'); change('Other draft', 1);
    fireEvent.change(screen.getByLabelText('Knowledge review status'), { target: { value: 'reviewed' } });
    expect(screen.queryAllByLabelText('Review note')).toHaveLength(0);
    vi.mocked(api.get).mockResolvedValue({ ...initial, knowledgeGaps: [initial.knowledgeGaps[1]] });
    fireEvent.change(screen.getByLabelText('Assistant', { exact: true }), { target: { value: 'assistant-two' } });
    await screen.findByText('No recorded knowledge gaps match this review status.');
    vi.mocked(api.get).mockResolvedValue(saved('Synthetic A'));
    await act(async () => post.resolve({ review: 'reviewed' }));
    fireEvent.change(screen.getByLabelText('Assistant', { exact: true }), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Reporting period'), { target: { value: '7' } });
    fireEvent.change(await screen.findByLabelText('Knowledge review status'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getAllByLabelText('Review note')).toHaveLength(2));
    expect(note()).toHaveValue('Synthetic B'); expect(note(1)).toHaveValue('Other draft');
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it.each(['actor', 'workspace'])('isolates a pending old save from a new %s', async scope => {
    const post = deferred<unknown>(); vi.mocked(api.post).mockReturnValue(post.promise);
    const view = mount(); await screen.findAllByLabelText('Review note');
    change('Old scope draft'); save();
    const next = { ...workspace, scopeKey: ['outreach-assistants', scope === 'actor' ? 5101 : 4101, 5102], profileId: 5102, requestOptions: { headers: { 'X-Business-Profile-Id': '5102' } } } as typeof workspace;
    mocks.workspace.mockReturnValue(next); view.rerenderOperations();
    await screen.findAllByLabelText('Review note'); change('New scope draft');
    await act(async () => post.reject(new Error('Old scope rejection')));
    expect(note()).toHaveValue('New scope draft'); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    vi.mocked(api.post).mockResolvedValue({ review: 'reviewed' }); save();
    expect(api.post).toHaveBeenLastCalledWith(expect.any(String), { key: 'gap-one', review: 'reviewed', note: 'New scope draft' }, next.requestOptions);
  });

  it('ignores an old completion after unmount and remount, and invalidates only its original scope', async () => {
    const post = deferred<unknown>(); vi.mocked(api.post).mockReturnValue(post.promise);
    const old = mount(); const invalidate = vi.spyOn(old.client, 'invalidateQueries');
    await screen.findAllByLabelText('Review note'); change('Old draft'); save(); old.unmount();
    const next = mount(); const nextInvalidate = vi.spyOn(next.client, 'invalidateQueries');
    await screen.findAllByLabelText('Review note'); change('Remounted draft');
    await act(async () => post.resolve({ review: 'reviewed' }));
    expect(note()).toHaveValue('Remounted draft');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [...workspace.scopeKey, 'diagnostics'] }, { throwOnError: true });
    expect(nextInvalidate).not.toHaveBeenCalled();
  });

  it('preserves null-note serialization and management permissions', async () => {
    vi.mocked(api.post).mockResolvedValue({ review: 'reviewed' });
    const view = mount(); await screen.findAllByLabelText('Review note'); change('  '); save();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving review…' })).not.toBeInTheDocument());
    expect(api.post).toHaveBeenLastCalledWith(expect.any(String), { key: 'gap-one', review: 'reviewed', note: null }, workspace.requestOptions);
    mocks.workspace.mockReturnValue({ ...workspace, catalog: { ...workspace.catalog, data: { ...workspace.catalog.data, permissions: { canManage: false } } } });
    view.rerenderOperations();
    expect(screen.queryByLabelText('Review note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
