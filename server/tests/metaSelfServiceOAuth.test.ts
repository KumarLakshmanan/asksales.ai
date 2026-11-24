import { withBusinessScope } from '../tenancy/businessContext.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const adminCredential = jest.fn<any>();
const accountContext = jest.fn<any>();
const selectedCredential = jest.fn<any>();
const webhookOwner = jest.fn<any>();
jest.unstable_mockModule('../services/instagramAccountSelectionService.js', () => ({ resolveInstagramAccountContext: accountContext }));
jest.unstable_mockModule('../models/channelCredentials/functions', () => ({ ChannelCredentialModel: { findByUserAndPlatform: selectedCredential } }));
jest.unstable_mockModule('../models/users/functions.js', () => ({ getUserById: webhookOwner }));
const nonceStore = new Map<string, string>();
jest.unstable_mockModule('../models/adminApiCredentials/functions', () => ({ getActiveAdminCredential: adminCredential }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({
  set: async (key: string, value: string) => { nonceStore.set(key, value); },
  getdel: async (key: string) => { const value = nonceStore.get(key); nonceStore.delete(key); return value || null; },
}) }));
jest.unstable_mockModule('../tenancy/oauthBusinessScope.js', () => ({
  rememberOAuthBusinessState: async (state: string) => state,
  oauthBusinessScope: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.unstable_mockModule('../services/OAuthBrowserFlowService.js', () => ({ beginOAuthBrowserFlow: async () => ({}), oauthBrowserCallback: () => (_req: unknown,_res: unknown,next: () => void) => next(), requireOAuthConfiguration: () => {} }));
jest.unstable_mockModule('../services/instagramGraphApiService', () => ({ storeInstagramApiCredentials: jest.fn(), getInstagramApiForUser: jest.fn() }));
jest.unstable_mockModule('../services/integrations/ProviderVerificationService.js', () => ({ verifyProviderIntegration: jest.fn(), providerVerificationRequiresReconnect: () => false }));
const instagram = (await import('../controllers/instagramOAuthController')).default;
const facebook = (await import('../controllers/facebookOAuthController')).default;
const app = express();
app.use((req, _res, next) => {
  const member = req.get('X-Audit-Role') === 'member';
  (req as any).user = { id: member ? 43 : 42, role: 'user', isApproved: true };
  return member ? withBusinessScope({ userId: 42, actorUserId: 43, businessProfileId: 420, role: 'member' }, next) : next();
});
app.use('/instagram', instagram);
app.use('/facebook', facebook);

beforeEach(() => {
  nonceStore.clear();
  jest.clearAllMocks();
  accountContext.mockResolvedValue(null);
  selectedCredential.mockResolvedValue(undefined);
  webhookOwner.mockResolvedValue({ webhookTokenNonce: 'fixture-nonce' });
  adminCredential.mockResolvedValue({ apiKey: 'shared-app', apiSecret: 'never-return-this', config: { instagramAppId: 'instagram-product', instagramAppSecret: 'instagram-secret' } });
});

describe('ordinary user Meta OAuth', () => {
  it('does not disclose Facebook URL capabilities in ordinary member status reads', async () => {
    const result = await request(app).get('/facebook/status').set('X-Audit-Role', 'member').expect(200);
    expect(result.body).toHaveProperty('officialApi');
    expect(result.body).not.toHaveProperty('webhookUrl');
    expect(result.body).not.toHaveProperty('webhookVerifyToken');
  });

  it('starts Instagram identity and shared setup reads together and reads the Meta app once', async () => {
    let started!: () => void, finish!: (value: null) => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<null>(resolve => { finish = resolve; });
    accountContext.mockImplementationOnce(() => { started(); return pending; });
    const responsePromise = request(app).get('/instagram/status').then(value => value);
    await began;
    const setupStartedBeforeIdentityFinished = adminCredential.mock.calls.length;
    finish(null);
    const response = await responsePromise;
    expect(setupStartedBeforeIdentityFinished).toBe(1);
    expect(response.status).toBe(200);
    expect(response.body.officialApi).toMatchObject({ connected: false, loginConfigured: true });
    expect(adminCredential).toHaveBeenCalledTimes(1);
  });

  it('starts Facebook owner, selected Page and review reads together', async () => {
    let started!: () => void, finish!: (value: object) => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<object>(resolve => { finish = resolve; });
    webhookOwner.mockImplementationOnce(() => { started(); return pending; });
    const responsePromise = request(app).get('/facebook/status').then(value => value);
    await began;
    const independentReads = [selectedCredential.mock.calls.length, adminCredential.mock.calls.length];
    finish({ webhookTokenNonce: 'fixture-nonce' });
    const response = await responsePromise;
    expect(independentReads).toEqual([1, 1]);
    expect(response.status).toBe(200);
    expect(response.body.officialApi.connected).toBe(false);
    expect(adminCredential).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response.body)).not.toContain('never-return-this');
  });

  it.each(['instagram', 'facebook'])('starts %s with the shared app and returns only the authorization URL', async platform => {
    const response = await request(app).get(`/${platform}/authorize?format=json`);
    expect(response.status).toBe(200);
    const url = new URL(response.body.url);
    expect(url.hostname).toBe(platform === 'instagram' ? 'www.instagram.com' : 'www.facebook.com');
    expect(url.searchParams.get('client_id')).toBe(platform === 'instagram' ? 'instagram-product' : 'shared-app');
    if (platform === 'instagram') {
      expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_manage_messages');
      expect(url.searchParams.get('enable_fb_login')).toBe('0');
    }
    const state = JSON.parse(Buffer.from(url.searchParams.get('state')!, 'base64').toString());
    expect(state.userId).toBe(42);
    expect(state.nonce.length).toBeGreaterThan(20);
    expect(JSON.stringify(response.body)).not.toContain('never-return-this');
    expect(url.searchParams.get('scope')).not.toContain('pages_manage_posts');
    expect(url.searchParams.get('scope')).not.toContain('instagram_content_publish');
  });
  it('keeps redirect callers working', async () => {
    const response = await request(app).get('/instagram/authorize');
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('https://www.instagram.com/');
  });
  it('returns an actionable configuration error before navigation', async () => {
    adminCredential.mockResolvedValue(null);
    const response = await request(app).get('/facebook/authorize?format=json');
    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/contact your administrator/i);
  });
  it('rejects arbitrary or unapproved additional scopes', async () => {
    const response = await request(app).get('/instagram/authorize?format=json&feature=business_management');
    expect(response.status).toBe(400);
  });
  it.each(['instagram', 'facebook'])('returns a denied %s consent to the corresponding integration page', async platform => {
    const response = await request(app).get(`/${platform}/callback?error=access_denied&error_description=Access%20was%20cancelled`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location);
    expect(location.pathname).toBe(`/dashboard/integrations/${platform}`);
    expect(location.searchParams.get('error')).toBe('access_denied');
  });
  it.each(['instagram', 'facebook'])('rejects a tampered %s callback before exchanging tokens', async platform => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const state = Buffer.from(JSON.stringify({ userId: 99, timestamp: Date.now(), nonce: 'not-issued' })).toString('base64');
    const response = await request(app).get(`/${platform}/callback`).query({ code: 'fake-code', state });
    expect(new URL(response.headers.location).searchParams.get('error')).toMatch(/invalid|nonce/i);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
