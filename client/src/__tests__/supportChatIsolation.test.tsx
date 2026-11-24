import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OwnerChat from '@/app/dashboard/(main)/support-ai/chat/page';
import MemberChat from '@/app/support/chat/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), toast: vi.fn(), push: vi.fn(), member: { id: 1, name: 'Member' } }));
const router = { push: mocks.push };
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post, patch: mocks.patch } }));
vi.mock('@/lib/support-api', () => ({ supportApi: { get: mocks.get, post: mocks.post, patch: mocks.patch } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-outreach-assistants', () => ({
  useAssistantWorkspace: () => ({ profileId: 1, scopeKey: ['outreach-assistants', 1, 1], requestOptions: { headers: { 'X-Business-Profile-Id': '1' } }, profiles: { isLoading: false, refetch: vi.fn() }, catalog: { data: { runtimeEnabled: true } } }),
  useAssistantList: () => ({ data: { runtimeEnabled: true, assistants: [{ id: 'test-assistant', draft: { name: 'Test assistant' }, draftVersion: 1 }] }, isError: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/contexts/SupportAuthContext', () => ({ useSupportAuth: () => ({ member: mocks.member, isLoading: false, logout: vi.fn() }) }));

const sessions = [1, 2].map(id => ({ id, title: `Saved conversation ${id}`, createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z', metadata: { channel: id === 1 ? 'instagram' : 'email', mode: 'advisory', assistantId: 'test-assistant' } }));
const message = (id: number, sessionId: number, content: string) => ({ id, sessionId, role: 'assistant', content, sources: [], confidence: 0.9, createdAt: '2026-09-18T00:00:00Z' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res; }); return { promise, resolve }; }

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  mocks.get.mockImplementation(async (url: string) => {
    const match = url.match(/sessions\/(\d+)$/);
    if (match) { const id = Number(match[1]); return { ...sessions[id - 1], messages: [message(id * 10, id, `History ${id}`)] }; }
    return { data: sessions, total: 2, hasMore: false };
  });
  mocks.patch.mockResolvedValue({});
});

describe('support conversation isolation', () => {
  it('hides machine memory only in the owner sidebar and preserves user-authored JSON in history', async () => {
    const memory = JSON.stringify({ schemaVersion: 1, kind: 'historical_user_statements', expiresAt: '2026-10-27T05:44:57.387Z', references: [{ sourceMessageId: 7, statement: 'Internal memory excerpt' }] });
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/sessions/1')) return { ...sessions[0], summary: memory, messages: [
        { ...message(10, 1, memory), role: 'user' },
        message(11, 1, 'Historical assistant reply'),
      ] };
      return { data: [{ ...sessions[0], summary: memory }, { ...sessions[1], summary: 'Readable saved summary' }], total: 2, hasMore: false };
    });
    render(<OwnerChat />);
    const first = await screen.findByRole('button', { name: 'Open chat Saved conversation 1' });
    const second = screen.getByRole('button', { name: 'Open chat Saved conversation 2' });
    expect(within(first).queryByText(/historical_user_statements|Internal memory excerpt/)).not.toBeInTheDocument();
    expect(within(second).getByText('Readable saved summary')).toBeVisible();
    expect(screen.getAllByRole('button', { name: /^Open chat / })).toEqual([first, second]);
    fireEvent.click(first);
    expect(await screen.findByText(memory)).toBeVisible();
    expect(screen.getByText('Historical assistant reply')).toBeVisible();
    expect(within(first).queryByText(memory)).not.toBeInTheDocument();
  });

  it('keeps an ordinary JSON summary visible in the owner sidebar', async () => {
    const summary = '{"refundDays":30,"message":"Please explain this JSON"}';
    mocks.get.mockResolvedValue({ data: [{ ...sessions[0], summary }], total: 1, hasMore: false });
    render(<OwnerChat />);
    const session = await screen.findByRole('button', { name: 'Open chat Saved conversation 1' });
    expect(within(session).getByText(summary)).toBeVisible();
  });

  it.each(['owner', 'member'])('ignores a stale session fetch in the %s chat', async surface => {
    const oldFetch = deferred<unknown>();
    const defaultGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((url: string) => url.endsWith('/sessions/1') ? oldFetch.promise : defaultGet(url));
    render(surface === 'owner' ? <OwnerChat /> : <MemberChat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat Saved conversation 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat Saved conversation 2' }));
    expect(await screen.findByText('History 2')).toBeVisible();
    await act(async () => oldFetch.resolve({ ...sessions[0], messages: [message(10, 1, 'Stale history')] }));
    expect(screen.queryByText('Stale history')).not.toBeInTheDocument();
    expect(screen.getByText('History 2')).toBeVisible();
  });

  it.each(['owner', 'member'])('does not append a late reply into another %s conversation', async surface => {
    const pending = deferred<unknown>(); mocks.post.mockReturnValue(pending.promise);
    render(surface === 'owner' ? <OwnerChat /> : <MemberChat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat Saved conversation 1' }));
    await screen.findByText('History 1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat Saved conversation 2' }));
    await screen.findByText('History 2');
    await act(async () => pending.resolve({ sessionId: 1, userMessage: { ...message(11, 1, 'First question'), role: 'user' }, assistantMessage: message(12, 1, 'Late private reply'), response: { sources: [] } }));
    expect(screen.queryByText('Late private reply')).not.toBeInTheDocument();
    expect(screen.getByText('History 2')).toBeVisible();
  });

  it('restores a saved output channel', async () => {
    render(<OwnerChat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat Saved conversation 1' }));
    await screen.findByText('History 1');
    expect(screen.getByRole('combobox', { name: 'Response channel' })).toHaveValue('instagram');
  });

  it.each(['owner', 'member'])('refreshes the current search after a late %s reply', async surface => {
    const pending = deferred<unknown>(); mocks.post.mockReturnValue(pending.promise);
    render(surface === 'owner' ? <OwnerChat /> : <MemberChat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat Saved conversation 1' }));
    await screen.findByText('History 1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat Saved conversation 2' }));
    await screen.findByText('History 2');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search conversations' }), { target: { value: 'current filter' } });
    await waitFor(() => expect(mocks.get.mock.calls.filter(([url]) => String(url).includes('/sessions?')).at(-1)?.[0]).toEqual(expect.stringContaining('search=current%20filter')));
    await act(async () => pending.resolve({ sessionId: 1, userMessage: { ...message(11, 1, 'First question'), role: 'user' }, assistantMessage: message(12, 1, 'Late private reply'), response: { sources: [] } }));
    expect(mocks.get.mock.calls.filter(([url]) => String(url).includes('/sessions?')).at(-1)?.[0]).toEqual(expect.stringContaining('search=current%20filter'));
  });

  it('keeps an established member title after a follow-up', async () => {
    mocks.post.mockResolvedValue({ userMessage: { ...message(11, 1, 'Follow-up question'), role: 'user' }, assistantMessage: message(12, 1, 'Follow-up answer'), response: { sources: [] } });
    render(<MemberChat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat Saved conversation 1' }));
    await screen.findByText('History 1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Follow-up question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Follow-up answer');
    expect(screen.getByRole('button', { name: 'Open chat Saved conversation 1' })).toBeInTheDocument();
  });

  it('archives with confirmation and restores through undo', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<OwnerChat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Saved conversation 1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/support/ai/sessions/1', { archived: false }));
    expect(mocks.patch).toHaveBeenCalledWith('/api/support/ai/sessions/1', { archived: true });
  });
});
