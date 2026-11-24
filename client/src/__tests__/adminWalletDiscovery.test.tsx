import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrganizationCredits from '@/components/admin/OrganizationCredits';
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ default: { get: state.get, post: state.post } }));
vi.mock('@/components/admin/AdminPlanAssignment', () => ({ default: () => null }));
const org = (id: number) => ({ id, name: `Synthetic ${id}`, ownerUserId: id,
  ownerEmail: `owner${id}@example.invalid`, balance: 0, planName: null, planSlug: null, catalogVersion: null });
function show() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OrganizationCredits /></QueryClientProvider>); }
beforeEach(() => { cleanup(); state.get.mockReset(); state.post.mockReset(); });
describe('bounded administrator billing-account discovery', () => {
  it('discloses partial results and allows narrowing to an initially omitted account without writes', async () => {
    state.get.mockImplementation(async (_path, options) => options.params.search === 'owner105@example.invalid'
      ? { organizations: [org(105)], resultLimit: 100, hasMore: false }
      : { organizations: Array.from({ length: 100 }, (_, i) => org(i + 1)), resultLimit: 100, hasMore: true });
    show();
    expect(await screen.findByText(/Showing the first 100 matching billing accounts/)).toHaveTextContent('exact account ID');
    expect(screen.queryByRole('option', { name: /owner105@example.invalid/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Find a billing account'), { target: { value: 'owner105@example.invalid' } });
    await screen.findByRole('option', { name: /owner105@example.invalid/ });
    await waitFor(() => expect(screen.queryByText(/More accounts match/)).not.toBeInTheDocument());
    expect(state.post).not.toHaveBeenCalled();
  });
  it('does not imply truncation when exactly 100 or fewer accounts match', async () => {
    state.get.mockResolvedValue({ organizations: [org(1)], resultLimit: 100, hasMore: false });
    show(); await screen.findByRole('option', { name: /owner1@example.invalid/ });
    expect(screen.queryByText(/More accounts match/)).not.toBeInTheDocument();
  });
});
