import { requireBusinessManager } from '../middleware/businessPermissions.js';
import { beginOAuthBrowserFlow, oauthBrowserCallback, requireOAuthConfiguration } from '../services/OAuthBrowserFlowService.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { collectMetaPages } from '../utils/metaPagePagination.js';
/**
 * Ad Platform OAuth Controller
 * Handles OAuth connections for Meta ad platforms
 * Credentials are fetched from user's integration settings in the database
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { getCredential, saveCredential } from '../services/credentialService';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions';
import { disconnectAdsForUser, upsertMetaPageConnection } from '../models/metaPageConnections/functions';
import { preserveMetaPageTokenBindings } from '../services/integrations/MetaPageTokenBinding.js';
import { logger } from '../utils/logger.js';
import { getIntegrationOAuthCallbackUrl } from '../utils/integrationUrls.js';
import { META_ADS_SCOPES, getMetaCapabilityStatuses, inspectMetaToken } from '../services/integrations/MetaCapabilityRegistry.js';
import { encryptMetaSecret } from '../utils/metaCredentialSecrets.js';
import { verifyProviderIntegration } from '../services/integrations/ProviderVerificationService.js';
import { discoverPaidAdAccounts } from '../services/ads/PaidAdAccountsService.js';
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { signOAuthState as signState, verifyOAuthState as verifyState, OAUTH_STATE_SECRET as STATE_SECRET } from '../utils/oauthState.js';
import { getAdminMetaCredentials } from '../utils/adminMetaApp.js';

const router = Router();
router.use('/callback', oauthBrowserCallback('meta_ads', (res, code) => res.redirect(`${FRONTEND_URL}/dashboard/integrations/meta?error=${encodeURIComponent(code)}`)));

const DEFAULT_META_API_VERSION = 'v25.0';
let resolvedMetaApiVersion: string | null = null;
async function getMetaApiVersion(): Promise<string> {
  if (resolvedMetaApiVersion) return resolvedMetaApiVersion;
  try {
    const cred = await getActiveAdminCredential('meta_app');
    const config = cred?.config as { apiVersion?: string } | null;
    if (config?.apiVersion) {
      resolvedMetaApiVersion = config.apiVersion;
      return resolvedMetaApiVersion;
    }
  } catch { /* fallback */ }
  return DEFAULT_META_API_VERSION;
}

const FRONTEND_URL = process.env.FRONTEND_URL;

if (!STATE_SECRET) {
  logger.error('[AdPlatformOAuth] OAUTH_STATE_SECRET / JWT_SECRET must be set');
}

/**
 * Get Meta App credentials from admin configuration (shared across all users)
 */

/**
 * GET /api/meta/oauth
 * Initiate Meta OAuth flow
 */
router.get('/', requireBusinessManager, async (req: Request, res: Response) => {
  try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const metaCreds = await getAdminMetaCredentials();
  if (!metaCreds) {
    return res.status(500).json({ error: 'Meta App not configured by admin. Please contact your administrator.' });
  }

  const apiVersion = await getMetaApiVersion();
  const redirectUri = getIntegrationOAuthCallbackUrl('meta');
  const state = await signState({ userId, nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now() });
  await beginOAuthBrowserFlow(req,res,'meta_ads',state,redirectUri,[metaCreds.appId,metaCreds.appSecret,redirectUri]);

  const authUrl = `https://www.facebook.com/${apiVersion}/dialog/oauth?` +
    `client_id=${metaCreds.appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&scope=${encodeURIComponent(META_ADS_SCOPES.join(','))}`;

  if (req.query.format === 'json') return res.json({ url: authUrl });
  res.redirect(authUrl);
  } catch { return res.status(503).json({ error: 'Provider sign-in is temporarily unavailable. Try again.' }); }
});

/**
 * GET /api/meta/oauth/callback
 * Handle Meta OAuth callback
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    // Handle OAuth errors (user denied, cancelled, etc.)
    if (error) {
      logger.warn({ code: error === 'access_denied' ? 'access_denied' : 'provider_error' }, '[AdPlatformOAuth] Meta callback error/cancel');
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations/meta?error=${encodeURIComponent(error === 'access_denied' ? 'access_denied' : 'provider_error')}`);
    }

    if (!code || !state) {
      throw new Error('Missing code or state parameter');
    }

    // SEC-003: Verify HMAC-signed state to prevent CSRF
    const stateData = verifyState(state as string);
    if (!stateData) {
      throw new Error('Invalid or expired state parameter');
    }
    const userId = stateData.userId;
    
    // Get admin's Meta credentials
    const metaCreds = await getAdminMetaCredentials();
    if (!metaCreds) {
      throw new Error('Meta App not configured by admin. Please contact your administrator.');
    }

    const apiVersion = await getMetaApiVersion();

    // Exchange code for access token
    const redirectUri = getIntegrationOAuthCallbackUrl('meta');
    requireOAuthConfiguration(req,[metaCreds.appId,metaCreds.appSecret,redirectUri]);
    const tokenUrl = `https://graph.facebook.com/${apiVersion}/oauth/access_token`;
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        client_id: metaCreds.appId,
        redirect_uri: redirectUri,
        client_secret: metaCreds.appSecret,
        code: String(code),
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenData: any = await tokenResponse.json();

    if (!tokenResponse.ok || tokenData.error) {
      throw new Error(tokenData.error?.message || 'Failed to get access token');
    }

    const shortLivedToken = tokenData.access_token;

    // Exchange short-lived token for long-lived token (~60 days)
    const longLivedUrl = `https://graph.facebook.com/${apiVersion}/oauth/access_token`;
    const longLivedResponse = await fetch(longLivedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: metaCreds.appId,
        client_secret: metaCreds.appSecret,
        fb_exchange_token: shortLivedToken,
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const longLivedData: any = await longLivedResponse.json();

    const accessToken = longLivedData.access_token || shortLivedToken;
    const tokenExpiresIn = longLivedData.expires_in || 5184000; // Default 60 days
    const tokenExpiry = new Date(Date.now() + tokenExpiresIn * 1000);
    const tokenInspection = await inspectMetaToken({ accessToken, appId: metaCreds.appId, appSecret: metaCreds.appSecret, apiVersion });
    if (!tokenInspection.valid) throw new Error('Meta could not verify the issued Ads access token for this application.');

    // Get ad accounts
    const adAccountsUrl = `https://graph.facebook.com/${apiVersion}/me/adaccounts?` +
      'fields=id,name,currency,timezone_name,account_status';

    const adAccountsResponse = await fetch(adAccountsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adAccountsData: any = await adAccountsResponse.json();

    if (!adAccountsResponse.ok || !adAccountsData.data || adAccountsData.data.length === 0) {
      throw new Error('No ad accounts found');
    }

    adAccountsData.data = await collectMetaPages(adAccountsData, accessToken);

    // Get Facebook Page ID (if available)
    const pagesUrl = `https://graph.facebook.com/${apiVersion}/me/accounts?fields=id,name,access_token,picture.type(square){url},instagram_business_account{id,username}`;
    const pagesResponse = await fetch(pagesUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pagesData: any = await pagesResponse.json();
    pagesData.data = await collectMetaPages(pagesData, accessToken);
    const existingCredential = await getCredential(userId, 'meta_ads');
    const adAccounts = (adAccountsData.data as Array<{ id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number }>)
      .map((account) => ({ ...account, id: account.id.replace('act_', '') }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const pages = ((pagesData.data || []) as Array<{ id: string; name?: string; access_token?: string; picture?: { data?: { url?: string } }; instagram_business_account?: { id: string; username?: string } }>)
      .map(({ id, name, picture, instagram_business_account }) => ({ id, name: name || id, pictureUrl: picture?.data?.url || null, instagramAccountId: instagram_business_account?.id || null, instagramUsername: instagram_business_account?.username || null }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const previousAdAccountId = String(existingCredential?.config?.adAccountId || '').replace(/^act_/, '');
    const previousPageId = String(existingCredential?.config?.pageId || '');
    const adAccount = adAccounts.find((account) => account.id === previousAdAccountId)
      || (adAccounts.length === 1 ? adAccounts[0] : null);
    const selectedPage = pages.find((page) => page.id === previousPageId)
      || (pages.length === 1 ? pages[0] : null);
    const adAccountId = adAccount?.id || '';
    const pageId = selectedPage?.id || '';

    // Store credentials in api_credentials via credentialService (backward compat)
    await saveCredential(
      userId,
      'meta_ads',
      metaCreds.appId, // apiKey
      metaCreds.appSecret, // apiSecret
      {
        adAccountId,
        pageId,
        instagramAccountId: selectedPage?.instagramAccountId || null,
        instagramUsername: selectedPage?.instagramUsername || null,
        accessToken,
        accountName: adAccount?.name || null,
        currency: adAccount?.currency || null,
        timezone: adAccount?.timezone_name || null,
        accountStatus: adAccount?.account_status ?? null,
        adAccounts,
        pages,
        grantedScopes: tokenInspection.grantedScopes,
        declinedScopes: tokenInspection.declinedScopes,
        providerRequestIds: tokenInspection.providerRequestIds,
        selectionRequired: !adAccountId || !pageId,
        connectedViaOAuth: true,
        connectedAt: new Date().toISOString(),
        tokenExpiry: tokenExpiry.toISOString(),
        lastRefreshedAt: new Date().toISOString(),
      }
    );

    await disconnectAdsForUser(userId);

    // Also store in meta_page_connections for centralized routing (only if we have a proper page token)
    if (pageId) {
      const selectedPageData = pagesData.data?.find((page: { id?: string }) => page.id === pageId);
      const pageName = selectedPageData?.name || '';
      const pageToken = selectedPageData?.access_token || null;
      if (pageToken) {
        const previousConnection = await preserveMetaPageTokenBindings(userId, pageId);
        await upsertMetaPageConnection({
          userId,
          pageId,
          pageName,
          pageAccessToken: encryptMetaSecret(pageToken)!,
          userAccessToken: encryptMetaSecret(accessToken)!,
          adAccountId,
          instagramAccountId: selectedPage?.instagramAccountId || undefined,
          instagramUsername: selectedPage?.instagramUsername || undefined,
          tokenExpiry,
          adAccountName: adAccount?.name || null,
          adAccountCurrency: adAccount?.currency || null,
          adAccountTimezone: adAccount?.timezone_name || null,
          isActive: true,
          facebookActive: previousConnection?.facebookActive ?? false,
          instagramActive: previousConnection?.instagramActive ?? false,
        });
      }
    }
    if (adAccountId && pageId) {
      await verifyProviderIntegration(userId, 'meta_ads').catch((verificationError) => {
        logger.warn({ err: verificationError, userId }, '[AdPlatformOAuth] Post-OAuth Ads verification did not complete');
      });
    }
    // Keep the reporting inventory in step with the OAuth connection. Failure
    // remains recoverable from Paid Ads without discarding the valid OAuth link.
    await discoverPaidAdAccounts(userId, 'meta').catch((discoveryError) => {
      logger.warn({ err: discoveryError, userId }, '[AdPlatformOAuth] Post-OAuth account discovery failed');
    });

    // Redirect back to frontend
    res.redirect(`${FRONTEND_URL}/dashboard/integrations/meta?meta_connected=true`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdPlatformOAuth] Meta callback error');
    res.redirect(`${FRONTEND_URL}/dashboard/integrations/meta?error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * GET /api/meta/oauth/platforms
 * Get connected ad platforms for user
 */
router.get('/platforms', async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get Meta Ads credentials from api_credentials
    const metaAdsCred = await getCredential(userId, 'meta_ads');
    
    const platforms = [];
    if (metaAdsCred && metaAdsCred.config?.accessToken) {
      const selected = Boolean(metaAdsCred.config?.adAccountId && metaAdsCred.config?.pageId);
      const capabilities = await getMetaCapabilityStatuses({
        scopes: metaAdsCred.config?.grantedScopes,
        accountReady: selected,
        permissions: META_ADS_SCOPES,
      });
      platforms.push({
        id: metaAdsCred.id,
        platform: 'meta',
        accountName: metaAdsCred.config?.accountName || (selected ? 'Meta Ads' : 'Select an ad account'),
        currency: metaAdsCred.config?.currency || 'USD',
        isActive: true,
        connectedAt: metaAdsCred.config?.connectedAt || metaAdsCred.createdAt,
        expiresAt: null,
        adAccountId: metaAdsCred.config?.adAccountId || null,
        pageId: metaAdsCred.config?.pageId || null,
        selectionRequired: !selected,
        grantedScopes: metaAdsCred.config?.grantedScopes || [],
        declinedScopes: metaAdsCred.config?.declinedScopes || [],
        capabilities,
      });
    }

    res.json({ platforms });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdPlatformOAuth] Error fetching platforms');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

router.get('/selection', requireBusinessManager, async (req: Request, res: Response) => {
  const userId = Number(businessOwnerUserId(req));
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Unauthorized' });
  const credential = await getCredential(userId, 'meta_ads');
  if (!credential?.config?.accessToken) return res.status(404).json({ error: 'Connect Meta Ads before selecting provider accounts.' });
  const storedPages = Array.isArray(credential.config.pages) ? credential.config.pages as Array<Record<string, unknown>> : [];
  const apiVersion = await getMetaApiVersion();
  const pages = await Promise.all(storedPages.map(async (page) => {
    if (typeof page.pictureUrl === 'string' && page.pictureUrl) return page;
    const pageId = String(page.id || '');
    if (!pageId) return page;
    try {
      const pictureUrl = new URL(`https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pageId)}`);
      pictureUrl.searchParams.set('fields', 'id,name,picture.type(square){url}');
      const response = await fetch(pictureUrl, {
        headers: { authorization: `Bearer ${String(credential.config.accessToken)}` },
        signal: AbortSignal.timeout(8_000),
      });
      const data = await response.json().catch(() => ({})) as { name?: string; picture?: { data?: { url?: string } } };
      if (!response.ok) return page;
      return { ...page, name: data.name || page.name, pictureUrl: data.picture?.data?.url || null };
    } catch {
      return page;
    }
  }));
  return res.json({
    adAccounts: Array.isArray(credential.config.adAccounts) ? credential.config.adAccounts : [],
    pages,
    selectedAdAccountId: credential.config.adAccountId || null,
    selectedPageId: credential.config.pageId || null,
  });
});

router.post('/selection', requireBusinessManager, async (req: Request, res: Response) => {
  const userId = Number(businessOwnerUserId(req));
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Unauthorized' });
  const adAccountId = String(req.body?.adAccountId || '').replace(/^act_/, '');
  const pageId = String(req.body?.pageId || '');
  const credential = await getCredential(userId, 'meta_ads');
  if (!credential?.config?.accessToken) return res.status(404).json({ error: 'Connect Meta Ads before selecting provider accounts.' });
  const adAccounts = Array.isArray(credential.config.adAccounts) ? credential.config.adAccounts as Array<Record<string, unknown>> : [];
  const pages = Array.isArray(credential.config.pages) ? credential.config.pages as Array<Record<string, unknown>> : [];
  const adAccount = adAccounts.find((account) => String(account.id) === adAccountId);
  const page = pages.find((candidate) => String(candidate.id) === pageId);
  if (!adAccount || !page) return res.status(400).json({ error: 'Choose an ad account and Facebook Page returned by the current Meta authorization.' });
  const updatedConfig = {
    ...credential.config,
    adAccountId,
    pageId,
    accountName: String(adAccount.name || adAccountId),
    currency: String(adAccount.currency || ''),
    timezone: String(adAccount.timezone_name || ''),
    accountStatus: adAccount.account_status ?? null,
    selectionRequired: false,
    selectedAt: new Date().toISOString(),
  };
  const apiVersion = await getMetaApiVersion();
  const pageTokenResponse = await fetch(`https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pageId)}?fields=access_token,instagram_business_account{id,username}`, {
    headers: { authorization: `Bearer ${String(credential.config.accessToken)}` },
    signal: AbortSignal.timeout(15_000),
  });
  const pageTokenData = await pageTokenResponse.json().catch(() => ({})) as { access_token?: string; instagram_business_account?: { id: string; username?: string }; error?: { message?: string } };
  if (!pageTokenResponse.ok || !pageTokenData.access_token) {
    return res.status(409).json({ error: pageTokenData.error?.message || 'Meta did not return a Page access token for the selected Page.' });
  }
  const selectedInstagram = pageTokenData.instagram_business_account;
  const saved = await saveCredential(userId, 'meta_ads', credential.apiKey || '', credential.apiSecret || '', { ...updatedConfig, instagramAccountId: selectedInstagram?.id || null, instagramUsername: selectedInstagram?.username || null });
  if (!saved) return res.status(500).json({ error: 'Unable to persist the Meta account selection.' });
  await disconnectAdsForUser(userId);
  const previousConnection = await preserveMetaPageTokenBindings(userId, pageId);
  await upsertMetaPageConnection({
    userId,
    pageId,
    pageName: String(page.name || pageId),
    instagramAccountId: selectedInstagram?.id || previousConnection?.instagramAccountId || null,
    instagramUsername: selectedInstagram?.username || previousConnection?.instagramUsername || null,
    tokenExpiry: credential.config.tokenExpiry ? new Date(String(credential.config.tokenExpiry)) : undefined,
    pageAccessToken: encryptMetaSecret(pageTokenData.access_token)!,
    userAccessToken: encryptMetaSecret(String(credential.config.accessToken))!,
    adAccountId,
    adAccountName: String(adAccount.name || adAccountId),
    adAccountCurrency: String(adAccount.currency || ''),
    adAccountTimezone: String(adAccount.timezone_name || ''),
    scopes: Array.isArray(credential.config.grantedScopes) ? credential.config.grantedScopes : [],
    isActive: true,
    facebookActive: previousConnection?.facebookActive ?? false,
    instagramActive: previousConnection?.instagramActive ?? false,
  });
  const verification = await verifyProviderIntegration(userId, 'meta_ads');
  await discoverPaidAdAccounts(userId, 'meta').catch((discoveryError) => {
    logger.warn({ err: discoveryError, userId }, '[AdPlatformOAuth] Post-selection account discovery failed');
  });
  return res.json({ success: true, adAccountId, pageId, verification });
});

/**
 * DELETE /api/meta/oauth/platforms/:platform
 * Disconnect ad platform
 */
router.delete('/platforms/:platform', requireBusinessManager, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { platform } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Clear the accessToken and adAccountId from api_credentials config
    if (platform === 'meta') {
      const existingCred = await getCredential(userId, 'meta_ads');
      if (existingCred) {
        await saveCredential(
          userId,
          'meta_ads',
          existingCred.apiKey || '',
          existingCred.apiSecret || '',
          {
            ...existingCred.config,
            accessToken: null,
            adAccountId: null,
            connectedViaOAuth: false,
            disconnectedAt: new Date().toISOString(),
          }
        );
      }
      await disconnectAdsForUser(userId);
      await db.execute(sql`UPDATE paid_ad_accounts SET is_active=FALSE, reporting_available=FALSE, publishing_available=FALSE, updated_at=NOW() WHERE user_id=${userId} AND platform='meta'`);
    }

    res.json({ success: true, message: `${platform} disconnected` });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdPlatformOAuth] Error disconnecting platform');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

export default router;
