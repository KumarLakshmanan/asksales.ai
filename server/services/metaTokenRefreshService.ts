/**
 * Meta Token Refresh Service
 * Proactively refreshes Meta (Facebook/Instagram) tokens that are expiring soon.
 * Runs as a cron job via BullMQ (every 6 hours).
 */

import { db } from '../models/db.js';
 
import { eq, and, lt, or, ne } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { metaPageConnectionsTable } from '../models/metaPageConnections/schema.js';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';
import { getGraphApiVersion } from '../utils/metaApiVersion.js';
import { logger } from '../utils/logger.js';
import { decryptValue } from './SecretsManager.js';
import { encryptMetaSecret } from '../utils/metaCredentialSecrets.js';

const ENCRYPTED_TOKEN_PATTERN = /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i;
const ENCRYPTED_TOKEN_PREFIX = 'enc:v1:';

function decodeToken(value: string): string {
  const candidate = value.startsWith(ENCRYPTED_TOKEN_PREFIX) ? value.slice(ENCRYPTED_TOKEN_PREFIX.length) : value;
  return ENCRYPTED_TOKEN_PATTERN.test(candidate) ? decryptValue(candidate) : value;
}

function encodeLike(value: string, _original: string): string {
  // Any successful refresh is also an opportunistic rotation of a legacy row.
  return encryptMetaSecret(value)!;
}

/**
 * Exchange a current long-lived token for a new long-lived token.
 */
async function exchangeToken(currentToken: string, appId: string, appSecret: string, apiVersion: string): Promise<{ accessToken: string; expiresIn: number } | null> {
  try {
    const url = `https://graph.facebook.com/${apiVersion}/oauth/access_token`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: currentToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text();
      logger.warn({ status: response.status, body: text }, '[MetaTokenRefresh] Token exchange failed');
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    if (data.error) {
      logger.warn({ error: data.error }, '[MetaTokenRefresh] Token exchange returned error');
      return null;
    }

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in || 5184000, // default 60 days
    };
  } catch (err) {
    logger.error({ err }, '[MetaTokenRefresh] Token exchange exception');
    return null;
  }
}

/**
 * Refresh all Meta tokens that expire within 7 days.
 */
export async function refreshExpiringMetaTokens(): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;

  // Load admin credentials (appId + appSecret)
  const adminCred = await getActiveAdminCredential('meta_app');
  const appId = adminCred?.apiKey;
  const appSecret = adminCred?.apiSecret;

  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (!appId || !appSecret) {
    logger.warn('[MetaTokenRefresh] No Facebook/Instagram app credentials configured');
    return { refreshed, failed };
  }

  const apiVersion = await getGraphApiVersion();

  // --- 1. Refresh channel_credentials tokens ---
  try {
    const expiringCreds = await db
      .select({ id: channelCredentialsTable.id, accessToken: channelCredentialsTable.accessToken, platform: channelCredentialsTable.platform })
      .from(channelCredentialsTable)
      .where(
        and(
          or(
            eq(channelCredentialsTable.platform, 'instagram_api'),
            eq(channelCredentialsTable.platform, 'facebook'),
            eq(channelCredentialsTable.platform, 'facebook_api'),
            eq(channelCredentialsTable.platform, 'instagram'),
            eq(channelCredentialsTable.platform, 'whatsapp')
          ),
          eq(channelCredentialsTable.isActive, true),
          lt(channelCredentialsTable.tokenExpiry, sevenDaysFromNow),
          ne(channelCredentialsTable.credentialType, 'manual')
        )
      );

    for (const cred of expiringCreds) {
      if (!cred.accessToken) continue;
      const result = await exchangeToken(decodeToken(cred.accessToken), appId, appSecret, apiVersion);
      if (result) {
        await db.update(channelCredentialsTable)
          .set({
            accessToken: encodeLike(result.accessToken, cred.accessToken),
            tokenExpiry: new Date(Date.now() + result.expiresIn * 1000),
            lastRefreshedAt: new Date(),
          })
          .where(eq(channelCredentialsTable.id, cred.id));
        refreshed++;
        logger.info({ credId: cred.id, platform: cred.platform }, '[MetaTokenRefresh] channel_credentials token refreshed');
      } else {
        failed++;
        logger.warn({ credId: cred.id, platform: cred.platform }, '[MetaTokenRefresh] channel_credentials refresh failed');
      }
    }
  } catch (err) {
    logger.error({ err }, '[MetaTokenRefresh] Error refreshing channel_credentials');
  }

  // --- 2. Refresh meta_page_connections tokens ---
  try {
    const expiringPages = await db
      .select({
        id: metaPageConnectionsTable.id,
        pageAccessToken: metaPageConnectionsTable.pageAccessToken,
        userAccessToken: metaPageConnectionsTable.userAccessToken,
        pageId: metaPageConnectionsTable.pageId,
      })
      .from(metaPageConnectionsTable)
      .where(
        and(
          eq(metaPageConnectionsTable.isActive, true),
          lt(metaPageConnectionsTable.tokenExpiry, sevenDaysFromNow)
        )
      );

    for (const page of expiringPages) {
      // Refresh user access token
      const userResult = await exchangeToken(decodeToken(page.userAccessToken), appId, appSecret, apiVersion);
      if (userResult) {
        // After refreshing user token, re-fetch page token
        try {
          const pageTokenUrl = `https://graph.facebook.com/${apiVersion}/${page.pageId}?fields=access_token`;
          const pageRes = await fetch(pageTokenUrl, {
            headers: { Authorization: `Bearer ${userResult.accessToken}` },
            signal: AbortSignal.timeout(15_000),
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pageData: any = await pageRes.json();

          await db.update(metaPageConnectionsTable)
            .set({
              userAccessToken: encodeLike(userResult.accessToken, page.userAccessToken),
              pageAccessToken: pageData.access_token
                ? encodeLike(pageData.access_token, page.pageAccessToken)
                : page.pageAccessToken,
              tokenExpiry: new Date(Date.now() + userResult.expiresIn * 1000),
            })
            .where(eq(metaPageConnectionsTable.id, page.id));
          refreshed++;
          logger.info({ pageId: page.pageId }, '[MetaTokenRefresh] meta_page_connections token refreshed');
        } catch (pageErr) {
          // User token refreshed but page token fetch failed — still save user token
          await db.update(metaPageConnectionsTable)
            .set({
              userAccessToken: encodeLike(userResult.accessToken, page.userAccessToken),
              tokenExpiry: new Date(Date.now() + userResult.expiresIn * 1000),
            })
            .where(eq(metaPageConnectionsTable.id, page.id));
          refreshed++;
          logger.warn({ pageId: page.pageId, err: pageErr }, '[MetaTokenRefresh] Page token fetch failed, user token saved');
        }
      } else {
        failed++;
        logger.warn({ pageId: page.pageId }, '[MetaTokenRefresh] meta_page_connections refresh failed');
      }
    }
  } catch (err) {
    logger.error({ err }, '[MetaTokenRefresh] Error refreshing meta_page_connections');
  }

  logger.info({ refreshed, failed }, '[MetaTokenRefresh] Refresh cycle complete');
  return { refreshed, failed };
}
