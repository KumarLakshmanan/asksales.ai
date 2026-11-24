/**
 * Channel Credentials Model Functions
 */

import { db } from '../db';
import { channelCredentialsTable, ChannelCredentialRecord, InsertChannelCredential } from './schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { metaPageConnectionsTable } from '../metaPageConnections/schema';
import { requireBusinessScope } from '../../tenancy/businessContext.js';

export class GmailMailboxOwnershipConflictError extends Error {
  readonly code = 'GMAIL_MAILBOX_ALREADY_CONNECTED';

  constructor() {
    super('This Gmail mailbox has conflicting active connection records. Ask an administrator to review existing connections before reconnecting.');
    this.name = 'GmailMailboxOwnershipConflictError';
  }
}

export const ChannelCredentialModel = {
  /**
   * Create or update channel credentials
   */
  async upsert(data: InsertChannelCredential): Promise<ChannelCredentialRecord> {
    const gmailMailbox = data.platform === 'gmail_api' && data.accountIdentifier
      ? data.accountIdentifier.trim().toLowerCase()
      : '';
    const scope = gmailMailbox ? requireBusinessScope() : undefined;
    if (scope && (data.userId !== scope.userId || (data.businessProfileId !== undefined && data.businessProfileId !== scope.businessProfileId))) {
      throw new Error('Gmail credentials must belong to the authorized business');
    }
    const normalizedData = gmailMailbox
      ? { ...data, accountIdentifier: gmailMailbox, businessProfileId: scope!.businessProfileId }
      : data;

    const persist = async (connection: typeof db, normalizedGmailAccount = false) => {
      const conditions = [
        eq(channelCredentialsTable.userId, normalizedData.userId),
        eq(channelCredentialsTable.platform, normalizedData.platform),
      ];
      // Treat provider mailbox addresses case-insensitively so a reconnect
      // updates this tenant's existing credential instead of creating another.
      if (gmailMailbox && normalizedGmailAccount) {
        conditions.push(sql`LOWER(TRIM(${channelCredentialsTable.accountIdentifier})) = ${gmailMailbox}`);
      } else if (normalizedData.accountIdentifier) {
        conditions.push(eq(channelCredentialsTable.accountIdentifier, normalizedData.accountIdentifier));
      }

      const matching = connection
        .select()
        .from(channelCredentialsTable)
        .where(and(...conditions));
      const [existing] = await (gmailMailbox && normalizedGmailAccount
        ? matching.orderBy(desc(channelCredentialsTable.isActive), desc(channelCredentialsTable.updatedAt), desc(channelCredentialsTable.id)).limit(1)
        : matching.limit(1));

      if (existing) {
        const [updated] = await connection
          .update(channelCredentialsTable)
          .set({ ...normalizedData, updatedAt: new Date() })
          .where(eq(channelCredentialsTable.id, existing.id))
          .returning();
        return updated;
      }

      const [inserted] = await connection
        .insert(channelCredentialsTable)
        .values(normalizedData)
        .returning();
      return inserted;
    };

    if (!gmailMailbox) return persist(db);

    return db.transaction(async (tx: typeof db) => {
      // OAuth callbacks for the same mailbox can arrive concurrently. Serialize
      // ownership checks so two tenants cannot both pass the check and insert.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${
        `channel_credentials:gmail_api:${gmailMailbox}`
      }, 0))`);

      if (normalizedData.isActive !== false) {
        // scopedPool captures scope when the transaction checks out its client;
        // withSystemScope around this query would still apply business RLS.
        // Use the repository's system-read policy on this SAME locked client
        // only for a boolean conflict read. Restore tenant RLS before writes.
        // A restore failure must abort/roll back, never permit an elevated write.
        await tx.execute(sql`SELECT set_config('app.business_system', 'on', true)`);
        let conflict: boolean;
        try {
          const result = await tx.execute(sql`SELECT
            COUNT(*) > 1 OR COALESCE(BOOL_OR(
              business_profile_id IS DISTINCT FROM ${scope!.businessProfileId}
              OR user_id IS DISTINCT FROM ${scope!.userId}
            ), FALSE) AS conflict
            FROM channel_credentials WHERE platform = 'gmail_api' AND is_active IS TRUE
              AND LOWER(TRIM(account_identifier)) = ${gmailMailbox}`);
          const verifiedConflict = result.rows[0]?.conflict;
          if (typeof verifiedConflict !== 'boolean') throw new Error('Gmail mailbox ownership could not be verified');
          conflict = verifiedConflict;
        } finally {
          await tx.execute(sql`SELECT set_config('app.business_system', 'off', true)`);
        }
        if (conflict) throw new GmailMailboxOwnershipConflictError();
      }

      return persist(tx, true);
    }, { isolationLevel: 'read committed' });
  },

  /**
   * Find credentials by user and platform
   */
  async findByUserAndPlatform(
    userId: number,
    platform: string
  ): Promise<ChannelCredentialRecord | undefined> {
    const [credential] = await db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform),
          eq(channelCredentialsTable.isActive, true)
        )
      )
      .orderBy(desc(channelCredentialsTable.isSelected), desc(channelCredentialsTable.updatedAt))
      .limit(1);
    
    return credential;
  },

  /**
   * Find all credentials for a user
   */
  async findByUser(userId: number): Promise<ChannelCredentialRecord[]> {
    return db
      .select()
      .from(channelCredentialsTable)
      .where(eq(channelCredentialsTable.userId, userId));
  },

  /**
   * Find all credentials for a user + platform (supports multiple accounts)
   */
  async findAllByUserAndPlatform(
    userId: number,
    platform: string
  ): Promise<ChannelCredentialRecord[]> {
    return db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform),
          eq(channelCredentialsTable.isActive, true)
        )
      )
      .orderBy(
        desc(channelCredentialsTable.isSelected),
        desc(channelCredentialsTable.updatedAt),
        desc(channelCredentialsTable.id),
      );
  },

  /** Find one active account by its tenant-owned database id. */
  async findActiveAccountById(
    userId: number,
    platform: string,
    credentialId: number,
  ): Promise<ChannelCredentialRecord | undefined> {
    const [credential] = await db
      .select()
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.id, credentialId),
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, platform),
        eq(channelCredentialsTable.isActive, true),
      ))
      .limit(1);
    return credential;
  },

  /** Find one active account by its provider-owned account identifier. */
  async findActiveAccountByIdentifier(
    userId: number,
    platform: string,
    accountIdentifier: string,
  ): Promise<ChannelCredentialRecord | undefined> {
    const [credential] = await db
      .select()
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, platform),
        eq(channelCredentialsTable.accountIdentifier, accountIdentifier),
        eq(channelCredentialsTable.isActive, true),
      ))
      .limit(1);
    return credential;
  },

  /** Select one already-owned account for a platform without altering tokens. */
  async selectAccount(userId: number, platform: string, credentialId: number): Promise<ChannelCredentialRecord | undefined> {
    return db.transaction(async (tx: typeof db) => {
      const [target] = await tx.select().from(channelCredentialsTable).where(and(
        eq(channelCredentialsTable.id, credentialId),
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, platform),
        eq(channelCredentialsTable.isActive, true),
      )).limit(1);
      if (!target) return undefined;
      await tx.update(channelCredentialsTable).set({ isSelected: false, updatedAt: new Date() }).where(and(
        eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, platform),
      ));
      const [selected] = await tx.update(channelCredentialsTable).set({ isSelected: true, updatedAt: new Date() })
        .where(eq(channelCredentialsTable.id, credentialId)).returning();
      return selected;
    });
  },

  /**
   * Remove exactly one tenant-owned account and choose a deterministic
   * replacement when the removed account was the publishing default.
   *
   * Meta routing is disabled for only the removed identity. Tokens are not
   * revoked at Meta because one Facebook authorization can back several
   * Pages/Instagram accounts; revoking it would disconnect the identities the
   * user intentionally kept.
   */
  async removeAccount(
    userId: number,
    platform: string,
    credentialId: number,
  ): Promise<{
    removedId: number;
    removedAccountIdentifier: string | null;
    selected: ChannelCredentialRecord | null;
  } | undefined> {
    return db.transaction(async (tx: typeof db) => {
      const [target] = await tx.select().from(channelCredentialsTable).where(and(
        eq(channelCredentialsTable.id, credentialId),
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, platform),
        eq(channelCredentialsTable.isActive, true),
      )).limit(1);
      if (!target) return undefined;

      if (target.accountIdentifier && platform === 'instagram_api') {
        await tx.update(metaPageConnectionsTable).set({
          instagramActive: false,
          updatedAt: new Date(),
        }).where(and(
          eq(metaPageConnectionsTable.userId, userId),
          eq(metaPageConnectionsTable.instagramAccountId, target.accountIdentifier),
        ));
      } else if (target.accountIdentifier && platform === 'facebook_api') {
        await tx.update(metaPageConnectionsTable).set({
          facebookActive: false,
          updatedAt: new Date(),
        }).where(and(
          eq(metaPageConnectionsTable.userId, userId),
          eq(metaPageConnectionsTable.pageId, target.accountIdentifier),
        ));
      }

      await tx.delete(channelCredentialsTable).where(and(
        eq(channelCredentialsTable.id, target.id),
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, platform),
      ));

      const [remainingDefault] = await tx.select().from(channelCredentialsTable).where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, platform),
        eq(channelCredentialsTable.isActive, true),
      )).orderBy(
        desc(channelCredentialsTable.isSelected),
        desc(channelCredentialsTable.updatedAt),
        desc(channelCredentialsTable.id),
      ).limit(1);

      let selected: ChannelCredentialRecord | null = remainingDefault || null;
      if (remainingDefault && (target.isSelected || !remainingDefault.isSelected)) {
        const [replacement] = await tx.update(channelCredentialsTable).set({
          isSelected: true,
          updatedAt: new Date(),
        }).where(eq(channelCredentialsTable.id, remainingDefault.id)).returning();
        selected = replacement || remainingDefault;
      }

      return {
        removedId: target.id,
        removedAccountIdentifier: target.accountIdentifier,
        selected,
      };
    });
  },

  /**
   * Find active platforms for a user
   */
  async findActivePlatforms(userId: number): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credentials: any[] = await db
      .select({ platform: channelCredentialsTable.platform })
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.isActive, true)
        )
      );
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return credentials.map((c: any) => c.platform);
  },

  /**
   * Update credentials
   */
  async update(
    userId: number,
    platform: string,
    data: Partial<InsertChannelCredential>
  ): Promise<ChannelCredentialRecord | undefined> {
    const [updated] = await db
      .update(channelCredentialsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform)
        )
      )
      .returning();
    
    return updated;
  },

  /** Update one exact tenant-owned provider account. */
  async updateAccount(
    userId: number,
    platform: string,
    credentialId: number,
    data: Partial<InsertChannelCredential>,
  ): Promise<ChannelCredentialRecord | undefined> {
    const [updated] = await db
      .update(channelCredentialsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(and(
        eq(channelCredentialsTable.id, credentialId),
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, platform),
      ))
      .returning();
    return updated;
  },

  /**
   * Update last used timestamp
   */
  async updateLastUsed(userId: number, platform: string): Promise<void> {
    await db
      .update(channelCredentialsTable)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform)
        )
      );
  },

  /**
   * Update token expiry and refresh timestamp
   */
  async updateTokens(
    userId: number,
    platform: string,
    accessToken: string,
    refreshToken: string | undefined,
    expiresAt: Date
  ): Promise<void> {
    const updateData: Partial<InsertChannelCredential> = {
      accessToken,
      tokenExpiry: expiresAt,
      lastRefreshedAt: new Date(),
      updatedAt: new Date(),
    };

    if (refreshToken) {
      updateData.refreshToken = refreshToken;
    }

    await db
      .update(channelCredentialsTable)
      .set(updateData)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform)
        )
      );
  },

  /**
   * Deactivate credentials
   */
  async deactivate(userId: number, platform: string): Promise<void> {
    await db
      .update(channelCredentialsTable)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform)
        )
      );
  },

  /**
   * Delete credentials
   */
  async delete(userId: number, platform: string): Promise<void> {
    await db
      .delete(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform)
        )
      );
  },
};
