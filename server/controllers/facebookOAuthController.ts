import { currentBusinessScope } from '../tenancy/businessContext.js';
import { hasBusinessManagerAuthority } from '../middleware/businessPermissions.js';
import { requireBusinessManager } from '../middleware/businessPermissions.js';
import { beginOAuthBrowserFlow, oauthBrowserCallback, requireOAuthConfiguration } from '../services/OAuthBrowserFlowService.js';
import { getUserById as getWebhookOwner } from '../models/users/functions.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { rememberOAuthBusinessState } from '../tenancy/oauthBusinessScope.js';
import { discoverFacebookPages } from '../utils/facebookPageDiscovery.js';
/**
 * Facebook OAuth Controller
 * Handles Facebook Pages OAuth flow + status + settings endpoints
 */

import crypto from 'crypto';
import { getMetaOAuthScopes, metaMessagingReadiness } from '../services/integrations/MetaConnectionPolicy.js';
import { preserveMetaPageTokenBindings } from '../services/integrations/MetaPageTokenBinding.js';
import { getMetaAppReviewPermissions } from '../services/integrations/MetaCapabilityRegistry.js';
import { Router, type Request, type Response } from 'express';
import { db } from '../models/db';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { getOAuthBaseUrl, getGraphApiVersion } from '../utils/metaApiVersion.js';
import { getIntegrationOAuthCallbackUrl } from '../utils/integrationUrls.js';
import { upsertMetaPageConnection, updateWebhookStatus, disconnectFacebookForUser } from '../models/metaPageConnections/functions';
import { metaPageConnectionsTable } from '../models/metaPageConnections/schema';
import { getRedisConnection } from '../infrastructure/redis.js';
import { webhookCapabilityConfig } from '../utils/userWebhookTokens.js';
import { decryptMetaSecret, encryptMetaSecret, metaSessionMetadata } from '../utils/metaCredentialSecrets.js';
import {
  FACEBOOK_META_SCOPES,
  getMetaCapabilityStatuses,
  inspectMetaToken,
} from '../services/integrations/MetaCapabilityRegistry.js';
import {
  providerVerificationRequiresReconnect,
  verifyProviderIntegration,
} from '../services/integrations/ProviderVerificationService.js';
import { getChannelCredentialEncryptionKeyId } from '../utils/channelCredentialSecrets.js';
import { getAdminMetaCredentials } from '../utils/adminMetaApp.js';

const router = Router();
router.use('/callback', oauthBrowserCallback('facebook', (res, code) => res.redirect(`${FRONTEND_URL}/dashboard/integrations/facebook?error=${encodeURIComponent(code)}`)));

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const getAppUrl = (_req: Request): string => {
  return getOAuthBaseUrl();
};

const NONCE_PREFIX = 'facebook:oauth:nonce:';
const NONCE_TTL_SECONDS = 900; // 15 minutes — covers slow consent + tab-switching

function selectPreferredPage(
  pages: Array<{ id: string; name: string; access_token?: string }>,
  previousPageId?: string | null,
): { id: string; name: string; access_token?: string } {
  const previous = previousPageId ? pages.find((page) => page.id === previousPageId) : undefined;
  // OAuth callbacks do not currently have a client-side page picker. Retaining
  // a previously selected page prevents reconnects from silently changing the
  // account; a stable ID sort makes first-time fallback deterministic.
  return previous || [...pages].sort((a, b) => a.id.localeCompare(b.id))[0];
}

async function storeOAuthNonce(nonce: string, userId: number): Promise<void> {
  try {
    const redis = getRedisConnection();
    await redis.set(`${NONCE_PREFIX}${nonce}`, String(userId), 'EX', NONCE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, '[FacebookOAuth] Failed to store nonce in Redis');
  }
}

async function consumeOAuthNonce(nonce: string): Promise<number | null> {
  try {
    const redis = getRedisConnection();
    const key = `${NONCE_PREFIX}${nonce}`;
    const value = await redis.get(key);
    if (!value) return null;
    await redis.del(key); // single-use
    return Number(value);
  } catch (err) {
    logger.warn({ err }, '[FacebookOAuth] Failed to consume nonce from Redis');
    return null;
  }
}

/**
 * Get Meta App credentials from admin configuration (shared across all users)
 */

/**
 * GET /api/facebook/oauth/authorize
 * Initiate Facebook Pages OAuth flow
 */
router.get('/authorize', requireBusinessManager, async (req: Request, res: Response) => {
  try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const metaCreds = await getAdminMetaCredentials();
  if (!metaCreds) {
    return res.status(500).json({ error: 'Meta App not configured by admin. Please contact your administrator.' });
  }

  const apiVersion = await getGraphApiVersion();
  const redirectUri = getIntegrationOAuthCallbackUrl('facebook');
  // C3: cryptographically strong, single-use nonce stored server-side in Redis
  const nonce = crypto.randomBytes(24).toString('hex');
  await storeOAuthNonce(nonce, userId);
  const state = Buffer.from(JSON.stringify({
    userId,
    timestamp: Date.now(),
    nonce,
  })).toString('base64');
  await rememberOAuthBusinessState(state);
  await beginOAuthBrowserFlow(req,res,'facebook',state,redirectUri,[metaCreds.appId,metaCreds.appSecret,redirectUri]);


  // Start with Page discovery, Messenger and webhook permissions.
  let scopes: string;
  try {
    scopes = getMetaOAuthScopes('facebook', typeof req.query.feature === 'string' ? req.query.feature : undefined,
      req.query.feature ? await getMetaAppReviewPermissions() : {}).join(',');
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    return res.status(400).json({ error: error instanceof Error ? error.message : 'This feature is not available.' });
  }

  const authUrl = `https://www.facebook.com/${apiVersion}/dialog/oauth?` +
    `client_id=${metaCreds.appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&auth_type=rerequest`;

  if (req.query.format === 'json') return res.json({ url: authUrl });
  res.redirect(authUrl);
  } catch { return res.status(503).json({ error: 'Facebook sign-in is temporarily unavailable. Try again.' }); }
});

/**
 * GET /api/facebook/oauth/callback
 * Handle Facebook OAuth callback — connects Facebook Page + subscribes to webhooks
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    // Handle OAuth errors (user denied, cancelled, etc.)
    if (error) {
      logger.warn({ code: error === 'access_denied' ? 'access_denied' : 'provider_error' }, '[FacebookOAuth] OAuth error/cancel');
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations/facebook?error=${encodeURIComponent(error === 'access_denied' ? 'access_denied' : 'provider_error')}`);
    }

    if (!code || !state) {
      throw new Error('Missing code or state parameter');
    }

    // Decode and validate state
    let stateData: { userId: number; timestamp: number; nonce?: string };
    try {
      stateData = JSON.parse(Buffer.from(state as string, 'base64').toString());
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      throw new Error('Invalid state parameter');
    }

    const userId = stateData.userId;

    // Check state timestamp (must be within 10 minutes)
    if (Date.now() - stateData.timestamp > 10 * 60 * 1000) {
      throw new Error('OAuth session expired. Please try again.');
    }

    // C3: validate nonce via Redis (single-use, prevents CSRF + replay)
    if (!stateData.nonce) {
      throw new Error('Invalid OAuth state: missing nonce');
    }
    const nonceUserId = await consumeOAuthNonce(stateData.nonce);
    if (nonceUserId === null) {
      throw new Error('Invalid or expired OAuth nonce. Please try again.');
    }
    if (nonceUserId !== userId) {
      throw new Error('OAuth nonce does not match user. Possible CSRF attempt.');
    }

    const metaCreds = await getAdminMetaCredentials();
    if (!metaCreds) {
      throw new Error('Meta App not configured by admin.');
    }

    const apiVersion = await getGraphApiVersion();
    const apiBase = `https://graph.facebook.com/${apiVersion}`;

    // Step 1: Exchange code for short-lived token
    const redirectUri = getIntegrationOAuthCallbackUrl('facebook');
    requireOAuthConfiguration(req,[metaCreds.appId,metaCreds.appSecret,redirectUri]);
    const tokenUrl = `${apiBase}/oauth/access_token`;
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: metaCreds.appId, redirect_uri: redirectUri, client_secret: metaCreds.appSecret, code: String(code) }),
      signal: AbortSignal.timeout(15_000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenData: any = await tokenResponse.json();

    if (!tokenResponse.ok || tokenData.error) {
      throw new Error(tokenData.error?.message || 'Failed to exchange code for access token');
    }

    const shortLivedToken = tokenData.access_token;

    // Step 2: Exchange for long-lived token (~60 days)
    const longLivedUrl = `${apiBase}/oauth/access_token`;
    const longLivedResponse = await fetch(longLivedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: metaCreds.appId, client_secret: metaCreds.appSecret, fb_exchange_token: shortLivedToken }),
      signal: AbortSignal.timeout(15_000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const longLivedData: any = await longLivedResponse.json();

    const accessToken = longLivedData.access_token || shortLivedToken;
    const tokenExpiresIn = longLivedData.expires_in || 5184000; // Default 60 days
    const tokenExpiry = new Date(Date.now() + tokenExpiresIn * 1000);
    const tokenInspection = await inspectMetaToken({
      accessToken,
      appId: metaCreds.appId,
      appSecret: metaCreds.appSecret,
      apiVersion,
    });
    if (!tokenInspection.valid) throw new Error('Meta could not verify the issued access token for this application.');

    // Step 3: Resolve Pages selected in Facebook consent, including Pages
    // listed only under the token's granular Page grant.
    const pages = await discoverFacebookPages({ apiBase, userAccessToken: accessToken, inspection: tokenInspection });

    const prior = await ChannelCredentialModel.findByUserAndPlatform(userId, 'facebook_api');
    const page = selectPreferredPage(pages, prior?.isSelected ? prior.accountIdentifier : null);
    const pageId = page.id;
    const pageName = page.name;
    const requiresExplicitPageSelection = pages.length > 1
      && !(prior?.isSelected && pages.some((candidate) => candidate.id === prior.accountIdentifier));

    logger.info({ userId, pageId, pageName }, '[FacebookOAuth] Got Facebook Page');

    // Step 4: Materialize every Page authorized in this consent. Credentials
    // remain account-bound so a reconnect cannot replace another Page.
    await db.update(channelCredentialsTable).set({ isSelected: false, updatedAt: new Date() }).where(and(
      eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, 'facebook_api'),
    ));
    for (const authorizedPage of pages) {
      const previousConnection = await preserveMetaPageTokenBindings(userId, authorizedPage.id);
      const [existing] = await db.select().from(channelCredentialsTable).where(and(
        eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, 'facebook_api'), eq(channelCredentialsTable.accountIdentifier, authorizedPage.id),
      )).limit(1);
      const fieldsResponse = await fetch(`${apiBase}/${authorizedPage.id}?fields=instagram_business_account{id,username,profile_picture_url,followers_count}`, { headers: { Authorization: `Bearer ${authorizedPage.access_token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const fields = fieldsResponse?.ok ? await fieldsResponse.json() as { instagram_business_account?: { id: string; username?: string; profile_picture_url?: string; followers_count?: number } } : {};
      const values = {
        credentialType: 'oauth', accessToken: encryptMetaSecret(accessToken), apiKey: encryptMetaSecret(authorizedPage.access_token), accountIdentifier: authorizedPage.id, accountName: authorizedPage.name,
        tokenExpiry, isActive: true, isSelected: !requiresExplicitPageSelection && authorizedPage.id === pageId,
        encryptionVersion: 'secrets-manager-v1', encryptionKeyId: getChannelCredentialEncryptionKeyId(), encryptedAt: new Date(),
        grantedScopes: tokenInspection.grantedScopes,
        sessionData: { ...metaSessionMetadata(existing?.sessionData), pageTokenBound: true, connectedViaOAuth: true, connectedAt: new Date().toISOString(), lastRefreshedAt: new Date().toISOString(), declinedScopes: tokenInspection.declinedScopes }, updatedAt: new Date(),
      };
      if (existing) await db.update(channelCredentialsTable).set(values).where(eq(channelCredentialsTable.id, existing.id));
      else await db.insert(channelCredentialsTable).values({ userId, platform: 'facebook_api', ...values });
      await upsertMetaPageConnection({ userId, pageId: authorizedPage.id, pageName: authorizedPage.name, pageAccessToken: encryptMetaSecret(authorizedPage.access_token)!, userAccessToken: encryptMetaSecret(accessToken)!, tokenExpiry, instagramAccountId: fields.instagram_business_account?.id, instagramUsername: fields.instagram_business_account?.username, instagramProfilePicture: fields.instagram_business_account?.profile_picture_url, instagramFollowersCount: fields.instagram_business_account?.followers_count, scopes: tokenInspection.grantedScopes, isActive: true, facebookActive: true, instagramActive: previousConnection?.instagramActive ?? false });
    }

    // Step 6: Subscribe every authorized Page. Multi-account selection is not
    // useful if inbound events silently stop for non-selected Pages.
    for (const authorizedPage of pages) {
      try {
        const subscribeUrl = `${apiBase}/${authorizedPage.id}/subscribed_apps`;
        const subResponse = await fetch(subscribeUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authorizedPage.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscribed_fields: ['messages', 'message_echoes', 'messaging_postbacks', 'messaging_optins', 'message_deliveries', 'message_reads',
              ...(tokenInspection.grantedScopes.includes('pages_manage_engagement') ? ['feed'] : []),
            ],
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const subData = await subResponse.json() as { success?: boolean; error?: unknown };
        if (subResponse.ok && subData.success) {
          logger.info({ pageId: authorizedPage.id }, '[FacebookOAuth] Page subscribed to webhooks');
          const [connection] = await db.select({ id: metaPageConnectionsTable.id })
            .from(metaPageConnectionsTable)
            .where(and(
              eq(metaPageConnectionsTable.userId, userId),
              eq(metaPageConnectionsTable.pageId, authorizedPage.id),
            ))
            .limit(1);
          if (connection) await updateWebhookStatus(connection.id, true);
        } else {
          logger.warn({ pageId: authorizedPage.id, error: subData.error }, '[FacebookOAuth] Webhook subscription returned non-success');
        }
      } catch (subErr) {
        logger.warn({ err: subErr, pageId: authorizedPage.id }, '[FacebookOAuth] Webhook subscription failed (non-fatal)');
      }
    }

    await verifyProviderIntegration(userId, 'facebook').catch((verificationError) => {
      logger.warn({ err: verificationError, userId }, '[FacebookOAuth] Post-OAuth provider verification did not complete');
    });

    // Redirect to frontend
    res.redirect(`${FRONTEND_URL}/dashboard/integrations/facebook?connected=true`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[FacebookOAuth] Callback error');
    res.redirect(`${FRONTEND_URL}/dashboard/integrations/facebook?error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * POST /api/facebook/oauth/refresh
 * Refresh Facebook long-lived token
 */
router.post('/refresh', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'facebook_api');

    if (!credential?.accessToken) {
      return res.status(400).json({ error: 'No Facebook API connection found' });
    }

    const metaCreds = await getAdminMetaCredentials();
    if (!metaCreds) {
      return res.status(500).json({ error: 'Meta App not configured by admin.' });
    }

    const apiVersion = await getGraphApiVersion();

    // Exchange current token for new long-lived token
    const refreshUrl = `https://graph.facebook.com/${apiVersion}/oauth/access_token`;
    const refreshResponse = await fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: metaCreds.appId,
        client_secret: metaCreds.appSecret,
        fb_exchange_token: decryptMetaSecret(credential.accessToken),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refreshData: any = await refreshResponse.json();

    if (!refreshResponse.ok || refreshData.error) {
      throw new Error(refreshData.error?.message || 'Failed to refresh token');
    }

    const newToken = refreshData.access_token;
    const expiresIn = refreshData.expires_in || 5184000;
    const newExpiry = new Date(Date.now() + expiresIn * 1000);

    await db.update(channelCredentialsTable)
      .set({
        accessToken: encryptMetaSecret(newToken),
        tokenExpiry: newExpiry,
        sessionData: {
          ...metaSessionMetadata(credential.sessionData),
          lastRefreshedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(channelCredentialsTable.id, credential.id));

    res.json({ success: true, expiresAt: newExpiry.toISOString() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[FacebookOAuth] Refresh error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * POST /api/facebook/oauth/disconnect
 * Disconnect Facebook API connection
 */
router.post('/disconnect', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await db.update(channelCredentialsTable)
      .set({ isActive: false, deactivationReason: 'user_disconnected', deactivatedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'facebook_api')
      ));

    // Shared page rows may route Instagram too; only stop Facebook routing.
    await disconnectFacebookForUser(userId);

    res.json({ success: true, message: 'Facebook disconnected' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[FacebookOAuth] Disconnect error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * GET /api/facebook/oauth/status
 * Returns Facebook connection status and webhook configuration
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // The status card and publisher must resolve the same selected Page.
    const [user, apiCredential, review] = await Promise.all([
      getWebhookOwner(userId),
      ChannelCredentialModel.findByUserAndPlatform(userId, 'facebook_api'),
      getMetaAppReviewPermissions(),
    ]);
    const providerAccountId = apiCredential?.accountIdentifier;
    const hasOfficialApi = ['oauth', 'manual'].includes(apiCredential?.credentialType || '')
      && Boolean(apiCredential?.accessToken)
      && !!providerAccountId;

    let apiTokenExpired = false;
    let apiTokenExpiresAt: string | null = null;
    if (hasOfficialApi && apiCredential.tokenExpiry) {
      apiTokenExpiresAt = apiCredential.tokenExpiry.toISOString();
      apiTokenExpired = new Date(apiCredential.tokenExpiry) < new Date();
    }
    // Meta may revoke a Page token well before its stored expiry.  Surface the
    // last safe provider-verification outcome instead of claiming that merely
    // having credential material means Messenger delivery is available.
    const providerCredentialInvalid = providerVerificationRequiresReconnect(apiCredential?.readinessErrorCode);

    // Determine connection method
    const connectionMethod = hasOfficialApi ? apiCredential?.credentialType : null;

    // Get profile data from meta_page_connections
    const pageConnections = providerAccountId ? await db.select({
      pageId: metaPageConnectionsTable.pageId,
      pageName: metaPageConnectionsTable.pageName,
      webhookSubscribed: metaPageConnectionsTable.webhookSubscribed,
      instagramAccountId: metaPageConnectionsTable.instagramAccountId,
      instagramUsername: metaPageConnectionsTable.instagramUsername,
      facebookActive: metaPageConnectionsTable.facebookActive,
    })
      .from(metaPageConnectionsTable)
      .where(and(
        eq(metaPageConnectionsTable.userId, userId),
        eq(metaPageConnectionsTable.pageId, providerAccountId),
        eq(metaPageConnectionsTable.isActive, true),
        eq(metaPageConnectionsTable.facebookActive, true)
      ))
      .limit(1) : [];
    const pageConn = pageConnections[0];
    const pageId = providerAccountId || null;
    const pagePictureUrl = pageId ? `https://graph.facebook.com/${pageId}/picture?type=large` : null;

    const appUrl = getAppUrl(req);
    const webhook = hasBusinessManagerAuthority(req) && currentBusinessScope() ? webhookCapabilityConfig(userId, user?.webhookTokenNonce, 'facebook') : undefined;
    const readiness = metaMessagingReadiness('facebook', {
      hasAccount: Boolean(hasOfficialApi), selected: Boolean(apiCredential?.isSelected),
      tokenExpired: apiTokenExpired, providerInvalid: providerCredentialInvalid,
      pageId, webhookSubscribed: pageConn?.webhookSubscribed, scopes: apiCredential?.grantedScopes,
    });
    const capabilities = await getMetaCapabilityStatuses({
      scopes: apiCredential?.grantedScopes,
      accountReady: Boolean(hasOfficialApi && !apiTokenExpired && apiCredential?.isSelected && pageId && pageConn?.webhookSubscribed),
      permissions: FACEBOOK_META_SCOPES,
      review,
    });

    res.json({
      success: true,
      officialApi: {
        ...readiness,
        requiresReconnect: Boolean(hasOfficialApi && (apiTokenExpired || providerCredentialInvalid)),
        credentialId: apiCredential?.id || null,
        username: apiCredential?.accountName || pageConn?.pageName || null,
        pageId,
        tokenExpired: apiTokenExpired,
        expiresAt: apiTokenExpiresAt,
        connectionMethod,
        pagePictureUrl,
        webhookSubscribed: pageConn?.webhookSubscribed || false,
        instagramConnected: !!pageConn?.instagramAccountId,
        instagramUsername: pageConn?.instagramUsername || null,
        instagramAccountId: pageConn?.instagramAccountId || null,
        grantedScopes: apiCredential?.grantedScopes || [],
        declinedScopes: Array.isArray((apiCredential?.sessionData as { declinedScopes?: unknown } | null)?.declinedScopes)
          ? (apiCredential?.sessionData as { declinedScopes: string[] }).declinedScopes
          : [],
        capabilities,
        readinessErrorCode: apiCredential?.readinessErrorCode || null,
        lastVerifiedAt: apiCredential?.lastReadinessCheckAt?.toISOString() || apiCredential?.providerVerifiedAt?.toISOString() || null,
      },
      ...(webhook ? { webhookUrl: `${appUrl}/api/webhooks/facebook/${webhook.token}`,
        webhookVerifyToken: webhook.verifyToken, webhookExpiresAt: webhook.expiresAt } : {}),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[FacebookOAuth] Status check error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

/**
 * GET /api/facebook/settings
 */
export const getFacebookSettings = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'facebook_api');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionData = credential?.sessionData as any || {};

    res.json({
      success: true,
      settings: {
        welcomeMessagesEnabled: sessionData.welcomeMessagesEnabled || false,
        dailyOutreachLimit: sessionData.dailyOutreachLimit || 20,
      }
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[FacebookOAuth] Get settings error');
    res.status(500).json({ success: false, error: 'Unable to load Facebook settings. Please try again.' });
  }
};

/**
 * POST /api/facebook/settings
 */
export const updateFacebookSettings = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { welcomeMessagesEnabled, dailyOutreachLimit } = req.body;
    if (welcomeMessagesEnabled !== undefined && typeof welcomeMessagesEnabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'welcomeMessagesEnabled must be a boolean' });
    }
    if (dailyOutreachLimit !== undefined && (!Number.isInteger(dailyOutreachLimit) || dailyOutreachLimit < 0 || dailyOutreachLimit > 50)) {
      return res.status(400).json({ success: false, error: 'dailyOutreachLimit must be an integer from 0 to 50' });
    }

    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'facebook_api');

    const existingSession = credential?.sessionData as { pageId?: string } | null;
    if (
      !credential
      || credential.credentialType !== 'oauth'
      || !credential.accessToken
      || !(existingSession?.pageId || credential.accountIdentifier)
      || (credential.tokenExpiry && credential.tokenExpiry.getTime() <= Date.now())
    ) {
      return res.status(400).json({
        success: false,
        error: 'A Facebook official API/OAuth credential is required. Please connect your account first.'
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentSessionData = credential.sessionData as any || {};
    const updatedSessionData = {
      ...currentSessionData,
      welcomeMessagesEnabled: typeof welcomeMessagesEnabled === 'boolean' ? welcomeMessagesEnabled : currentSessionData.welcomeMessagesEnabled,
      dailyOutreachLimit: Number.isInteger(dailyOutreachLimit) ? dailyOutreachLimit : currentSessionData.dailyOutreachLimit,
    };

    await db.update(channelCredentialsTable)
      .set({
        sessionData: updatedSessionData,
        updatedAt: new Date()
      })
      .where(eq(channelCredentialsTable.id, credential.id));

    res.json({
      success: true,
      settings: {
        welcomeMessagesEnabled: updatedSessionData.welcomeMessagesEnabled,
        dailyOutreachLimit: updatedSessionData.dailyOutreachLimit,
      }
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[FacebookOAuth] Update settings error');
    res.status(500).json({ success: false, error: 'Unable to save Facebook settings. Please try again.' });
  }
};

export default router;
