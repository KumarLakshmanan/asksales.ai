import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MSG91IntegrationPage from '@/app/dashboard/(main)/integrations/msg91/page';
import { msg91State } from '@/lib/integrations';
import { getOutreachIntegrationStatus } from '@/lib/integration-status';
import type { MSG91SettingsResponse } from '@/lib/msg91';
import { describeChannelEvent } from '@/components/integrations/WebhookEventsWorkspace';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const connected = (): MSG91SettingsResponse => ({
  success: true, configured: true, connected: true,
  settings: { hasAuthKey: true, senderId: 'ABCDEF', flowId: 'template-42', messageVariable: 'message', connectionStatus: 'ready', lastVerifiedAt: '2026-09-29T06:00:00Z' },
});
let saved: MSG91SettingsResponse;
let statusUnavailable: boolean;
let callbacksUnavailable: boolean;
const callbackUrl = 'https://app.example.test/api/webhooks/sms/fixture-token';

beforeEach(() => {
  vi.clearAllMocks();
  saved = connected();
  statusUnavailable = false;
  callbacksUnavailable = false;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/api/msg91-settings') {
      if (statusUnavailable) throw new Error('SMS status could not be loaded.');
      return saved;
    }
    if (url === '/api/webhooks/config') {
      if (callbacksUnavailable) throw new Error('Callback setup unavailable.');
      return { success: true, webhooks: { sms: { url: callbackUrl, deliveryUrl: `${callbackUrl}/delivery`, expiresAt: '2099-01-01T00:00:00Z' } } };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  mocks.post.mockReset().mockImplementation(async (url: string, body: Record<string, string>) => {
    if (url === '/api/msg91-settings') saved = { ...connected(), settings: { ...connected().settings!, senderId: body.senderId, flowId: body.flowId, messageVariable: body.messageVariable } };
    return { success: true };
  });
  mocks.delete.mockReset().mockImplementation(async () => {
    saved = { success: true, configured: false, connected: false, settings: null };
    return { success: true };
  });
});
afterEach(cleanup);

async function renderConnected() {
  render(<MSG91IntegrationPage />);
  await screen.findByRole('heading', { name: 'ABCDEF' });
  return screen.getByRole('region', { name: 'SMS connection' });
}

describe('MSG91 integration workspace', () => {
  it('shows the saved sender, shared feature links, and delivery and inbound callbacks', async () => {
    const connection = await renderConnected();
    expect(within(connection).getByText('Connected', { exact: true })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open SMS outreach' })).toHaveAttribute('href', '/dashboard/outreach/sms');
    const features = screen.getByRole('complementary', { name: 'SMS features' });
    expect(within(features).getByRole('link', { name: /Events and activity/ })).toHaveAttribute('href', '/dashboard/integrations/msg91/events');
    expect(await screen.findByLabelText('Delivery callback URL')).toHaveValue(`${callbackUrl}/delivery`);
    expect(screen.getByLabelText('Incoming SMS callback URL')).toHaveValue(callbackUrl);
    expect(screen.getByText(/previously configured URLs keep their original expiry/)).toBeVisible();
    expect(screen.getByLabelText('MSG91 Auth Key')).toHaveValue('');
    expect(screen.getByLabelText('MSG91 Auth Key')).toHaveAttribute('type', 'password');
  });

  it('retains draft details and the saved account display after testing without sending an SMS', async () => {
    const connection = await renderConnected();
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Approved Sender ID'));
    await user.type(screen.getByLabelText('Approved Sender ID'), 'xyzabc');
    await user.type(screen.getByLabelText('MSG91 Auth Key'), 'replacement-key');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'MSG91 connection verified' })));
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/msg91-settings/test', { authKey: 'replacement-key', senderId: 'XYZABC', flowId: 'template-42', messageVariable: 'message' });
    expect(screen.getByLabelText('Approved Sender ID')).toHaveValue('XYZABC');
    expect(screen.getByLabelText('MSG91 Auth Key')).toHaveValue('replacement-key');
    expect(within(connection).getByRole('heading', { name: 'ABCDEF' })).toBeVisible();
  });

  it('verifies and saves a connection while preserving a saved Auth Key', async () => {
    saved = { ...connected(), connected: false, settings: { ...connected().settings!, connectionStatus: 'action_required' } };
    const connection = await renderConnected();
    expect(within(connection).getByText('Action required', { exact: true })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(within(connection).getByText('Connected', { exact: true })).toBeVisible());
    expect(mocks.post).toHaveBeenCalledWith('/api/msg91-settings', expect.objectContaining({ authKey: '', senderId: 'ABCDEF', flowId: 'template-42' }));
    expect(screen.getByLabelText('MSG91 Auth Key')).toHaveValue('');
  });

  it('preserves an existing connection and draft when verification fails', async () => {
    const connection = await renderConnected();
    mocks.post.mockResolvedValueOnce({ success: false, error: 'The sender does not match this template.' });
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('SMS Template ID'));
    await user.type(screen.getByLabelText('SMS Template ID'), 'draft-template');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'SMS setup failed', description: 'The sender does not match this template.' })));
    expect(screen.getByLabelText('SMS Template ID')).toHaveValue('draft-template');
    expect(within(connection).getByText('template-42', { exact: true })).toBeVisible();
  });

  it('blocks concurrent changes while verification is pending', async () => {
    await renderConnected();
    let finish!: (value: { success: boolean }) => void;
    mocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByLabelText('Approved Sender ID')).toBeDisabled();
    await act(async () => { finish({ success: true }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled());
  });

  it('keeps unavailable status distinct and blocks saving fallback settings until retry succeeds', async () => {
    statusUnavailable = true;
    render(<MSG91IntegrationPage />);
    await screen.findByRole('heading', { name: 'SMS status unavailable' });
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Open SMS outreach' })).not.toBeInTheDocument();
    statusUnavailable = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'ABCDEF' });
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled();
  });

  it('retries callback setup independently of the verified sender', async () => {
    callbacksUnavailable = true;
    const connection = await renderConnected();
    expect(await screen.findByText('Callback setup unavailable.')).toBeVisible();
    expect(within(connection).getByText('Connected', { exact: true })).toBeVisible();
    callbacksUnavailable = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry callback setup' }));
    expect(await screen.findByLabelText('Delivery callback URL')).toHaveValue(`${callbackUrl}/delivery`);
  });

  it('opens the shared connection guide and explains template and inbound number requirements', async () => {
    await renderConnected();
    await userEvent.click(screen.getByRole('button', { name: 'How to connect' }));
    expect(await screen.findByRole('heading', { name: 'How to connect MSG91 SMS' })).toBeVisible();
    expect(screen.getByText(/Receiving replies requires that inbound service/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'MSG91 SMS documentation' })).toHaveAttribute('href', 'https://docs.msg91.com/sms/send-sms');
  });

  it('disconnects and clears the saved sender after confirmation', async () => {
    await renderConnected();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('heading', { name: 'Connect SMS' });
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith('/api/msg91-settings');
    expect(screen.getByLabelText('Approved Sender ID')).toHaveValue('');
  });
});

describe('SMS readiness shared by overview and outreach', () => {
  it('presents delivery receipts and failures with readable activity summaries', () => {
    expect(describeChannelEvent({ id: 1, event_type: 'sms_delivery_delivered', processed: true }, 'MSG91 SMS')).toMatchObject({ title: 'SMS delivered', category: 'Delivery', status: 'handled' });
    expect(describeChannelEvent({ id: 2, event_type: 'sms_delivery_failed', processed: true, payload: { failureReason: 'Recipient unavailable' } }, 'MSG91 SMS')).toMatchObject({ title: 'SMS delivery failed', category: 'Delivery', status: 'attention', summary: 'Recipient unavailable' });
  });
  it('requires verification and distinguishes revoked keys from incomplete settings', async () => {
    expect(msg91State(saved)).toBe('connected');
    saved = { ...saved, connected: false, settings: { ...saved.settings!, connectionStatus: 'action_required' } };
    expect(msg91State(saved)).toBe('action_required');
    expect(await getOutreachIntegrationStatus('sms')).toBe(false);
    saved.settings!.connectionStatus = 'reauth_required';
    expect(msg91State(saved)).toBe('reconnect');
    expect(msg91State(saved, 'Network unavailable')).toBe('unavailable');
    expect(msg91State({ success: true, configured: false, settings: null })).toBe('disconnected');
  });
});
