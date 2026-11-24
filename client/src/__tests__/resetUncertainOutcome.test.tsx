import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const mocks = vi.hoisted(() => ({ post: vi.fn(), toast: vi.fn(), push: vi.fn() }));
const router = { push: mocks.push };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/api', async original => ({ ...await original<object>(), api: { post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/auth/SplitAuthShell', () => ({ SplitAuthShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
import { ApiError } from '@/lib/api';
import ResetPassword from '@/app/reset-password/page';
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => cleanup());
async function submit(error: Error) {
  mocks.post.mockRejectedValueOnce(error);render(<ResetPassword />);
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'synthetic@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: '123456' } });
  fireEvent.change(screen.getByLabelText('New password', { exact: true }), { target: { value: 'Synthetic!Audit2026' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Synthetic!Audit2026' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: /^Reset password$/ }).closest('form')!); });
}
it.each([new Error('Lost response'), new ApiError('Network', 0), new ApiError('Internal', 503)])('keeps an uncertain reset outcome recoverable: %s', async error => {
  await submit(error);
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Password reset could not be confirmed', description: expect.stringContaining('Try signing in with the new password') }));
  expect(screen.getByRole('link', { name: /^Sign in$/ })).toHaveAttribute('href', '/login');
  expect(screen.getByRole('link', { name: 'Request another code' })).toHaveAttribute('href', '/forgot-password');
  expect(mocks.post).toHaveBeenCalledTimes(1);expect(mocks.push).not.toHaveBeenCalled();
});
it('preserves a concrete rejected-code response', async () => {
  await submit(new ApiError('Invalid or expired code', 400));
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Password was not reset', description: 'Invalid or expired code' }));
});
