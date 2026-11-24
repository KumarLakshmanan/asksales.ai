import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIntegrationStatus } from '@/hooks/use-integration-status';
import { selectBusinessProfile } from '@/lib/business-profile';
import InstagramPage from '@/app/dashboard/(main)/integrations/instagram/page';
import FacebookPage from '@/app/dashboard/(main)/integrations/facebook/page';
import WhatsAppPage from '@/app/dashboard/(main)/integrations/whatsapp/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }), useSearchParams: () => new URLSearchParams() }));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('user', JSON.stringify({ id: 7 }));
  sessionStorage.setItem('active-business-profile:7', '11');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe('integration status loading', () => {
  it.each([
    { Page: InstagramPage, name: 'Instagram', button: 'Continue with Instagram', response: { officialApi: { connected: false } } },
    { Page: FacebookPage, name: 'Facebook', button: 'Continue with Facebook', response: { officialApi: { connected: false } } },
    { Page: WhatsAppPage, name: 'WhatsApp', button: 'Connect WhatsApp Business', response: { success: true, configured: false, config: null } },
  ])('$name keeps its heading/help visible while status loads and reuses a recent result on return', async ({ Page, name, button, response }) => {
    const pending = deferred<typeof response>();
    mocks.get.mockReturnValue(pending.promise);
    const first = render(<Page />, { wrapper });
    expect(screen.getByRole('heading', { name })).toBeVisible();
    expect(screen.getByRole('button', { name: 'How to connect' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(`Loading ${name} connection`);
    expect(screen.queryByRole('button', { name: button })).not.toBeInTheDocument();
    await act(async () => { pending.resolve(response); });
    expect(await screen.findByRole('button', { name: button })).toBeVisible();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    first.unmount();
    render(<Page />, { wrapper });
    expect(screen.getByRole('button', { name: button })).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent observers and forces a fresh read after a connection change', async () => {
    const pending = deferred<{ connected: boolean }>();
    mocks.get.mockReturnValueOnce(pending.promise).mockResolvedValue({ connected: false });
    const one = renderHook(() => useIntegrationStatus<{ connected: boolean }>('/status'), { wrapper });
    const two = renderHook(() => useIntegrationStatus<{ connected: boolean }>('/status'), { wrapper });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    expect(mocks.get).toHaveBeenCalledWith('/status', expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 12_000 }));
    await act(async () => { pending.resolve({ connected: true }); });
    await waitFor(() => expect(two.result.current.data?.connected).toBe(true));
    await act(async () => { await one.result.current.refetch(); });
    await waitFor(() => expect(two.result.current.data?.connected).toBe(false));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('rechecks a previously cached connection when returning after its freshness window', async () => {
    mocks.get.mockResolvedValueOnce({ connected: true }).mockResolvedValue({ connected: false });
    const first = renderHook(() => useIntegrationStatus<{ connected: boolean }>('/status'), { wrapper });
    await waitFor(() => expect(first.result.current.data?.connected).toBe(true));
    first.unmount();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 16_000);
    const second = renderHook(() => useIntegrationStatus<{ connected: boolean }>('/status'), { wrapper });
    await waitFor(() => expect(second.result.current.data?.connected).toBe(false));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('refreshes WhatsApp after pausing and keeps the new state when revisiting', async () => {
    const response = { success: true, configured: true, enabled: true, config: { connectionStatus: 'ready', phoneNumberId: 'fixture', businessAccountId: 'fixture' } };
    mocks.get.mockResolvedValueOnce(response).mockResolvedValue({ ...response, enabled: false });
    mocks.post.mockResolvedValue({ success: true });
    const first = render(<WhatsAppPage />, { wrapper });
    await act(async () => (await screen.findByRole('button', { name: 'Pause messaging' })).click());
    expect(await screen.findByRole('button', { name: 'Resume messaging' })).toBeVisible();
    expect(mocks.post).toHaveBeenCalledWith('/api/whatsapp/toggle', { enabled: false });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    first.unmount();
    render(<WhatsAppPage />, { wrapper });
    expect(screen.getByRole('button', { name: 'Resume messaging' })).toBeVisible();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('cancels the old business read and never shows its result in the newly selected business', async () => {
    const pending = deferred<{ name: string }>();
    mocks.get.mockReturnValueOnce(pending.promise).mockResolvedValue({ name: 'New business' });
    const hook = renderHook(() => useIntegrationStatus<{ name: string }>('/status'), { wrapper });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    const signal = mocks.get.mock.calls[0][1].signal as AbortSignal;
    act(() => selectBusinessProfile(12));
    await waitFor(() => expect(hook.result.current.data?.name).toBe('New business'));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ name: 'Old business' }));
    expect(hook.result.current.data?.name).toBe('New business');
  });

  it('does not read an unverified account or carry cached status to another signed-in account', async () => {
    mocks.get.mockResolvedValueOnce({ name: 'Account one' }).mockResolvedValue({ name: 'Account two' });
    const first = renderHook(() => useIntegrationStatus<{ name: string }>('/status'), { wrapper });
    await waitFor(() => expect(first.result.current.data?.name).toBe('Account one'));
    first.unmount();
    localStorage.removeItem('user');
    const anonymous = renderHook(() => useIntegrationStatus<{ name: string }>('/status'), { wrapper });
    expect(anonymous.result.current.data).toBeUndefined();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    anonymous.unmount();
    localStorage.setItem('user', JSON.stringify({ id: 8 }));
    sessionStorage.setItem('active-business-profile:8', '11');
    const next = renderHook(() => useIntegrationStatus<{ name: string }>('/status'), { wrapper });
    await waitFor(() => expect(next.result.current.data?.name).toBe('Account two'));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('shows status failure with a working retry instead of an endless spinner', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Connection status timed out')).mockResolvedValue({ officialApi: { connected: false } });
    render(<FacebookPage />, { wrapper });
    expect(await screen.findByText('Connection status timed out')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => screen.getByRole('button', { name: 'Try again' }).click());
    expect(await screen.findByRole('button', { name: 'Continue with Facebook' })).toBeVisible();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});
