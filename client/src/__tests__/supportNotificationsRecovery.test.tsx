import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SupportNotificationsPage from '@/app/support/notifications/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/support-api', async original => ({ ...await original<object>(), supportApi: { get: mocks.get, post: mocks.post } }));

class FakeSocket { onmessage: ((event: MessageEvent) => void) | null = null; close = vi.fn(); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows an error with Try again instead of an empty list when notifications fail to load', async () => {
  mocks.get.mockRejectedValueOnce(new Error('Synthetic outage'))
    .mockResolvedValueOnce({ notifications: [], unreadCount: 0, unacknowledgedCount: 0, total: 0 });
  render(<SupportNotificationsPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Notifications could not be loaded');
  expect(screen.queryByText('No support alerts yet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
  expect(await screen.findByText('No support alerts yet')).toBeVisible();
  expect(mocks.get).toHaveBeenCalledTimes(2);
});
