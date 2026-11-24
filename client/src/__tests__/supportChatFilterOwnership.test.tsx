import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Chat from '@/app/dashboard/(main)/support-ai/chat/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post, patch: mocks.patch } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-outreach-assistants', () => ({
  useAssistantWorkspace: () => ({ profileId: 1, scopeKey: ['outreach-assistants', 1, 1],
    profiles: { isLoading: false, refetch: vi.fn() }, catalog: { data: { runtimeEnabled: false } } }),
  useAssistantList: () => ({ data: { runtimeEnabled: false, assistants: [] }, isError: false, isFetching: false, refetch: vi.fn() }),
}));
const active = { id: 88, title: 'Active QA chat', metadata: { archived: false }, createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' };
const archived = { ...active, id: 89, title: 'Archived QA chat', metadata: { archived: true } };
const list = (rows: unknown[]) => ({ data: rows, total: rows.length, hasMore: false });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/dashboard/support-ai/chat');
  Element.prototype.scrollIntoView = vi.fn();
});

describe('support chat list filter ownership', () => {
  it('removes active rows/actions while archived results load and preserves the open transcript', async () => {
    const pending = deferred<ReturnType<typeof list>>();
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/88')
      ? { ...active, messages: [{ id: 1, role: 'user', content: 'Saved historical question', createdAt: active.createdAt }] }
      : url.includes('archived=true') ? pending.promise : list([active]));
    render(<Chat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat Active QA chat' }));
    await screen.findByText('Saved historical question');
    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation filter' }), { target: { value: 'archived' } });
    expect(screen.queryByRole('button', { name: 'Open chat Active QA chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /(?:Restore|Archive) Active QA chat/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeInTheDocument();
    await act(async () => pending.resolve(list([])));
    expect(await screen.findByText('No archived conversations')).toBeInTheDocument();
    expect(screen.getByText('Saved historical question')).toBeVisible();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('never offers Archive on an archived row while active results load', async () => {
    window.history.replaceState({}, '', '/dashboard/support-ai/chat?chatBusiness=1&archived=true');
    const pending = deferred<ReturnType<typeof list>>();
    mocks.get.mockImplementation(async (url: string) => url.includes('archived=true') ? list([archived]) : pending.promise);
    render(<Chat />);
    await screen.findByRole('button', { name: 'Restore Archived QA chat' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation filter' }), { target: { value: 'active' } });
    expect(screen.queryByRole('button', { name: /(?:Restore|Archive) Archived QA chat/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeInTheDocument();
    await act(async () => pending.resolve(list([active])));
    expect(await screen.findByRole('button', { name: 'Archive Active QA chat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore Active QA chat' })).not.toBeInTheDocument();
  });

  it('ignores a late old-filter search response while the new filter is still pending', async () => {
    const oldSearch = deferred<ReturnType<typeof list>>();
    const newFilter = deferred<ReturnType<typeof list>>();
    mocks.get.mockImplementation(async (url: string) => url.includes('archived=true') ? newFilter.promise
      : url.includes('search=slow') ? oldSearch.promise : list([active]));
    render(<Chat />);
    await screen.findByRole('button', { name: 'Open chat Active QA chat' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search conversations' }), { target: { value: 'slow' } });
    await waitFor(() => expect(mocks.get.mock.calls.some(([url]) => url.includes('search=slow'))).toBe(true));
    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation filter' }), { target: { value: 'archived' } });
    await act(async () => oldSearch.resolve(list([active])));
    expect(screen.queryByRole('button', { name: 'Open chat Active QA chat' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeInTheDocument();
    await act(async () => newFilter.resolve(list([archived])));
    expect(await screen.findByRole('button', { name: 'Restore Archived QA chat' })).toBeInTheDocument();
  });

  it('does not restore stale rows on a rejected filter request and retries the new filter', async () => {
    const pending = deferred<ReturnType<typeof list>>();
    let failed = false;
    mocks.get.mockImplementation(async (url: string) => url.includes('archived=true')
      ? failed ? list([archived]) : pending.promise : list([active]));
    render(<Chat />);
    await screen.findByRole('button', { name: 'Open chat Active QA chat' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation filter' }), { target: { value: 'archived' } });
    await act(async () => pending.reject(new Error('Synthetic history read failed')));
    expect(await screen.findByText('Synthetic history read failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /(?:Restore|Archive) Active QA chat/ })).not.toBeInTheDocument();
    failed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Restore Archived QA chat' })).toBeInTheDocument();
    expect(mocks.get).toHaveBeenLastCalledWith(expect.stringContaining('archived=true'), expect.objectContaining({ headers: { 'X-Business-Profile-Id': '1' } }));
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
