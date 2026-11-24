import { businessOwnerUserId } from '../tenancy/businessContext.js';
 
import type { AuthenticatedRequest } from '../types/express.js';
/**
 * Integrations Controller
 * Manages integration configurations for Google Ads, Twitter, LinkedIn
 * 
 * NOTE: Meta Ads and Meta App configurations are admin-managed via /api/admin/meta/* routes.
 * Per-user Meta credentials have been removed — use OAuth connect buttons instead.
 */

 
import { Response } from "express";
import { deleteCredential, getCredential, saveCredential } from "../services/credentialService";
import { discoverGoogleAdsAccounts } from "../services/ads/GoogleAdsService.js";
import { decryptValue } from "../services/SecretsManager.js";
import { logger } from '../utils/logger.js';
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';

const MASKED_SECRET = '••••••••';

async function googleAdsDeveloperToken(legacyToken?: string): Promise<string> {
  return process.env.GOOGLE_ADS_DEVELOPER_TOKEN || legacyToken || '';
}

function decryptStoredSecret(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    return value.split(':').length === 3 ? decryptValue(value) : value;
  } catch {
    return value;
  }
}

function normalizeGoogleAccountId(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[-\s]/g, '') : '';
}

// Extend Express Request to include user

/**
 * Get Google Ads configuration
 */
export const getGoogleAdsConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const cred = await getCredential(userId, 'google_ads');
    const developerToken = await googleAdsDeveloperToken(cred?.config?.developerToken);
    if (!cred) return res.json({ success: true, config: null, providerConfigured: Boolean(developerToken) });
    
    return res.json({
      success: true,
      config: {
        customerId: cred.config?.customerId || '',
        managerAccountId: cred.config?.managerAccountId || '',
        hasRefreshToken: Boolean(cred.config?.refreshToken),
        connectedViaOAuth: Boolean(cred.config?.connectedViaOAuth),
        providerConfigured: Boolean(developerToken),
        ready: Boolean(
          cred.apiKey && cred.apiSecret && developerToken &&
          cred.config?.customerId && cred.config?.refreshToken
        ),
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[IntegrationsController] Error getting Google Ads config');
    res.status(500).json({ error: "Unable to retrieve your Google Ads configuration. Please try again." });
  }
};

/**
 * Save Google Ads configuration
 */
export const getGoogleAdsAccounts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const credentials = await getGoogleAdsCredentials(userId);
    if (!credentials?.refreshToken) return res.status(409).json({ error: 'Connect your Google account first.' });
    if (!credentials.developerToken) return res.status(503).json({ error: 'Google Ads access is not configured by AskSales yet. Contact support.' });
    const result = await discoverGoogleAdsAccounts(credentials);
    return res.json(result);
  } catch (error) {
    logger.warn({ err: error }, '[IntegrationsController] Could not list Google Ads accounts');
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Google Ads accounts could not be loaded.' });
  }
};

export const selectGoogleAdsAccount = async (req: AuthenticatedRequest, res: Response) => {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const customerId = normalizeGoogleAccountId(req.body?.customerId);
  if (!/^\d{10}$/.test(customerId)) return res.status(400).json({ error: 'Choose a Google Ads customer account.' });
  try {
    const credentials = await getGoogleAdsCredentials(userId);
    if (!credentials?.refreshToken || !credentials.developerToken) return res.status(409).json({ error: 'Google Ads authorization or platform setup is incomplete.' });
    const discovered = await discoverGoogleAdsAccounts(credentials);
    const account = discovered.accounts.find(item => item.customerId === customerId && !item.manager);
    if (!account) return res.status(403).json({ error: 'This Google Ads customer account was not found among your authorized accounts.' });
    const existing = await getCredential(userId, 'google_ads');
    const saved = await saveCredential(userId, 'google_ads', existing.apiKey, existing.apiSecret, {
      ...existing.config,
      customerId: account.customerId,
      managerAccountId: account.managerAccountId || '',
    });
    if (!saved) return res.status(500).json({ error: 'Google Ads account selection could not be saved.' });
    return res.json({ success: true, customerId: account.customerId, accountName: account.name || null });
  } catch (error) {
    logger.warn({ err: error }, '[IntegrationsController] Could not select Google Ads account');
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Google Ads account selection failed.' });
  }
};

export const disconnectGoogleAds = async (req: AuthenticatedRequest, res: Response) => {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (!await deleteCredential(userId, 'google_ads')) return res.status(500).json({ error: 'Google Ads could not be disconnected.' });
    await db.execute(sql`UPDATE paid_ad_accounts SET is_active=FALSE, reporting_available=FALSE,
      publishing_available=FALSE, updated_at=NOW() WHERE user_id=${userId} AND platform='google'`);
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, '[IntegrationsController] Google Ads disconnect failed');
    return res.status(503).json({ error: 'Google Ads could not be disconnected. Try again.' });
  }
};

/**
 * Get Google Ads credentials for publishing (internal use)
 */
export const getGoogleAdsCredentials = async (userId: number) => {
  try {
    const cred = await getCredential(userId, 'google_ads');
    if (!cred) {
      return null;
    }
    
    return {
      clientId: cred.apiKey || '',
      clientSecret: decryptStoredSecret(cred.apiSecret),
      developerToken: await googleAdsDeveloperToken(cred.config?.developerToken),
      customerId: normalizeGoogleAccountId(cred.config?.customerId),
      refreshToken: decryptStoredSecret(cred.config?.refreshToken),
      managerAccountId: normalizeGoogleAccountId(cred.config?.managerAccountId),
    };
  } catch (error) {
    logger.error({ err: error }, '[IntegrationsController] Error getting Google Ads credentials');
    return null;
  }
};

// ─── Twitter Config ──────────────────────────────────────────────────────────

export const getTwitterConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const cred = await getCredential(userId, 'twitter_api');
    if (!cred) return res.json({ success: true, config: null });

    return res.json({
      success: true,
      config: {
        apiKey: cred.apiKey ? MASKED_SECRET : '',
        apiSecret: cred.apiSecret ? MASKED_SECRET : '',
        bearerToken: cred.config?.bearerToken ? MASKED_SECRET : '',
        hasApiKey: Boolean(cred.apiKey),
        hasApiSecret: Boolean(cred.apiSecret),
        hasBearerToken: Boolean(cred.config?.bearerToken),
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[IntegrationsController] Error getting Twitter config');
    res.status(500).json({ error: "Unable to retrieve Twitter configuration." });
  }
};

export const saveTwitterConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { apiKey, apiSecret, bearerToken } = req.body;

    for (const [field, value] of Object.entries({ apiKey, apiSecret, bearerToken })) {
      if (value !== undefined && (typeof value !== 'string' || value.length > 5000)) {
        return res.status(400).json({ error: `${field} is invalid` });
      }
    }

    const existing = await getCredential(userId, 'twitter_api');
    const effectiveApiKey = typeof apiKey === 'string' && apiKey.trim() && apiKey !== MASKED_SECRET
      ? apiKey.trim()
      : existing?.apiKey || '';
    const effectiveSecret = typeof apiSecret === 'string' && apiSecret.trim() && apiSecret !== MASKED_SECRET
      ? apiSecret.trim()
      : existing?.apiSecret || '';
    const effectiveBearerToken = typeof bearerToken === 'string' && bearerToken.trim() && bearerToken !== MASKED_SECRET
      ? bearerToken.trim()
      : existing?.config?.bearerToken || '';

    const saved = await saveCredential(
      userId,
      'twitter_api',
      effectiveApiKey,
      effectiveSecret || '',
      { ...(existing?.config || {}), bearerToken: effectiveBearerToken }
    );

    if (!saved) return res.status(500).json({ error: "Unable to save Twitter configuration." });
    return res.json({ success: true, message: "Twitter configuration saved" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[IntegrationsController] Error saving Twitter config');
    res.status(500).json({ error: "Unable to save Twitter configuration." });
  }
};

// ─── LinkedIn Config ─────────────────────────────────────────────────────────

export const getLinkedInConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const cred = await getCredential(userId, 'linkedin_api');
    if (!cred) return res.json({ success: true, config: null });

    return res.json({
      success: true,
      config: {
        clientId: cred.apiKey || '',
        clientSecret: cred.apiSecret ? MASKED_SECRET : '',
        hasClientSecret: Boolean(cred.apiSecret),
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[IntegrationsController] Error getting LinkedIn config');
    res.status(500).json({ error: "Unable to retrieve LinkedIn configuration." });
  }
};

export const saveLinkedInConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { clientId, clientSecret } = req.body;

    if (typeof clientId !== 'string' || clientId.trim().length > 500) {
      return res.status(400).json({ error: 'clientId is invalid' });
    }
    if (clientSecret !== undefined && (typeof clientSecret !== 'string' || clientSecret.length > 5000)) {
      return res.status(400).json({ error: 'clientSecret is invalid' });
    }

    const existing = await getCredential(userId, 'linkedin_api');
    const effectiveSecret = typeof clientSecret === 'string' && clientSecret.trim() && clientSecret !== MASKED_SECRET
      ? clientSecret.trim()
      : existing?.apiSecret || '';

    const saved = await saveCredential(
      userId,
      'linkedin_api',
      clientId.trim(),
      effectiveSecret || '',
      {}
    );

    if (!saved) return res.status(500).json({ error: "Unable to save LinkedIn configuration." });
    return res.json({ success: true, message: "LinkedIn configuration saved" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[IntegrationsController] Error saving LinkedIn config');
    res.status(500).json({ error: "Unable to save LinkedIn configuration." });
  }
};
