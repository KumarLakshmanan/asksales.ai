import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { GMAIL_STATE_MAX_AGE_MS, gmailConfigHash, gmailSessionHash, gmailReturnUrl, resolveGmailRedirectUri, signGmailOAuthState, verifyGmailOAuthState } from '../utils/gmailOAuthFlow.js';
const names = ['NODE_ENV', 'APP_URL', 'API_URL', 'NGROK_URL', 'GMAIL_REDIRECT_URI', 'CLIENT_URL', 'FRONTEND_URL'] as const;
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const config = { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'https://api.example.test/api/gmail/oauth/callback' };
const secret = 'fixture-signing-key';
const now = 1000000;
const state = () => ({ userId: 9, actorUserId: 12, ts: now, nonce: 'a'.repeat(32), callbackHost: 'api.example.test', pkceChallenge: 'a'.repeat(43), sessionHash: gmailSessionHash('fixture-session'), configHash: gmailConfigHash(config, secret) });
beforeEach(() => { for (const name of names) delete process.env[name]; process.env.NODE_ENV = 'test'; });
afterAll(() => { for (const name of names) { const value = original[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
describe('Gmail state and URL contracts', () => {
  it('binds actor, session and exact client/redirect contract without secret material', () => {
    const signed = signGmailOAuthState(state(), secret);
    expect(verifyGmailOAuthState(signed, secret, now + 1)).toEqual(state());
    expect(Buffer.from(signed.split('.')[0], 'base64url').toString()).not.toContain(config.clientSecret);
    expect(gmailConfigHash({ ...config, redirectUri: 'https://dev.example.test/api/gmail/oauth/callback' }, secret)).not.toBe(state().configHash);
  });
  it('rejects tampered, extra-segment, expired, future and invalid numeric states', () => {
    const signed = signGmailOAuthState(state(), secret);
    expect(verifyGmailOAuthState(signed + 'x', secret, now)).toBeNull();
    expect(verifyGmailOAuthState(signed + '.extra', secret, now)).toBeNull();
    expect(verifyGmailOAuthState(signed, secret, now + GMAIL_STATE_MAX_AGE_MS + 1)).toBeNull();
    expect(verifyGmailOAuthState(signed, secret, now - 1)).toBeNull();
    expect(verifyGmailOAuthState(signGmailOAuthState({ ...state(), userId: 1.1 }, secret), secret, now)).toBeNull();
  });
  it('ignores development tunnels in production and fails closed without public config', () => {
    process.env.NODE_ENV = 'production'; process.env.NGROK_URL = 'https://tunnel.example.test'; process.env.APP_URL = 'https://api.example.test/';
    expect(resolveGmailRedirectUri()).toBe(config.redirectUri);
    delete process.env.APP_URL;
    expect(() => resolveGmailRedirectUri()).toThrow();
    expect(() => gmailReturnUrl('connection_failed')).toThrow();
  });
  it('preserves exact explicit redirect, supports legacy callback and local development', () => {
    expect(resolveGmailRedirectUri()).toBe('http://localhost:8080/api/gmail/oauth/callback');
    process.env.NGROK_URL = 'https://tunnel.example.test';
    expect(resolveGmailRedirectUri()).toBe('https://tunnel.example.test/api/gmail/oauth/callback');
    expect(resolveGmailRedirectUri('https://api.example.test/api/gmail-oauth/callback')).toBe('https://api.example.test/api/gmail-oauth/callback');
    process.env.GMAIL_REDIRECT_URI = config.redirectUri;
    expect(resolveGmailRedirectUri('https://dev.example.test/api/gmail/oauth/callback')).toBe(config.redirectUri);
  });
  it.each(['https://api.example.test/wrong', 'https://api.example.test/api/gmail/oauth/callback?code=x', 'https://api.example.test/api/gmail/oauth/callback#fragment', 'http://api.example.test/api/gmail/oauth/callback', 'https://user:pass@api.example.test/api/gmail/oauth/callback'])('rejects invalid callback %s', value => {
    expect(() => resolveGmailRedirectUri(value)).toThrow();
  });
  it('returns to configured frontend with stable result and original business', () => {
    process.env.NODE_ENV = 'production'; process.env.FRONTEND_URL = 'https://app.example.test/';
    const url = new URL(gmailReturnUrl('access_denied', false, 11));
    expect(url.origin).toBe('https://app.example.test'); expect(url.searchParams.get('gmail_error')).toBe('access_denied'); expect(url.searchParams.get('gmail_business_profile_id')).toBe('11');
  });
});
