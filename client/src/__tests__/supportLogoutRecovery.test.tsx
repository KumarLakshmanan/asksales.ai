import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SupportAuthProvider, useSupportAuth } from '@/contexts/SupportAuthContext';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), replace: vi.fn(), toast: vi.fn() }));
const router = { replace: mocks.replace };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/support-api', async original => ({ ...await original<object>(), supportApi: { get: mocks.get, post: mocks.post } }));
function Status() { const auth = useSupportAuth(); return <><p>{auth.isLoading ? 'Checking' : auth.isAuthenticated ? 'Verified' : 'Signed out'}</p><button onClick={() => void auth.logout()}>Sign out</button></>; }
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); mocks.get.mockResolvedValue({ id: 51, name: 'Synthetic member' }); mocks.post.mockResolvedValue({}); });
afterEach(() => cleanup());
it('keeps the verified session and cached display data after failed logout, then retries', async () => {
  let attempts = 0;
  mocks.post.mockImplementation(async (path: string) => { if (path.endsWith('/logout') && attempts++ === 0) throw new Error('Synthetic revocation failure'); return {}; });
  render(<SupportAuthProvider><Status /></SupportAuthProvider>);
  await screen.findByText('Verified');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); });
  expect(screen.getByText('Verified')).toBeVisible();
  expect(localStorage.getItem('support_member')).toContain('Synthetic member');
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); });
  expect(screen.getByText('Signed out')).toBeVisible();
  expect(localStorage.getItem('support_member')).toBeNull();
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('/support/login');
});
it('clears the session after confirmed logout', async () => {
  render(<SupportAuthProvider><Status /></SupportAuthProvider>);
  await screen.findByText('Verified');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); });
  expect(screen.getByText('Signed out')).toBeVisible();
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('/support/login');
});
