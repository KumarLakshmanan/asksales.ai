import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getRedisConnection } from '../infrastructure/redis.js';
import { AUTH_COOKIES, readAuthCookie, setAuthCookie } from '../utils/authCookies.js';
import { verifyToken, isTokenRevoked } from '../utils/jwt.js';
import { getUserById } from '../models/users/functions.js';
import { withSystemScope } from '../tenancy/businessContext.js';
import { consumeOAuthBusinessScope } from '../tenancy/oauthBusinessScope.js';
import { gmailReturnUrl } from '../utils/gmailOAuthFlow.js';
import { sha256Hex as digest } from '../utils/sha256.js';

const MAX_AGE_MS = 10 * 60_000;
const flowKey = (provider: string, state: string) => `oauth:browser:${provider}:${digest(state)}`;
const cookieName = (provider: string, state: string) => `oauth_flow_${digest(`${provider}:${state}`).slice(0,32)}`;
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/api/' });
type BrowserFlow = { actorUserId: number; sessionHash: string; cookieHash: string; configHash: string;
  codeVerifier?: string; callbackUri: string; createdAt: number };
const verifiedFlows = new WeakMap<Request, BrowserFlow>();

export function oauthConfigurationHash(values: string[]): string {
  const secret = process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('OAuth signing is not configured');
  return crypto.createHmac('sha256', secret).update(JSON.stringify(values)).digest('hex');
}
export function createOAuthPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** Store only the hashed application session; the PKCE verifier stays server-side.
 * A provider state signature alone does not bind consent to its initiating browser. */
export async function beginOAuthBrowserFlow(req: Request, res: Response, provider: string, state: string,
  callbackUri: string, configuration: string[], usePkce = false) {
  const session = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : readAuthCookie(req, AUTH_COOKIES.user);
  if (!session || !req.user?.id) throw new Error('An authenticated browser session is required');
  const callback = new URL(callbackUri);
  if (callback.username || callback.password || callback.search || callback.hash
    || !['https:', ...(process.env.NODE_ENV !== 'production' && ['localhost','127.0.0.1','[::1]'].includes(callback.hostname) ? ['http:'] : [])].includes(callback.protocol)) {
    throw new Error('OAuth callback configuration is invalid');
  }
  // Validate the trusted return origin before leaving a pending flow in Redis.
  gmailReturnUrl('true', true);
  if (req.headers.authorization?.startsWith('Bearer ')) setAuthCookie(res, AUTH_COOKIES.user, session);
  const cookie = crypto.randomBytes(32).toString('base64url');
  const pkce = usePkce ? createOAuthPkce() : undefined;
  const record: BrowserFlow = { actorUserId: req.user.id, sessionHash: digest(session), cookieHash: digest(cookie),
    configHash: oauthConfigurationHash(configuration), callbackUri, createdAt: Date.now(), codeVerifier: pkce?.verifier };
  await getRedisConnection().set(flowKey(provider,state), JSON.stringify(record), 'PX', MAX_AGE_MS);
  res.cookie(cookieName(provider,state), cookie, { ...cookieOptions(), maxAge: MAX_AGE_MS });
  res.set('Cache-Control', 'no-store');
  return { codeChallenge: pkce?.challenge, codeChallengeMethod: pkce ? 'S256' as const : undefined };
}

export function oauthBrowserFlow(req: Request) {
  const record = verifiedFlows.get(req);
  if (!record) throw new Error('OAuth browser validation is required');
  return { codeVerifier: record.codeVerifier, configHash: record.configHash };
}
export function requireOAuthConfiguration(req: Request, configuration: string[]) {
  if (oauthBrowserFlow(req).configHash !== oauthConfigurationHash(configuration)) throw new Error('OAuth configuration changed. Start sign-in again.');
}

export function oauthBrowserCallback(provider: string, onFailure: (res: Response, code: string) => unknown) {
  const consumeBusiness = consumeOAuthBusinessScope(onFailure);
  return async (req: Request, res: Response, next: NextFunction) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const state = req.query.state;
    if (typeof state !== 'string' || !state || state.length > 2048) return onFailure(res, 'invalid_or_expired_state');
    try {
      const redis = getRedisConnection();
      const serialized = await redis.get(flowKey(provider,state));
      if (!serialized) return onFailure(res, 'invalid_or_expired_state');
      const record = JSON.parse(serialized) as BrowserFlow;
      if (!Number.isSafeInteger(record.actorUserId) || !Number.isSafeInteger(record.createdAt)
        || record.createdAt > Date.now() || Date.now() - record.createdAt > MAX_AGE_MS) return onFailure(res, 'invalid_or_expired_state');
      const cookie = readAuthCookie(req, cookieName(provider,state));
      const session = readAuthCookie(req, AUTH_COOKIES.user);
      if (!cookie && (!session || digest(session) === record.sessionHash) && req.query.oauth_handoff !== '1') {
        const callback = new URL(record.callbackUri);
        const destination = new URL(gmailReturnUrl('true',true));
        if (req.get('host') === callback.host && callback.host !== destination.host) {
          destination.pathname = callback.pathname;
          destination.search = '';
          destination.searchParams.set('state',state);
          destination.searchParams.set('oauth_handoff','1');
          if (typeof req.query.code === 'string') destination.searchParams.set('code',req.query.code);
          if (typeof req.query.error === 'string') destination.searchParams.set('error',req.query.error === 'access_denied' ? 'access_denied' : 'provider_error');
          return res.redirect(destination.toString());
        }
      }
      if (!cookie || digest(cookie) !== record.cookieHash || !session || digest(session) !== record.sessionHash) return onFailure(res,'session_changed');
      const actor = verifyToken(session) as (ReturnType<typeof verifyToken> & { jti?: string }) | null;
      if (!actor || actor.userId !== record.actorUserId || actor.adminId || actor.supportMemberId
        || (actor.jti && await isTokenRevoked(actor.jti))) return onFailure(res,'session_changed');
      const user = await withSystemScope('Validate provider OAuth browser actor', () => getUserById(record.actorUserId));
      if (!user || user.deletedAt || (user.passwordChangedAt && actor.iat && actor.iat * 1000 < user.passwordChangedAt.getTime())) return onFailure(res,'session_changed');
      const consumed = await redis.eval("local v=redis.call('GET',KEYS[1]); if v==ARGV[1] then redis.call('DEL',KEYS[1]); return v end; return nil",1,flowKey(provider,state),serialized);
      if (!consumed) return onFailure(res,'invalid_or_expired_state');
      res.clearCookie(cookieName(provider,state),cookieOptions());
      verifiedFlows.set(req,record);
      return consumeBusiness(req,res,next);
    } catch { return onFailure(res,'oauth_unavailable'); }
  };
}
