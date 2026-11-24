/** Acceptance mocked administrator UI reproduction; no real mutations. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPlanAssignment from '@/components/admin/AdminPlanAssignment';
import { SUBSCRIPTION_PLANS } from '../../../shared/subscriptions';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ default: mocks }));
const overview = (id: number) => ({
  organization: { id, name: `Synthetic organization ${id}`, ownerUserId: id, ownerEmail: `owner-${id}@example.test` },
  current: null, pending: null,
  access: { reason: 'rollout_pending', allowed: true, canTopUp: false, accessUntil: null },
  nextDepositAt: null,
  entitlements: { limits: {}, usage: {}, enforced: false, catalogVersion: null, planSlug: null },
  adminTerms: [], catalog: { version: 2, plans: SUBSCRIPTION_PLANS, currency: 'INR', taxInclusive: true },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((path: string) => Promise.resolve(overview(Number(path.match(/organizations\/(\d+)/)?.[1]))));
  mocks.post.mockImplementation((path: string) => Promise.resolve(overview(Number(path.match(/organizations\/(\d+)/)?.[1]))));
});
afterEach(cleanup);

describe('regression: administrator confirmation lifetime', () => {
  it('expected target binding: choosing a different organization requires a fresh grant review', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (id: number) => <QueryClientProvider client={client}><AdminPlanAssignment organizationId={id} /></QueryClientProvider>;
    const { rerender } = render(view(11));
    await screen.findByText('Synthetic organization 11');
    fireEvent.change(screen.getByLabelText('Published plan'), { target: { value: 'growth' } });
    fireEvent.change(screen.getByLabelText('Reason for the plan change'), { target: { value: 'Approved only for organization 11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review assignment' }));
    expect(screen.getByRole('alertdialog', { name: 'Assign Growth to Synthetic organization 11?' })).toBeInTheDocument();
    // Parent OrganizationCredits renders the same component without a key.
    rerender(view(22));
    await screen.findByText('Synthetic organization 22');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText('Reason for the plan change')).toHaveValue('');
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
