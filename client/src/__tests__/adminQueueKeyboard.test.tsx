import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Queues from '@/app/admin/dashboard/queues/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), remove: vi.fn(), role: 'super_admin' }));
vi.mock('@/lib/admin-api', () => ({ default: { get: mocks.get, post: mocks.post, delete: mocks.remove } }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: mocks.role }, isLoading: false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'super_admin';
  mocks.get.mockImplementation(async (url: string) => url.endsWith('/queues')
    ? [{ queueName: 'synthetic-queue', waiting: 1, active: 0, completed: 0, failed: 1, delayed: 0, isPaused: false }]
    : { jobs: [{ id: 'synthetic-job', name: 'Synthetic diagnostic job', status: 'failed', data: { account: '[REDACTED]' }, opts: {}, attemptsMade: 1, failedReason: 'Synthetic failure', stacktrace: [], returnvalue: null, timestamp: 1, processedOn: null, finishedOn: null }], total: 1, start: 0, end: 49, hasMore: false });
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Queues /></QueryClientProvider>);
}

describe('admin queue keyboard controls', () => {
  it('opens a queue with Enter/Space, focuses its heading and restores the queue control', async () => {
    mount(); const user = userEvent.setup();
    const queue = await screen.findByRole('button', { name: 'View jobs in synthetic-queue' });
    queue.focus(); await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Queue: synthetic-queue' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back to queue overview' }));
    const restored = await screen.findByRole('button', { name: 'View jobs in synthetic-queue' });
    expect(restored).toHaveFocus(); await user.keyboard(' ');
    expect(await screen.findByRole('heading', { name: 'Queue: synthetic-queue' })).toHaveFocus();
    expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('discloses redacted diagnostics by keyboard without moving focus or invoking job operations', async () => {
    mount(); const user = userEvent.setup();
    await user.click(await screen.findByText('synthetic-queue'));
    const disclosure = await screen.findByRole('button', { name: 'Show details for job synthetic-job' });
    disclosure.focus(); await user.keyboard('{Enter}');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true'); expect(disclosure).toHaveFocus();
    const region = screen.getByRole('region', { name: 'Details for job synthetic-job' });
    expect(disclosure).toHaveAttribute('aria-controls', region.id);
    expect(region).toHaveTextContent('[REDACTED]');
    await user.keyboard(' '); expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure).toHaveFocus(); expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('retains read-error recovery without treating failure as an empty queue', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Synthetic queue read unavailable'));
    mount(); const user = userEvent.setup();
    expect(await screen.findByText('Synthetic queue read unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: 'View jobs in synthetic-queue' })).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('retains the super-admin gate and performs no queue reads for a regular admin', () => {
    mocks.role = 'admin'; mount();
    expect(screen.getByRole('heading', { name: 'Super admin access required' })).toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
});
