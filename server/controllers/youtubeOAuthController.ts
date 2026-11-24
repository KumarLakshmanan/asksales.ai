import { requireBusinessManager } from '../middleware/businessPermissions.js';
import { beginOAuthBrowserFlow, oauthBrowserCallback, oauthBrowserFlow, requireOAuthConfiguration } from '../services/OAuthBrowserFlowService.js';
import { configureGmailConnectionTransport } from '../utils/gmailOAuthDiagnostics.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { rememberOAuthBusinessState } from '../tenancy/oauthBusinessScope.js';
/**
 * YouTube OAuth Controller
 * Handles YouTube OAuth authentication flow for video publishing
 */

import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import { decryptValue, encryptValue } from '../services/SecretsManager.js';
import { getIntegrationOAuthCallbackUrl } from '../utils/integrationUrls.js';
import { and, eq } from 'drizzle-orm';
import { db } from '../models/db.js';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';

const router = Router();
router.use('/callback', oauthBrowserCallback('youtube', (res, code) => res.redirect(`${CLIENT_URL}/dashboard/integrations/youtube?youtube_error=${encodeURIComponent(code)}`)));

const CLIENT_URL = process.env.CLIENT_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  // Management, captions, thumbnails, playlists, and comment moderation.
  'https://www.googleapis.com/auth/youtube.force-ssl',
  // Kept separate so the server can reject analytics requests until it is granted.
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  // The Analytics Reports API also documents read-only YouTube account access.
  'https://www.googleapis.com/auth/youtube.readonly',
];

const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

async function signState(userId: number): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ userId, nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now() })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET || '').update(payload).digest('base64url');
  return rememberOAuthBusinessState(`${payload}.${signature}`);
}

function verifyState(value: string): number | null {
  try {
    const [payload, signature] = value.split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET || '').update(payload).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { userId?: number; ts?: number };
    if (!parsed.userId || !parsed.ts || Date.now() - parsed.ts > OAUTH_STATE_MAX_AGE_MS) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}

/**
 * Get YouTube OAuth credentials from admin panel DB
 */
async function getYouTubeCredentials(): Promise<{ clientId: string; clientSecret: string; redirectUri: string }> {
  // Try to use Gmail OAuth credentials (same Google Cloud project)
  const adminCred = await getActiveAdminCredential('gmail_oauth');
  
  const clientId = adminCred?.apiKey || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  const clientSecret = adminCred?.apiSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  
  return {
    clientId,
    clientSecret,
    redirectUri: getIntegrationOAuthCallbackUrl('youtube'),
  };
}

/**
 * Generate YouTube OAuth URL
 * GET /api/youtube/oauth/auth
 */
router.get('/auth', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    const { clientId, clientSecret, redirectUri } = await getYouTubeCredentials();
    
    if (!clientId || !clientSecret || !(process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET)) {
      return res.status(500).json({ error: 'YouTube OAuth credentials not configured' });
    }

    // Use user ID from auth token as state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const oauth2Client = new google.auth.OAuth2(clientId, '', redirectUri);
    
    const state = await signState(userId);
    const browser = await beginOAuthBrowserFlow(req,res,'youtube',state,redirectUri,[clientId,clientSecret,redirectUri],true);
    const authUrl = oauth2Client.generateAuthUrl({
      code_challenge: browser.codeChallenge,
      code_challenge_method: 'S256' as import('google-auth-library').CodeChallengeMethod,
      access_type: 'offline',
      scope: YOUTUBE_SCOPES,
      state,
      prompt: 'consent',
    });

    res.json({ authUrl });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ error }, '[YouTubeOAuth] Error generating auth URL');
    res.status(500).json({ error: 'Unable to start the YouTube connection. Please try again.' });
  }
});

/**
 * YouTube OAuth callback
 * GET /api/youtube/oauth/callback
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error: authError } = req.query;

    if (authError) {
      logger.error({ authError }, '[YouTubeOAuth] Authorization error');
      return res.redirect(`${CLIENT_URL}/dashboard/integrations/youtube?youtube_error=${encodeURIComponent(authError as string)}`);
    }

    if (!code || !state) {
      return res.redirect(`${CLIENT_URL}/dashboard/integrations/youtube?youtube_error=missing_code`);
    }

    const userId = verifyState(String(state));
    if (!userId) {
      return res.redirect(`${CLIENT_URL}/dashboard/integrations/youtube?youtube_error=invalid_or_expired_state`);
    }

    const { clientId, clientSecret, redirectUri } = await getYouTubeCredentials();
    
    if (!clientId || !clientSecret) {
      return res.redirect(`${CLIENT_URL}/dashboard/integrations/youtube?youtube_error=no_config`);
    }

    // Exchange code for tokens
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    requireOAuthConfiguration(req,[clientId,clientSecret,redirectUri]);
    configureGmailConnectionTransport(oauth2Client);
    const { tokens } = await oauth2Client.getToken({ code: code as string, codeVerifier: oauthBrowserFlow(req).codeVerifier, redirect_uri: redirectUri });

    if (!tokens.access_token) {
      return res.redirect(`${CLIENT_URL}/dashboard/integrations/youtube?youtube_error=no_access_token`);
    }

    // Set credentials to retrieve the authorized channel. Do not request
    // Avoid profile/email scopes; channel identity comes from YouTube itself.
    oauth2Client.setCredentials(tokens);

    // Get YouTube channel info
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    let channelId = '';
    let channelTitle = 'YouTube channel';
    
    try {
      const channelsResponse = await youtube.channels.list({
        part: ['snippet', 'contentDetails'],
        mine: true,
      });
      
      if (channelsResponse.data.items && channelsResponse.data.items.length > 0) {
        const channel = channelsResponse.data.items[0];
        channelId = channel.id || '';
        channelTitle = channel.snippet?.title || channelTitle;
      }
    } catch (err) {
      logger.warn({ err }, '[YouTubeOAuth] Could not fetch YouTube channel info');
    }
    if (!channelId) {
      // Do not create an account-less credential: it would make a later
      // reconnect overwrite an unrelated selected channel for this tenant.
      throw new Error('Google did not return a YouTube channel for this authorization. Select a channel-enabled Google account and try again.');
    }

    // Calculate token expiry
    const expiresAt = tokens.expiry_date 
      ? new Date(tokens.expiry_date) 
      : new Date(Date.now() + 3600 * 1000);

    // Google only returns a refresh token on the first consent in many cases.
    // Preserve a still-valid stored refresh token during a reconnect.
    // A Google identity can own more than one YouTube/Brand channel.  A
    // reconnect must only ever reuse the refresh token for the exact channel
    // returned by this consent—not an arbitrary row for the tenant.
    const [existing] = await db.select({ refreshToken: channelCredentialsTable.refreshToken, sessionData: channelCredentialsTable.sessionData })
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'youtube'),
        eq(channelCredentialsTable.accountIdentifier, channelId),
      ))
      .limit(1);

    const previousClientId = (existing?.sessionData as { oauthClientId?: string } | null)?.oauthClientId;
    const refreshToken = tokens.refresh_token ? encryptValue(tokens.refresh_token) : previousClientId === clientId ? existing?.refreshToken : undefined;
    if (!refreshToken) throw new Error('Google did not return offline access for this channel and OAuth client. Reconnect the channel.');

    // Make the channel authorized in this OAuth flow the active target.  The
    // unique partial index allows exactly one selected account per tenant and
    // platform, so clear the former selection before inserting a new channel.
    await db.update(channelCredentialsTable).set({ isSelected: false, updatedAt: new Date() })
      .where(and(eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, 'youtube')));

    // Store credentials in database.
    await ChannelCredentialModel.upsert({
      userId,
      platform: 'youtube',
      credentialType: 'oauth',
      accessToken: encryptValue(tokens.access_token),
      refreshToken,
      tokenExpiry: expiresAt,
      accountIdentifier: channelId,
      accountName: channelTitle,
      isActive: true,
      isSelected: true,
      sessionData: {
        scope: tokens.scope,
        tokenType: tokens.token_type,
        oauthClientId: clientId,
      },
      grantedScopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [],
      providerApprovalStatus: 'not_required',
      providerApiVersion: 'youtube-data-v3',
      providerVerifiedAt: new Date(),
      lastReadinessCheckAt: new Date(),
      readinessErrorCode: null,
    });

    logger.info({ userId, channelId, channelTitle }, '[YouTubeOAuth] Successfully connected YouTube');

    res.redirect(`${CLIENT_URL}/dashboard/integrations/youtube?youtube_connected=true`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.warn('[YouTubeOAuth] Callback could not finish');
    res.redirect(`${CLIENT_URL}/dashboard/integrations/youtube?youtube_error=${encodeURIComponent('connection_failed')}`);
  }
});

/**
 * Get YouTube connection status
 * GET /api/youtube/oauth/status
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const creds = await ChannelCredentialModel.findByUserAndPlatform(userId, 'youtube');
    
    const config = await getYouTubeCredentials();
    const issuingClient = (creds?.sessionData as { oauthClientId?: string } | null)?.oauthClientId;
    const clientChanged = Boolean(issuingClient && issuingClient !== config.clientId);
    const expiredWithoutRefresh = clientChanged || Boolean(creds?.tokenExpiry && new Date(creds.tokenExpiry) <= new Date() && !creds.refreshToken);
    const scopes = typeof (creds?.sessionData as { scope?: unknown } | null)?.scope === 'string'
      ? String((creds?.sessionData as { scope: string }).scope).split(/\s+/).filter(Boolean)
      : [];
    res.json({
      connected: Boolean(creds?.isActive && !expiredWithoutRefresh),
      channelId: creds?.accountIdentifier || null,
      channelName: creds?.accountName || null,
      tokenExpiry: creds?.tokenExpiry || null,
      refreshAvailable: Boolean(creds?.refreshToken),
      readiness: creds?.isActive
        ? (expiredWithoutRefresh ? 'needs_reconnect' : 'ready')
        : 'disconnected',
      scopes,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ error }, '[YouTubeOAuth] Error checking status');
    res.status(500).json({ error: 'Unable to check the YouTube connection. Please try again.' });
  }
});

/**
 * Disconnect YouTube
 * POST /api/youtube/oauth/disconnect
 */
router.post('/disconnect', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const [credential] = await db.select({ accessToken: channelCredentialsTable.accessToken })
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'youtube'),
        eq(channelCredentialsTable.isActive, true),
      ))
      .limit(1);

    // Revocation is best-effort: a local disconnect must never leave the user
    // unable to remove the integration when Google's endpoint is unavailable.
    let revokeWarning: string | undefined;
    if (credential?.accessToken) {
      let token = credential.accessToken;
      try {
        token = token.split(':').length === 3 ? decryptValue(token) : token;
        const revoked = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!revoked.ok) revokeWarning = 'Google authorization could not be revoked remotely. Remove access from your Google Account permissions.';
      } catch (error) {
        logger.warn({ err: error, userId }, '[YouTubeOAuth] Google token revocation failed');
        revokeWarning = 'Google authorization could not be revoked remotely. Remove access from your Google Account permissions.';
      }
    }

    await db
      .update(channelCredentialsTable)
      .set({ isActive: false, deactivationReason: 'user_disconnected', deactivatedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'youtube')
        )
      );
    
    logger.info({ userId }, '[YouTubeOAuth] Disconnected YouTube');
    res.json({ success: true, ...(revokeWarning ? { warning: revokeWarning } : {}) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ error }, '[YouTubeOAuth] Error disconnecting');
    res.status(500).json({ error: 'Unable to disconnect YouTube. Please try again.' });
  }
});

export default router;
