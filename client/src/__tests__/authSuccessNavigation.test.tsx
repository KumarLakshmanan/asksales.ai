import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ push: vi.fn(), post: vi.fn(), toast: vi.fn(), login: vi.fn() }));
const router = { push: mocks.push };
vi.mock('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams('email=synthetic@example.invalid') }));
vi.mock('@/lib/api', () => ({ api: { post: mocks.post }, ApiError: class extends Error {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ login: mocks.login }) }));
vi.mock('@/components/auth/SplitAuthShell', () => ({ SplitAuthShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('@/components/ui/input-otp', () => ({
  InputOTP: ({ onChange, children: _children, ...props }: Omit<ComponentProps<"input">, "onChange"> & { onChange: (value: string) => void }) => <input {...props} onChange={event => onChange(event.target.value)} />,
  InputOTPGroup: () => null, InputOTPSeparator: () => null, InputOTPSlot: () => null,
}));
import ForgotPassword from '@/app/forgot-password/page';
import ResetPassword from '@/app/reset-password/page';
import VerifyEmail from '@/app/verify-email/page';

beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const cases = [
  { name: 'verification', Component: VerifyEmail, target: '/setup/business-profile', result: { user: { id: 1, email: 'synthetic@example.invalid' } }, submit: () => fireEvent.change(screen.getByLabelText('Six-digit verification OTP'), { target: { value: '123456' } }) },
  { name: 'recovery request', Component: ForgotPassword, target: '/reset-password?email=synthetic%40example.invalid', result: {}, submit: () => { fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'synthetic@example.invalid' } }); fireEvent.submit(screen.getByRole('button', { name: 'Request recovery code' }).closest('form')!); } },
  { name: 'password reset', Component: ResetPassword, target: '/login', result: {}, submit: () => { fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: '123456' } }); fireEvent.change(screen.getByLabelText('New password', { exact: true }), { target: { value: 'Synthetic!Audit2026' } }); fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Synthetic!Audit2026' } }); fireEvent.submit(screen.getByRole('button', { name: /^Reset password$/ }).closest('form')!); } },
];
for (const { name, Component, submit, target, result } of cases) describe(name, () => {
  it('navigates once when the successful page stays mounted', async () => {
    mocks.post.mockResolvedValueOnce(result);
    render(<Component />);
    await act(async () => { submit(); });
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(target);
  });
  it('does not override navigation after leaving the success page', async () => {
    mocks.post.mockResolvedValueOnce(result);
    const view = render(<Component />);
    await act(async () => { submit(); });
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it('does not navigate when the response arrives after leaving', async () => {
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<Component />);
    await act(async () => { submit(); });
    view.unmount();
    await act(async () => { finish(result); });
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
