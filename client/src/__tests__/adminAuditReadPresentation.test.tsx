import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminAuditLogsPage from '@/app/admin/dashboard/audit-logs/page';

const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ api: { get: state.get } }));
const entry = { domain: 'pricing', source_id: '1', action: 'update', target: 'synthetic_record',
  admin_id: 7, admin_name: 'Synthetic administrator', details: {}, created_at: '2026-10-23T10:00:00Z' };
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AdminAuditLogsPage />
  </QueryClientProvider>);
}
beforeEach(() => { state.get.mockReset(); state.get.mockResolvedValue({ entries: [entry], total: 1, page: 1, totalPages: 1 }); });
afterEach(cleanup);
describe('bounded audit read presentation', () => {
  it('names both filters accessibly without changing the read contract', async () => {
    mount(); await screen.findByText('synthetic_record');
    expect(screen.getByRole('combobox', { name: 'Audit domain' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search administrator audit' })).toBeInTheDocument();
    expect(state.get).toHaveBeenCalledWith('/api/admin/audit-logs', { params: { domain: 'all', search: '', page: 1, limit: 50 } });
  });
  it('lets an empty later page return to existing earlier results after the filtered count shrinks', async () => {
    const user = userEvent.setup();
    state.get.mockImplementation((_url, options) => Promise.resolve(options.params.page === 1
      ? { entries: [entry], total: 51, page: 1, totalPages: 2 }
      : { entries: [], total: 1, page: 2, totalPages: 1 }));
    mount(); await screen.findByText('synthetic_record');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.queryByText('synthetic_record')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(screen.getByText(/No audit events on this page/)).toBeInTheDocument();
    expect(screen.queryByText('No audit events match these filters.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Page 2 of 1/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Return to first page' }));
    expect(await screen.findByText('synthetic_record')).toBeInTheDocument();
  });
  it('retains the ordinary first-page no-match state', async () => {
    state.get.mockResolvedValue({ entries: [], total: 0, page: 1, totalPages: 0 });
    mount(); expect(await screen.findByText('No audit events match these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument();
  });
});
