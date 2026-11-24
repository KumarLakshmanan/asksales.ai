import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { currentBusinessScope, currentDatabaseScope, withBusinessScope } from '../tenancy/businessContext.js';
import { currentVerifiedWebhookCapability, issueWebhookCapability } from '../utils/userWebhookTokens.js';
const execute = jest.fn<(query: SQL) => Promise<{ rows: Array<Record<string, unknown>> }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { businessWebhookScope } = await import('../middleware/businessWebhookScope.js');
const app = express();
app.post('/api/webhooks/:purpose/:userToken/:callbackType?', businessWebhookScope, (req, res) => {
  const purpose = req.params.callbackType === 'delivery' ? 'sms_delivery' : req.params.purpose as 'sms';
  const authority = currentVerifiedWebhookCapability(req.params.userToken, purpose);
  res.json({ userId: authority?.userId, businessProfileId: currentBusinessScope()?.businessProfileId });
});
beforeEach(() => { execute.mockReset().mockResolvedValue({ rows: [{ id: 7, user_id: 42, webhook_token_nonce: 'owner-nonce' }] }); });
describe('purpose-bound webhook public route authority', () => {
  it('resolves only the signed owner/profile, then establishes separate callback authority', async () => {
    execute.mockImplementationOnce(async query => {
      expect(currentDatabaseScope()?.kind).toBe('system');
      const sql = new PgDialect().sqlToQuery(query);
      expect(sql.params).toEqual([7, 42]);
      expect(sql.sql).toContain('LIMIT 1');
      return { rows: [{ id: 7, user_id: 42, webhook_token_nonce: 'owner-nonce' }] };
    });
    const token = issueWebhookCapability(42, 'owner-nonce', 'sms', 7);
    const result = await request(app).post(`/api/webhooks/sms/${token}`).expect(200);
    expect(result.body).toEqual({ userId: 42, businessProfileId: 7 });
    expect(currentVerifiedWebhookCapability(token, 'sms')).toBeUndefined();
  });
  it('rejects replay across purposes before any database lookup', async () => {
    const token = issueWebhookCapability(42, 'owner-nonce', 'sms', 7);
    await request(app).post(`/api/webhooks/leads/${token}`).expect(403);
    await request(app).post(`/api/webhooks/sms/${token}/delivery`).expect(403);
    expect(execute).not.toHaveBeenCalled();
  });
  it('accepts a separate delivery capability and rejects rotated credentials', async () => {
    const token = issueWebhookCapability(42, 'owner-nonce', 'sms_delivery', 7);
    await request(app).post(`/api/webhooks/sms/${token}/delivery`).expect(200);
    await request(app).post(`/api/webhooks/sms/${issueWebhookCapability(42, 'stolen-old-nonce', 'sms', 7)}`).expect(403);
    await request(app).post(`/api/webhooks/sms/${'a'.repeat(32)}`).expect(403);
  });
  it('rejects expired capabilities and mismatched persisted ownership', async () => {
    const expired = issueWebhookCapability(42, 'owner-nonce', 'sms', 7, Math.floor(Date.now() / 1000) - 91 * 86400);
    await request(app).post(`/api/webhooks/sms/${expired}`).expect(403);
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ rows: [{ id: 8, user_id: 99, webhook_token_nonce: 'owner-nonce' }] });
    await request(app).post(`/api/webhooks/sms/${issueWebhookCapability(42, 'owner-nonce', 'sms', 7)}`).expect(403);
  });
  it('does not treat an authenticated tenant scope as verified webhook authority', () => {
    const token = issueWebhookCapability(42, 'owner-nonce', 'sms', 7);
    withBusinessScope({ userId: 42, businessProfileId: 7 }, () => {
      expect(currentVerifiedWebhookCapability(token, 'sms')).toBeUndefined();
    });
  });
});
