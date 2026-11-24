import { beforeEach, expect, it, jest } from '@jest/globals';

const send = jest.fn<(...args: unknown[]) => Promise<any>>();
const active = jest.fn<(type: string) => Promise<any>>();
const lastUsed = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.unstable_mockModule('resend', () => ({ Resend: class { emails = { send }; } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions', () => ({
  getActiveAdminCredential: active,
  getAdminCredentialById: jest.fn<() => Promise<any>>().mockResolvedValue({ apiKey: 'test-key' }),
  markAdminCredentialInactive: jest.fn(),
  updateAdminCredentialLastUsed: lastUsed,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
const { sendAdminEmail } = await import('../services/adminEmailService');
const message = { to: 'owner@example.com', subject: 'Reminder', html: '<p>Test</p>' };

beforeEach(() => {
  jest.clearAllMocks();
  active.mockResolvedValue({ id: 1, config: { provider: 'resend', resendCredentialId: 2, fromEmail: 'mail@example.com' } });
});

it('reports an explicit unverified-domain rejection as a confirmed failure', async () => {
  send.mockResolvedValueOnce({ data: null, error: { statusCode: 403, message: 'Domain not verified' } });
  expect(await sendAdminEmail(message)).toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: false });
  expect(lastUsed).not.toHaveBeenCalled();
});

it.each([408, 500])('retains uncertainty for provider status %s', async statusCode => {
  send.mockResolvedValueOnce({ data: null, error: { statusCode, message: 'Provider unavailable' } });
  expect(await sendAdminEmail(message)).toMatchObject({ success: false, outcomeUncertain: true });
});

it('does not claim success without a provider acknowledgement', async () => {
  send.mockResolvedValueOnce({ data: {}, error: null });
  expect(await sendAdminEmail(message)).toMatchObject({ success: false, outcomeUncertain: true });
});

it('returns the accepted provider reference', async () => {
  send.mockResolvedValueOnce({ data: { id: 'mail-1' }, error: null });
  expect(await sendAdminEmail(message)).toMatchObject({ success: true, messageId: 'mail-1' });
});

it('reports missing configuration before any provider attempt', async () => {
  active.mockResolvedValueOnce(null);
  expect(await sendAdminEmail(message)).toMatchObject({ success: false, deliveryAttempted: false, outcomeUncertain: false });
  expect(send).not.toHaveBeenCalled();
});
