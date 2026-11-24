import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProposalsPage from '@/app/dashboard/(main)/proposals/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks, ApiError: class extends Error {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));

const emptyList = { proposals: [], total: 0, totalPages: 1 };
const analytics = (total: number) => ({ total, draft: 0, sent: 0, viewed: 0, accepted: 0, rejected: 0, expired: 0, delivery_unknown: 0, acceptanceRate: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/proposals/analytics') ? analytics(0) : emptyList));
});
afterEach(cleanup);

describe('proposals empty state', () => {
  it('says there are no proposals yet when the workspace has none and no filter is active', async () => {
    render(<ProposalsPage />);
    expect(await screen.findByRole('heading', { name: 'No proposals yet' })).toBeInTheDocument();
    expect(screen.queryByText('No proposals match this view')).not.toBeInTheDocument();
  });

  it('keeps the "no match" message when a search or filter hides results', async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/proposals/analytics') ? analytics(3) : emptyList));
    render(<ProposalsPage />);
    expect(await screen.findByRole('heading', { name: 'No proposals match this view' })).toBeInTheDocument();
  });

  it('treats an active search as a filter, even when the workspace is empty', async () => {
    render(<ProposalsPage />);
    await screen.findByRole('heading', { name: 'No proposals yet' });
    fireEvent.change(screen.getByLabelText('Search proposals'), { target: { value: 'acme' } });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'No proposals match this view' })).toBeInTheDocument());
  });
});
