import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findByUserAndPlatform = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const findActiveAccountByIdentifier = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const suppressionQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: Array<{ destination: string }> }>>();
const updateAccount = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({
  ChannelCredentialModel: {
    findByUserAndPlatform,
    findActiveAccountByIdentifier,
    updateAccount,
  },
}));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: suppressionQuery } }));
jest.unstable_mockModule('../services/InboundContactResolver.js', () => ({ inboundContactResolver: {} }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  privacyVaultService: {},
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text, piiTypes: [], tokenCount: 0 }),
}));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js', () => ({
  decryptChannelCredentialSecret: (value: string) => value.replace(/^sealed:/, ''),
  decryptChannelCredentialSession: (value: unknown) => value,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { sendSMS } = await import('../services/smsService.js');

const credential = (sessionData: Record<string, unknown> = {}) => ({
  id: 31,
  isActive: true,
  credentialType: 'api_key',
  providerVerifiedAt: new Date(),
  encryptionVersion: 'v1',
  encryptionKeyId: 'qa-key-id',
  encryptedAt: new Date(),
  apiSecret: 'sealed:provider-auth-key',
  accountIdentifier: 'ABCDEF',
  sessionData: {
    senderId: 'ABCDEF',
    flowId: 'FLOW-42',
    messageVariable: 'proposal_message',
    ...sessionData,
  },
});

describe('MSG91 outbound provider contract', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    findByUserAndPlatform.mockReset().mockResolvedValue(credential());
    findActiveAccountByIdentifier.mockReset().mockResolvedValue(credential());
    suppressionQuery.mockReset().mockResolvedValue({ rows: [] });
    updateAccount.mockReset().mockResolvedValue(undefined);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ type: 'success', message: 'provider-request-1' }));
  });

  it('runs the final callback after credential preparation and before provider fetch', async () => {
    const beforeProvider = jest.fn<() => Promise<void>>().mockImplementation(async () => {
      expect(findByUserAndPlatform).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    expect(await sendSMS(9, '+14155550100', 'Customer update', undefined, undefined, { beforeProvider }))
      .toMatchObject({ success: true, deliveryAttempted: true });
    expect(beforeProvider).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(suppressionQuery).toHaveBeenCalledTimes(1);
  });

  it('propagates the original final-check failure without a provider effect', async () => {
    const invalidated = new Error('Synthetic final provenance invalidation');
    await expect(sendSMS(9, '+14155550100', 'Customer update', undefined, undefined, {
      beforeProvider: async () => { throw invalidated; },
    })).rejects.toBe(invalidated);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(updateAccount).not.toHaveBeenCalled();
  });

  it('keeps actual recipient suppression ahead of credential preparation and the callback', async () => {
    suppressionQuery.mockResolvedValueOnce({ rows: [{ destination: '14155550100' }] });
    const beforeProvider = jest.fn<() => Promise<void>>();
    expect(await sendSMS(9, '+14155550100', 'Customer update', undefined, undefined, { beforeProvider }))
      .toMatchObject({ success: false, deliveryAttempted: false, outcomeUncertain: false });
    expect(suppressionQuery).toHaveBeenCalledTimes(1);
    expect(findByUserAndPlatform).not.toHaveBeenCalled();
    expect(beforeProvider).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('uses the official Flow API shape and exact configured message variable', async () => {
    const result = await sendSMS(9, '+1 (415) 555-0100', 'Review proposal https://example.test/p/1', undefined, 'ABCDEF');

    expect(result).toEqual({
      success: true,
      messageId: 'provider-request-1',
      deliveryAttempted: true,
      outcomeUncertain: false,
    });
    expect(findActiveAccountByIdentifier).toHaveBeenCalledWith(9, 'msg91_sms', 'ABCDEF');
    expect(globalThis.fetch).toHaveBeenCalledWith('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: 'provider-auth-key', accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: 'FLOW-42',
        short_url: '0',
        recipients: [{
          mobiles: '14155550100',
          proposal_message: 'Review proposal https://example.test/p/1',
        }],
      }),
      signal: expect.any(AbortSignal),
      redirect: 'error',
    });
    expect(updateAccount).toHaveBeenCalledWith(9, 'msg91_sms', 31, { lastUsedAt: expect.any(Date) });
  });

  it('does not call the provider when the required Template ID is missing', async () => {
    findByUserAndPlatform.mockResolvedValueOnce(credential({ flowId: undefined }));
    const result = await sendSMS(9, '+14155550100', 'Review proposal');

    expect(result).toMatchObject({ success: false, deliveryAttempted: false });
    expect(result.error).toContain('Template ID');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('marks a network failure after dispatch begins as an uncertain outcome', async () => {
    jest.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('socket closed'));
    const result = await sendSMS(9, '+14155550100', 'Review proposal');

    expect(result).toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: true });
  });

  it.each(['+1 (415) 555-0100', '9198765432', '9876543210'])('normalizes %s without mistaking an Indian local prefix for the country code', async phone => {
    await sendSMS(9, phone, 'Customer update');
    const options = jest.mocked(globalThis.fetch).mock.calls[0][1];
    const expected = phone.startsWith('+') ? '14155550100' : `91${phone}`;
    expect(JSON.parse(options?.body as string).recipients[0].mobiles).toBe(expected);
  });

  it.each(['invalid-number', '123', '+000000000', '91+9876543210'])('rejects invalid phone %s before attempting delivery', async phone => {
    const result = await sendSMS(9, phone, 'Customer update');
    expect(result).toMatchObject({ success: false, deliveryAttempted: false, outcomeUncertain: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([{ isActive: false }, { providerVerifiedAt: null }, { encryptionVersion: null }, { readinessErrorCode: 'MSG91_AUTH_FAILED' }])('blocks SMS for unready credentials: %j', async changes => {
    findByUserAndPlatform.mockResolvedValueOnce({ ...credential(), ...changes });
    expect(await sendSMS(9, '+14155550100', 'Customer update')).toMatchObject({ success: false, deliveryAttempted: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not fall back to a different account when the bound sender is disconnected', async () => {
    findActiveAccountByIdentifier.mockResolvedValueOnce(null);
    const result = await sendSMS(9, '+14155550100', 'Customer update', undefined, 'ABCDEF');
    expect(result).toMatchObject({ success: false, deliveryAttempted: false });
    expect(findByUserAndPlatform).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('preserves confirmed delivery when last-used bookkeeping fails', async () => {
    updateAccount.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await sendSMS(9, '+14155550100', 'Customer update')).toMatchObject({ success: true, messageId: 'provider-request-1', outcomeUncertain: false });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('requires a provider receipt before declaring a send successful', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ type: 'success' }));
    expect(await sendSMS(9, '+14155550100', 'Customer update')).toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: true });
  });

  it('distinguishes known provider rejections from uncertain transport outcomes', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ type: 'error', message: 'Template rejected' }));
    expect(await sendSMS(9, '+14155550100', 'Customer update')).toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: false });
  });

  it('marks non-JSON server failures as uncertain and never returns provider secrets', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('provider-auth-key: upstream failure', { status: 502 }));
    const result = await sendSMS(9, '+14155550100', 'Customer update');
    expect(result).toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: true });
    expect(JSON.stringify(result)).not.toContain('provider-auth-key');
  });
});
