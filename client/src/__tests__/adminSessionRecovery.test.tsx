import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '@/contexts/AdminAuthContext';
import { AdminProtectedRoute } from '@/components/admin/AdminProtectedRoute';
import { ApiError } from '@/lib/admin-api';
import { SESSION_CARD_RECHECK_MS } from '@/lib/sessionCheckRetry';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn(), replace: vi.fn(), delays: [] as number[] }));
vi.mock('@/lib/sessionCheckRetry', async original => ({ ...await original<object>(), sessionCheckRetryDelays: () => mocks.delays }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock('@/lib/admin-api', async original => ({ ...await original<object>(), api: { get: mocks.get, post: mocks.post } }));

const admin = { id: 1, email: 'ops@example.test', name: 'Ops', role: 'super_admin' };
const renderGuard = () => render(<AdminAuthProvider><AdminProtectedRoute><p>Admin dashboard</p></AdminProtectedRoute></AdminAuthProvider>);

beforeEach(() => { vi.resetAllMocks(); mocks.delays = []; localStorage.clear(); mocks.post.mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows an error card instead of the sign-in page during an outage, and opens after Retry', async () => {
  localStorage.setItem('admin', JSON.stringify(admin));
  mocks.get.mockRejectedValueOnce(new ApiError('Synthetic outage', 503)).mockResolvedValueOnce({ admin });
  renderGuard();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not check your admin session');
  expect(screen.queryByText('Admin dashboard')).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry session check' }));
  expect(await screen.findByText('Admin dashboard')).toBeVisible();
  expect(mocks.push).not.toHaveBeenCalled();
});

it('treats a network failure as an outage, not a sign-out', async () => {
  mocks.get.mockRejectedValue(new TypeError('Failed to fetch'));
  renderGuard();
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(mocks.push).not.toHaveBeenCalled();
});

it('keeps re-checking while the error card is shown', async () => {
  vi.useFakeTimers();
  mocks.get.mockRejectedValueOnce(new ApiError('Synthetic outage', 500)).mockResolvedValueOnce({ admin });
  renderGuard();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole('alert')).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_CARD_RECHECK_MS); });
  expect(screen.getByText('Admin dashboard')).toBeVisible();
  expect(mocks.get).toHaveBeenCalledTimes(2);
});

it.each([401, 403])('sends a %i rejection to the admin sign-in page', async status => {
  mocks.get.mockRejectedValue(new ApiError('Signed out', status));
  renderGuard();
  expect(await screen.findByText('Redirecting to admin sign-in…')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(mocks.push).toHaveBeenCalledWith('/admin/login');
});

it('retries a transient failure automatically before deciding', async () => {
  mocks.delays = [0, 0];
  mocks.get.mockRejectedValueOnce(new ApiError('Synthetic outage', 503)).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ admin });
  renderGuard();
  expect(await screen.findByText('Admin dashboard')).toBeVisible();
  expect(mocks.get).toHaveBeenCalledTimes(3);
});
