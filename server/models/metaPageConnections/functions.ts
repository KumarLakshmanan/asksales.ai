/**
 * Meta Page Connections Model Functions
 * CRUD operations for user ↔ Facebook Page / Instagram mappings
 */

import { db } from '../db';
import { metaPageConnectionsTable, MetaPageConnectionRecord, InsertMetaPageConnection } from './schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { decryptMetaSecret } from '../../utils/metaCredentialSecrets.js';
import { logger } from '../../utils/logger.js';

/**
 * Upsert a meta page connection for a user (insert or update on conflict)
 */
export async function upsertMetaPageConnection(data: InsertMetaPageConnection): Promise<MetaPageConnectionRecord> {
  const [result] = await db
    .insert(metaPageConnectionsTable)
    .values(data)
    .onConflictDoUpdate({
      target: [metaPageConnectionsTable.businessProfileId, metaPageConnectionsTable.userId, metaPageConnectionsTable.pageId],
      set: {
        pageName: data.pageName,
        pageAccessToken: data.pageAccessToken,
        instagramAccountId: data.instagramAccountId,
        instagramUsername: data.instagramUsername,
        instagramProfilePicture: data.instagramProfilePicture,
        instagramFollowersCount: data.instagramFollowersCount,
        userAccessToken: data.userAccessToken,
        tokenExpiry: data.tokenExpiry,
        adAccountId: data.adAccountId,
        adAccountName: data.adAccountName,
        adAccountCurrency: data.adAccountCurrency,
        adAccountTimezone: data.adAccountTimezone,
        scopes: data.scopes,
        isActive: true,
        facebookActive: data.facebookActive,
        instagramActive: data.instagramActive,
        webhookSubscribed: data.webhookSubscribed,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result;
}

/**
 * Get active meta page connection for a user
 */
export async function getActiveConnectionForUser(userId: number): Promise<MetaPageConnectionRecord | null> {
  const [result] = await db
    .select()
    .from(metaPageConnectionsTable)
    .where(
      and(
        eq(metaPageConnectionsTable.userId, userId),
        eq(metaPageConnectionsTable.isActive, true)
      )
    )
    .limit(1);
  return result || null;
}

/**
 * Get all active connections for a user
 */
export async function getConnectionsForUser(userId: number): Promise<MetaPageConnectionRecord[]> {
  return db
    .select()
    .from(metaPageConnectionsTable)
    .where(eq(metaPageConnectionsTable.userId, userId));
}

/**
 * Find user by Facebook Page ID (for webhook routing)
 */
export async function findUserByPageId(pageId: string, platform?: 'facebook' | 'instagram'): Promise<MetaPageConnectionRecord | null> {
  const results = await db
    .select()
    .from(metaPageConnectionsTable)
    .where(
      and(
        eq(metaPageConnectionsTable.pageId, pageId),
        eq(metaPageConnectionsTable.isActive, true),
        ...(platform === 'facebook' ? [eq(metaPageConnectionsTable.facebookActive, true)] : []),
        ...(platform === 'instagram' ? [eq(metaPageConnectionsTable.instagramActive, true)] : [])
      )
    )
    .limit(2);
  return results.length === 1 ? results[0] : null;
}

/**
 * Find user by Instagram Account ID (for webhook routing)
 */
export async function findUserByInstagramAccountId(igAccountId: string, platform: 'instagram' = 'instagram'): Promise<MetaPageConnectionRecord | null> {
  const results = await db
    .select()
    .from(metaPageConnectionsTable)
    .where(
      and(
        eq(metaPageConnectionsTable.instagramAccountId, igAccountId),
        eq(metaPageConnectionsTable.isActive, true),
        ...(platform === 'instagram' ? [eq(metaPageConnectionsTable.instagramActive, true)] : [])
      )
    )
    .limit(2);
  return results.length === 1 ? results[0] : null;
}

/** Resolve profile/routing metadata for one tenant-owned Instagram identity. */
export async function findInstagramConnectionForUserAndAccount(
  userId: number,
  instagramAccountId: string,
  routingId?: string,
): Promise<MetaPageConnectionRecord | null> {
  const [result] = await db
    .select()
    .from(metaPageConnectionsTable)
    .where(and(
      eq(metaPageConnectionsTable.userId, userId),
      eq(metaPageConnectionsTable.instagramAccountId, instagramAccountId),
      ...(routingId ? [eq(metaPageConnectionsTable.pageId, routingId)] : []),
      eq(metaPageConnectionsTable.isActive, true),
      eq(metaPageConnectionsTable.instagramActive, true),
    ))
    .limit(1);
  return result || null;
}

/** Resolve the tenant-owned Instagram account behind an IG account or Page id. */
export async function findInstagramConnectionForUserAndRoutingId(
  userId: number,
  routingId: string,
): Promise<MetaPageConnectionRecord | null> {
  const [result] = await db
    .select()
    .from(metaPageConnectionsTable)
    .where(and(
      eq(metaPageConnectionsTable.userId, userId),
      or(
        eq(metaPageConnectionsTable.instagramAccountId, routingId),
        eq(metaPageConnectionsTable.pageId, routingId),
      ),
      eq(metaPageConnectionsTable.isActive, true),
      eq(metaPageConnectionsTable.instagramActive, true),
    ))
    .limit(1);
  return result || null;
}

/**
 * Get all active connections (for admin overview / webhook routing cache)
 */
export async function getAllActiveConnections(): Promise<MetaPageConnectionRecord[]> {
  return db
    .select()
    .from(metaPageConnectionsTable)
    .where(eq(metaPageConnectionsTable.isActive, true));
}

/** Deactivate only Facebook routing; Instagram webhook routing remains live. */
export async function disconnectFacebookForUser(userId: number): Promise<void> {
  await db.update(metaPageConnectionsTable)
    .set({ facebookActive: false, updatedAt: new Date() })
    .where(eq(metaPageConnectionsTable.userId, userId));
}

/** Deactivate only Instagram routing; Facebook webhook routing remains live. */
export async function disconnectInstagramForUser(userId: number): Promise<void> {
  await db.update(metaPageConnectionsTable)
    .set({ instagramActive: false, updatedAt: new Date() })
    .where(eq(metaPageConnectionsTable.userId, userId));
}

/** Disconnect Ads while preserving the shared Facebook/Instagram page link. */
export async function disconnectAdsForUser(userId: number): Promise<void> {
  await db
    .update(metaPageConnectionsTable)
    .set({
      adAccountId: null,
      adAccountName: null,
      adAccountCurrency: null,
      adAccountTimezone: null,
      updatedAt: new Date(),
    })
    .where(eq(metaPageConnectionsTable.userId, userId));
}

/**
 * Update webhook subscription status
 */
export async function updateWebhookStatus(id: number, subscribed: boolean): Promise<void> {
  await db
    .update(metaPageConnectionsTable)
    .set({ webhookSubscribed: subscribed, updatedAt: new Date() })
    .where(eq(metaPageConnectionsTable.id, id));
}

/**
 * Count active connections (for admin stats)
 */
export async function countActiveConnections(): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(metaPageConnectionsTable)
    .where(eq(metaPageConnectionsTable.isActive, true));
  return Number(result?.count || 0);
}

/**
 * Get Meta Ads credentials for a user by combining meta_page_connections + admin config.
 * Returns accessToken, adAccountId, pageId, apiVersion needed for Meta Ads API calls.
 * Falls back to channel_credentials (manual credentials) if meta_page_connections has no data.
 */
export async function getMetaAdsCreds(userId: number): Promise<{
  accessToken: string;
  adAccountId: string;
  pageId: string;
  apiVersion: string;
  adAccountName?: string | null;
  adAccountCurrency?: string | null;
  adAccountTimezone?: string | null;
  pageName?: string | null;
  instagramAccountId?: string | null;
  instagramUsername?: string | null;
  expiresAt?: Date | null;
} | null> {
  // Primary: meta_page_connections (populated by OAuth flow)
  // Find a connection that specifically has an adAccountId configured
  const connections = await db
    .select()
    .from(metaPageConnectionsTable)
    .where(
      and(
        eq(metaPageConnectionsTable.userId, userId),
        eq(metaPageConnectionsTable.isActive, true)
      )
    );
    
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adConnections = connections.filter((c: any) => c.userAccessToken && c.adAccountId);
  // Multiple configured Pages require an explicit Ads selection, never row order.
  if (adConnections.length > 1) return null;
  const adConnection = adConnections[0];
  
  if (adConnection) {
    if (adConnection.tokenExpiry && new Date(adConnection.tokenExpiry) <= new Date()) {
      return null;
    }
    // Get API version from admin config if available
    let apiVersion = 'v25.0';
    try {
      const { getActiveAdminCredential } = await import('../adminApiCredentials/functions');
      const adminCred = await getActiveAdminCredential('meta_app');
      if (adminCred?.config?.apiVersion) {
        apiVersion = adminCred.config.apiVersion as string;
      }
    } catch { /* use default */ }

    let accessToken: string;
    try {
      accessToken = decryptMetaSecret(adConnection.userAccessToken!);
    } catch (error) {
      // A token sealed with a retired key cannot be used; the owner must reconnect Meta.
      logger.warn({ err: error instanceof Error ? error.message : String(error), connectionId: adConnection.id }, '[MetaAds] Stored Meta token cannot be decrypted; reconnect required');
      return null;
    }

    return {
      accessToken,
      adAccountId: adConnection.adAccountId!,
      pageId: adConnection.pageId || '',
      apiVersion,
      adAccountName: adConnection.adAccountName,
      adAccountCurrency: adConnection.adAccountCurrency,
      adAccountTimezone: adConnection.adAccountTimezone,
      pageName: adConnection.pageName,
      instagramAccountId: adConnection.instagramAccountId,
      instagramUsername: adConnection.instagramUsername,
      expiresAt: adConnection.tokenExpiry,
    };
  }

  // Fallback: channel_credentials with platform='meta' (manual credentials)
  try {
    const { channelCredentialsTable } = await import('../channelCredentials/schema');
    const manualCreds = await db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'meta'),
          eq(channelCredentialsTable.isActive, true)
        )
      )
      .limit(1);

    if (
      manualCreds.length > 0
      && manualCreds[0].accessToken
      && manualCreds[0].accountIdentifier
      && (!manualCreds[0].tokenExpiry || new Date(manualCreds[0].tokenExpiry) > new Date())
    ) {
      const session = manualCreds[0].sessionData && typeof manualCreds[0].sessionData === 'object'
        ? manualCreds[0].sessionData as Record<string, unknown>
        : {};
      let apiVersion = 'v25.0';
      try {
        const { getActiveAdminCredential } = await import('../adminApiCredentials/functions');
        const adminCred = await getActiveAdminCredential('meta_app');
        if (adminCred?.config?.apiVersion) {
          apiVersion = adminCred.config.apiVersion as string;
        }
      } catch { /* use default */ }

      return {
        accessToken: decryptMetaSecret(manualCreds[0].accessToken!),
        adAccountId: manualCreds[0].accountIdentifier!,
        pageId: typeof session.pageId === 'string' ? session.pageId : '',
        apiVersion,
        adAccountName: typeof session.adAccountName === 'string' ? session.adAccountName : null,
        adAccountCurrency: typeof session.adAccountCurrency === 'string' ? session.adAccountCurrency : null,
        adAccountTimezone: typeof session.adAccountTimezone === 'string' ? session.adAccountTimezone : null,
        pageName: typeof session.pageName === 'string' ? session.pageName : null,
        instagramAccountId: typeof session.instagramAccountId === 'string' ? session.instagramAccountId : null,
        instagramUsername: typeof session.instagramUsername === 'string' ? session.instagramUsername : null,
        expiresAt: manualCreds[0].tokenExpiry,
      };
    }
  } catch { /* no manual creds found */ }

  // Final Fallback: api_credentials via credentialService (legacy/OAuth fallback)
  try {
    const { CredentialService } = await import('../../services/credentialService.js');
    const metaCreds = await CredentialService.getCredential(userId, 'meta_ads');
    if (metaCreds && metaCreds.config?.accessToken && metaCreds.config?.adAccountId) {
      let apiVersion = 'v25.0';
      try {
        const { getActiveAdminCredential } = await import('../adminApiCredentials/functions');
        const adminCred = await getActiveAdminCredential('meta_app');
        if (adminCred?.config?.apiVersion) {
          apiVersion = adminCred.config.apiVersion as string;
        }
      } catch { /* use default */ }

      return {
        accessToken: metaCreds.config.accessToken,
        adAccountId: metaCreds.config.adAccountId,
        pageId: metaCreds.config.pageId || '',
        apiVersion,
        adAccountName: metaCreds.config.adAccountName || null,
        adAccountCurrency: metaCreds.config.adAccountCurrency || null,
        adAccountTimezone: metaCreds.config.adAccountTimezone || null,
        pageName: metaCreds.config.pageName || null,
        instagramAccountId: metaCreds.config.instagramAccountId || null,
        instagramUsername: metaCreds.config.instagramUsername || null,
      };
    }
  } catch { /* no api_credentials found */ }

  return null;
}
