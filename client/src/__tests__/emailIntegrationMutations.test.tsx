import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailIntegrationPage from '@/app/dashboard/(main)/integrations/email/page';
import { selectBusinessProfile } from '@/lib/business-profile';

const { get, post, toast, state } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), state: { connected: true, tokenExpired: false, senderReadFails: false, statusReadFails: false } }));
vi.mock('@/lib/api', () => ({ default: { get, post, delete: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), back: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
const gmailSender = { id: 31, type: 'gmail', label: 'Synthetic Gmail', email: 'owner@example.test', isVerified: true, connectionActive: true, isDefault: true };
const otherSender = { id: 32, type: 'resend', label: 'Unrelated sender', email: 'team@example.test', isVerified: false, isDefault: false };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function ready() { render(<EmailIntegrationPage />); await screen.findByRole('heading', { name: 'Gmail account' }); }
async function disconnect() { fireEvent.click(within(screen.getByRole('region', { name: 'Email connection' })).getByRole('button', { name: 'Disconnect Gmail' })); fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' })); }
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(state, { connected: true, tokenExpired: false, senderReadFails: false, statusReadFails: false });
  localStorage.setItem('user', JSON.stringify({ id: 12 })); sessionStorage.setItem('active-business-profile:12', '17');
  get.mockImplementation(async (url: string) => {
    if (url === '/api/gmail/oauth/status') { if (state.statusReadFails) throw new Error('synthetic read failure'); return { connected: state.connected, tokenExpired: state.tokenExpired, email: state.connected ? 'owner@example.test' : null, configSource: 'default', watchStatus: 'not_configured' }; }
    if (url === '/api/resend/domains') return { domains: [] };
    if (url === '/api/email-senders') { if (state.senderReadFails) throw new Error('synthetic sender read failure'); return { senders: state.connected ? [gmailSender, otherSender] : [otherSender] }; }
    throw new Error('Unexpected synthetic endpoint: ' + url);
  });
  post.mockImplementation(async () => { state.connected = false; return { success: true }; });
});
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); Reflect.deleteProperty(navigator, 'clipboard'); vi.useRealTimers(); });

async function dnsRecords() {
  const read = get.getMockImplementation()!;
  get.mockImplementation((url: string, ...args: unknown[]) => url === '/api/resend/domains'
    ? Promise.resolve({ domains: [{ id: 7, resendDomainId: 'synthetic-domain', name: 'synthetic.example.test', status: 'pending', dnsRecords: [{ record: 'SPF', name: '@', type: 'TXT', value: 'synthetic-dns-value', status: 'pending', ttl: 'Auto' }] }] })
    : read(url, ...args));
  await ready(); fireEvent.click(screen.getByRole('button', { name: 'DNS records' }));
  return screen.getByRole('button', { name: 'Copy value for SPF' });
}

describe('email integration mutation acceptance', () => {
  it.each([
    { connected: false, tokenExpired: false, action: 'Connect Gmail' },
    { connected: true, tokenExpired: false, action: 'Change Gmail account' },
    { connected: true, tokenExpired: true, action: 'Reconnect Gmail' },
  ])('shows one mailbox authorization action: $action', async scenario => {
    Object.assign(state, scenario);
    await ready();
    expect(screen.getAllByRole('button', { name: /^(Connect Gmail|Reconnect Gmail|Change Gmail account)$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: scenario.action })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Connect Email' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sending domains', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sender addresses', level: 2 })).toBeInTheDocument();
  });
  it('removes a disconnected Gmail sender and readiness without removing unrelated senders', async () => {
    await ready(); await disconnect();
    await waitFor(() => expect(get.mock.calls.filter(([url]) => url === '/api/email-senders')).toHaveLength(2));
    expect(screen.queryByText('owner@example.test', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('team@example.test', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('Gmail · Ready to send')).not.toBeInTheDocument();
  });
  it('does not retain a ready Gmail sender when the post-disconnect sender read fails', async () => {
    await ready(); post.mockImplementationOnce(async () => { state.connected = false; state.senderReadFails = true; return { success: true }; });
    await disconnect();
    await waitFor(() => expect(screen.queryByText('Gmail · Ready to send')).not.toBeInTheDocument());
    expect(screen.queryByText('owner@example.test', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('team@example.test', { exact: true })).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Try again' });
  });
  it('keeps confirmed disconnect success separate from a failed status refresh', async () => {
    await ready(); post.mockImplementationOnce(async () => { state.connected = false; state.statusReadFails = true; return { success: true }; });
    await disconnect();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Gmail disconnected locally' })));
    await screen.findByRole('button', { name: 'Try again' });
    expect(toast.mock.calls.some(([value]) => value.title === 'Disconnect Error')).toBe(false);
  });
  it('keeps confirmed watch success separate from a failed status refresh', async () => {
    await ready(); post.mockImplementationOnce(async () => { state.statusReadFails = true; return { success: true }; });
    fireEvent.click(screen.getByRole('button', { name: 'Restart sync' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Inbox Refreshed' })));
    await screen.findByRole('button', { name: 'Try again' });
    expect(toast.mock.calls.some(([value]) => value.title === 'Sync Error')).toBe(false);
  });
  it('keeps confirmed domain creation separate from a failed DNS read', async () => {
    await ready();
    post.mockImplementationOnce(async () => { get.mockImplementation(async (url: string) => {
      if (url === '/api/resend/domains') throw new Error('synthetic DNS read failure');
      throw new Error('Unexpected follow-up endpoint');
    }); return { success: true }; });
    fireEvent.change(screen.getByLabelText('Domain name', { exact: true }), { target: { value: 'synthetic.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Domain Added' })));
    await screen.findByRole('button', { name: 'Try again' });
    expect(toast.mock.calls.some(([value]) => value.title === 'Error')).toBe(false);
  });
  it.each(['success', 'error'])('ignores a late watch %s after switching businesses', async outcome => {
    await ready(); const pending = deferred<{ success: boolean }>(); post.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Restart sync' }));
    act(() => selectBusinessProfile(18));
    await screen.findByRole('heading', { name: 'Gmail account' });
    await act(async () => { if (outcome === 'success') pending.resolve({ success: true }); else pending.reject(new Error('late provider rejection')); });
    expect(toast).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledOnce();
  });
  it('does not invalidate another business sender cache or notify after late disconnect', async () => {
    await ready(); const pending = deferred<{ success: boolean }>(); post.mockReturnValueOnce(pending.promise);
    await disconnect(); act(() => selectBusinessProfile(18));
    await screen.findByRole('heading', { name: 'Gmail account' });
    await act(async () => pending.resolve({ success: true }));
    expect(screen.getByText('Synthetic Gmail', { exact: true })).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledOnce();
  });
  it('ignores a late watch response after changing the signed-in actor', async () => {
    await ready(); const pending = deferred<{ success: boolean }>(); post.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Restart sync' }));
    localStorage.setItem('user', JSON.stringify({ id: 13 }));
    await act(async () => pending.resolve({ success: true }));
    expect(toast).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledOnce();
  });
  it('does not notify when a watch response arrives after unmount', async () => {
    const page = render(<EmailIntegrationPage />); await screen.findByRole('heading', { name: 'Gmail account' });
    const pending = deferred<{ success: boolean }>(); post.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Restart sync' })); page.unmount();
    await act(async () => pending.resolve({ success: true })); expect(toast).not.toHaveBeenCalled();
  });
  it('reports DNS copied only after the clipboard accepts the value', async () => {
    const pending = deferred<void>(); const writeText = vi.fn().mockReturnValue(pending.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fireEvent.click(await dnsRecords()); expect(writeText).toHaveBeenCalledWith('synthetic-dns-value'); expect(toast).not.toHaveBeenCalled();
    await act(async () => pending.resolve()); expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Copied' }));
  });
  it.each(['denied', 'unavailable'])('handles %s clipboard access without false success or an unhandled rejection', async mode => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unavailable' ? undefined : { writeText: vi.fn().mockRejectedValue(new DOMException('Synthetic denied clipboard', 'NotAllowedError')) } });
    fireEvent.click(await dnsRecords());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not copy DNS value' })));
    expect(toast.mock.calls.some(([value]) => value.title === 'Copied')).toBe(false);
    expect(screen.getByText('synthetic-dns-value')).toBeInTheDocument();
  });
  it('ignores a clipboard completion after switching businesses', async () => {
    const pending = deferred<void>(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => pending.promise } });
    fireEvent.click(await dnsRecords()); act(() => selectBusinessProfile(18));
    await act(async () => pending.resolve()); expect(toast).not.toHaveBeenCalled();
  });
});
