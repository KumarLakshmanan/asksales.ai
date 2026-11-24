import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Queues from '@/app/admin/dashboard/queues/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ default: { get: mocks.get, delete: mocks.remove } }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: 'super_admin' }, isLoading: false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => url.endsWith('/queues')
    ? [{ queueName: 'lead-enrichment', waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0, isPaused: true }]
    : { jobs: [{ id: 'synthetic-removal', name: 'Synthetic queued enrichment', status: 'waiting', data: {}, opts: {}, attemptsMade: 0, stacktrace: [], returnvalue: null, timestamp: 1, processedOn: null, finishedOn: null }], total: 1, start: 0, end: 49, hasMore: false });
});

async function removeJob() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Queues /></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'View jobs in lead-enrichment' }));
  await user.click(await screen.findByRole('button', { name: 'Cancel job synthetic-removal' }));
  await user.click(screen.getByRole('button', { name: 'Remove' }));
}

describe('admin queue removal receipts', () => {
  it('reports confirmed removal with pending cleanup, server guidance and its opaque reference', async () => {
    mocks.remove.mockResolvedValue({ success: true, removed: true, cleanupPending: true, intentId: 'opaque-removal-audit-01', message: 'Job removed. Reservation cleanup is pending reconciliation.' });
    await removeJob();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Job removed; cleanup pending', variant: 'warning', description: expect.stringContaining('Reservation cleanup is pending reconciliation.') })));
    expect(mocks.toast.mock.lastCall?.[0].description).toContain('Reference: opaque-removal-audit-01');
    expect(mocks.toast.mock.lastCall?.[0].description).not.toMatch(/refund(ed| successful)|credits? (returned|released)/i);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('/api/admin/queues/lead-enrichment/jobs/synthetic-removal');
  });

  it('keeps ordinary successful removal distinct and preserves its server message', async () => {
    mocks.remove.mockResolvedValue({ success: true, removed: true, cleanupPending: false, message: 'Job removed. Its reservation was not eligible for release.' });
    await removeJob();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: 'Job removed', description: 'Job removed. Its reservation was not eligible for release.' }));
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps deletion failure an error without a successful-removal or cleanup-pending claim', async () => {
    mocks.remove.mockRejectedValue(new Error('Unable to remove job.'));
    await removeJob();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: 'Error', description: 'Failed to remove job', variant: 'destructive' }));
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});
