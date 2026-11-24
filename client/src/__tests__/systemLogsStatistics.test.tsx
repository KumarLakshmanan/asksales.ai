import React from 'react';
import { fireEvent, render, screen, within, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { get, toast } = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ default: { get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: 'admin' } }) }));
import Page from '@/app/admin/dashboard/system-logs/page';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const rows = { success: true, data: [], total: 0, totalPages: 0 };
describe('log statistic availability', () => {
  it('shows unavailable rather than zero when the initial statistics request fails', async () => {
    get.mockImplementation((url: string) => url.endsWith('/stats') ? Promise.reject(new Error('Synthetic outage')) : Promise.resolve(rows));
    render(<Page />); await screen.findByText('Statistics unavailable');
    expect(screen.getAllByText('Unavailable')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Retry statistics' })).toBeVisible();
  });
  it('marks last-known counts stale and recovers through a statistics-only retry', async () => {
    let fail = false;
    get.mockImplementation((url: string) => url.endsWith('/stats') ? fail ? Promise.reject(new Error('Synthetic outage')) : Promise.resolve({ stats: { error: 2 } }) : Promise.resolve(rows));
    render(<Page />); await screen.findByText('2'); await screen.findByText('No logs found');
    fail = true; fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Statistics unavailable');
    const card = screen.getByText('Errors').closest('[class*="cursor-pointer"]') as HTMLElement;
    expect(within(card).getByText('2')).toBeVisible();
    fail = false; fireEvent.click(screen.getByRole('button', { name: 'Retry statistics' }));
    await screen.findByText(/Statistics last updated/);
    expect(screen.queryByText('Statistics unavailable')).not.toBeInTheDocument();
  });
  it('preserves valid zero counts after a successful empty statistics response', async () => {
    get.mockImplementation((url: string) => Promise.resolve(url.endsWith('/stats') ? { stats: {} } : rows));
    render(<Page />); await screen.findByText('No logs found');
    expect(screen.getAllByText('0')).toHaveLength(4);
    expect(screen.queryByText('Statistics unavailable')).not.toBeInTheDocument();
  });
});
