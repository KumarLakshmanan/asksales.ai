import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SupportPipelinePage from '@/app/dashboard/(main)/support/pipeline/page';
const mocks = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn(), refresh: (() => Promise.resolve()) as () => Promise<void>, profile: 1, listeners: new Set<() => void>() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/business-profile', () => ({ selectedBusinessProfileId: () => mocks.profile, subscribeBusinessProfile: (callback: () => void) => { mocks.listeners.add(callback); return () => mocks.listeners.delete(callback); } }));
vi.mock('@/hooks/use-support-realtime-refresh', () => ({ useSupportRealtimeRefresh: (refresh: () => Promise<void>) => { mocks.refresh = refresh; return { isRealtimeConnected: true }; } }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const ticket = (id: number, subject = `Ticket ${id}`) => ({ id, ticketNumber: `TKT-${id}`, subject, status: 'open', priority: 'medium', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' });
beforeEach(() => { vi.clearAllMocks(); mocks.profile = 1; mocks.listeners.clear(); });
afterEach(cleanup);
describe('support pipeline loading and recovery', () => {
  it('renders the first tickets while later pages and team metadata are pending', async () => {
    const second = deferred<unknown>(); const teams = deferred<unknown>();
    mocks.get.mockImplementation((path: string) => path === '/api/support/teams' ? teams.promise : path.includes('page=2') ? second.promise : Promise.resolve({ tickets: [ticket(1)], total: 2, totalPages: 2 }));
    render(<SupportPipelinePage />);
    await screen.findByText('Ticket 1');
    expect(screen.getByRole('status')).toHaveTextContent('Loaded 1 of 2');
    expect(screen.queryByText('Loading support tickets…')).not.toBeInTheDocument();
    await act(async () => { second.resolve({ tickets: [ticket(2)] }); teams.resolve([]); });
    await screen.findByText('Ticket 2');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(mocks.get.mock.calls.filter(([path]) => path.startsWith('/api/support?')).every(([path]) => path.includes('view=pipeline'))).toBe(true);
  });
  it('keeps usable tickets visible when a later page fails and can retry the complete queue', async () => {
    mocks.get.mockImplementation((path: string) => path === '/api/support/teams' ? Promise.resolve([]) : path.includes('page=2') ? Promise.reject(new Error('The request took too long. Please try again.')) : Promise.resolve({ tickets: [ticket(1)], total: 2, totalPages: 2 }));
    render(<SupportPipelinePage />);
    await screen.findByRole('alert');
    expect(screen.getByText('Ticket 1')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Showing 1 of 2 tickets');
    mocks.get.mockImplementation((path: string) => Promise.resolve(path === '/api/support/teams' ? [] : path.includes('page=2') ? { tickets: [ticket(2)] } : { tickets: [ticket(1)], total: 2, totalPages: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Ticket 2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('does not restart a slow load on polling or realtime updates', async () => {
    const second = deferred<unknown>();
    mocks.get.mockImplementation((path: string) => path === '/api/support/teams' ? Promise.resolve([]) : path.includes('page=2') ? second.promise : Promise.resolve({ tickets: [ticket(1)], total: 2, totalPages: 2 }));
    render(<SupportPipelinePage />); await screen.findByText('Ticket 1');
    await act(async () => { await mocks.refresh(); });
    expect(mocks.get.mock.calls.filter(([path]) => path.includes('page=1'))).toHaveLength(1);
    await act(async () => { second.resolve({ tickets: [ticket(2)] }); });
    await screen.findByText('Ticket 2');
  });
  it('aborts the old workspace request and ignores its late results', async () => {
    const old = deferred<unknown>();
    mocks.get.mockImplementation((path: string) => path === '/api/support/teams' ? Promise.resolve([]) : mocks.profile === 1 ? old.promise : Promise.resolve({ tickets: [ticket(2, 'New workspace ticket')], total: 1, totalPages: 1 }));
    render(<SupportPipelinePage />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    const oldSignal = mocks.get.mock.calls.find(([path]) => path.includes('page=1'))![1].signal;
    await act(async () => { mocks.profile = 2; mocks.listeners.forEach(listener => listener()); });
    await screen.findByText('New workspace ticket');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { old.resolve({ tickets: [ticket(1, 'Old workspace ticket')], total: 1, totalPages: 1 }); });
    expect(screen.queryByText('Old workspace ticket')).not.toBeInTheDocument();
  });
});
