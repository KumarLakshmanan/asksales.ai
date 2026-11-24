import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const push = vi.fn();
const apiGet = vi.fn();
const apiPost = vi.fn();
const retry = vi.hoisted(() => ({ delays: [] as number[] }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/home',
  useRouter: () => ({ push, replace }),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

vi.mock('@/lib/sessionCheckRetry', async original => ({
  ...(await original<typeof import('@/lib/sessionCheckRetry')>()),
  sessionCheckRetryDelays: () => retry.delays,
  waitForSessionRetry: () => Promise.resolve(),
}));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ApiError } from '@/lib/api';

const firstUser = {
  id: 9,
  email: 'first@example.com',
  name: 'First Tenant',
  hasBusinessProfile: true,
  hasBrandToolkit: true,
};

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

describe('AuthProvider tenant cache isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    retry.delays = [];
    apiGet.mockResolvedValue({ user: firstUser });
    apiPost.mockResolvedValue({ success: true });
  });

  it('restores the verified account for business selection from a cookie session', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(JSON.parse(localStorage.getItem('user')!)).toEqual(firstUser);
  });

  it('clears business queries when the verified cookie account changes', async () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    queryClient.setQueryData(['business-profiles'], [{ id: 99 }]);
    apiGet.mockResolvedValueOnce({ user: { ...firstUser, id: 2 } });
    await act(async () => result.current.checkAuth());
    expect(queryClient.getQueryData(['business-profiles'])).toBeUndefined();
    expect(result.current.user?.id).toBe(2);
  });

  it.each(['network failure', 'session verification unavailable'] as const)('preserves the requested page on %s and retries without trusting cached user data', async failure => {
    localStorage.setItem('user', JSON.stringify(firstUser));
    apiGet.mockRejectedValueOnce(failure === 'network failure' ? new TypeError('Failed to fetch') : new ApiError('Your session could not be verified. Please try again.', 503));
    const Wrapper = createWrapper(new QueryClient());
    render(<Wrapper><ProtectedRoute skipSetupCheck><p>Protected campaign</p></ProtectedRoute></Wrapper>);
    await screen.findByText('Session check unavailable');
    expect(screen.queryByText('Protected campaign')).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(localStorage.getItem('user')).toContain('First Tenant');
    fireEvent.click(screen.getByRole('button', { name: 'Retry session check' }));
    await screen.findByText('Protected campaign');
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['network failure', () => new TypeError('Failed to fetch')],
    ['server error', () => new ApiError('Unable to retrieve your account information.', 500)],
    ['session verification unavailable', () => new ApiError('Your session could not be verified. Please try again.', 503)],
    ['request timeout', () => new ApiError('Request timed out', 408)],
  ] as const)('retries a transient %s automatically and opens the page without the error card', async (_label, failure) => {
    retry.delays = [0, 0, 0];
    apiGet.mockRejectedValueOnce(failure()).mockRejectedValueOnce(failure());
    const Wrapper = createWrapper(new QueryClient());
    render(<Wrapper><ProtectedRoute skipSetupCheck><p>Protected campaign</p></ProtectedRoute></Wrapper>);
    await screen.findByText('Protected campaign');
    expect(screen.queryByText('Session check unavailable')).not.toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(3);
    expect(push).not.toHaveBeenCalled();
  });

  it('shows the error card only after every transient retry fails, without rendering protected content', async () => {
    retry.delays = [0, 0, 0];
    apiGet.mockRejectedValue(new ApiError('Your session could not be verified. Please try again.', 503));
    const Wrapper = createWrapper(new QueryClient());
    render(<Wrapper><ProtectedRoute skipSetupCheck><p>Protected campaign</p></ProtectedRoute></Wrapper>);
    await screen.findByText('Session check unavailable');
    expect(apiGet).toHaveBeenCalledTimes(4);
    expect(screen.queryByText('Protected campaign')).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps re-checking in the background while the card is shown and opens the page once the server recovers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiGet.mockRejectedValueOnce(new ApiError('Your session could not be verified. Please try again.', 503));
      const Wrapper = createWrapper(new QueryClient());
      render(<Wrapper><ProtectedRoute skipSetupCheck><p>Protected campaign</p></ProtectedRoute></Wrapper>);
      await screen.findByText('Session check unavailable');
      expect(screen.getByText(/Checking again in \d+ seconds\./)).toBeInTheDocument();
      expect(apiGet).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await screen.findByText('Protected campaign');
      expect(apiGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403, 429])('does not retry a %s response', async status => {
    retry.delays = [0, 0, 0];
    apiGet.mockRejectedValue(new ApiError('Rejected', status));
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current.user).toBeNull();
  });

  it('abandons pending retries when a new login supersedes the check', async () => {
    retry.delays = [0, 0, 0];
    let rejectCheck: (reason: unknown) => void = () => undefined;
    apiGet.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCheck = reject; }));
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(new QueryClient()) });
    act(() => result.current.login({ id: 2, email: 'second@example.com', name: 'Second Tenant' }));
    await act(async () => rejectCheck(new ApiError('Unavailable', 503)));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current.user?.id).toBe(2);
    expect(result.current.error).toBeNull();
  });

  it.each([401, 403])('still clears cached tenant data and redirects on a genuine %s rejection', async status => {
    apiGet.mockRejectedValueOnce(new ApiError('Unauthorized', status));
    const queryClient = new QueryClient();
    queryClient.setQueryData(['business-profiles'], [{ id: 99 }]);
    localStorage.setItem('user', JSON.stringify(firstUser));
    const Wrapper = createWrapper(queryClient);
    render(<Wrapper><ProtectedRoute skipSetupCheck><p>Protected campaign</p></ProtectedRoute></Wrapper>);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Protected campaign')).not.toBeInTheDocument();
    expect(queryClient.getQueryData(['business-profiles'])).toBeUndefined();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('ignores a stale failed session check after an explicit new login', async () => {
    let rejectCheck: (reason: unknown) => void = () => undefined;
    apiGet.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCheck = reject; }));
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(new QueryClient()) });
    act(() => result.current.login({ id: 2, email: 'second@example.com', name: 'Second Tenant' }));
    await act(async () => rejectCheck(new ApiError('Expired old session', 401)));
    expect(result.current.user?.id).toBe(2);
    expect(result.current.error).toBeNull();
  });

  it('clears tenant-scoped queries when another user logs in', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['business-profiles'], [{ id: 99, name: 'First profile' }]);
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.login({ id: 1, email: 'second@example.com', name: 'Second Tenant' });
    });

    expect(queryClient.getQueryData(['business-profiles'])).toBeUndefined();
    expect(result.current.user?.id).toBe(1);
  });

  it('clears tenant-scoped queries on logout', async () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    queryClient.setQueryData(['business-profiles'], [{ id: 99, name: 'First profile' }]);

    await act(async () => {
      await result.current.logout();
    });

    expect(queryClient.getQueryData(['business-profiles'])).toBeUndefined();
    expect(result.current.user).toBeNull();
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('retains the account and queries after failed logout, then allows an explicit retry', async () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    queryClient.setQueryData(['business-profiles'], [{ id: 99 }]);
    apiPost.mockRejectedValueOnce(new ApiError('Revocation unavailable', 503));
    await act(async () => result.current.logout());
    expect(result.current.user?.id).toBe(firstUser.id);
    expect(queryClient.getQueryData(['business-profiles'])).toEqual([{ id: 99 }]);
    expect(localStorage.getItem('user')).not.toBeNull(); expect(replace).not.toHaveBeenCalled();
    await act(async () => result.current.logout());
    expect(result.current.user).toBeNull(); expect(queryClient.getQueryData(['business-profiles'])).toBeUndefined();
    expect(replace).toHaveBeenCalledWith('/');
  });
});
