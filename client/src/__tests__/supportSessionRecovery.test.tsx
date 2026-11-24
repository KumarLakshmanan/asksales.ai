import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SupportAuthProvider, useSupportAuth } from '@/contexts/SupportAuthContext';
import { ApiError } from '@/lib/support-api';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), replace: vi.fn(), delays: [] as number[] }));
vi.mock('@/lib/sessionCheckRetry', async original => ({ ...await original<object>(), sessionCheckRetryDelays: () => mocks.delays }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/lib/support-api', async original => ({ ...await original<object>(), supportApi: { get: mocks.get, post: mocks.post } }));
function Status() {
  const auth = useSupportAuth();
  return <><p>{auth.isLoading ? 'Checking' : auth.isAuthenticated ? 'Verified' : 'Unverified'}</p>{auth.error && <p role="alert">{auth.error}</p>}<button onClick={() => void auth.checkAuth()}>Retry session</button></>;
}
beforeEach(() => { vi.resetAllMocks(); mocks.delays = []; localStorage.clear(); mocks.post.mockResolvedValue({}); });
afterEach(() => cleanup());
it('keeps an outage unverified and retryable even with cached member display data', async () => {
  localStorage.setItem('support_member', JSON.stringify({ id: 51, name: 'Cached display only' }));
  mocks.get.mockRejectedValueOnce(new ApiError('Synthetic outage', 503)).mockResolvedValueOnce({ id: 51, name: 'Verified member' });
  render(<SupportAuthProvider><Status /></SupportAuthProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not check');
  expect(screen.getByText('Unverified')).toBeVisible(); expect(mocks.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry session' }));
  expect(await screen.findByText('Verified')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});
it('preserves an explicit authentication rejection as signed out rather than an outage', async () => {
  mocks.get.mockRejectedValue(new ApiError('Signed out', 401));
  render(<SupportAuthProvider><Status /></SupportAuthProvider>);
  expect(await screen.findByText('Unverified')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull(); expect(mocks.post).not.toHaveBeenCalled();
});
it('retries a transient outage automatically before showing the support session error', async () => {
  mocks.delays = [0, 0, 0];
  mocks.get.mockRejectedValueOnce(new ApiError('Synthetic outage', 503)).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ id: 51, name: 'Verified member' });
  render(<SupportAuthProvider><Status /></SupportAuthProvider>);
  expect(await screen.findByText('Verified')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull(); expect(mocks.get).toHaveBeenCalledTimes(3);
});
it('does not retry an authentication rejection', async () => {
  mocks.delays = [0, 0, 0];
  mocks.get.mockRejectedValue(new ApiError('Signed out', 401));
  render(<SupportAuthProvider><Status /></SupportAuthProvider>);
  expect(await screen.findByText('Unverified')).toBeVisible();
  expect(mocks.get).toHaveBeenCalledTimes(1);
});
