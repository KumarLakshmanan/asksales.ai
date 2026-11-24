import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
// Transport tests assume readiness; socialCustomerDeliveryBoundary exercises the real gate.
jest.unstable_mockModule('../services/assistants/CustomerDeliveryGate.js', () => ({
  assertCustomerDeliveryReady: async () => ({}), assertCustomerDeliveryRuntime: () => {},
  deliverySetupFailure: () => undefined, CustomerDeliverySetupError: class extends Error {},
}));

jest.unstable_mockModule('../models/db', () => ({ db: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: jest.fn() }));
jest.unstable_mockModule('../services/credentialService', () => ({ getCredential: jest.fn() }));
jest.unstable_mockModule('../utils/metaApiVersion.js', () => ({ getGraphApiVersion: async () => 'v25.0', getGraphApiBase: () => 'https://graph.facebook.com/v25.0' }));
jest.unstable_mockModule('../services/instagramAccountSelectionService.js', () => ({ resolveInstagramAccountContext: jest.fn() }));
const { FacebookMessengerService } = await import('../services/FacebookMessengerService.js');
const { InstagramGraphApiService } = await import('../services/instagramGraphApiService.js');
const fetchMock = jest.fn<typeof fetch>();
const realFetch = globalThis.fetch;
beforeEach(() => { fetchMock.mockReset(); globalThis.fetch = fetchMock; });
afterEach(() => { globalThis.fetch = realFetch; jest.restoreAllMocks(); });
function facebook() {
  const service = new FacebookMessengerService();
  (service as any).credentials = { pageId: 'page', accessToken: 'test-only-token' };
  return service;
}
function instagram() {
  const service = new InstagramGraphApiService();
  service.setCredentials({ pageId: 'page', instagramAccountId: 'ig', accessToken: 'test-only-token', pageAccessToken: 'test-only-page-token' });
  return service;
}
function response(status: number, body: unknown) { return new Response(JSON.stringify(body), { status }); }
describe('Meta attachment transport safety', () => {
  it('sends direct Instagram messages through the Instagram account host and token', async () => {
    fetchMock.mockResolvedValue(response(200, { message_id: 'ack', recipient_id: 'recipient' }));
    const service = new InstagramGraphApiService();
    service.setCredentials({ pageId: 'ig-user', instagramAccountId: 'ig-user', accessToken: 'direct-token', useInstagramLogin: true });
    expect(await service.sendMessage('recipient', 'Hello')).toMatchObject({ success: true, messageId: 'ack' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://graph.instagram.com/v25.0/ig-user/messages');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer direct-token' });
  });
  it('sends only an attachment and preserves the provider acknowledgement', async () => {
    fetchMock.mockResolvedValue(response(200, { message_id: 'ack', recipient_id: 'recipient' }));
    expect(await facebook().sendMessageWithAttachment('recipient', 'image', 'https://example.com/signed.jpg', 'caption'))
      .toMatchObject({ success: true, messageId: 'ack', outcomeUncertain: false });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).message).toEqual({ attachment: { type: 'image', payload: { url: 'https://example.com/signed.jpg', is_reusable: false } } });
  });
  it.each([200, 502])('treats unacknowledged Facebook HTTP %s as uncertain', async (status) => {
    fetchMock.mockResolvedValue(response(status, {}));
    expect(await facebook().sendMessageWithAttachment('recipient', 'image', 'https://example.com/image.jpg'))
      .toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('preserves explicit Facebook rejection codes', async () => {
    fetchMock.mockResolvedValue(response(400, { error: { message: 'Invalid token', code: 190 } }));
    expect(await facebook().sendMessageWithAttachment('recipient', 'image', 'https://example.com/image.jpg'))
      .toMatchObject({ success: false, errorCode: 'META_GRAPH_190', outcomeUncertain: false });
  });
  it.each([{}, { unexpected: true }])('never falls through to another Instagram transport without a message acknowledgement', async (body) => {
    fetchMock.mockResolvedValue(response(200, body));
    expect(await instagram().sendMessageWithAttachment('recipient', 'image', 'https://example.com/image.jpg'))
      .toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('treats an unstructured Instagram gateway rejection as uncertain', async () => {
    fetchMock.mockResolvedValue(response(502, {}));
    expect(await instagram().sendMessageWithAttachment('recipient', 'image', 'https://example.com/image.jpg'))
      .toMatchObject({ success: false, outcomeUncertain: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('allows the alternate Instagram transport only after a confirmed rejection', async () => {
    fetchMock.mockResolvedValueOnce(response(400, { error: { message: 'Unsupported route', code: 100 } }))
      .mockResolvedValueOnce(response(200, { message_id: 'ack' }));
    expect(await instagram().sendMessageWithAttachment('recipient', 'image', 'https://example.com/image.jpg'))
      .toMatchObject({ success: true, messageId: 'ack' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('graph.instagram.com');
  });
  it('does not swallow an ambiguous send after token refresh and send again on another transport', async () => {
    const service = instagram();
    jest.spyOn(service as any, 'refreshAccessToken').mockResolvedValue(true);
    fetchMock.mockResolvedValueOnce(response(401, { error: { message: 'Expired', code: 190 } })).mockRejectedValueOnce(new Error('Connection reset after dispatch'));
    expect(await service.sendMessageWithAttachment('recipient', 'image', 'https://example.com/image.jpg'))
      .toMatchObject({ success: false, outcomeUncertain: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
