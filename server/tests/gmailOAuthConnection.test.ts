/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { currentBusinessScope, withBusinessScope } from '../tenancy/businessContext.js';
import { signGmailOAuthState, verifyGmailOAuthState } from '../utils/gmailOAuthFlow.js';
const signingKey = 'synthetic-oauth-signing-key';
process.env.OAUTH_STATE_SECRET = signingKey;
process.env.APP_URL = 'https://api.example.test';
process.env.CLIENT_URL = 'https://app.example.test';
delete process.env.GMAIL_REDIRECT_URI;
delete process.env.NGROK_URL;
const verifySession = jest.fn<any>();
const sessionRevoked = jest.fn<any>();
const findUser = jest.fn<any>();
const store = new Map<string, string>();
const scope = { userId: 9, actorUserId: 12, businessProfileId: 11, role: 'billing_admin' as const };
const resolveScope = jest.fn<any>();
const admin = jest.fn<any>();
const find = jest.fn<any>();
const findMailbox = jest.fn<any>();
const findId = jest.fn<any>();
const upsert = jest.fn<any>();
const updateAll = jest.fn<any>();
const where = jest.fn<any>();
const set = jest.fn<any>();
const execute = jest.fn<any>();
const getToken = jest.fn<any>();
const getTokenInfo = jest.fn<any>();
const getProfile = jest.fn<any>();
const getPerson = jest.fn<any>();
const watch = jest.fn<any>();
const refresh = jest.fn<any>();
const persistWatch = jest.fn<any>();
const senderCreate = jest.fn<any>();
const setDefault = jest.fn<any>();
const findSender = jest.fn<any>();
const clientConstruction = jest.fn<any>();
const logger = { info: jest.fn<any>(), warn: jest.fn<any>(), error: jest.fn<any>() };
jest.unstable_mockModule('../utils/jwt.js', () => ({ verifyToken: verifySession, isTokenRevoked: sessionRevoked }));
jest.unstable_mockModule('../models/users/functions.js', () => ({ getUserById: findUser }));
const fixtureDb: any = { execute, select: () => ({ from: () => ({ where: () => ({ limit: () => {
  const result = Promise.resolve([credential()]); return Object.assign(result, { for: async () => [credential()] });
} }) }) }), update: () => ({ set: (updates: any) => { set(updates); return { where }; } }) };
fixtureDb.transaction = async (work: any) => work(fixtureDb);
jest.unstable_mockModule('../models/db.js', () => ({ db: fixtureDb }));
jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({ ChannelCredentialModel: {
  findByUserAndPlatform: find, findActiveAccountByIdentifier: findMailbox, findActiveAccountById: findId, upsert, update: updateAll,
} }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: admin }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({
  set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
  get: async (key: string) => store.get(key) || null,
  eval: async (_script: string, _count: number, key: string) => { const value = store.get(key); store.delete(key); return value || null; },
}) }));
jest.unstable_mockModule('../tenancy/businessScopeResolver.js', () => ({ resolveBusinessScope: resolveScope }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger }));
jest.unstable_mockModule('../services/GmailWatchService.js', () => ({ persistGmailWatch: persistWatch, persistGmailWatchFailure: jest.fn<any>().mockResolvedValue(undefined) }));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js', () => ({
  getChannelCredentialEncryptionKeyId: () => 'fixture-key',
  decryptChannelCredentialSecret: (value: string) => value?.replace(/^encrypted:/, '') || '',
  decryptChannelCredentialSession: (value: unknown) => value,
  encryptChannelCredentialSecret: (value: string) => value ? `encrypted:${value}` : value,
  encryptChannelCredentialSession: (value: unknown) => value,
}));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({
  findByCredential: findSender, findByEmailAndType: findSender, create: senderCreate, update: senderCreate, setDefault,
}));
jest.unstable_mockModule('googleapis', () => ({ google: {
  auth: { OAuth2: class {
    transporter = { interceptors: { request: { add: jest.fn() } } };
    constructor(...args: any[]) { clientConstruction(...args); }
    generateAuthUrl(options: any) { return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ state: options.state, scope: options.scope.join(' '), access_type: options.access_type, prompt: options.prompt, redirect_uri: String(clientConstruction.mock.calls.at(-1)?.[2]), code_challenge: options.code_challenge, code_challenge_method: options.code_challenge_method })}`; }
    getToken = getToken; getTokenInfo = getTokenInfo; refreshAccessToken = refresh; setCredentials = jest.fn();
  } },
  gmail: () => ({ users: { getProfile, watch } }),
  people: () => ({ people: { get: getPerson } }),
} }));
const { default: router, getGmailClientForUser } = await import('../controllers/gmailOAuthController.js');
const app = express();
app.use(express.json());
app.use('/api/gmail/oauth', (req, _res, next) => {
  if (req.path === '/callback') return next();
  req.user = { id: 12 } as any;
  return withBusinessScope(scope, next);
}, router);
// Match the application's backwards-compatible alias without touching live routes.
app.get('/api/gmail-oauth/callback', (req, res) => res.redirect(`/api/gmail/oauth/callback?${new URLSearchParams(req.query as Record<string, string>)}`));
const credential = () => ({ id: 31, userId: 9, accountIdentifier: 'owner@example.test', accessToken: 'encrypted:fixture-access', refreshToken: 'encrypted:fixture-refresh', tokenExpiry: new Date(0), sessionData: { oauthClientId: 'fixture-client', oauthConfigSource: 'default', lastHistoryId: 'advanced-cursor' } });
const granted = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify'];
const tokenFixture = () => ({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: granted.join(' '), expiry_date: Date.now() + 3600000 } });
const result = (response: request.Response) => new URL(response.headers.location).searchParams;
async function initiate(path = '/authorize') {
  const response = await request(app).get(`/api/gmail/oauth${path}`).set('Cookie', 'asksales_session=fixture-session');
  expect(response.status).toBe(200);
  const state = new URL(response.body.url).searchParams.get('state')!;
  const cookie = (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return { state, cookies: ['asksales_session=fixture-session', cookie], response };
}
async function callback(flow: Awaited<ReturnType<typeof initiate>>, query: Record<string, string> = { code: 'fixture-code' }) {
  return request(app).get('/api/gmail/oauth/callback').set('Host', 'app.example.test').query({ ...query, state: flow.state }).set('Cookie', flow.cookies);
}
beforeEach(() => {
  jest.clearAllMocks(); store.clear();
  verifySession.mockReset().mockReturnValue({ userId: 12, iat: Math.floor(Date.now() / 1000), jti: 'fixture-session-id' });
  sessionRevoked.mockReset().mockResolvedValue(false);
  findUser.mockReset().mockResolvedValue({ id: 12, deletedAt: null, passwordChangedAt: null });
  resolveScope.mockReset().mockResolvedValue(scope);
  admin.mockReset().mockResolvedValue({ apiKey: 'fixture-client', apiSecret: 'fixture-secret', config: { redirectUri: 'https://api.example.test/api/gmail/oauth/callback', pubsubTopic: 'projects/fixture/topics/gmail' } });
  find.mockReset().mockImplementation(async (_userId: number, platform: string) => platform === 'gmail_api' ? credential() : null);
  findId.mockReset().mockResolvedValue(credential()); findMailbox.mockReset().mockResolvedValue(null);
  upsert.mockReset().mockImplementation(async (value: any) => { expect(currentBusinessScope()).toMatchObject(scope); return { id: 31, ...value }; });
  where.mockReset().mockResolvedValue([]); execute.mockReset().mockResolvedValue({ rows: [] });
  getToken.mockReset().mockResolvedValue(tokenFixture()); getTokenInfo.mockReset().mockResolvedValue({ scopes: granted });
  getProfile.mockReset().mockResolvedValue({ data: { emailAddress: ' Owner@Example.Test ' } });
  getPerson.mockReset().mockResolvedValue({ data: { names: [{ displayName: 'Fixture Owner' }] } });
  watch.mockReset().mockResolvedValue({ data: { expiration: String(Date.now() + 86400000), historyId: 'history-fixture' } });
  refresh.mockReset().mockResolvedValue({ credentials: { access_token: 'fixture-new-access', expiry_date: Date.now() + 3600000 } });
  findSender.mockReset().mockResolvedValue(null); senderCreate.mockReset().mockResolvedValue({ id: 44 });
});
describe('Gmail OAuth mocked end-to-end connection', () => {
  it('initiates offline consent and completes in original actor/business with encrypted tokens and bound client', async () => {
    const flow = await initiate('/auth-url');
    expect(flow.response.body.authUrl).toBe(flow.response.body.url);
    const url = new URL(flow.response.body.url); expect(url.searchParams.get('access_type')).toBe('offline'); expect(url.searchParams.get('prompt')).toBe('consent');
    expect(flow.response.headers['set-cookie'][0]).toMatch(/HttpOnly; SameSite=Lax/);
    expect(JSON.stringify(flow.response.body)).not.toContain('fixture-secret');
    const response = await callback(flow);
    expect(result(response).get('gmail_success')).toBe('true'); expect(result(response).get('gmail_business_profile_id')).toBe('11');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, accountIdentifier: 'owner@example.test', accessToken: 'encrypted:fixture-access', refreshToken: 'encrypted:fixture-refresh', sessionData: expect.objectContaining({ oauthClientId: 'fixture-client', oauthConfigSource: 'default' }), grantedScopes: granted }));
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ code: 'fixture-code', codeVerifier: expect.any(String) }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(setDefault).toHaveBeenCalledWith(9, 44); expect(persistWatch).toHaveBeenCalledWith(9, 31, expect.any(String), 'history-fixture');
  });
  it('aligns a stale account cookie with the verified Bearer session before Google navigation', async () => {
    const response = await request(app).get('/api/gmail/oauth/authorize').set('Authorization', 'Bearer fixture-current-session').set('Cookie', 'asksales_session=fixture-old-session');
    expect(response.status).toBe(200);
    const cookies = (response.headers['set-cookie'] as unknown as string[]).map(value => value.split(';')[0]);
    expect(cookies).toContain('asksales_session=fixture-current-session');
    const flow = { response, state: new URL(response.body.url).searchParams.get('state')!, cookies };
    expect(result(await callback(flow)).get('gmail_success')).toBe('true');
  });
  it('handles denied consent and consumes state without any provider calls or records', async () => {
    const flow = await initiate(); const response = await callback(flow, { error: 'access_denied' });
    expect(result(response).get('gmail_error')).toBe('access_denied'); expect(store.size).toBe(0); expect(getToken).not.toHaveBeenCalled(); expect(upsert).not.toHaveBeenCalled();
  });
  it('handles canceled/missing callback code safely', async () => {
    expect(result(await callback(await initiate(), {})).get('gmail_error')).toBe('missing_code'); expect(getToken).not.toHaveBeenCalled();
  });
  it('never passes raw provider callback errors or exchange errors into logs/return URLs', async () => {
    const flow = await initiate(); const unsafe = 'provider detail access_token=fixture-sensitive-value';
    expect(result(await callback(flow, { error: unsafe })).get('gmail_error')).toBe('connection_failed');
    getToken.mockRejectedValueOnce(new Error(unsafe)); const response = await callback(await initiate());
    expect(result(response).get('gmail_error')).toBe('token_exchange_failed'); expect(response.headers.location).not.toContain('fixture-sensitive-value'); expect(JSON.stringify(logger.error.mock.calls)).not.toContain('fixture-sensitive-value');
  });
  it.each(['absent-cookie', 'other-session'])('rejects browser/session mismatch: %s', async mode => {
    const flow = await initiate(); flow.cookies = mode === 'absent-cookie' ? [] : ['asksales_session=another-session', flow.cookies[1]];
    expect(result(await callback(flow)).get('gmail_error')).toBe('session_changed'); expect(getToken).not.toHaveBeenCalled(); expect(upsert).not.toHaveBeenCalled();
  });
  it('hands API-domain callbacks to the trusted frontend cookie origin once while keeping registered redirect', async () => {
    const flow = await initiate();
    const handoff = await request(app).get('/api/gmail/oauth/callback').set('Host', 'api.example.test').query({ state: flow.state, code: 'fixture-code' });
    const destination = new URL(handoff.headers.location);
    expect(destination.origin).toBe('https://app.example.test'); expect(destination.pathname).toBe('/api/gmail/oauth/callback');
    expect(getToken).not.toHaveBeenCalled(); expect(store.size).toBe(1);
    const completed = await request(app).get(destination.pathname + destination.search).set('Host', 'app.example.test').set('Cookie', flow.cookies);
    expect(result(completed).get('gmail_success')).toBe('true');
    expect(clientConstruction.mock.calls.at(-1)?.[2]).toBe('https://api.example.test/api/gmail/oauth/callback');
    const missing = await request(app).get(destination.pathname + destination.search).set('Host', 'api.example.test');
    expect(result(missing).get('gmail_error')).toBe('session_changed');
  });
  it.each(['expired', 'revoked', 'wrong-actor', 'password-changed', 'deleted'])('rejects session %s before consuming state or exchanging code', async mode => {
    const flow = await initiate();
    if (mode === 'expired') verifySession.mockReturnValue(null);
    if (mode === 'revoked') sessionRevoked.mockResolvedValue(true);
    if (mode === 'wrong-actor') verifySession.mockReturnValue({ userId: 88 });
    if (mode === 'password-changed') findUser.mockResolvedValue({ id: 12, passwordChangedAt: new Date(Date.now() + 1000) });
    if (mode === 'deleted') findUser.mockResolvedValue({ id: 12, deletedAt: new Date() });
    expect(result(await callback(flow)).get('gmail_error')).toBe('session_changed'); expect(getToken).not.toHaveBeenCalled(); expect(store.size).toBe(1);
  });
  it('rejects expired, tampered and malformed duplicate state', async () => {
    const flow = await initiate(); const parsed = verifyGmailOAuthState(flow.state, signingKey)!;
    flow.state = signGmailOAuthState({ ...parsed, ts: Date.now() - 600001 }, signingKey);
    expect(result(await callback(flow)).get('gmail_error')).toBe('invalid_or_expired_state');
    const another = await initiate(); another.state += '.extra';
    expect(result(await callback(another)).get('gmail_error')).toBe('invalid_or_expired_state');
    const malformed = await request(app).get('/api/gmail/oauth/callback?state=a&state=b&code=fixture');
    expect(result(malformed).get('gmail_error')).toBe('invalid_or_expired_state'); expect(getToken).not.toHaveBeenCalled();
  });
  it('allows only one of concurrent callbacks and rejects replay', async () => {
    const flow = await initiate(); const responses = await Promise.all([callback(flow), callback(flow)]);
    expect(responses.filter(response => result(response).get('gmail_success') === 'true')).toHaveLength(1);
    expect(responses.filter(response => result(response).get('gmail_error') === 'invalid_or_expired_state')).toHaveLength(1);
    expect(result(await callback(flow)).get('gmail_error')).toBe('invalid_or_expired_state'); expect(getToken).toHaveBeenCalledTimes(1);
  });
  it('rejects revoked connection authority before code exchange', async () => {
    const flow = await initiate(); resolveScope.mockResolvedValueOnce({ ...scope, role: 'member' });
    expect(result(await callback(flow)).get('gmail_error')).toBe('permission_changed'); expect(getToken).not.toHaveBeenCalled();
  });
  it('detects configuration changes between initiate and callback', async () => {
    const flow = await initiate(); admin.mockResolvedValue({ apiKey: 'other-client', apiSecret: 'other-secret', config: {} });
    expect(result(await callback(flow)).get('gmail_error')).toBe('configuration_changed'); expect(getToken).not.toHaveBeenCalled();
  });
  it('keeps exact legacy registered redirect URI through alias and token exchange', async () => {
    admin.mockResolvedValue({ apiKey: 'fixture-client', apiSecret: 'fixture-secret', config: { redirectUri: 'https://api.example.test/api/gmail-oauth/callback' } });
    const flow = await initiate(); const alias = await request(app).get('/api/gmail-oauth/callback').query({ state: flow.state, code: 'fixture-code' });
    const response = await request(app).get(alias.headers.location).set('Cookie', flow.cookies);
    expect(result(response).get('gmail_success')).toBe('true'); expect(clientConstruction.mock.calls.at(-1)?.[2]).toBe('https://api.example.test/api/gmail-oauth/callback');
  });
  it('refuses partial consent without storing an unusable sender', async () => {
    getToken.mockResolvedValue({ tokens: { ...tokenFixture().tokens, scope: 'https://www.googleapis.com/auth/gmail.readonly' } });
    expect(result(await callback(await initiate())).get('gmail_error')).toBe('missing_scopes'); expect(upsert).not.toHaveBeenCalled(); expect(senderCreate).not.toHaveBeenCalled();
  });
  it('accepts Gmail modify as the documented sending and reading capability without inventing scopes', async () => {
    getToken.mockResolvedValue({ tokens: { ...tokenFixture().tokens, scope: 'https://www.googleapis.com/auth/gmail.modify' } });
    expect(result(await callback(await initiate())).get('gmail_success')).toBe('true');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'] }));
  });
  it('verifies token info if provider omits scope from exchange', async () => {
    getToken.mockResolvedValue({ tokens: { ...tokenFixture().tokens, scope: undefined } });
    expect(result(await callback(await initiate())).get('gmail_success')).toBe('true'); expect(getTokenInfo).toHaveBeenCalledWith('fixture-access');
  });
  it('preserves refresh only for the same mailbox and issuing client, without replacing watch metadata', async () => {
    findMailbox.mockResolvedValue(credential()); getToken.mockResolvedValue({ tokens: { ...tokenFixture().tokens, refresh_token: undefined } });
    expect(result(await callback(await initiate())).get('gmail_success')).toBe('true');
    expect((upsert.mock.calls[0][0] as any).refreshToken).toBe('encrypted:fixture-refresh'); expect(upsert.mock.calls[0][0]).not.toHaveProperty('sessionData');
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL); expect(query.sql).toContain('COALESCE(session_data'); expect(query.params).not.toContain('advanced-cursor');
  });
  it.each(['new-account', 'other-client', 'legacy-unbound'])('does not borrow old refresh tokens for %s', async mode => {
    if (mode !== 'new-account') findMailbox.mockResolvedValue({ ...credential(), sessionData: mode === 'other-client' ? { oauthClientId: 'other-client' } : {} });
    getToken.mockResolvedValue({ tokens: { ...tokenFixture().tokens, refresh_token: undefined } });
    expect(result(await callback(await initiate())).get('gmail_error')).toBe('missing_refresh_token'); expect(upsert).not.toHaveBeenCalled();
  });
  it('does not fail successful connection when optional display name/watch are unavailable', async () => {
    getPerson.mockRejectedValueOnce(new Error('fixture display unavailable')); watch.mockRejectedValueOnce(new Error('fixture watch unavailable'));
    expect(result(await callback(await initiate())).get('gmail_success')).toBe('true'); expect(persistWatch).not.toHaveBeenCalled();
  });
  it('returns safe mailbox ownership conflict recovery', async () => {
    upsert.mockRejectedValueOnce({ code: 'GMAIL_MAILBOX_ALREADY_CONNECTED' });
    expect(result(await callback(await initiate())).get('gmail_error')).toBe('mailbox_already_connected'); expect(senderCreate).not.toHaveBeenCalled();
  });
  it('returns the real failure category/stage and a reference matching the safe diagnostic log', async () => {
    getProfile.mockRejectedValueOnce({ response: { status: 403, data: { error: {
      message: 'private-provider-response', details: [{ reason: 'SERVICE_DISABLED', metadata: { consumer: 'private-project' } }],
    } } } });
    const response = await callback(await initiate());
    const params = result(response);
    expect(params.get('gmail_error')).toBe('gmail_api_disabled');
    expect(params.get('gmail_error_stage')).toBe('mailbox_profile');
    expect(params.get('gmail_error_ref')).toMatch(/^[a-f0-9-]{36}$/);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      gmailDiagnosticId: params.get('gmail_error_ref'), failureStage: 'mailbox_profile',
      providerCode: 'SERVICE_DISABLED', httpStatus: 403, userId: 9, businessProfileId: 11,
    }), '[GmailOAuth] Connection failed');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-');
    expect(getProfile).toHaveBeenCalledTimes(1); expect(upsert).not.toHaveBeenCalled();
  });
  it('recovers a transient mailbox lookup failure without replaying the authorization code', async () => {
    getProfile.mockRejectedValueOnce({ response: { status: 503 } });
    expect(result(await callback(await initiate())).get('gmail_success')).toBe('true');
    expect(getToken).toHaveBeenCalledTimes(1); expect(getProfile).toHaveBeenCalledTimes(2);
    expect(getProfile).toHaveBeenLastCalledWith({ userId: 'me' }, { timeout: 5000, retry: false });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it('reports database failure causes inside Drizzle wrappers without exposing SQL or tokens', async () => {
    upsert.mockRejectedValueOnce(new Error('private SQL with private-token', { cause: { code: '42501', detail: 'private-row' } }));
    const params = result(await callback(await initiate()));
    expect(params.get('gmail_error')).toBe('connection_database_permission_denied');
    expect(params.get('gmail_error_stage')).toBe('credential_save');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ databaseCode: '42501', gmailDiagnosticId: params.get('gmail_error_ref') }), expect.any(String));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-');
    expect(senderCreate).not.toHaveBeenCalled();
  });
  it('identifies rejected authorization codes and does not retry the single-use exchange', async () => {
    getToken.mockRejectedValueOnce({ response: { status: 400, data: { error: 'invalid_grant', error_description: 'private-detail' } } });
    const params = result(await callback(await initiate()));
    expect(params.get('gmail_error')).toBe('authorization_code_rejected');
    expect(params.get('gmail_error_stage')).toBe('token_exchange');
    expect(getToken).toHaveBeenCalledTimes(1); expect(getProfile).not.toHaveBeenCalled();
  });
  it('reports sender setup failures separately instead of claiming the connection never reached Google', async () => {
    senderCreate.mockRejectedValueOnce(new Error('private sender failure'));
    const params = result(await callback(await initiate()));
    expect(params.get('gmail_error')).toBe('sender_setup_failed');
    expect(params.get('gmail_error_stage')).toBe('sender_setup');
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), '[GmailOAuth] Successfully connected Gmail');
  });
  it('reports missing or malformed OAuth configuration before creating state', async () => {
    admin.mockResolvedValueOnce(null); const response = await request(app).get('/api/gmail/oauth/authorize').set('Cookie', 'asksales_session=fixture-session');
    expect(response.status).toBe(400); expect(response.body.needsConfig).toBe(true); expect(store.size).toBe(0);
    admin.mockResolvedValueOnce({ apiKey: 'fixture-client', apiSecret: 'fixture-secret', config: { redirectUri: 'https://api.example.test/wrong' } });
    const invalid = await request(app).get('/api/gmail/oauth/authorize').set('Cookie', 'asksales_session=fixture-session'); expect(invalid.status).toBe(503); expect(store.size).toBe(0);
  });
});
describe('Gmail refresh mocked account isolation', () => {
  it('manual refresh updates only selected tenant credential and preserves refresh token', async () => {
    const response = await request(app).post('/api/gmail/oauth/refresh'); expect(response.status).toBe(200);
    expect(updateAll).not.toHaveBeenCalled(); expect(new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL).params).toEqual([31, 9, 'gmail_api', true, 'owner@example.test']); expect(set.mock.calls[0][0]).not.toHaveProperty('refreshToken');
  });
  it('does not deactivate a valid grant when its client changed', async () => {
    admin.mockResolvedValue({ apiKey: 'other-client', apiSecret: 'other-secret', config: {} });
    const response = await request(app).post('/api/gmail/oauth/refresh'); expect(response.status).toBe(409); expect(refresh).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });
  it('uses issuing default client even if owner subsequently adds personal config', async () => {
    find.mockImplementation(async (_id: number, platform: string) => platform === 'gmail_config' ? { sessionData: { clientId: 'user-client', clientSecret: 'user-secret' } } : credential());
    await withBusinessScope(scope, () => getGmailClientForUser(9)); expect(clientConstruction).toHaveBeenCalledWith('fixture-client', 'fixture-secret', 'https://api.example.test/api/gmail/oauth/callback');
  });
  it('does not corrupt stored tokens on transient refresh failure or empty refresh response', async () => {
    refresh.mockRejectedValueOnce(new Error('fixture outage')); expect((await request(app).post('/api/gmail/oauth/refresh')).status).toBe(503); expect(set).not.toHaveBeenCalled();
    refresh.mockResolvedValueOnce({ credentials: {} }); expect((await request(app).post('/api/gmail/oauth/refresh')).status).toBe(503); expect(set).not.toHaveBeenCalled();
  });
  it('deactivates only selected credential on invalid_grant and status stops claiming connected', async () => {
    refresh.mockRejectedValueOnce({ response: { data: { error: 'invalid_grant' } } });
    const revoked = await request(app).post('/api/gmail/oauth/refresh'); expect(revoked.status).toBe(409); expect(revoked.body.code).toBe('GMAIL_RECONNECT_REQUIRED'); expect(new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL).params).toEqual([31, 9, 'gmail_api', true, 'owner@example.test']); expect(updateAll).not.toHaveBeenCalled();
    refresh.mockRejectedValueOnce({ response: { data: { error: 'invalid_grant' } } }); findId.mockResolvedValueOnce(null);
    const status = await request(app).get('/api/gmail/oauth/status'); expect(status.status).toBe(200); expect(status.body.connected).toBe(false);
  });
});

describe('Gmail provider lifecycle acceptance', () => {
  it('rejects a wrong PKCE verifier before consuming state or exchanging code', async () => {
    const flow=await initiate();flow.cookies[1]=flow.cookies[1].split('.').slice(0,-1).join('.')+'.wrong-verifier';
    expect(result(await callback(flow)).get('gmail_error')).toBe('session_changed');expect(getToken).not.toHaveBeenCalled();expect(store.size).toBe(1);
  });
  it('reports a changed issuing OAuth client as reconnect-required even before expiry', async () => {
    find.mockImplementation(async (_id:number,platform:string)=>platform==='gmail_api'?{...credential(),tokenExpiry:new Date(Date.now()+3600_000)}:null);
    admin.mockResolvedValue({apiKey:'new-client',apiSecret:'new-secret',config:{}});
    const response=await request(app).get('/api/gmail/oauth/status');
    expect(response.body).toMatchObject({connected:false,requiresReconnect:true,readinessErrorCode:'GMAIL_OAUTH_CLIENT_CHANGED'});expect(refresh).not.toHaveBeenCalled();
  });
  it('exposes mailbox cooldown and delayed sync without falsely revoking authorization', async () => {
    find.mockImplementation(async (_id:number,platform:string)=>platform==='gmail_api'?{...credential(),tokenExpiry:new Date(Date.now()+3600_000),sessionData:{oauthClientId:'fixture-client',oauthConfigSource:'default',watchExpiration:String(Date.now()+2*86400_000)}}:null);
    const later=new Date(Date.now()+900_000).toISOString();execute.mockResolvedValue({rows:[{gmail_cooldown_until:later,gmail_sync_due_at:later,gmail_sync_failures:2,gmail_sync_history_id:'200'}]});
    const response=await request(app).get('/api/gmail/oauth/status');
    expect(response.body).toMatchObject({connected:true,connectionState:'rate_limited',cooldownUntil:later,syncFailures:2,syncPending:true,watchStatus:'active'});
  });
  it('returns unavailable for transient status refresh failure instead of telling the user to reconnect', async () => {
    refresh.mockRejectedValue(new Error('synthetic timeout'));
    const response=await request(app).get('/api/gmail/oauth/status');expect(response.status).toBe(503);expect(response.body.code).toBe('GMAIL_STATUS_UNAVAILABLE');expect(set).not.toHaveBeenCalled();
  });
  it('configures the final OAuth client with expiry and no automatic refresh replay', async () => {
    const result=await withBusinessScope(scope,()=>getGmailClientForUser(9));
    expect(result?.client.setCredentials).toHaveBeenLastCalledWith({access_token:'fixture-new-access',expiry_date:expect.any(Number)});
    expect(result?.credential.accessToken).toBe('fixture-new-access');
  });
});
