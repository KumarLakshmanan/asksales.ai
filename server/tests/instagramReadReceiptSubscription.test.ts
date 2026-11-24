import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: jest.fn() }));
jest.unstable_mockModule('../utils/metaApiVersion.js', () => ({ getGraphApiVersion: async () => 'v23.0' }));
const { subscribeInstagramLoginAccount } = await import('../services/integrations/InstagramLogin.js');

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fieldsSent = (spy: jest.SpiedFunction<typeof fetch>) =>
  spy.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)).get('subscribed_fields'));

afterEach(() => { jest.restoreAllMocks(); });

describe('Instagram Login webhook subscription', () => {
  it('asks for read receipts along with messages', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, { success: true }));
    await subscribeInstagramLoginAccount('ig-user', 'token', []);
    expect(fieldsSent(spy)).toEqual(['messages,messaging_postbacks,messaging_seen']);
  });

  it('still connects messaging when Meta refuses the read-receipt field', async () => {
    const spy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(400, { error: { message: 'Invalid parameter: messaging_seen' } }))
      .mockResolvedValueOnce(reply(200, { success: true }));
    await subscribeInstagramLoginAccount('ig-user', 'token', ['instagram_business_manage_comments']);
    expect(fieldsSent(spy)).toEqual(['messages,messaging_postbacks,comments,messaging_seen', 'messages,messaging_postbacks,comments']);
  });

  it('fails the connection when messaging itself cannot be enabled', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(400, { error: { message: 'Permission denied' } }));
    await expect(subscribeInstagramLoginAccount('ig-user', 'token', [])).rejects.toThrow('Permission denied');
  });
});
