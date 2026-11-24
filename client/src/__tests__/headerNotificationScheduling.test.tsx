import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  get: vi.fn(), user: { id: 4101, name: 'Synthetic actor' },
  handlers: new Map<string, Set<() => void>>(),
}));
vi.mock('@/lib/api', () => ({ api: { get: fixture.get } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, user: fixture.user, logout: vi.fn() }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: (name: string, handler: () => void) => {
  if (!fixture.handlers.has(name)) fixture.handlers.set(name, new Set());
  fixture.handlers.get(name)!.add(handler);
  return () => fixture.handlers.get(name)!.delete(handler);
} }) }));
vi.mock('@/hooks/use-billing-organizations', () => ({ useBillingOrganizations: () => ({ ready: true, billingScopeKey: 'synthetic' }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/dashboard/knowledge-base' }));
vi.mock('@/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('next/image', () => ({ default: () => null }));
import Header from '@/components/Header';
import { selectBusinessProfile } from '@/lib/business-profile';

type Response = { count: number };
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function emit(name: string) { act(() => fixture.handlers.get(name)?.forEach(handler => handler())); }
function reconnect() { emit('websocket_disconnected'); emit('websocket_connected'); }
function signal(index = 0): AbortSignal { return fixture.get.mock.calls[index][1].signal; }

beforeEach(() => {
  fixture.get.mockReset(); fixture.handlers.clear(); fixture.user = { id: 4101, name: 'Synthetic actor' };
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify(fixture.user));
  sessionStorage.setItem('active-business-profile:4101', '4102');
});
afterEach(cleanup);

describe('Header count scheduling', () => {
  it('coalesces the first connected event with the authoritative in-flight mount count', async () => {
    const first = deferred(); fixture.get.mockReturnValue(first.promise); render(<Header />);
    emit('websocket_connected');
    expect(fixture.get).toHaveBeenCalledTimes(1); expect(signal().aborted).toBe(false);
    await act(async () => first.resolve({ count: 3 }));
    await screen.findByRole('button', { name: 'Notifications (3 unread)' });
    expect(fixture.get).toHaveBeenCalledTimes(1);
  });
  it('refreshes on a real reconnect after the count settled', async () => {
    fixture.get.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 7 }); render(<Header />);
    await screen.findByRole('button', { name: 'Notifications (3 unread)' }); reconnect();
    await screen.findByRole('button', { name: 'Notifications (7 unread)' });
    expect(fixture.get).toHaveBeenCalledTimes(2); expect(signal().aborted).toBe(false);
  });
  it('queues a fresh read after an in-flight read when the stream reconnects', async () => {
    const first = deferred(); fixture.get.mockReturnValueOnce(first.promise).mockResolvedValue({ count: 7 }); render(<Header />);
    emit('websocket_connected'); reconnect();
    expect(fixture.get).toHaveBeenCalledTimes(1); expect(signal().aborted).toBe(false);
    await act(async () => first.resolve({ count: 3 }));
    await screen.findByRole('button', { name: 'Notifications (7 unread)' });
    expect(fixture.get).toHaveBeenCalledTimes(2);
  });
  it('preserves a queued reconnect refresh even when the earlier read fails', async () => {
    const first = deferred(); fixture.get.mockReturnValueOnce(first.promise).mockResolvedValue({ count: 7 }); render(<Header />);
    reconnect(); await act(async () => first.reject(new Error('Synthetic outage')));
    await screen.findByRole('button', { name: 'Notifications (7 unread)' }); expect(fixture.get).toHaveBeenCalledTimes(2);
  });
  it('allows a failed coalesced first count to recover on focus', async () => {
    const first = deferred(); fixture.get.mockReturnValueOnce(first.promise).mockResolvedValue({ count: 5 }); render(<Header />);
    emit('websocket_connected'); await act(async () => first.reject(new Error('Synthetic outage')));
    expect(fixture.get).toHaveBeenCalledTimes(1); fireEvent.focus(window);
    await screen.findByRole('button', { name: 'Notifications (5 unread)' }); expect(fixture.get).toHaveBeenCalledTimes(2);
  });
  it('retains a refresh arriving during a request without aborting the same-scope read', async () => {
    const first = deferred(); fixture.get.mockReturnValueOnce(first.promise).mockResolvedValue({ count: 4 }); render(<Header />);
    emit('events:notification'); fireEvent.focus(window);
    expect(fixture.get).toHaveBeenCalledTimes(1); expect(signal().aborted).toBe(false);
    await act(async () => first.resolve({ count: 3 })); await screen.findByRole('button', { name: 'Notifications (4 unread)' });
    expect(fixture.get).toHaveBeenCalledTimes(2);
  });
  it('aborts a changed business and never lets its late result or queued refresh cross scopes', async () => {
    const first = deferred(); fixture.get.mockReturnValueOnce(first.promise).mockResolvedValue({ count: 8 }); render(<Header />);
    reconnect(); act(() => selectBusinessProfile(4112));
    await screen.findByRole('button', { name: 'Notifications (8 unread)' }); expect(signal().aborted).toBe(true);
    await act(async () => first.resolve({ count: 99 })); expect(fixture.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Notifications (99 unread)' })).toBeNull();
  });
  it('aborts a changed actor and ignores an old actor result', async () => {
    const first = deferred(); fixture.get.mockReturnValueOnce(first.promise).mockResolvedValue({ count: 6 }); const view = render(<Header />);
    fixture.user = { id: 4201, name: 'Other synthetic' }; localStorage.setItem('user', JSON.stringify(fixture.user));
    sessionStorage.setItem('active-business-profile:4201', '4202'); view.rerender(<Header />);
    await screen.findByRole('button', { name: 'Notifications (6 unread)' }); expect(signal().aborted).toBe(true);
    await act(async () => first.resolve({ count: 99 })); expect(fixture.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Notifications (99 unread)' })).toBeNull();
  });
  it('retains the last authoritative count after a refresh failure, then retries', async () => {
    fixture.get.mockResolvedValueOnce({ count: 3 }).mockRejectedValueOnce(new Error('Synthetic outage')).mockResolvedValueOnce({ count: 2 });
    render(<Header />); await screen.findByRole('button', { name: 'Notifications (3 unread)' }); reconnect();
    await waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Notifications (3 unread)' })).toBeVisible();
    fireEvent.focus(window); await screen.findByRole('button', { name: 'Notifications (2 unread)' });
  });
});
