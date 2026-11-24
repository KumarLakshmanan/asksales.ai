import React from 'react';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { get, toast } = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ default: { get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: 'admin' } }) }));
import Page from '@/app/admin/dashboard/system-logs/page';
const result = (message: string) => ({ success: true, data: [{ id: 1, level: 'error', message, context: { requestId: 'fixture' }, createdAt: '2026-10-23T04:45:00Z' }], total: 1, page: 1, totalPages: 1, retentionDays: 30 });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
function applySource(value: string) { fireEvent.change(screen.getByPlaceholderText('Filter source…'), { target: { value } }); fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' })); }
beforeEach(() => { vi.clearAllMocks(); get.mockImplementation((url: string) => Promise.resolve(url.endsWith('/stats') ? { stats: { error: 1 } } : result('Initial'))); });
afterEach(cleanup);
describe('system log read recovery', () => {
  it('does not present an initial read failure as a successful empty result', async () => {
    let failed = true;
    get.mockImplementation((url: string) => url.endsWith('/stats') ? Promise.resolve({ stats: {} }) : failed ? Promise.reject(new Error('Synthetic outage')) : Promise.resolve(result('Recovered')));
    render(<Page />); await screen.findByText('Logs could not be loaded');
    expect(screen.queryByText('No logs found')).not.toBeInTheDocument();
    expect(screen.getByText('Log count unavailable')).toBeVisible();
    failed = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Recovered'); expect(screen.queryByText('Log count unavailable')).not.toBeInTheDocument();
  });
  it('keeps the latest filter when an older successful response arrives last', async () => {
    const late = deferred<ReturnType<typeof result>>();
    get.mockImplementation((url: string) => url.endsWith('/stats') ? Promise.resolve({ stats: {} }) : url.includes('source=alpha') ? late.promise : Promise.resolve(result(url.includes('source=beta') ? 'Current beta' : 'Initial')));
    render(<Page />); await screen.findByText('Initial'); applySource('alpha');
    await waitFor(() => expect(get.mock.calls.some(([url]) => String(url).includes('source=alpha'))).toBe(true));
    applySource('beta'); await screen.findByText('Current beta');
    await act(async () => late.resolve(result('Stale alpha')));
    expect(screen.queryByText('Stale alpha')).not.toBeInTheDocument(); expect(screen.getByText('Current beta')).toBeVisible();
  });
  it('suppresses an obsolete error after a newer filter succeeds', async () => {
    const late = deferred<ReturnType<typeof result>>();
    get.mockImplementation((url: string) => url.endsWith('/stats') ? Promise.resolve({ stats: {} }) : url.includes('source=alpha') ? late.promise : Promise.resolve(result('Current')));
    render(<Page />); await screen.findByText('Current'); applySource('alpha');
    await waitFor(() => expect(get.mock.calls.some(([url]) => String(url).includes('source=alpha'))).toBe(true)); applySource('beta');
    await waitFor(() => expect(get.mock.calls.some(([url]) => String(url).includes('source=beta'))).toBe(true));
    await act(async () => late.reject(new Error('Obsolete failure')));
    expect(screen.queryByText('Logs could not be loaded')).not.toBeInTheDocument(); expect(toast).not.toHaveBeenCalled();
  });
  it('cancels pending reads on unmount', async () => {
    get.mockImplementation((url: string) => url.endsWith('/stats') ? Promise.resolve({ stats: {} }) : new Promise(() => {}));
    const { unmount } = render(<Page />);
    const options = get.mock.calls.find(([url]) => String(url).includes('/system-logs?'))?.[1] as { signal?: AbortSignal } | undefined;
    unmount(); expect(options?.signal?.aborted).toBe(true);
  });
});
