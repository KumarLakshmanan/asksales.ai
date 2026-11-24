/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const execute = jest.fn<any>();

jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers.js');
const {
  getAdminWebhookLogs,
  getIntegrationWebhookEvents,
  getIntegrationWebhookStats,
} = await import('../controllers/integrationWebhookLogsController.js');

describe('integration webhook log tenant boundaries', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ rows: [] });
  });

  it('requires an authenticated tenant before querying webhook events', async () => {
    const req = mockRequest({ params: { platform: 'instagram' }, query: {} });
    const res = mockResponse();

    await getIntegrationWebhookEvents(req, res);

    expect(res._status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('scopes Instagram events to the current user and excludes other social channels', async () => {
    const req = mockAuthRequest(42, { params: { platform: 'instagram' }, query: {} });
    const res = mockResponse();

    await getIntegrationWebhookEvents(req, res);

    expect(res._status).toBe(200);
    const query = JSON.stringify(execute.mock.calls[0][0]);
    expect(query).toContain('user_id = ');
    expect(query).toContain('42');
    expect(query).toContain('twitter%');
    expect(query).toContain('linkedin%');
    expect(query).toContain('instagram_webhook_events');
    expect(query).toContain('webhook_events');
    expect(query).toContain('meta_page_connections');
    expect(query).not.toContain('user_id IS NULL');
  });

  it.each(['twitter', 'linkedin'])('loads %s events from the shared social event store', async (platform) => {
    const req = mockAuthRequest(7, { params: { platform }, query: { limit: '5000', offset: '-9' } });
    const res = mockResponse();

    await getIntegrationWebhookEvents(req, res);

    expect(res._status).toBe(200);
    const query = JSON.stringify(execute.mock.calls[0][0]);
    expect(query).toContain(`${platform}%`);
    expect(query).toContain('7');
    expect(query).toContain('200');
    expect(query).not.toContain('user_id IS NULL');
  });

  it('loads legacy Facebook Page events only through an active connection owned by the user', async () => {
    const req = mockAuthRequest(19, { params: { platform: 'facebook' }, query: {} });
    const res = mockResponse();

    await getIntegrationWebhookEvents(req, res);

    expect(res._status).toBe(200);
    const query = JSON.stringify(execute.mock.calls[0][0]);
    expect(query).toContain('facebook%');
    expect(query).toContain('user_id IS NULL');
    expect(query).toContain('meta_page_connections');
    expect(query).toContain('facebook_active = TRUE');
    expect(query).toContain('facebook_api');
    expect(query).toContain('19');
  });

  it('scopes statistics to the authenticated user', async () => {
    const req = mockAuthRequest(13, { params: { platform: 'whatsapp' }, query: {} });
    const res = mockResponse();

    await getIntegrationWebhookStats(req, res);

    expect(res._status).toBe(200);
    const query = JSON.stringify(execute.mock.calls[0][0]);
    expect(query).toContain('13');
    expect(query).not.toContain('user_id IS NULL');
  });

  it('loads MSG91 callback events and statistics from the tenant-owned event store', async () => {
    const req = mockAuthRequest(13, { params: { platform: 'msg91' }, query: {} });
    const res = mockResponse();
    await getIntegrationWebhookEvents(req, res);
    await getIntegrationWebhookStats(req, res);
    expect(res._status).toBe(200);
    for (const [query] of execute.mock.calls) {
      const serialized = JSON.stringify(query);
      expect(serialized).toContain('webhook_events');
      expect(serialized).toContain('msg91');
      expect(serialized).toContain('user_id = ');
      expect(serialized).toContain('13');
      expect(serialized).not.toContain('user_id IS NULL');
    }
  });

  it('rejects an invalid admin user filter instead of returning unscoped data', async () => {
    const req = mockRequest({ query: { userId: 'not-a-user' } });
    const res = mockResponse();

    await getAdminWebhookLogs(req, res);

    expect(res._status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});
