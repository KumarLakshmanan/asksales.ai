import { requireBusinessManager } from '../middleware/businessPermissions.js';
import { beginOAuthBrowserFlow, oauthBrowserCallback, oauthBrowserFlow, requireOAuthConfiguration } from '../services/OAuthBrowserFlowService.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
/**
 * Google Ads OAuth Controller
 * Handles OAuth connection flow for Google Ads using shared admin credentials.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { getCredential, saveCredential } from '../services/credentialService.js';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';
import { logger } from '../utils/logger.js';
import { encryptValue } from '../services/SecretsManager.js';
import { getIntegrationOAuthCallbackUrl } from '../utils/integrationUrls.js';
import { signOAuthState as signState, verifyOAuthState as verifyState, OAUTH_STATE_SECRET as STATE_SECRET } from '../utils/oauthState.js';

const router = Router();
router.use('/callback', oauthBrowserCallback('google_ads', (res, code) => res.redirect(`${FRONTEND_URL}/dashboard/integrations/google-ads?error=${encodeURIComponent(code)}`)));
const FRONTEND_URL = process.env.CLIENT_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

if (!STATE_SECRET) {
  logger.error('[GoogleAdsOAuth] OAUTH_STATE_SECRET / JWT_SECRET must be set');
}

/**
 * Get Google App credentials from admin configurations (shared platform keys)
 */
async function getAdminGoogleCredentials() {
  const credential = await getActiveAdminCredential('gmail_oauth');
  if (credential?.apiKey && credential?.apiSecret) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = credential.config as any;
    return {
      clientId: credential.apiKey,
      clientSecret: credential.apiSecret,
      redirectUri: config?.redirectUri || getIntegrationOAuthCallbackUrl('googleAds'),
    };
  }
  return null;
}

/**
 * GET /api/google-ads/oauth
 * Initiate Google Ads OAuth authorization
 */
router.get('/', requireBusinessManager, async (req: Request, res: Response) => {
  try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!STATE_SECRET) {
    return res.status(503).json({ error: 'OAuth signing is not configured' });
  }

  const googleCreds = await getAdminGoogleCredentials();
  if (!googleCreds) {
    return res.status(500).json({ error: 'Google App not configured by admin. Please contact your administrator.' });
  }

  const state = await signState({ userId, nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now() });
  
  // Scopes required for Google Ads API
  const scope = encodeURIComponent('https://www.googleapis.com/auth/adwords');
  const redirectUri = encodeURIComponent(getIntegrationOAuthCallbackUrl('googleAds'));
  const browser = await beginOAuthBrowserFlow(req,res,'google_ads',state,getIntegrationOAuthCallbackUrl('googleAds'),[googleCreds.clientId,googleCreds.clientSecret,getIntegrationOAuthCallbackUrl('googleAds')],true);

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${googleCreds.clientId}` +
    `&redirect_uri=${redirectUri}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${state}` + `&code_challenge=${browser.codeChallenge}&code_challenge_method=S256`;

  if (req.query.format === 'json') return res.json({ url: authUrl });
  res.redirect(authUrl);
  } catch { return res.status(503).json({ error: 'Provider sign-in is temporarily unavailable. Try again.' }); }
});

/**
 * GET /api/google-ads/oauth/callback
 * Google Ads OAuth Callback handler
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      logger.warn({ code: error === 'access_denied' ? 'access_denied' : 'provider_error' }, '[GoogleAdsOAuth] Google callback error');
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations/google-ads?error=${encodeURIComponent(error === 'access_denied' ? 'access_denied' : 'provider_error')}`);
    }

    if (!code || !state) {
      throw new Error('Missing code or state parameter');
    }

    const stateData = verifyState(state as string);
    if (!stateData) {
      throw new Error('Invalid or expired state parameter');
    }
    const userId = stateData.userId;

    const googleCreds = await getAdminGoogleCredentials();
    if (!googleCreds) {
      throw new Error('Google App credentials missing');
    }

    const redirectUri = getIntegrationOAuthCallbackUrl('googleAds');
    requireOAuthConfiguration(req,[googleCreds.clientId,googleCreds.clientSecret,redirectUri]);
    const tokenBody = new URLSearchParams({
      code_verifier: oauthBrowserFlow(req).codeVerifier!,
      code: code as string,
      client_id: googleCreds.clientId,
      client_secret: googleCreds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(10_000),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenData: any = await tokenResponse.json();
    if (!tokenResponse.ok || tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error || 'Failed to exchange OAuth code');
    }

    const refreshToken = tokenData.refresh_token;
    if (!refreshToken) {
      throw new Error('Google did not grant offline Ads access. Please reconnect and approve the requested permission.');
    }
    const expiresIn = tokenData.expires_in || 3600;
    const tokenExpiry = new Date(Date.now() + expiresIn * 1000);

    // A new Google grant may belong to a different user. Require account selection again
    // so an old customer ID cannot be treated as authorized by the new token.
    const existing = await getCredential(userId, 'google_ads');
    await saveCredential(
      userId,
      'google_ads',
      googleCreds.clientId, // apiKey
      encryptValue(googleCreds.clientSecret), // apiSecret
      {
        ...(existing?.config || {}),
        refreshToken: encryptValue(refreshToken),
        customerId: '',
        managerAccountId: '',
        tokenExpiry: tokenExpiry.toISOString(),
        connectedViaOAuth: true,
        connectedAt: new Date().toISOString(),
      }
    );

    res.redirect(`${FRONTEND_URL}/dashboard/integrations/google-ads?google_connected=true`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch {
    logger.warn('[GoogleAdsOAuth] Callback could not finish');
    res.redirect(`${FRONTEND_URL}/dashboard/integrations/google-ads?error=${encodeURIComponent('connection_failed')}`);
  }
});

export default router;
