/* eslint-disable @typescript-eslint/no-explicit-any */
/** Shared webhook helpers: capability tokens, app secrets and provider account lookup. */
import { Request } from 'express';
import { db } from '../../models/db';
import { eq, and, desc } from 'drizzle-orm';
import { timingSafeEqual } from '../../utils/secureCompare.js';
import { channelCredentialsTable } from '../../models/channelCredentials/schema';
import { decryptMetaSecret } from '../../utils/metaCredentialSecrets.js';
import { currentVerifiedWebhookCapability, webhookCapabilityVerifyToken, type WebhookPurpose } from '../../utils/userWebhookTokens.js';
import { getCredential } from '../../services/credentialService.js';

export async function getUserAppSecretFromPayload(body: any, platform: 'facebook_api' | 'instagram_api'): Promise<string | null> {
  try {

    const entries: any[] = body?.entry || [];
    for (const entry of entries) {
      const accountId = entry.id;
      if (!accountId) continue;

      // Primary: look up channel_credentials by exact accountIdentifier
      const rows = await db
        .select({ apiSecret: channelCredentialsTable.apiSecret, sessionData: channelCredentialsTable.sessionData })
        .from(channelCredentialsTable)
        .where(and(
          eq(channelCredentialsTable.platform, platform),
          eq(channelCredentialsTable.accountIdentifier, String(accountId)),
          eq(channelCredentialsTable.isActive, true)
        ))
        .limit(1);
      if (rows.length > 0) {

        const sd = rows[0].sessionData as any;
        if (rows[0].apiSecret) return decryptMetaSecret(rows[0].apiSecret);
        if (sd?.appSecret) return decryptMetaSecret(sd.appSecret as string);
      }

      // Fallback: webhook entry.id may be the IG account ID stored in meta_page_connections,
      // not matching channel_credentials.accountIdentifier (common when user connected via two different flows)
      if (platform === 'instagram_api' || platform === 'facebook_api') {
        const { findUserByPageId, findUserByInstagramAccountId } = await import('../../models/metaPageConnections/functions.js');
        const connectionPlatform = platform === 'facebook_api' ? 'facebook' : 'instagram';
        const pageConn = await findUserByPageId(String(accountId), connectionPlatform).catch(() => null) ||
                          await findUserByInstagramAccountId(String(accountId), 'instagram').catch(() => null);
        if (pageConn) {
          const ccRows = await db
            .select({ apiSecret: channelCredentialsTable.apiSecret, sessionData: channelCredentialsTable.sessionData })
            .from(channelCredentialsTable)
            .where(and(
              eq(channelCredentialsTable.userId, pageConn.userId),
              eq(channelCredentialsTable.platform, platform),
              eq(channelCredentialsTable.isActive, true)
            ))
            .limit(1);
          if (ccRows.length > 0) {

            const sd = ccRows[0].sessionData as any;
            if (ccRows[0].apiSecret) return decryptMetaSecret(ccRows[0].apiSecret);
            if (sd?.appSecret) return decryptMetaSecret(sd.appSecret as string);
          }
        }
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Remove any bracketed placeholder tokens that the LLM may have left in a reply,
 * e.g. [Link to Calendar], [Your Name], [insert here].
 * Social replies are sent directly to customers so they must be clean.
 */
export function stripSocialPlaceholders(text: string): string {
  return text.replace(/\s*\[[^\]]{1,60}\]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// Extend Express Request to include user

// Get APP_URL with proper fallback - construct from request if not set
export const getAppUrl = (req: Request): string => {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.API_URL) return process.env.API_URL;

  // Construct from request - check for forwarded headers (for reverse proxy)
  const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:8080';
  return `${protocol}://${host}`;
};

/**
 * Consume the capability authority established by the public-route boundary
 */
export const findUserIdFromToken = async (token: string, purpose: WebhookPurpose | readonly WebhookPurpose[]): Promise<number | null> => {
  return currentVerifiedWebhookCapability(token, purpose)?.userId || null;
};

export async function tenantWebhookAppSecret(
  userId: number,
  serviceName: 'twitter_api' | 'linkedin_api',
): Promise<string | null> {
  const credential = await getCredential(userId, serviceName);
  return typeof credential?.apiSecret === 'string' && credential.apiSecret.length > 0
    ? credential.apiSecret
    : null;
}

export async function resolveWebhookProviderAccount(
  userId: number,
  platform: 'twitter_api' | 'linkedin_api',
  claimedAccountId?: string,
): Promise<string | null> {
  const predicates = [
    eq(channelCredentialsTable.userId, userId),
    eq(channelCredentialsTable.platform, platform),
    eq(channelCredentialsTable.isActive, true),
  ];
  if (claimedAccountId) {
    predicates.push(eq(channelCredentialsTable.accountIdentifier, claimedAccountId));
  }
  const credentials = await db.select({
    accountIdentifier: channelCredentialsTable.accountIdentifier,
  })
    .from(channelCredentialsTable)
    .where(and(...predicates))
    .orderBy(desc(channelCredentialsTable.isSelected), desc(channelCredentialsTable.id))
    .limit(claimedAccountId ? 1 : 2);
  if (claimedAccountId) return credentials[0]?.accountIdentifier || null;
  return credentials.length === 1 ? credentials[0].accountIdentifier || null : null;
}

/**
 * Verify user's verify token
 */
export const verifyUserToken = async (token: string, verifyToken: string, purpose: WebhookPurpose | readonly WebhookPurpose[]): Promise<number | null> => {
  const userId = await findUserIdFromToken(token, purpose);
  return userId && timingSafeEqual(webhookCapabilityVerifyToken(token), verifyToken) ? userId : null;
};
