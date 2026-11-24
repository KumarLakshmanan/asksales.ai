import { and, eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { channelCredentialsTable, type ChannelCredentialRecord } from '../models/channelCredentials/schema.js';
import { encryptChannelCredentialSecret, getChannelCredentialEncryptionKeyId } from '../utils/channelCredentialSecrets.js';

export interface CredentialRefreshBinding {
  userId: number;
  credentialId: number;
  platform: string;
  accountIdentifier?: string;
}
export interface RefreshedProviderTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

export function isRevokedRefreshToken(error: unknown): boolean {
  const failure = error as { response?: { data?: { error?: unknown } } } | undefined;
  return failure?.response?.data?.error === 'invalid_grant';
}

/** The row lock serializes refreshes across HTTP requests and worker processes.
 * Reconnect/disconnect writes to the same row also take this lock, so an old
 * provider response cannot overwrite a newer grant. Provider calls must be bounded.
 * Do not throw a terminal provider rejection inside the transaction: that would
 * roll back the persisted reconnect status. */
export async function refreshChannelCredential(
  binding: CredentialRefreshBinding,
  refresh: (credential: ChannelCredentialRecord) => Promise<RefreshedProviderTokens>,
): Promise<{ credential: ChannelCredentialRecord | null; reconnectRequired: boolean }> {
  const result = await db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    const conditions = [
      eq(channelCredentialsTable.id, binding.credentialId),
      eq(channelCredentialsTable.userId, binding.userId),
      eq(channelCredentialsTable.platform, binding.platform),
      eq(channelCredentialsTable.isActive, true),
      ...(binding.accountIdentifier ? [sql`LOWER(TRIM(${channelCredentialsTable.accountIdentifier})) = ${binding.accountIdentifier.trim().toLowerCase()}`] : []),
    ];
    const [current] = await tx.select().from(channelCredentialsTable)
      .where(and(...conditions)).limit(1).for('update') as ChannelCredentialRecord[];
    if (!current) return { credential: null, reconnectRequired: false };
    if (current.accessToken && current.tokenExpiry && current.tokenExpiry.getTime() > Date.now() + 60_000) {
      return { credential: current, reconnectRequired: false };
    }
    if (!current.refreshToken) return { credential: null, reconnectRequired: true };
    try {
      const tokens = await refresh(current);
      if (!tokens.accessToken?.trim() || !Number.isFinite(tokens.expiresAt.getTime()) || tokens.expiresAt.getTime() <= Date.now()) {
        throw new Error('Provider refresh returned an incomplete token receipt');
      }
      const updates = {
        accessToken: encryptChannelCredentialSecret(tokens.accessToken),
        ...(tokens.refreshToken ? { refreshToken: encryptChannelCredentialSecret(tokens.refreshToken) } : {}),
        tokenExpiry: tokens.expiresAt,
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
        encryptionVersion: 'secrets-manager-v1',
        encryptionKeyId: getChannelCredentialEncryptionKeyId(),
        encryptedAt: new Date(),
        ...(current.readinessErrorCode === 'TOKEN_REFRESH_REJECTED' ? { readinessErrorCode: null } : {}),
      };
      await tx.update(channelCredentialsTable).set(updates).where(and(...conditions));
      return { credential: { ...current, ...updates } as ChannelCredentialRecord, reconnectRequired: false };
    } catch (error) {
      if (!isRevokedRefreshToken(error)) return { credential: null, reconnectRequired: false, error };
      await tx.update(channelCredentialsTable).set({
        isActive: false, readinessErrorCode: 'TOKEN_REFRESH_REJECTED',
        deactivationReason: 'provider_authorization_revoked', deactivatedAt: new Date(), updatedAt: new Date(),
      }).where(and(...conditions));
      return { credential: null, reconnectRequired: true };
    }
  });
  if ('error' in result) throw result.error;
  return result;
}
