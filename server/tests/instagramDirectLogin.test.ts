/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { AUTH_COOKIES } from '../utils/authCookies.js';

process.env.CLIENT_URL = 'http://localhost:3000';
const browserSession = 'synthetic-instagram-browser-session';
const scope = { userId: 42, actorUserId: 42, businessProfileId: 17, role: 'owner' as const };
const resolveScope = jest.fn<any>();

const admin = jest.fn<any>();
const store = jest.fn<any>();
const upsert = jest.fn<any>();
const webhook = jest.fn<any>();
const verification = jest.fn<any>();
const nonces = new Map<string, string>();
jest.unstable_mockModule('../models/adminApiCredentials/functions', () => ({ getActiveAdminCredential: admin }));
jest.unstable_mockModule('../models/db', () => ({ db: {} }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({
  set: async (key: string, value: string) => { nonces.set(key, value); },
  get: async (key: string) => nonces.get(key) || null,
  getdel: async (key: string) => { const value = nonces.get(key); nonces.delete(key); return value; },
  eval: async (_script: string, _count: number, key: string, expected?: string) => {
    const value = nonces.get(key);
    if (expected !== undefined && value !== expected) return null;
    nonces.delete(key);
    return value || null;
  },
}) }));
// Exercise the real browser/business-scope middleware; only external identity/storage are fixtures.
jest.unstable_mockModule('../tenancy/businessScopeResolver.js', () => ({ resolveBusinessScope: resolveScope }));
jest.unstable_mockModule('../utils/jwt.js', () => ({
  verifyToken: (session: string) => session === browserSession ? { userId: 42 } : null,
  isTokenRevoked: async () => false,
}));
jest.unstable_mockModule('../models/users/functions.js', () => ({ getUserById: async () => ({ id: 42 }) }));
jest.unstable_mockModule('../services/instagramGraphApiService', () => ({ storeInstagramApiCredentials: store, getInstagramApiForUser: jest.fn() }));
jest.unstable_mockModule('../services/instagramAccountSelectionService.js', () => ({ resolveInstagramAccountContext: jest.fn() }));
jest.unstable_mockModule('../models/metaPageConnections/functions', () => ({ upsertMetaPageConnection: upsert, updateWebhookStatus: webhook, disconnectInstagramForUser: jest.fn() }));
jest.unstable_mockModule('../services/integrations/ProviderVerificationService.js', () => ({ verifyProviderIntegration: verification, providerVerificationRequiresReconnect: () => false }));
jest.unstable_mockModule('../utils/metaApiVersion.js', () => ({ getGraphApiVersion: async () => 'v25.0', getOAuthBaseUrl: () => 'https://api.example.test' }));
jest.unstable_mockModule('../utils/integrationUrls.js', () => ({ getIntegrationOAuthCallbackUrl: () => 'https://api.example.test/api/instagram/oauth/callback' }));
jest.unstable_mockModule('../utils/metaCredentialSecrets.js', () => ({ encryptMetaSecret: (value: string) => `encrypted:${value}`, metaSessionMetadata: () => ({}) }));
const router = (await import('../controllers/instagramOAuthController')).default;
const { refreshInstagramLoginToken, getInstagramLoginApp, getInstagramWebhookSigningSecrets } = await import('../services/integrations/InstagramLogin.js');
const app = express();
app.use((req, _res, next) => {
  (req as any).user = { id: 42, role: 'user' };
  req.headers.authorization = `Bearer ${browserSession}`;
  if (req.path === '/callback') return next();
  return withBusinessScope(scope, next);
});
app.use(router);
let fetchSpy: ReturnType<typeof jest.spyOn>;
let grantMessages = true;
let grantInsights = false;
let subscribe = true;

beforeEach(() => {
  jest.clearAllMocks(); nonces.clear(); grantMessages = true; grantInsights = false; subscribe = true;
  resolveScope.mockResolvedValue(scope);
  admin.mockImplementation(async (platform: string) => platform === 'meta_app' ? {
    apiKey: 'parent-app', apiSecret: 'parent-secret',
    config: { instagramAppId: 'ig-app', instagramAppSecret: 'ig-secret', directInstagramLoginEnabled: false },
  } : null);
  store.mockResolvedValue(true); upsert.mockResolvedValue({ id: 71 }); webhook.mockResolvedValue(undefined); verification.mockResolvedValue({});
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.instagram.com') return Response.json({ data: [{ access_token: 'short-token', user_id: 'ig-user',
      permissions: ['instagram_business_basic', ...(grantMessages ? ['instagram_business_manage_messages'] : []),
        ...(grantInsights ? ['instagram_business_manage_insights'] : [])].join(',') }] });
    if (url.pathname === '/access_token') return Response.json({ access_token: 'long-token', expires_in: 5184000 });
    if (url.pathname.endsWith('/me')) return Response.json({ id: 'app-scoped-id', user_id: 'ig-user', username: 'orchid', name: 'Orchid Studio', account_type: 'BUSINESS' });
    if (url.pathname.endsWith('/subscribed_apps') && init?.method === 'POST') return Response.json({ success: subscribe });
    throw new Error(`Unexpected test request: ${url.hostname}${url.pathname}`);
  });
});
afterEach(() => fetchSpy.mockRestore());

function callbackCookies(start: request.Response) {
  const cookies = start.headers['set-cookie'] as unknown as string[];
  return [`${AUTH_COOKIES.user}=${browserSession}`, ...cookies.map(cookie => cookie.split(';')[0])];
}

async function connect() {
  const start = await request(app).get('/authorize?format=json');
  const url = new URL(start.body.url);
  const response = await request(app).get('/callback').set('Cookie', callbackCookies(start)).query({ state: url.searchParams.get('state'), code: 'auth-code' });
  return { url, response, cookies: callbackCookies(start) };
}

describe('direct Instagram Login', () => {
  it('uses the Instagram product credentials and connects an ordinary user without requesting Facebook Pages', async () => {
    const { url, response } = await connect();
    expect(url.hostname).toBe('www.instagram.com');
    expect(url.searchParams.get('client_id')).toBe('ig-app');
    expect(url.searchParams.get('enable_fb_login')).toBe('0');
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_manage_messages');
    expect(new URL(response.headers.location).searchParams.get('instagram_api_connected')).toBe('true');
    expect(store).toHaveBeenCalledWith(42, expect.objectContaining({ instagramAccountId: 'ig-user', pageId: '', useInstagramLogin: true,
      grantedScopes: ['instagram_business_basic', 'instagram_business_manage_messages'] }));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ pageId: 'ig-user', facebookActive: false, instagramActive: true, userAccessToken: 'encrypted:long-token' }));
    expect(webhook).toHaveBeenCalledWith(71, true);
    const subscription = fetchSpy.mock.calls.find(([input, init]: [unknown, any]) =>
      new URL(String(input)).pathname.endsWith('/subscribed_apps') && init?.method === 'POST')!;
    expect(new URLSearchParams(String(subscription[1]?.body)).get('subscribed_fields')).toBe('messages,messaging_postbacks,messaging_seen');
    expect(verification).toHaveBeenCalledWith(42, 'instagram');
    expect(fetchSpy.mock.calls.every(([input]: [unknown]) => !String(input).includes('graph.facebook.com'))).toBe(true);
    expect(fetchSpy.mock.calls.every(([input]: [unknown]) => !String(input).includes('/me/permissions'))).toBe(true);
    const exchange = fetchSpy.mock.calls.find(([input]: [unknown]) => new URL(String(input)).pathname === '/access_token')!;
    expect(exchange[1]?.method || 'GET').toBe('GET');
    expect(new URL(String(exchange[0])).searchParams.get('grant_type')).toBe('ig_exchange_token');
  });
  it('records partial consent without subscribing or inventing messaging permission', async () => {
    grantMessages = false;
    await connect();
    expect(store).toHaveBeenCalledWith(42, expect.objectContaining({ grantedScopes: ['instagram_business_basic'], declinedScopes: ['instagram_business_manage_messages'] }));
    expect(webhook).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ webhookSubscribed: false }));
  });
  it('requests tester insights separately and returns to Social Insights after consent', async () => {
    grantInsights = true;
    admin.mockImplementation(async (platform: string) => platform === 'meta_app' ? {
      apiKey: 'parent-app', apiSecret: 'parent-secret',
      config: { instagramAppId: 'ig-app', instagramAppSecret: 'ig-secret',
        appReviewPermissions: { instagram_business_manage_insights: 'testing' } },
    } : null);
    const start = await request(app).get('/authorize?format=json&feature=instagram_manage_insights');
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_insights');
    const callback = await request(app).get('/callback').set('Cookie', callbackCookies(start)).query({ state: url.searchParams.get('state'), code: 'auth-code' });
    expect(callback.headers.location).toBe('http://localhost:3000/dashboard/marketing/analytics?platform=instagram');
    expect(store).toHaveBeenCalledWith(42, expect.objectContaining({ grantedScopes: expect.arrayContaining(['instagram_business_manage_insights']) }));
  });
  it('keeps a failed subscription unready and rejects replayed callbacks', async () => {
    subscribe = false;
    const { url, cookies } = await connect();
    expect(webhook).toHaveBeenCalledWith(71, false);
    const count = fetchSpy.mock.calls.length;
    const replay = await request(app).get('/callback').set('Cookie', cookies).query({ state: url.searchParams.get('state'), code: 'auth-code' });
    expect(new URL(replay.headers.location).searchParams.get('error')).toMatch(/invalid|already/);
    expect(fetchSpy).toHaveBeenCalledTimes(count);
  });
  it('rejects missing browser cookies before provider exchange or credential writes', async () => {
    const start = await request(app).get('/authorize?format=json');
    const url = new URL(start.body.url);
    const response = await request(app).get('/callback').query({ state: url.searchParams.get('state'), code: 'auth-code' });
    expect(new URL(response.headers.location).searchParams.get('error')).toBe('session_changed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
  it('rejects revoked business permission before provider exchange or credential writes', async () => {
    const start = await request(app).get('/authorize?format=json');
    const url = new URL(start.body.url);
    resolveScope.mockResolvedValue(null);
    const response = await request(app).get('/callback').set('Cookie', callbackCookies(start)).query({ state: url.searchParams.get('state'), code: 'auth-code' });
    expect(new URL(response.headers.location).searchParams.get('error')).toBe('permission_changed');
    expect(resolveScope).toHaveBeenCalledWith(42, 17);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
  it('never substitutes the parent Facebook App ID when Instagram configuration is absent', async () => {
    admin.mockImplementation(async (platform: string) => platform === 'meta_app' ? { apiKey: 'parent-app', apiSecret: 'parent-secret', config: {} } : null);
    expect(await getInstagramLoginApp()).toBeNull();
    const response = await request(app).get('/authorize?format=json');
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/Instagram App ID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('uses only configured deployment signing secrets for Instagram webhooks', async () => {
    expect(await getInstagramWebhookSigningSecrets()).toEqual(['parent-secret', 'ig-secret']);
    admin.mockResolvedValue(null);
    expect(await getInstagramWebhookSigningSecrets()).toEqual([]);
  });
  it('refreshes existing Instagram tokens through the refresh endpoint, without Facebook exchange', async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ access_token: 'refreshed', expires_in: 5184000 }));
    expect(await refreshInstagramLoginToken('long-token')).toEqual({ accessToken: 'refreshed', expiresIn: 5184000 });
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://graph.instagram.com/refresh_access_token');
    expect(url.searchParams.get('grant_type')).toBe('ig_refresh_token');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
});
