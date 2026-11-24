import { requireBusinessManager } from '../middleware/businessPermissions.js';
import { businessOwnerUserId, currentBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { rememberOAuthBusinessState, consumeOAuthBusinessScope } from '../tenancy/oauthBusinessScope.js';
/**
 * Gmail OAuth Controller
 * Handles Gmail OAuth authentication flow and token management
 * Supports per-user OAuth client credentials stored in database
 */

import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import { db } from '../models/db';
import { sql, and, eq } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { logger } from '../utils/logger.js';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions';
import crypto from 'crypto';
import { configureGmailConnectionTransport, configureGmailPersistedTokenClient, gmailConnectionFailure, readGmailConnection, type GmailConnectionStage } from '../utils/gmailOAuthDiagnostics.js';
import { AUTH_COOKIES, readAuthCookie, setAuthCookie } from '../utils/authCookies.js';
import { verifyToken, isTokenRevoked } from '../utils/jwt.js';
import { getUserById } from '../models/users/functions.js';
import { GMAIL_STATE_MAX_AGE_MS, gmailConfigHash, gmailSessionHash, gmailReturnUrl, resolveGmailRedirectUri, signGmailOAuthState, verifyGmailOAuthState, type GmailOAuthConfig } from '../utils/gmailOAuthFlow.js';
import { createOAuthPkce } from '../services/OAuthBrowserFlowService.js';
import { disconnectGmailAccounts } from '../services/GmailDisconnectService.js';
import { refreshChannelCredential } from '../services/ChannelCredentialRefreshService.js';
import { gmailWatchHealth, safeGmailHealthDate } from '../utils/gmailConnectionHealth.js';
import { guardGmailClient } from '../services/GmailCooldownService.js';
import { persistGmailWatch, persistGmailWatchFailure } from '../services/GmailWatchService.js';
import {
  decryptChannelCredentialSecret,
  decryptChannelCredentialSession,
  encryptChannelCredentialSecret,
  encryptChannelCredentialSession,
  getChannelCredentialEncryptionKeyId,
} from '../utils/channelCredentialSecrets.js';

const router = Router();
const gmailVerifiers = new WeakMap<Request, string>();
// Check the initiating browser/session before consuming the tenant binding.
router.use('/callback', async (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const state = typeof req.query.state === 'string' ? verifyGmailOAuthState(req.query.state, OAUTH_STATE_SECRET) : null;
  if (!state) return redirectGmailResult(res, 'invalid_or_expired_state');
  const cookie = readAuthCookie(req, `gmail_oauth_${state.nonce}`);
  const [binding, verifier] = cookie?.split('.') || [];
  const challenge = verifier ? crypto.createHash('sha256').update(verifier).digest('base64url') : '';
  if (verifier && challenge !== state.pkceChallenge) return redirectGmailResult(res, 'session_changed');
  const session = readAuthCookie(req, AUTH_COOKIES.user);
  // A same-origin Next proxy sets host-only cookies on the frontend, while
  // Google may return to the registered API hostname. Hand the code to that
  // trusted frontend API proxy once; verify cookies there before any exchange.
  // The OAuth client's registered redirect URI remains unchanged.
  if (!cookie && (!session || gmailSessionHash(session) === state.sessionHash) && req.query.gmail_handoff !== '1') {
    try {
      const destination = new URL(gmailReturnUrl('true', true));
      if (req.get('host') === state.callbackHost && req.get('host') !== destination.host) {
        destination.pathname = '/api/gmail/oauth/callback';
        destination.search = '';
        destination.searchParams.set('state', String(req.query.state));
        destination.searchParams.set('gmail_handoff', '1');
        if (typeof req.query.code === 'string') destination.searchParams.set('code', req.query.code);
        if (typeof req.query.error === 'string') destination.searchParams.set('error', req.query.error === 'access_denied' ? 'access_denied' : 'provider_error');
        return res.redirect(destination.toString());
      }
    } catch { return redirectGmailResult(res, 'oauth_unavailable'); }
  }
  if (binding !== gmailSessionHash(String(req.query.state)) || !verifier || !session || gmailSessionHash(session) !== state.sessionHash) {
    return redirectGmailResult(res, 'session_changed');
  }
  try {
    // Callback authentication skips the current business picker, but must still
    // reject expired/revoked sessions and accounts changed during consent.
    const actor = verifyToken(session) as (ReturnType<typeof verifyToken> & { jti?: string }) | null;
    if (!actor || actor.userId !== state.actorUserId || actor.adminId || actor.supportMemberId
      || (actor.jti && await isTokenRevoked(actor.jti))) return redirectGmailResult(res, 'session_changed');
    const user = await withSystemScope('Validate Gmail OAuth browser actor', () => getUserById(state.actorUserId));
    if (!user || user.deletedAt || (user.passwordChangedAt && actor.iat && actor.iat * 1000 < user.passwordChangedAt.getTime())) {
      return redirectGmailResult(res, 'session_changed');
    }
  } catch { return redirectGmailResult(res, 'oauth_unavailable'); }
  gmailVerifiers.set(req, verifier);
  res.clearCookie(`gmail_oauth_${state.nonce}`, gmailStateCookieOptions());
  return next();
}, consumeOAuthBusinessScope((res, code) => redirectGmailResult(res, code)));

/**
 * Internal helper: set up Gmail Pub/Sub watch for a user.
 * Called automatically after OAuth connect and from the manual POST /watch endpoint.
 */
export async function setupGmailWatchForUser(userId: number, gmailClient: ReturnType<typeof google.gmail>, credentialId: number): Promise<void> {
  // Inbox notification configuration is independent of the OAuth redirect.
  const adminCred = await getActiveAdminCredential('gmail_oauth');
  const watchConfig = adminCred?.config as { pubsubTopic?: string; topicName?: string } | undefined;
  const topicName = watchConfig?.pubsubTopic || watchConfig?.topicName;
  if (!topicName) {
    throw new Error('Configure the Gmail Pub/Sub topic before enabling notifications');
  }

  const watchResponse = await gmailClient.users.watch({
    userId: 'me',
    requestBody: {
      topicName,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    },
  });

  const expiration = watchResponse.data.expiration;
  const historyId = watchResponse.data.historyId;

  await persistGmailWatch(userId, credentialId, expiration, historyId);

  logger.info({ userId, expiration, historyId }, '[GmailOAuth] Watch set up automatically after OAuth connect');
}

const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET || '';

function gmailStateCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/api/' };
}

function redirectGmailResult(res: Response, code: string, success = false, diagnostic?: ReturnType<typeof gmailConnectionFailure>) {
  const reference = success ? undefined : crypto.randomUUID();
  const scope = currentBusinessScope();
  if (!success) logger.error({
    ...diagnostic,
    failureCode: code,
    failureStage: diagnostic?.failureStage || 'session',
    gmailDiagnosticId: reference,
    userId: scope?.userId,
    businessProfileId: scope?.businessProfileId,
  }, '[GmailOAuth] Connection failed');
  try {
    const destination = new URL(gmailReturnUrl(code, success, scope?.businessProfileId));
    if (reference) {
      destination.searchParams.set('gmail_error_ref', reference);
      destination.searchParams.set('gmail_error_stage', diagnostic?.failureStage || 'session');
    }
    return res.redirect(destination.toString());
  } catch {
    return res.status(503).send('Gmail connection return URL is unavailable. Ask the app administrator to check CLIENT_URL or FRONTEND_URL.');
  }
}

async function signOAuthState(req: Request, res: Response, userId: number, config: GmailOAuthConfig): Promise<string> {
  const session = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : readAuthCookie(req, AUTH_COOKIES.user);
  if (!session) throw new Error('An authenticated browser session is required');
  // The auth middleware accepts Bearer before cookies. Bind the browser to that
  // same verified session even when an older account cookie is still present.
  if (req.headers.authorization?.startsWith('Bearer ')) setAuthCookie(res, AUTH_COOKIES.user, session);
  const pkce = createOAuthPkce();
  const state = await rememberOAuthBusinessState(signGmailOAuthState({
    userId,
    actorUserId: req.user!.id,
    nonce: crypto.randomBytes(16).toString('hex'),
    ts: Date.now(),
    sessionHash: gmailSessionHash(session),
    pkceChallenge: pkce.challenge,
    configHash: gmailConfigHash(config, OAUTH_STATE_SECRET),
    callbackHost: new URL(config.redirectUri!).host,
  }, OAUTH_STATE_SECRET));
  const payload = verifyGmailOAuthState(state, OAUTH_STATE_SECRET)!;
  res.cookie(`gmail_oauth_${payload.nonce}`, `${gmailSessionHash(state)}.${pkce.verifier}`, { ...gmailStateCookieOptions(), maxAge: GMAIL_STATE_MAX_AGE_MS });
  return state;
}

/**
 * Get default Gmail OAuth credentials from admin panel DB (no env fallback)
 */
export async function getDefaultGmailCredentials(): Promise<{ clientId: string; clientSecret: string; redirectUri?: string; topicName?: string }> {
  const adminCred = await getActiveAdminCredential('gmail_oauth');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = adminCred?.config as any;
  return {
    clientId: adminCred?.apiKey || '',
    clientSecret: adminCred?.apiSecret || '',
    redirectUri: resolveGmailRedirectUri(config?.redirectUri),
    // Admin UI stores as 'pubsubTopic'; also support legacy 'topicName'
    topicName: config?.pubsubTopic || config?.topicName || '',
  };
}

// Gmail API scopes
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

/**
 * Get user's Gmail OAuth config from database
 */
async function getUserGmailConfig(userId: number): Promise<{ clientId: string; clientSecret: string; redirectUri?: string } | null> {
  const config = await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_config');
  if (config?.sessionData && typeof config.sessionData === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = decryptChannelCredentialSession(config.sessionData) as any;
    if (data.clientId && data.clientSecret) {
      return { 
        clientId: data.clientId, 
        clientSecret: data.clientSecret,
        redirectUri: resolveGmailRedirectUri(data.redirectUri),
      };
    }
  }
  return null;
}

async function resolveUserGmailConfig(userId: number) {
  const userConfig = await getUserGmailConfig(userId);
  return userConfig ? { ...userConfig, source: 'user' as const } : { ...await getDefaultGmailCredentials(), source: 'default' as const };
}

async function resolveCredentialGmailConfig(userId: number, credential: { sessionData?: unknown }) {
  const metadata = decryptChannelCredentialSession(credential.sessionData) as { oauthClientId?: string; oauthConfigSource?: string } | null;
  const config = metadata?.oauthConfigSource === 'default'
    ? { ...await getDefaultGmailCredentials(), source: 'default' as const }
    : await resolveUserGmailConfig(userId);
  if (metadata?.oauthClientId && metadata.oauthClientId !== config.clientId) {
    throw Object.assign(new Error('Gmail OAuth client changed; reconnect this mailbox'), { code: 'GMAIL_OAUTH_CLIENT_CHANGED' });
  }
  return config;
}

function gmailAccessToken(credential: { accessToken?: string | null }): string {
  return decryptChannelCredentialSecret(credential.accessToken);
}

function gmailRefreshToken(credential: { refreshToken?: string | null }): string {
  return decryptChannelCredentialSecret(credential.refreshToken);
}

/**
 * Create OAuth2 client with user-specific credentials
 */
function createOAuth2Client(clientId?: string, clientSecret?: string, redirectUri?: string) {
  if (!clientId || !clientSecret) {
    throw new Error('Gmail OAuth credentials not configured. Please add your Google OAuth Client ID and Secret in Settings → Integrations → Gmail');
  }
  return new google.auth.OAuth2(clientId, clientSecret, resolveGmailRedirectUri(redirectUri));
}

/**
 * Get Gmail OAuth status
 * GET /api/gmail/oauth/status
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if user has OAuth config
    const userConfig = await getUserGmailConfig(userId);
    const hasConfig = !!userConfig;
    const defaultConfig = userConfig ? null : await getDefaultGmailCredentials();
    const hasDefaultConfig = !!defaultConfig?.clientId && !!defaultConfig?.clientSecret;

    // Check if Gmail credentials exist for user
    let credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_api');

    if (!credential) {
      return res.json({
        connected: false,
        email: null,
        tokenExpired: false,
        expiresAt: null,
        hasConfig,
        configSource: userConfig ? 'user' : (hasDefaultConfig ? 'default' : 'none'),
      });
    }

    let oauthConfig: Awaited<ReturnType<typeof resolveCredentialGmailConfig>>;
    try {
      const config = oauthConfig = await resolveCredentialGmailConfig(userId, credential);
      if (!config.clientId || !config.clientSecret) throw new Error('Gmail configuration unavailable');
    } catch (error) {
      if ((error as { code?: string })?.code !== 'GMAIL_OAUTH_CLIENT_CHANGED') throw error;
      return res.json({ connected: false, requiresReconnect: true, connectionState: 'reconnect_required',
        readinessErrorCode: 'GMAIL_OAUTH_CLIENT_CHANGED', email: credential.accountIdentifier,
        tokenExpired: false, hasConfig, configSource: userConfig ? 'user' : (hasDefaultConfig ? 'default' : 'none') });
    }
    let tokenExpired = Boolean(credential.tokenExpiry && credential.tokenExpiry.getTime() <= Date.now());
    if (!credential.tokenExpiry || credential.tokenExpiry.getTime() <= Date.now() + 60_000) {
      const refreshed = await refreshGmailCredential(userId, credential.id, credential.accountIdentifier || '', oauthConfig);
      if (!refreshed.credential) return res.json({ connected: false, requiresReconnect: refreshed.reconnectRequired,
        connectionState: refreshed.reconnectRequired ? 'reconnect_required' : 'disconnected', email: credential.accountIdentifier,
        tokenExpired, expiresAt: credential.tokenExpiry?.toISOString() || null, hasConfig,
        configSource: userConfig ? 'user' : (hasDefaultConfig ? 'default' : 'none') });
      credential = refreshed.credential;
      tokenExpired = Boolean(credential.tokenExpiry && credential.tokenExpiry.getTime() <= Date.now());
    }
    const watch = gmailWatchHealth(decryptChannelCredentialSession(credential.sessionData) as Record<string, unknown> | null);
    const health = await db.execute(sql`SELECT gmail_cooldown_until,gmail_sync_due_at,gmail_sync_failures,gmail_sync_history_id
      FROM channel_credentials WHERE id=${credential.id} AND user_id=${userId} AND platform='gmail_api' AND is_active IS TRUE`);
    const row = health.rows[0] || {};
    const cooldownUntil = safeGmailHealthDate(row.gmail_cooldown_until);
    const rateLimited = Boolean(cooldownUntil && Date.parse(cooldownUntil) > Date.now());
    return res.json({
      connected: !tokenExpired,
      connectionState: tokenExpired ? 'reconnect_required' : rateLimited ? 'rate_limited' : 'connected',
      requiresReconnect: tokenExpired,
      cooldownUntil: rateLimited ? cooldownUntil : null,
      syncPending: row.gmail_sync_history_id != null,
      syncRetryAt: safeGmailHealthDate(row.gmail_sync_due_at),
      syncFailures: Math.max(0, Number(row.gmail_sync_failures) || 0),
      email: credential.accountIdentifier,
      accountName: credential.accountName,
      tokenExpired,
      expiresAt: credential.tokenExpiry?.toISOString() || null,
      lastUsedAt: credential.lastUsedAt?.toISOString() || null,
      hasConfig,
      configSource: userConfig ? 'user' : (hasDefaultConfig ? 'default' : 'none'),
      ...watch,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[GmailOAuth] Error checking status');
    return res.status(503).json({ code: 'GMAIL_STATUS_UNAVAILABLE', error: 'Gmail status is temporarily unavailable. Try again.' });
  }
});

/**
 * Save Gmail OAuth config (Client ID and Secret)
 * POST /api/gmail/oauth/config
 */
router.post('/config', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { clientId, clientSecret } = req.body;
    
    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'Client ID and Client Secret are required' });
    }

    // Validate the credentials by attempting to create an OAuth client
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const testClient = new google.auth.OAuth2(clientId, clientSecret, resolveGmailRedirectUri());
      // Basic validation passed
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      return res.status(400).json({ error: 'Invalid OAuth credentials format' });
    }

    // Store config in database
    await ChannelCredentialModel.upsert({
      userId,
      platform: 'gmail_config',
      credentialType: 'oauth_config',
      accessToken: 'oauth_config_not_authorized',
      isActive: true,
      sessionData: encryptChannelCredentialSession({
        clientId,
        clientSecret,
      }),
    });

    return res.json({
      success: true,
      message: 'Gmail OAuth configuration saved',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[GmailOAuth] Error saving config');
    return res.status(500).json({ error: 'Unable to save Gmail configuration. Please try again.' });
  }
});

/**
 * Get Gmail OAuth config status
 * GET /api/gmail/oauth/config
 */
router.get('/config', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userConfig = await getUserGmailConfig(userId);
    const adminCred = await getActiveAdminCredential('gmail_oauth');
    const hasDefaultConfig = !!adminCred?.apiKey && !!adminCred?.apiSecret;

    return res.json({
      hasUserConfig: !!userConfig,
      hasDefaultConfig,
      clientIdPreview: userConfig ? `${userConfig.clientId.substring(0, 20)}...` : null,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[GmailOAuth] Error getting config');
    return res.status(500).json({ error: 'Unable to retrieve Gmail configuration. Please try again.' });
  }
});

/**
 * Delete Gmail OAuth config
 * DELETE /api/gmail/oauth/config
 */
router.delete('/config', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await ChannelCredentialModel.delete(userId, 'gmail_config');

    return res.json({
      success: true,
      message: 'Gmail OAuth configuration deleted',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[GmailOAuth] Error deleting config');
    return res.status(500).json({ error: 'Unable to delete Gmail configuration. Please try again.' });
  }
});

/**
 * Start Gmail OAuth authorization - returns auth URL instead of redirecting
 * GET /api/gmail/oauth/authorize
 * GET /api/gmail/oauth/auth-url (alias for client compatibility)
 */
router.get(['/authorize', '/auth-url'], requireBusinessManager, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!OAUTH_STATE_SECRET) {
      return res.status(503).json({ error: 'OAuth signing is not configured' });
    }

    // Validate both public URL contracts before creating a connection session.
    try { gmailReturnUrl('true', true); } catch {
      return res.status(503).json({ code: 'GMAIL_RETURN_URL_NOT_CONFIGURED', error: 'Gmail sign-in return URL is unavailable. Ask the app administrator to check CLIENT_URL or FRONTEND_URL.' });
    }
    let config: Awaited<ReturnType<typeof resolveUserGmailConfig>>;
    try { config = await resolveUserGmailConfig(userId); } catch {
      return res.status(503).json({ code: 'GMAIL_OAUTH_CONFIGURATION_INVALID', error: 'Gmail sign-in configuration is unavailable. Ask the app administrator to check the OAuth callback and client settings.' });
    }
    const { clientId, clientSecret, redirectUri } = config;

    if (!clientId || !clientSecret) {
      return res.status(400).json({ 
        error: 'Gmail OAuth not configured. Please provide your Google OAuth Client ID and Secret first.',
        needsConfig: true 
      });
    }

    const oauth2Client = createOAuth2Client(clientId, clientSecret, redirectUri);

    // Generate authorization URL
    const state = await signOAuthState(req, res, userId, config);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // Force consent to get refresh token
      scope: GMAIL_SCOPES,
      state,
      code_challenge: verifyGmailOAuthState(state, OAUTH_STATE_SECRET)!.pkceChallenge,
      code_challenge_method: 'S256' as import('google-auth-library').CodeChallengeMethod,
    });

    // Return JSON with auth URL instead of redirecting
    // Include both 'authUrl' (legacy) and 'url' (expected by client)
    return res.json({
      success: true,
      authUrl,
      url: authUrl,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ userId: req.user?.id }, '[GmailOAuth] Error starting authorization');
    return res.status(500).json({ error: 'Unable to start Gmail authorization. Please try again.' });
  }
});

/**
 * Gmail OAuth callback
 * GET /api/gmail/oauth/callback
 */
router.get('/callback', async (req: Request, res: Response) => {
  let stage: GmailConnectionStage = 'session';
  const reject = (code: string) => redirectGmailResult(res, code, false, { ...gmailConnectionFailure(undefined, stage), failureCode: code });
  const fail = (error: unknown) => {
    const diagnostic = gmailConnectionFailure(error, stage);
    return redirectGmailResult(res, diagnostic.failureCode, false, diagnostic);
  };
  try {
    const { code, state, error: authError } = req.query;

    const verifiedState = typeof state === 'string' ? verifyGmailOAuthState(state, OAUTH_STATE_SECRET) : null;
    const scope = currentBusinessScope();
    if (!verifiedState || !scope || verifiedState.userId !== scope.userId || verifiedState.actorUserId !== (scope.actorUserId ?? scope.userId)) {
      return reject('invalid_or_expired_state');
    }
    if (authError) return reject(authError === 'access_denied' ? 'access_denied' : 'connection_failed');
    if (typeof code !== 'string' || !code) return reject('missing_code');
    const userId = verifiedState.userId;
    stage = 'configuration';
    const config = await resolveUserGmailConfig(userId);
    const { clientId, clientSecret, redirectUri } = config;
    if (!clientId || !clientSecret) return reject('no_config');
    if (gmailConfigHash(config, OAUTH_STATE_SECRET) !== verifiedState.configHash) {
      return reject('configuration_changed');
    }

    // Exchange code for tokens
    stage = 'token_exchange';
    const oauth2Client = createOAuth2Client(clientId, clientSecret, redirectUri);
    configureGmailConnectionTransport(oauth2Client);
    let tokens;
    try { ({ tokens } = await oauth2Client.getToken({ code, codeVerifier: gmailVerifiers.get(req), redirect_uri: redirectUri })); } catch (error) {
      return fail(error);
    }

    if (!tokens.access_token) {
      return reject('token_exchange_failed');
    }

    // Google can grant only a subset of requested scopes. Verify before saving
    // a sender; a profile lookup alone does not prove sending permission.
    stage = 'permissions';
    const grantedScopes = typeof tokens.scope === 'string'
      ? tokens.scope.split(/\s+/).filter(Boolean)
      : (await oauth2Client.getTokenInfo(tokens.access_token)).scopes;
    const canSend = grantedScopes.some(value => ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'].includes(value));
    const canRead = grantedScopes.some(value => ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'].includes(value));
    if (!canSend || !canRead) {
      return reject('missing_scopes');
    }

    // Set credentials to get user info
    oauth2Client.setCredentials(tokens);

    // Get user profile from Gmail API
    stage = 'mailbox_profile';
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await readGmailConnection(() => gmail.users.getProfile({ userId: 'me' }, { timeout: 5000, retry: false }));
    const emailAddress = profile.data.emailAddress?.trim().toLowerCase();
    if (!emailAddress) throw new Error('Gmail did not return a mailbox address');

    // Also get display name from people API
    const people = google.people({ version: 'v1', auth: oauth2Client });
    let displayName = emailAddress;
    try {
      const person = await people.people.get({
        resourceName: 'people/me',
        personFields: 'names,emailAddresses',
      }, { timeout: 3000, retry: false });
      displayName = person.data.names?.[0]?.displayName || emailAddress;
    } catch {
      logger.info('[GmailOAuth] Could not get display name');
    }

    // Calculate token expiry
    const expiresAt = tokens.expiry_date 
      ? new Date(tokens.expiry_date) 
      : new Date(Date.now() + 3600 * 1000); // Default 1 hour

    // Google does not always return a new refresh token after a reconnect.
    // Preserve the existing one so an otherwise-successful reconnect cannot
    // silently turn into a one-hour-only connection.
    stage = 'credential_save';
    const existingCredential = await ChannelCredentialModel.findActiveAccountByIdentifier(userId, 'gmail_api', emailAddress);
    const existingMetadata = decryptChannelCredentialSession(existingCredential?.sessionData) as { oauthClientId?: string } | null;
    const refreshToken = tokens.refresh_token || (existingCredential && existingMetadata?.oauthClientId === clientId ? gmailRefreshToken(existingCredential) : '') || undefined;
    if (!refreshToken) return reject('missing_refresh_token');

    // Store credentials in database
    const savedCredential = await ChannelCredentialModel.upsert({
      userId,
      platform: 'gmail_api',
      credentialType: 'oauth',
      accessToken: encryptChannelCredentialSecret(tokens.access_token),
      refreshToken: encryptChannelCredentialSecret(refreshToken),
      tokenExpiry: expiresAt,
      accountIdentifier: emailAddress || '',
      accountName: displayName || '',
      isActive: true,
      encryptionVersion: 'secrets-manager-v1',
      encryptionKeyId: getChannelCredentialEncryptionKeyId(),
      encryptedAt: new Date(),
      grantedScopes,
      providerApprovalStatus: 'approved',
      providerVerifiedAt: new Date(),
      lastReadinessCheckAt: new Date(),
      readinessErrorCode: null,
      // Preserve live watch/cursor metadata on reconnect. Rewriting a snapshot
      // here could roll back a webhook cursor advanced during the OAuth flow.
      ...(!existingCredential ? { sessionData: encryptChannelCredentialSession({
        scope: tokens.scope,
        tokenType: tokens.token_type,
        oauthClientId: clientId,
        oauthConfigSource: config.source,
      }) } : {}),
    });

    if (existingCredential) {
      // Merge only issuing-client metadata: never roll back a concurrently
      // advanced inbox watch/history cursor with an old JSON snapshot.
      await db.execute(sql`UPDATE channel_credentials
        SET session_data = COALESCE(session_data, '{}'::jsonb) || ${JSON.stringify({ oauthClientId: clientId, oauthConfigSource: config.source })}::jsonb
        WHERE id = ${savedCredential.id} AND user_id = ${userId} AND platform = 'gmail_api'`);
    }
    // OAuth is the Gmail sender setup. Make the newly authorized mailbox the
    // default so an older Gmail sender cannot silently handle new messages.
    stage = 'sender_setup';
    const EmailSenderModel = await import('../models/emailSenders/functions');
    const existingSender = await EmailSenderModel.findByCredential(userId, savedCredential.id)
      || await EmailSenderModel.findByEmailAndType(userId, emailAddress, 'gmail');
    const sender = existingSender
      ? await EmailSenderModel.update(userId, existingSender.id, {
          credentialId: savedCredential.id,
          email: emailAddress,
          displayName: displayName || emailAddress,
          isVerified: true,
        })
      : await EmailSenderModel.create({
          userId,
          type: 'gmail',
          label: `Gmail - ${emailAddress}`,
          email: emailAddress,
          displayName: displayName || emailAddress,
          isVerified: true,
          credentialId: savedCredential.id,
        });
    if (sender) await EmailSenderModel.setDefault(userId, sender.id);
    logger.info({ userId }, '[GmailOAuth] Successfully connected Gmail');

    // Automatically set up Pub/Sub watch so inbound emails are received immediately
    try {
      await setupGmailWatchForUser(userId, gmail, savedCredential.id);
    } catch (error) {
      await persistGmailWatchFailure(userId, savedCredential.id).catch(() => undefined);
      logger.warn({ userId, gmailDiagnosticId: crypto.randomUUID(), ...gmailConnectionFailure(error, 'inbox_watch') }, '[GmailOAuth] Auto-watch setup failed after OAuth — user can retry via Watch button');
    }

    // Redirect back to Gmail integrations page with success
    return redirectGmailResult(res, 'true', true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return reject('connection_capacity_exceeded');
    return fail(error);
  }
});

/**
 * Refresh Gmail access token
 * POST /api/gmail/oauth/refresh
 */
router.post('/refresh', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_api');
    if (!credential) return res.status(409).json({ code: 'GMAIL_RECONNECT_REQUIRED', error: 'Reconnect this Gmail mailbox.' });
    const config = await resolveCredentialGmailConfig(userId, credential);
    const result = await refreshGmailCredential(userId, credential.id, credential.accountIdentifier || '', config);
    if (!result.credential) return res.status(409).json({ code: 'GMAIL_RECONNECT_REQUIRED', error: 'Gmail authorization expired or was revoked. Reconnect this mailbox.' });
    return res.json({ success: true, message: 'Gmail authorization is current', expiresAt: result.credential.tokenExpiry?.toISOString() });
  } catch (error) {
    if ((error as { code?: string })?.code === 'GMAIL_OAUTH_CLIENT_CHANGED') {
      return res.status(409).json({ code: 'GMAIL_OAUTH_CLIENT_CHANGED', error: 'Gmail sign-in settings changed. Reconnect this mailbox.' });
    }
    logger.warn({ userId: req.user?.id }, '[GmailOAuth] Refresh unavailable');
    return res.status(503).json({ code: 'GMAIL_REFRESH_UNAVAILABLE', error: 'Gmail authorization could not be checked. Try again.' });
  }
});

/**
 * Disconnect Gmail
 * POST /api/gmail/oauth/disconnect
 */
router.post('/disconnect', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const result = await disconnectGmailAccounts(userId);
    return res.json({ success: true, message: 'Gmail disconnected locally', ...result });
  } catch {
    return res.status(503).json({ error: 'Gmail disconnect could not finish. Check connection status and try again.' });
  }
});

// Gmail Pub/Sub webhook handler has been moved to gmailWebhookController.ts
// It is mounted directly in routes.ts WITHOUT auth middleware.

/**
 * Setup Gmail Push Notifications (Watch)
 * POST /api/gmail/oauth/watch
 * 
 * Sets up push notifications for a user's Gmail account
 */
router.post('/watch', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const clientResult = await getGmailClientForUser(userId);
    if (!clientResult) {
      return res.status(400).json({ error: 'Gmail not connected' });
    }

    const { client } = clientResult;
    const gmail = guardGmailClient(google.gmail({ version: 'v1', auth: client, retry: false, timeout: 30_000 }), { userId, credentialId: clientResult.credential.id, emailAddress: clientResult.credential.accountIdentifier || '' });

    await setupGmailWatchForUser(userId, gmail, Number(clientResult.credential.id));

    // Read back the stored expiration for the response
    const credResult = await db.execute(
      sql`SELECT session_data FROM channel_credentials WHERE id = ${Number(clientResult.credential.id)}
        AND user_id = ${userId} AND platform = 'gmail_api' AND is_active IS TRUE`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = (credResult.rows[0] as any)?.session_data || {};

    return res.json({
      success: true,
      message: 'Gmail push notifications enabled',
      expiration: session.watchExpiration ? new Date(parseInt(session.watchExpiration)).toISOString() : null,
      historyId: session.lastHistoryId,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[GmailOAuth] Watch error');
    return res.status(500).json({ error: 'Unable to set up Gmail notifications. Please try again.' });
  }
});

/**
 * Stop Gmail Push Notifications (Stop Watch)
 * POST /api/gmail/oauth/unwatch
 */
router.post('/unwatch', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const clientResult = await getGmailClientForUser(userId);
    if (!clientResult) {
      return res.status(400).json({ error: 'Gmail not connected' });
    }

    const { client } = clientResult;
    const gmail = guardGmailClient(google.gmail({ version: 'v1', auth: client, retry: false, timeout: 30_000 }), { userId, credentialId: clientResult.credential.id, emailAddress: clientResult.credential.accountIdentifier || '' });

    await gmail.users.stop({ userId: 'me' });

    // Clear watch data from session
    await db.execute(
      sql`UPDATE channel_credentials 
          SET session_data = session_data - 'watchExpiration' - 'watchRenewalStatus' - 'watchRenewalRetryAfter' - 'watchRenewalError',
          updated_at = NOW()
          WHERE id = ${Number(clientResult.credential.id)} AND user_id = ${userId}
            AND platform = 'gmail_api' AND is_active IS TRUE`
    );

    return res.json({
      success: true,
      message: 'Gmail push notifications disabled',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[GmailOAuth] Unwatch error');
    return res.status(500).json({ error: 'Unable to stop Gmail notifications. Please try again.' });
  }
});

/**
 * Get Gmail watch status for the authenticated user
 * GET /api/gmail/oauth/watch/status
 */
router.get('/watch/status', async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_api');
    if (!credential) return res.json({ connected: false, watchActive: false, status: 'not_connected' });
    const session = decryptChannelCredentialSession(credential.sessionData) as Record<string, unknown> | null;
    const health = gmailWatchHealth(session);
    return res.json({ connected: true, watchActive: ['active', 'expiring_soon'].includes(health.watchStatus),
      status: health.watchStatus, emailAddress: credential.accountIdentifier, expiresAt: health.watchExpiresAt,
      watchRenewalStatus: health.watchRenewalStatus, watchRetryAt: health.watchRetryAt, lastHistoryId: session?.lastHistoryId || null });
  } catch {
    return res.status(503).json({ error: 'Gmail reply sync status is temporarily unavailable.' });
  }
});

/**
 * Get Gmail OAuth client for a user (helper for other services)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function refreshGmailCredential(userId: number, credentialId: number, accountIdentifier: string, config: Awaited<ReturnType<typeof resolveCredentialGmailConfig>>) {
  return refreshChannelCredential({ userId, credentialId, platform: 'gmail_api', accountIdentifier }, async credential => {
    const metadata = decryptChannelCredentialSession(credential.sessionData) as { oauthClientId?: string } | null;
    if (metadata?.oauthClientId && metadata.oauthClientId !== config.clientId) throw Object.assign(new Error('Gmail OAuth client changed'), { code: 'GMAIL_OAUTH_CLIENT_CHANGED' });
    const client = createOAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
    configureGmailConnectionTransport(client);
    client.setCredentials({ refresh_token: gmailRefreshToken(credential) });
    const { credentials } = await client.refreshAccessToken();
    if (!credentials.access_token) throw new Error('Gmail refresh returned no access token');
    return { accessToken: credentials.access_token, refreshToken: credentials.refresh_token || undefined,
      expiresAt: new Date(credentials.expiry_date || Date.now() + 3600_000) };
  });
}

export async function getGmailClientForUser(userId: number, binding?: { credentialId: number; accountIdentifier: string }): Promise<{ client: import('google-auth-library').OAuth2Client; credential: import('../models/channelCredentials/schema.js').ChannelCredentialRecord } | null> {
  try {
    let credential = binding
      ? (await db.select().from(channelCredentialsTable).where(and(
          eq(channelCredentialsTable.id, binding.credentialId), eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'gmail_api'), eq(channelCredentialsTable.isActive, true),
          sql`LOWER(TRIM(${channelCredentialsTable.accountIdentifier})) = ${binding.accountIdentifier.trim().toLowerCase()}`,
        )).limit(1))[0]
      : await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_api');
    if (!credential?.accessToken) return null;
    // Resolve even for unexpired tokens: an old issuing client is not usable.
    const initialConfig = await resolveCredentialGmailConfig(userId, credential);
    if (!credential.tokenExpiry || new Date(credential.tokenExpiry).getTime() <= Date.now() + 60_000) {
      credential = (await refreshGmailCredential(userId, credential.id, credential.accountIdentifier || '', initialConfig)).credential;
      if (!credential) return null;
    }
    const config = await resolveCredentialGmailConfig(userId, credential);
    const client = createOAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
    configureGmailConnectionTransport(client);
    // Refresh only through the locked persistence path. The SDK must not retry
    // a message POST with an unpersisted refresh after an unexpected 401.
      configureGmailPersistedTokenClient(client);
    client.setCredentials({ access_token: gmailAccessToken(credential), expiry_date: credential.tokenExpiry?.getTime() });
    return { client, credential: { ...credential, accessToken: gmailAccessToken(credential), refreshToken: gmailRefreshToken(credential) || null } };
  } catch {
    logger.warn({ userId }, '[GmailOAuth] Gmail authorization unavailable');
    return null;
  }
}

export default router;
