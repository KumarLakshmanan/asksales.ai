import crypto from 'node:crypto';
import { sha256Hex as gmailSessionHash } from './sha256.js';
export { gmailSessionHash };

export const GMAIL_STATE_MAX_AGE_MS = 10 * 60 * 1000;
export type GmailOAuthConfig = { clientId: string; clientSecret: string; redirectUri?: string };
export type GmailOAuthState = {
  userId: number; actorUserId: number; nonce: string; ts: number;
  sessionHash: string; configHash: string; callbackHost: string; pkceChallenge: string;
};

export function gmailConfigHash(config: GmailOAuthConfig, secret: string): string {
  return crypto.createHmac('sha256', secret)
    .update(JSON.stringify([config.clientId, config.clientSecret, config.redirectUri])).digest('hex');
}

export function signGmailOAuthState(state: GmailOAuthState, secret: string): string {
  if (!secret) throw new Error('OAuth signing is not configured');
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function verifyGmailOAuthState(value: string, secret: string, now = Date.now()): GmailOAuthState | null {
  if (!secret || value.length > 2048) return null;
  try {
    const parts = value.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GmailOAuthState;
    if (!Number.isSafeInteger(state.userId) || state.userId <= 0 || !Number.isSafeInteger(state.actorUserId) || state.actorUserId <= 0
      || !Number.isSafeInteger(state.ts) || state.ts > now || now - state.ts > GMAIL_STATE_MAX_AGE_MS
      || typeof state.callbackHost !== 'string' || !state.callbackHost || state.callbackHost.length > 255
      || !/^[A-Za-z0-9_-]{43}$/.test(state.pkceChallenge) || !/^[a-f0-9]{32}$/.test(state.nonce) || !/^[a-f0-9]{64}$/.test(state.sessionHash) || !/^[a-f0-9]{64}$/.test(state.configHash)) return null;
    return state;
  } catch { return null; }
}

/** Explicit provider configuration wins. A dev tunnel is never a production default. */
export function resolveGmailRedirectUri(configured?: string): string {
  const explicit = process.env.GMAIL_REDIRECT_URI?.trim() || configured?.trim();
  const base = process.env.NODE_ENV === 'production'
    ? process.env.APP_URL || process.env.API_URL
    : process.env.NGROK_URL || process.env.APP_URL || process.env.API_URL || 'http://localhost:8080';
  const value = explicit || `${base?.replace(/\/+$/, '')}/api/gmail/oauth/callback`;
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || !['/api/gmail/oauth/callback', '/api/gmail-oauth/callback'].includes(url.pathname)
    || (process.env.NODE_ENV === 'production' ? url.protocol !== 'https:' || local : url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('Gmail OAuth redirect configuration is invalid');
  }
  return value;
}

export function gmailReturnUrl(code: string, success = false, businessProfileId?: number): string {
  const base = process.env.CLIENT_URL?.trim() || process.env.FRONTEND_URL?.trim()
    || (process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : undefined);
  if (!base) throw new Error('Gmail frontend URL is not configured');
  const url = new URL('/dashboard/integrations/email', base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local && url.protocol === 'http:'))) {
    throw new Error('Gmail frontend URL configuration is invalid');
  }
  url.searchParams.set(success ? 'gmail_success' : 'gmail_error', code);
  if (businessProfileId) url.searchParams.set('gmail_business_profile_id', String(businessProfileId));
  return url.toString();
}
