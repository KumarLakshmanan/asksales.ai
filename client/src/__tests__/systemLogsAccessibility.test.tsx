import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { get, toast } = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ default: { get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: 'admin' } }) }));
import Page from '@/app/admin/dashboard/system-logs/page';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function setup() {
  get.mockImplementation((url: string) => Promise.resolve(url.endsWith('/stats') ? { stats: { error: 1 } } : { data: [{ id: 7, level: 'error', message: 'Synthetic event', context: { requestId: 'safe-id' }, createdAt: '2026-10-23T04:45:00Z' }], total: 1, totalPages: 1 }));
  return render(<Page />);
}
describe('keyboard log diagnostics', () => {
  it('exposes a native disclosure with expanded state and Enter/Space activation', async () => {
    setup(); const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Show details for log 7' });
    button.focus(); await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Hide details for log 7' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Context')).toBeVisible(); await user.keyboard(' ');
    expect(screen.queryByText('Context')).not.toBeInTheDocument(); expect(button).toHaveFocus();
  });
  it('makes the statistics filters keyboard-operable with distinct names', async () => {
    setup(); const user = userEvent.setup(); await screen.findByText('Synthetic event');
    screen.getByRole('button', { name: 'Filter logs: Errors' }).focus(); await user.keyboard('{Enter}');
    await waitFor(() => expect(get.mock.calls.some(([url]) => String(url).includes('level=error'))).toBe(true));
  });
  it('labels all filters visibly including the local-time interpretation', async () => {
    setup(); await screen.findByText('Synthetic event');
    expect(screen.getByLabelText('Log level')).toBeVisible();
    expect(screen.getByLabelText('Source')).toBeVisible();
    expect(screen.getByLabelText('Message or source')).toBeVisible();
    expect(screen.getByLabelText('From (local time)')).toBeVisible();
    expect(screen.getByLabelText('To (local time)')).toBeVisible();
  });
});
