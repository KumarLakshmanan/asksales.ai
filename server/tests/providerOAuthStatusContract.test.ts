import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { currentBusinessScope, withBusinessScope } from '../tenancy/businessContext.js';

const query = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[][] }>>();
const owner = jest.fn<(...args: unknown[]) => Promise<{ webhookTokenNonce: string }>>();
const database = drizzle({ client: { query } as unknown as Pool });
jest.unstable_mockModule('../models/db.js', () => ({ db: database }));
jest.unstable_mockModule('../models/users/functions.js', () => ({ getUserById: owner }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { default: twitter } = await import('../controllers/twitterOAuthController.js');
const { default: linkedin } = await import('../controllers/linkedinOAuthController.js');
const { verifyWebhookCapability, webhookCapabilityVerifyToken } = await import('../utils/userWebhookTokens.js');

const scope = { userId: 9, actorUserId: 12, businessProfileId: 17, role: 'billing_admin' as const };
const app = express();
app.use((req, _res, next) => {
  if (req.header('X-Audit-Anonymous') === 'true') return next();
  req.user = { id: 12 } as typeof req.user;
  return withBusinessScope({ ...scope, role: req.header('X-Audit-Role') === 'member' ? 'member' : scope.role }, next);
});
app.use('/api/twitter/oauth', twitter);
app.use('/api/linkedin/oauth', linkedin);

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  owner.mockReset().mockResolvedValue({ webhookTokenNonce: 'synthetic-owner-nonce' });
  process.env.APP_URL = 'https://synthetic-app.example.test';
  delete process.env.API_URL;
});

const cases: Array<{ label: string; rows: unknown[][]; connected: boolean; expired?: boolean; expiresAt?: string; username?: string | null; identifier?: string | null }> = [
  { label: 'no grant', rows: [], connected: false },
  { label: 'valid OAuth grant', rows: [['oauth', true, '2099-01-01 00:00:00', 'Synthetic account', 'provider-account']], connected: true, expiresAt: '2099-01-01T00:00:00.000Z', username: 'Synthetic account', identifier: 'provider-account' },
  { label: 'expired OAuth grant', rows: [['oauth', true, '2000-01-01 00:00:00', 'Synthetic account', 'provider-account']], connected: false, expired: true, expiresAt: '2000-01-01T00:00:00.000Z', username: 'Synthetic account', identifier: 'provider-account' },
  { label: 'grant without expiry', rows: [['oauth', true, null, 'Synthetic account', 'provider-account']], connected: true, username: 'Synthetic account', identifier: 'provider-account' },
  { label: 'missing access token', rows: [['oauth', false, '2000-01-01 00:00:00', 'Synthetic account', 'provider-account']], connected: false, username: 'Synthetic account', identifier: 'provider-account' },
  { label: 'missing account identity', rows: [['oauth', true, '2000-01-01 00:00:00', 'Synthetic account', null]], connected: false, username: 'Synthetic account' },
  { label: 'manual credentials', rows: [['manual', true, '2000-01-01 00:00:00', 'Synthetic account', 'provider-account']], connected: false, username: 'Synthetic account', identifier: 'provider-account' },
  { label: 'missing account name', rows: [['oauth', true, null, '', 'provider-account']], connected: true, identifier: 'provider-account' },
];

describe.each([
  { provider: 'twitter', platform: 'twitter_api', identifierField: 'accountId', otherField: 'organizationId' },
  { provider: 'linkedin', platform: 'linkedin_api', identifierField: 'organizationId', otherField: 'accountId' },
])('$provider OAuth status contract', ({ provider, platform, identifierField, otherField }) => {
  const endpoint = `/api/${provider}/oauth/status`;

  it.each(cases)('preserves the $label response and scoped SQL read', async row => {
    query.mockImplementationOnce(async () => {
      expect(currentBusinessScope()).toMatchObject(scope);
      return { rows: row.rows };
    });
    const response = await request(app).get(endpoint).query({ userId: 99, businessProfileId: 99 });
    expect(response.status).toBe(200);
    expect(response.body.officialApi).toEqual({
      connected: row.connected,
      username: row.username ?? null,
      [identifierField]: row.identifier ?? null,
      tokenExpired: row.expired ?? false,
      expiresAt: row.expiresAt ?? null,
    });
    expect(response.body.officialApi).not.toHaveProperty(otherField);
    expect(owner).toHaveBeenCalledWith(9);
    expect(query).toHaveBeenCalledTimes(1);
    const [config, values] = query.mock.calls[0] as [{ text: string; rowMode: string }, unknown[]];
    expect(values).toEqual([9, platform, true, 1]);
    expect(config.rowMode).toBe('array');
    expect(config.text).toContain('"access_token" IS NOT NULL');
    expect(config.text).toContain('"is_active" = $3');
    const token = response.body.webhookUrl.split('/').pop();
    expect(verifyWebhookCapability(token, 'synthetic-owner-nonce', provider as 'twitter' | 'linkedin')).toMatchObject({ userId: 9, businessProfileId: 17 });
    expect(response.body.webhookVerifyToken).toBe(webhookCapabilityVerifyToken(token));
    expect(Date.parse(response.body.webhookExpiresAt)).toBeGreaterThan(Date.now());
  });

  it('retains ordinary member status without disclosing URL or verification capabilities', async () => {
    const result = await request(app).get(endpoint).set('X-Audit-Role', 'member').expect(200);
    expect(result.body).toHaveProperty('officialApi');
    expect(result.body).not.toHaveProperty('webhookUrl');
    expect(result.body).not.toHaveProperty('webhookVerifyToken');
    expect(result.body).not.toHaveProperty('webhookExpiresAt');
  });

  it('rejects an anonymous read without credential or owner access', async () => {
    const response = await request(app).get(endpoint).set('X-Audit-Anonymous', 'true');
    expect(response.status).toBe(401);
    expect(owner).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['owner', 'credentials'])('returns a generic failure when %s lookup fails', async boundary => {
    if (boundary === 'owner') owner.mockRejectedValueOnce(new Error('synthetic-private-error'));
    else query.mockRejectedValueOnce(new Error('synthetic-private-error'));
    const response = await request(app).get(endpoint);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'An unexpected error occurred. Please try again.' });
    expect(JSON.stringify(response.body)).not.toContain('synthetic-private-error');
  });

  it('retains API_URL precedence and the forwarded HTTPS fallback', async () => {
    delete process.env.APP_URL;
    process.env.API_URL = 'https://synthetic-api.example.test';
    expect((await request(app).get(endpoint)).body.webhookUrl).toMatch(/^https:\/\/synthetic-api\.example\.test\//);
    delete process.env.API_URL;
    const fallback = await request(app).get(endpoint).set('Host', 'synthetic-proxy.example.test').set('X-Forwarded-Proto', 'https');
    expect(fallback.body.webhookUrl).toMatch(/^https:\/\/synthetic-proxy\.example\.test\//);
  });
});
