import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import MemberTicket from '@/app/support/tickets/[id]/page';
import OwnerTicket from '@/app/dashboard/(main)/support/[id]/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), ticketId: '1', actor: 7 }));
const router = { push: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => ({ id: mocks.ticketId }) }));
vi.mock('@/lib/support-api', () => ({ supportApi: { get: mocks.get, post: mocks.post } }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/SupportAuthContext', () => ({ useSupportAuth: () => ({ member: { id: mocks.actor, teamId: 2, name: 'Member', role: 'member' }, isAuthenticated: true, isLoading: false }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: mocks.actor, businessProfileId: 3 } }) }));
vi.mock('@/hooks/use-support-realtime-refresh', () => ({ useSupportRealtimeRefresh: () => ({ isRealtimeConnected: true }) }));
vi.mock('@/components/proposals/RelatedProposals', () => ({ RelatedProposals: () => null }));

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear(); mocks.ticketId = '1'; mocks.actor = 7;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes('/timeline')) return { events: [] };
    if (url.endsWith('/teams')) return [];
    return { id: Number(mocks.ticketId), ticketNumber: 'SUP-1', subject: 'Synthetic request', status: 'open', priority: 'medium', tags: [], messages: [], channel: 'web', customerName: 'Synthetic', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z', totalMessages: 0, ownershipMode: 'human_owned', assignedMemberId: mocks.actor, aiReplyEnabled: false };
  });
});
afterEach(cleanup);

describe.each([
  ['member', MemberTicket, 'Write a customer reply'],
  ['owner', OwnerTicket, 'Write a reply to the customer'],
] as const)('%s reply intent', (_realm, Page, label) => {
  it('keeps the page usable and blocks sends when retry storage is disabled', async () => {
    localStorage.setItem('user', JSON.stringify({ id: mocks.actor }));
    const get = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function(this: Storage, key: string) {
      if (this === sessionStorage) throw new Error('Synthetic storage disabled');
      return get.call(this, key);
    });
    try {
      render(<Page />);
      fireEvent.change(await screen.findByRole('textbox', { name: label }), { target: { value: 'Reviewed reply' } });
      await act(async () => { fireEvent.submit(screen.getByRole('textbox', { name: label }).closest('form')!); });
      expect(mocks.post).not.toHaveBeenCalled();
      await waitFor(() => expect(mocks.toast.mock.calls.at(-1)?.[0].description).toMatch(/storage is unavailable/));
    } finally { spy.mockRestore(); }
  });
  it('clears the old composer on ticket and actor change and does not reuse its intent', async () => {
    const keys: string[] = [];
    mocks.post.mockImplementation(async (_url: string, body: { idempotencyKey: string }) => {
      keys.push(body.idempotencyKey); throw new Error('Synthetic response unavailable');
    });
    const view = render(<Page />);
    let input = await screen.findByRole('textbox', { name: label });
    fireEvent.change(input, { target: { value: 'Reviewed response' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(keys).toHaveLength(1);
    mocks.ticketId = '2'; mocks.actor = 8; view.rerender(<Page />);
    input = await screen.findByRole('textbox', { name: label });
    await waitFor(() => { expect(input).toHaveValue(''); expect(input).not.toBeDisabled(); });
    expect(keys).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'Reviewed response' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
    await waitFor(() => expect(mocks.toast.mock.calls).toHaveLength(2));
  });
  it('replays one durable intent after committed response loss, including component reload', async () => {
    const keys: string[] = []; const durable = new Set<string>();
    mocks.post.mockImplementation(async (_url: string, body: { idempotencyKey: string }) => {
      keys.push(body.idempotencyKey); durable.add(body.idempotencyKey);
      if (keys.length === 1) throw new Error('Synthetic committed response lost');
      return {};
    });
    const view = render(<Page />);
    fireEvent.change(await screen.findByRole('textbox', { name: label }), { target: { value: 'Reviewed synthetic response' } });
    await act(async () => { fireEvent.submit(screen.getByRole('textbox', { name: label }).closest('form')!); });
    await waitFor(() => expect(keys).toHaveLength(1));
    view.unmount(); render(<Page />);
    fireEvent.change(await screen.findByRole('textbox', { name: label }), { target: { value: 'Reviewed synthetic response' } });
    await act(async () => { fireEvent.submit(screen.getByRole('textbox', { name: label }).closest('form')!); });
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    expect(durable.size).toBe(1);
  });
});
