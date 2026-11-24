import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WalletsPage from '@/app/admin/dashboard/wallets/page';

type Session = { admin: { id: number; role: string } | null; isLoading: boolean };
const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), toast: vi.fn(),
  session: { admin: { id: 1, role: 'super_admin' }, isLoading: false } as Session,
  submitHandlers: [] as Array<() => unknown>,
}));
vi.mock('@/lib/admin-api', () => ({
  default: { get: mocks.get, post: mocks.post },
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => mocks.session }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/admin/AdminPlanAssignment', () => ({
  default: ({ organizationId }: { organizationId: number | null }) => <p>Plan form for organization {organizationId}</p>,
}));
// Capture a submission callback to model a queued action from an earlier render.
// Authorization/state logic stays in the real WalletsPage under test.
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, variant: _variant, size: _size, ...props }:
    React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const wording = React.Children.toArray(children).filter(child => typeof child === 'string').join('').trim();
    if (wording === 'Add Credits' && onClick) mocks.submitHandlers.push(() => onClick({} as React.MouseEvent<HTMLButtonElement>));
    return <button {...props} onClick={onClick}>{children}</button>;
  },
}));

const wallet = {
  id: 9, userId: 7, organizationId: 77, organizationName: 'Synthetic billing account',
  balance: 1234, totalCreditsAdded: 4000, totalCreditsUsed: 2766,
  userName: 'Synthetic owner', userEmail: 'owner@example.test', createdAt: '2026-10-01T00:00:00Z',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.submitHandlers = [];
  mocks.session = { admin: { id: 1, role: 'super_admin' }, isLoading: false };
  mocks.get.mockResolvedValue({
    items: [wallet], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    summary: { totalWallets: 1, totalBalance: 1234, totalCreditsAdded: 4000 },
  });
  mocks.post.mockResolvedValue({ newBalance: 1334 });
});
afterEach(cleanup);
async function expectReadAccess() {
  const email = await screen.findByText('owner@example.test');
  const row = within(email.closest('tr')!);
  expect(row.getByText('1,234')).toBeInTheDocument();
  expect(row.getByText('+4,000')).toBeInTheDocument();
  expect(row.getByText('-2,766')).toBeInTheDocument();
  expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/wallets\?/));
}
function openCreditForm() {
  fireEvent.click(screen.getByRole('button', { name: /^Add Credits$/ }));
  const dialog = within(screen.getByRole('dialog', { name: 'Add credits to billing account' }));
  fireEvent.change(dialog.getByLabelText('Credits amount'), { target: { value: '100' } });
  fireEvent.change(dialog.getByLabelText('Reason'), { target: { value: 'Synthetic verified adjustment' } });
  return dialog;
}

describe('administrator wallet mutation capabilities', () => {
  it.each([
    ['ordinary administrator', { admin: { id: 2, role: 'admin' }, isLoading: false }],
    ['missing administrator', { admin: null, isLoading: false }],
    ['loading session with cached super administrator', { admin: { id: 1, role: 'super_admin' }, isLoading: true }],
  ] as const)('retains wallet reads but withholds billing mutations for %s', async (_label, session) => {
    mocks.session = session;
    render(<WalletsPage />);
    await expectReadAccess();
    expect(screen.queryByRole('button', { name: /^Add Credits$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Manage Plan$/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Subscription billing' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(session.isLoading
      ? 'Checking billing management permissions…'
      : 'Read-only billing access. A super administrator can add credits or manage plans.');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('keeps reviewed credit adjustment and plan management available to a verified super administrator', async () => {
    render(<WalletsPage />);
    await expectReadAccess();
    const dialog = openCreditForm();
    fireEvent.click(dialog.getByRole('button', { name: /^Add Credits$/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/wallets/7/add-credits', {
      amount: 100, reason: 'Synthetic verified adjustment',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /^Manage Plan$/ }));
    expect(screen.getByRole('dialog', { name: 'Manage account plan' })).toBeInTheDocument();
    expect(screen.getByText('Plan form for organization 77')).toBeInTheDocument();
  });

  it('closes a stale credit form and rejects its retained handler after management authority is lost', async () => {
    const { rerender } = render(<WalletsPage />);
    await expectReadAccess();
    openCreditForm();
    const oldSubmit = mocks.submitHandlers.at(-1)!;
    mocks.session = { admin: { id: 2, role: 'admin' }, isLoading: false };
    rerender(<WalletsPage />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { await oldSubmit(); });
    expect(mocks.post).not.toHaveBeenCalled();
    await expectReadAccess();
  });

  it('hides an open plan dialog while management capability is being verified again', async () => {
    const { rerender } = render(<WalletsPage />);
    await expectReadAccess();
    fireEvent.click(screen.getByRole('button', { name: /^Manage Plan$/ }));
    expect(screen.getByRole('dialog', { name: 'Manage account plan' })).toBeInTheDocument();
    mocks.session = { admin: { id: 1, role: 'super_admin' }, isLoading: true };
    rerender(<WalletsPage />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Plan form for organization 77')).toBeNull();
  });

  it.each([1, 3])('does not let a late adjustment result overwrite a new form after verification returns administrator %s', async nextAdminId => {
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<WalletsPage />);
    await expectReadAccess();
    const firstDialog = openCreditForm();
    fireEvent.click(firstDialog.getByRole('button', { name: /^Add Credits$/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    mocks.session = { admin: null, isLoading: true };
    rerender(<WalletsPage />);
    expect(screen.queryByRole('dialog')).toBeNull();
    mocks.session = { admin: { id: nextAdminId, role: 'super_admin' }, isLoading: false };
    rerender(<WalletsPage />);
    const nextDialog = openCreditForm();
    fireEvent.change(nextDialog.getByLabelText('Reason'), { target: { value: 'New administrator draft' } });
    await act(async () => { finish({ newBalance: 1334 }); });
    expect(screen.getByRole('dialog', { name: 'Add credits to billing account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toHaveValue('New administrator draft');
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Credits Added' }));
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
