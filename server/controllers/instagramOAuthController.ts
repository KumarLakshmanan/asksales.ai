import { requireBusinessManager } from '../middleware/businessPermissions.js';
import { beginOAuthBrowserFlow, oauthBrowserCallback, requireOAuthConfiguration } from '../services/OAuthBrowserFlowService.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { rememberOAuthBusinessState } from '../tenancy/oauthBusinessScope.js';
/**
 * Instagram OAuth Controller
 * Handles OAuth flow for Instagram Business API integration
 * 
 * This controller manages:
 * - OAuth initiation with proper Instagram messaging scopes
 * - OAuth callback to exchange code for tokens
 * - Long-lived token exchange
 * - Webhook subscription setup
 * - Token refresh
 * 
 * New accounts use direct Instagram Login with instagram_business_basic and
 * instagram_business_manage_messages. Existing Facebook-backed credentials stay readable.
 */

import crypto from 'crypto';
import { getInstagramLoginScopes, metaMessagingReadiness } from '../services/integrations/MetaConnectionPolicy.js';
import { exchangeInstagramLoginCode, getInstagramLoginApp, subscribeInstagramLoginAccount } from '../services/integrations/InstagramLogin.js';
import { getMetaAppReviewPermissions } from '../services/integrations/MetaCapabilityRegistry.js';

import { Router, type Request, type Response } from 'express';
import { db } from '../models/db';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { eq, and } from 'drizzle-orm';
import { 
  storeInstagramApiCredentials, 
  getInstagramApiForUser 
} from '../services/instagramGraphApiService';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions';
import { upsertMetaPageConnection, updateWebhookStatus, disconnectInstagramForUser } from '../models/metaPageConnections/functions';
import { logger } from '../utils/logger.js';
import { getOAuthBaseUrl } from '../utils/metaApiVersion.js';
import { getIntegrationOAuthCallbackUrl } from '../utils/integrationUrls.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { isDirectInstagramLogin, isOAuthBackedInstagramCredential } from '../utils/instagramOAuthCredential.js';
import { encryptMetaSecret } from '../utils/metaCredentialSecrets.js';
import { resolveInstagramAccountContext } from '../services/instagramAccountSelectionService.js';
import {
  INSTAGRAM_META_SCOPES,
  INSTAGRAM_LOGIN_SCOPES,
  getMetaCapabilityStatuses,
  normalizeMetaAppReviewPermissions,
} from '../services/integrations/MetaCapabilityRegistry.js';
import {
  providerVerificationRequiresReconnect,
  verifyProviderIntegration,
} from '../services/integrations/ProviderVerificationService.js';

// CSRF nonce store (Redis-backed, single-use, 15-min TTL)
const OAUTH_NONCE_PREFIX = 'instagram:oauth:nonce:';
const OAUTH_NONCE_TTL_SECONDS = 900;

async function storeOAuthNonce(nonce: string, userId: number, scopes: readonly string[]): Promise<void> {
  try {
    const redis = getRedisConnection();
    await redis.set(`${OAUTH_NONCE_PREFIX}${nonce}`, JSON.stringify({ userId, scopes }), 'EX', OAUTH_NONCE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, '[InstagramOAuth] Failed to persist CSRF nonce in Redis');
    throw new Error('Instagram sign-in is temporarily unavailable. Please try again.');
  }
}

async function consumeOAuthNonce(nonce: string): Promise<{ userId: number; scopes: string[] } | null> {
  try {
    const redis = getRedisConnection();
    const key = `${OAUTH_NONCE_PREFIX}${nonce}`;
    const stored = await redis.getdel(key);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { userId?: unknown; scopes?: unknown };
    if (!Number.isInteger(parsed.userId) || !Array.isArray(parsed.scopes)
      || !parsed.scopes.every(scope => typeof scope === 'string')) return null;
    return { userId: parsed.userId as number, scopes: parsed.scopes as string[] };
  } catch (err) {
    logger.warn({ err }, '[InstagramOAuth] Failed to consume CSRF nonce');
    return null;
  }
}

const router = Router();
router.use('/callback', oauthBrowserCallback('instagram', (res, code) => res.redirect(`${FRONTEND_URL}/dashboard/integrations/instagram?error=${encodeURIComponent(code)}`)));

// Environment configuration - construct from request if not set
const getAppUrl = (_req: Request): string => {
  return getOAuthBaseUrl();
};

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/** Safe configuration summary; no app secrets or account tokens are returned. */
router.get('/debug', async (_req: Request, res: Response) => {
  const app = await getInstagramLoginApp();
  res.json({ redirectUri: getIntegrationOAuthCallbackUrl('instagram'), igAppConfigured: Boolean(app),
    flow: 'instagram_login', usedApp: 'instagram_product', igAppId: app?.appId || null });
});

router.get('/authorize', requireBusinessManager, async (req: Request, res: Response) => {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const app = await getInstagramLoginApp();
    if (!app) return res.status(503).json({ error: 'Instagram Login is not configured yet. Please contact your administrator to configure the Instagram App ID and secret.' });
    let scopes: string[];
    try {
      scopes = getInstagramLoginScopes(typeof req.query.feature === 'string' ? req.query.feature : undefined,
        req.query.feature ? await getMetaAppReviewPermissions() : {});
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'This feature is not available.' });
    }
    const nonce = crypto.randomBytes(24).toString('hex');
    await storeOAuthNonce(nonce, userId, scopes);
    const state = Buffer.from(JSON.stringify({ userId, timestamp: Date.now(), nonce, useInstagramLogin: true,
      returnToInsights: scopes.includes('instagram_business_manage_insights') })).toString('base64');
    await rememberOAuthBusinessState(state);
    const redirectUri = getIntegrationOAuthCallbackUrl('instagram');
    await beginOAuthBrowserFlow(req,res,'instagram',state,redirectUri,[app.appId,app.appSecret,redirectUri]);
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.search = new URLSearchParams({ client_id: app.appId, redirect_uri: getIntegrationOAuthCallbackUrl('instagram'),
      response_type: 'code', scope: scopes.join(','), state, enable_fb_login: '0', force_authentication: '1' }).toString();
    if (req.query.format === 'json') return res.json({ url: url.toString() });
    return res.redirect(url.toString());
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.warn({ err: error, userId }, '[InstagramOAuth] Could not start Instagram Login');
    return res.status(503).json({ error: 'Instagram sign-in could not be started. Please try again or contact support.' });
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${FRONTEND_URL}/dashboard/integrations/instagram?error=${encodeURIComponent(error === 'access_denied' ? 'access_denied' : 'provider_error')}`);
    if (typeof code !== 'string' || typeof state !== 'string') throw new Error('Missing authorization code or state parameter');
    let stateData: { userId: number; timestamp: number; nonce?: string; useInstagramLogin?: boolean; returnToInsights?: boolean };
    try { stateData = JSON.parse(Buffer.from(state, 'base64').toString()); }
    catch { throw new Error('Invalid state parameter'); }
    const nonceGrant = stateData.nonce ? await consumeOAuthNonce(stateData.nonce) : null;
    if (!nonceGrant || nonceGrant.userId !== stateData.userId || stateData.useInstagramLogin !== true) {
      throw new Error('OAuth session is invalid or has already been used. Please retry the connection.');
    }
    if (!Number.isFinite(stateData.timestamp) || Date.now() - stateData.timestamp > 10 * 60 * 1000 || stateData.timestamp > Date.now() + 60_000) {
      throw new Error('OAuth session expired. Please try again.');
    }
    const userId = stateData.userId;
    const app = await getInstagramLoginApp();
    if (!app) throw new Error('Instagram Login is not configured. Please contact your administrator.');
    requireOAuthConfiguration(req,[app.appId,app.appSecret,getIntegrationOAuthCallbackUrl('instagram')]);
    const result = await exchangeInstagramLoginCode(app, code, getIntegrationOAuthCallbackUrl('instagram'), nonceGrant.scopes);
    if (!result.grantedScopes.includes('instagram_business_basic')) {
      throw new Error('Instagram account access was not granted. Please reconnect and allow access to your professional account.');
    }
    const { accountId, profile, accessToken, expiresIn, grantedScopes, declinedScopes } = result;
    const stored = await storeInstagramApiCredentials(userId, {
      accessToken, instagramAccountId: accountId, pageId: '', pageAccessToken: accessToken,
      username: profile.username!, expiresIn, connectedViaOAuth: true, useInstagramLogin: true,
      grantedScopes, declinedScopes,
    });
    if (!stored) throw new Error('Your Instagram authorization could not be saved. Please try again.');
    // The account ID is a routing key in this legacy table, never a Facebook Page.
    const connection = await upsertMetaPageConnection({
      userId, pageId: accountId, pageName: profile.name || profile.username!,
      pageAccessToken: encryptMetaSecret(accessToken)!, userAccessToken: encryptMetaSecret(accessToken)!,
      instagramAccountId: accountId, instagramUsername: profile.username,
      instagramProfilePicture: profile.profile_picture_url || null,
      instagramFollowersCount: profile.followers_count ?? null,
      tokenExpiry: new Date(Date.now() + expiresIn * 1000), scopes: grantedScopes,
      isActive: true, facebookActive: false, instagramActive: true, webhookSubscribed: false,
    });
    if (grantedScopes.includes('instagram_business_manage_messages')) {
      try {
        await subscribeInstagramLoginAccount(accountId, accessToken, grantedScopes);
        await updateWebhookStatus(connection.id, true);
      } catch (webhookError) {
        await updateWebhookStatus(connection.id, false);
        logger.warn({ userId, accountId, err: webhookError }, '[InstagramOAuth] Messaging subscription needs attention');
      }
    }
    await verifyProviderIntegration(userId, 'instagram').catch(verificationError => {
      logger.warn({ userId, err: verificationError }, '[InstagramOAuth] Post-login verification did not complete');
    });
    return res.redirect(stateData.returnToInsights && nonceGrant.scopes.includes('instagram_business_manage_insights')
      ? `${FRONTEND_URL}/dashboard/marketing/analytics?platform=instagram`
      : `${FRONTEND_URL}/dashboard/integrations/instagram?instagram_api_connected=true`);
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.warn({ err: error }, '[InstagramOAuth] Instagram Login callback failed');
    return res.redirect(`${FRONTEND_URL}/dashboard/integrations/instagram?error=${encodeURIComponent(error instanceof Error ? error.message : 'Instagram sign-in failed. Please try again.')}`);
  }
});

/**
 * GET /api/instagram/oauth/status
 * Check Instagram API connection status for current user
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Resolve one coherent identity. The credential, profile, linked Page,
    // webhook state and token status must all belong to the publishing default.
    const [accountContext, adminCredential] = await Promise.all([
      resolveInstagramAccountContext(userId),
      getActiveAdminCredential('meta_app'),
    ]);
    const apiCredential = accountContext?.credential;
    const pageConn = accountContext?.connection;
    const useInstagramLogin = isDirectInstagramLogin(apiCredential);
    const webhookSubscribed = Boolean(pageConn?.webhookSubscribed && apiCredential?.readinessErrorCode !== 'WEBHOOK_SUBSCRIPTION');
    const providerAccountId = apiCredential?.accountIdentifier;
    const hasOfficialApi = isOAuthBackedInstagramCredential(apiCredential)
      || (apiCredential?.credentialType === 'manual' && !!apiCredential.accessToken && !!apiCredential.accountIdentifier);

    // Check if API token is expired
    let apiTokenExpired = false;
    let apiTokenExpiresAt: string | null = null;
    if (hasOfficialApi && apiCredential?.tokenExpiry) {
      apiTokenExpiresAt = apiCredential.tokenExpiry.toISOString();
      apiTokenExpired = new Date(apiCredential.tokenExpiry) < new Date();
    }
    // A provider can revoke a token before its nominal expiry.  The safe
    // verification endpoint persists that provider outcome so the connection
    // card must not continue presenting a revoked credential as healthy.
    const providerCredentialInvalid = providerVerificationRequiresReconnect(apiCredential?.readinessErrorCode);

    // Determine connection method
    const connectionMethod = hasOfficialApi ? apiCredential?.credentialType : null;

    // The webhook is now globally configured by admin — no per-user webhook URLs
    const appUrl = getAppUrl(req);
    const readiness = metaMessagingReadiness('instagram', {
      hasAccount: Boolean(hasOfficialApi), selected: Boolean(apiCredential?.isSelected),
      tokenExpired: apiTokenExpired, providerInvalid: providerCredentialInvalid,
      useInstagramLogin, pageId: pageConn?.pageId, webhookSubscribed, scopes: apiCredential?.grantedScopes,
    });
    const capabilities = await getMetaCapabilityStatuses({
      scopes: apiCredential?.grantedScopes,
      accountReady: readiness.connected,
      permissions: useInstagramLogin ? INSTAGRAM_LOGIN_SCOPES : INSTAGRAM_META_SCOPES,
      review: normalizeMetaAppReviewPermissions(adminCredential?.config?.appReviewPermissions),
    });
    const loginConfigured = Boolean(await getInstagramLoginApp(adminCredential));

    res.json({
      success: true,
      officialApi: {
        ...readiness,
        loginConfigured,
        requiresReconnect: Boolean(hasOfficialApi && (apiTokenExpired || providerCredentialInvalid)),
        credentialId: apiCredential?.id || null,
        username: pageConn?.instagramUsername || apiCredential?.accountName || null,
        instagramAccountId: providerAccountId || null,
        tokenExpired: apiTokenExpired,
        expiresAt: apiTokenExpiresAt,
        connectionMethod,
        loginMethod: useInstagramLogin ? 'instagram' : 'facebook',
        profilePicture: pageConn?.instagramProfilePicture || null,
        followersCount: pageConn?.instagramFollowersCount ?? null,
        pageName: useInstagramLogin ? null : pageConn?.pageName || null,
        pageId: useInstagramLogin ? null : pageConn?.pageId || null,
        webhookSubscribed,
        grantedScopes: apiCredential?.grantedScopes || [],
        declinedScopes: Array.isArray((apiCredential?.sessionData as { declinedScopes?: unknown } | null)?.declinedScopes)
          ? (apiCredential?.sessionData as { declinedScopes: string[] }).declinedScopes
          : [],
        capabilities,
        readinessErrorCode: apiCredential?.readinessErrorCode || null,
        lastVerifiedAt: apiCredential?.lastReadinessCheckAt?.toISOString() || apiCredential?.providerVerifiedAt?.toISOString() || null,
      },
      webhookUrl: `${appUrl}/api/webhooks/instagram`,
      webhookConfiguredByAdmin: true,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[InstagramOAuth] Status check error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * POST /api/instagram/oauth/refresh
 * Manually refresh the Instagram API access token
 */
router.post('/refresh', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const service = await getInstagramApiForUser(userId);
    
    if (!service) {
      return res.status(400).json({ 
        error: 'Instagram API not connected. Please connect via OAuth first.' 
      });
    }

    // Refresh the token (reads from meta_page_connections internally)
    const refreshed = await service.refreshAccessToken();

    if (refreshed) {
      res.json({ 
        success: true, 
        message: 'Access token refreshed successfully',
      });
    } else {
      res.status(400).json({ 
        error: 'Unable to refresh token. Please reconnect your Instagram account.' 
      });
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[InstagramOAuth] Refresh error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * POST /api/instagram/oauth/disconnect
 * Disconnect Instagram API integration
 */
router.post('/disconnect', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { type } = req.body; // 'browser', 'api', or 'all'

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (type === 'browser' || type === 'all') {
      await db.update(channelCredentialsTable)
        .set({ isActive: false, deactivationReason: 'user_disconnected', deactivatedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'instagram')
        ));
    }

    if (type === 'api' || type === 'all') {
      await db.update(channelCredentialsTable)
        .set({ isActive: false, deactivationReason: 'user_disconnected', deactivatedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'instagram_api')
        ));

      // Also deactivate the meta_page_connections record so status shows disconnected
      await disconnectInstagramForUser(userId);
    }

    res.json({ 
      success: true, 
      message: `Instagram ${type === 'all' ? 'integrations' : type + ' integration'} disconnected` 
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[InstagramOAuth] Disconnect error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * GET /api/instagram/oauth/account
 * Get Instagram Business Account details
 */
router.get('/account', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const service = await getInstagramApiForUser(userId);
    
    if (!service) {
      return res.status(400).json({ 
        error: 'Instagram API not connected',
        connected: false,
      });
    }

    const accountInfo = await service.getBusinessAccountInfo();

    if (!accountInfo.success) {
      return res.status(400).json({ error: accountInfo.error });
    }

    res.json({
      success: true,
      account: accountInfo.account,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[InstagramOAuth] Get account error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * POST /api/instagram/oauth/test-message
 * Send a test message to verify the integration works
 */
router.post('/test-message', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { recipientId, message } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!recipientId || !message) {
      return res.status(400).json({ error: 'recipientId and message are required' });
    }

    const service = await getInstagramApiForUser(userId);
    
    if (!service) {
      return res.status(400).json({ 
        error: 'Instagram API not connected. Please connect via OAuth first.' 
      });
    }

    const result = await service.sendMessage(recipientId, message);
    if (result.code === 'ASSISTANT_SETUP_REQUIRED') return res.status(409).json(result);

    res.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[InstagramOAuth] Test message error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * GET /api/instagram/oauth/conversations
 * Get Instagram conversations/inbox
 */
router.get('/conversations', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const limit = parseInt(req.query.limit as string) || 20;
    const cursor = req.query.cursor as string;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const service = await getInstagramApiForUser(userId);
    
    if (!service) {
      return res.status(400).json({ 
        error: 'Instagram API not connected',
        connected: false,
      });
    }

    const result = await service.getConversations(limit, cursor);

    res.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[InstagramOAuth] Get conversations error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * GET /api/instagram/oauth/conversations/:conversationId/messages
 * Get messages from a specific conversation
 */
router.get('/conversations/:conversationId/messages', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { conversationId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const cursor = req.query.cursor as string;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const service = await getInstagramApiForUser(userId);
    
    if (!service) {
      return res.status(400).json({ 
        error: 'Instagram API not connected',
        connected: false,
      });
    }

    const result = await service.getConversationMessages(conversationId, limit, cursor);

    res.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[InstagramOAuth] Get messages error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * POST /api/instagram/oauth/conversations/:conversationId/reply
 * Reply to a conversation
 */
router.post('/conversations/:conversationId/reply', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { conversationId } = req.params;
    const { recipientId, message } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!recipientId || !message) {
      return res.status(400).json({ error: 'recipientId and message are required' });
    }

    const service = await getInstagramApiForUser(userId);
    
    if (!service) {
      return res.status(400).json({ 
        error: 'Instagram API not connected',
        connected: false,
      });
    }

    const result = await service.sendMessage(recipientId, message);
    if (result.code === 'ASSISTANT_SETUP_REQUIRED') return res.status(409).json(result);

    res.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[InstagramOAuth] Reply error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * POST /api/instagram/oauth/manual
 * Save Instagram manual credentials from the settings form.
 * Accepts: clientId, clientSecret, accessToken, igUserId, pageId
 * (aliases for appId, appSecret, instagramAccountId used elsewhere)
 */
router.post('/manual', requireBusinessManager, async (req: Request, res: Response) => {
  const { saveInstagramManualCredentials } = await import('./metaManualCredentialsController.js');
  req.body = { ...req.body, appId: req.body.clientId, appSecret: req.body.clientSecret, instagramAccountId: req.body.igUserId };
  return saveInstagramManualCredentials(req, res);
});

export default router;
