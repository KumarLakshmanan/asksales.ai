import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js', () => ({
  decryptChannelCredentialSecret: (value: string) => value.replace(/^sealed:/, ''),
  encryptChannelCredentialSecret: (value: string) => `sealed:${value}`,
  getChannelCredentialEncryptionKeyId: () => 'qa-key',
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { TwitterApiService } = await import('../services/TwitterApiService.js');
const { LinkedInApiService } = await import('../services/LinkedInApiService.js');

function initialize<T extends object>(service: T, credentials: Record<string, unknown>): T {
  (service as T & { credentials: Record<string, unknown> }).credentials = credentials;
  return service;
}

describe('official social message provider contracts', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('sends an X DM through the current v2 endpoint and requires its event receipt', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { dm_conversation_id: 'conversation-1', dm_event_id: 'dm-event-1' },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const service = initialize(new TwitterApiService(), { accessToken: 'twitter-user-token' });

    await expect(service.sendMessage('customer-user-id', 'Review the proposal')).resolves.toEqual({
      success: true,
      dmEventId: 'dm-event-1',
      deliveryAttempted: true,
      outcomeUncertain: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.x.com/2/dm_conversations/with/customer-user-id/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer twitter-user-token',
        },
        body: JSON.stringify({ text: 'Review the proposal' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('treats an X transport failure after dispatch starts as uncertain', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket closed'));
    const service = initialize(new TwitterApiService(), { accessToken: 'twitter-user-token' });

    await expect(service.sendMessage('customer-user-id', 'Review')).resolves.toMatchObject({
      success: false,
      deliveryAttempted: true,
      outcomeUncertain: true,
    });
  });

  it('uses LinkedIn x-linkedin-id as the authoritative receipt for an empty 201 response', async () => {
    const providerReceipt = '{thread=urn:li:messagingThread:thread-1, id=message-1}';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 201,
      headers: { 'x-linkedin-id': providerReceipt },
    }));
    const service = initialize(new LinkedInApiService(), {
      accessToken: 'linkedin-user-token',
      apiVersion: '202603',
    });

    await expect(service.sendMessage('urn:li:person:customer', 'Review the proposal')).resolves.toEqual({
      success: true,
      messageId: providerReceipt,
      deliveryAttempted: true,
      outcomeUncertain: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.linkedin.com/v2/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer linkedin-user-token',
          'LinkedIn-Version': '202603',
        },
        body: JSON.stringify({
          recipients: ['urn:li:person:customer'],
          body: 'Review the proposal',
          messageType: 'MEMBER_TO_MEMBER',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('distinguishes a LinkedIn rejection from a transport-uncertain request', async () => {
    const service = initialize(new LinkedInApiService(), { accessToken: 'linkedin-user-token' });
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Not allowed' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(service.sendMessage('urn:li:person:customer', 'Review')).resolves.toMatchObject({
      success: false,
      deliveryAttempted: true,
      outcomeUncertain: false,
    });

    jest.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.sendMessage('urn:li:person:customer', 'Review')).resolves.toMatchObject({
      success: false,
      deliveryAttempted: true,
      outcomeUncertain: true,
    });
  });
});
