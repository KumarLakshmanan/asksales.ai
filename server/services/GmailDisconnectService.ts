import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { channelCredentialsTable, type ChannelCredentialRecord } from '../models/channelCredentials/schema.js';
import { emailSendersTable } from '../models/emailSenders/schema.js';
import { decryptChannelCredentialSecret } from '../utils/channelCredentialSecrets.js';

/** Preserve the existing business-wide Gmail disconnect contract. Lock the exact
 * accounts while revoking/deactivating them so a concurrent reconnect commits
 * afterwards instead of being deleted by an old snapshot. Remote revocation is
 * best effort; the response must distinguish it from local disconnection. */
export async function disconnectGmailAccounts(userId: number) {
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    const credentials = await tx.select().from(channelCredentialsTable).where(and(
      eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, 'gmail_api'),
      eq(channelCredentialsTable.isActive, true),
    )).orderBy(channelCredentialsTable.id).for('update') as ChannelCredentialRecord[];
    let revocationFailures = 0;
    const revoked = new Set<string>();
    for (const credential of credentials) {
      const token = decryptChannelCredentialSecret(credential.refreshToken || credential.accessToken);
      if (!token || revoked.has(token)) continue;
      revoked.add(token);
      try {
        const response = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) revocationFailures++;
      } catch { revocationFailures++; }
    }
    const ids = credentials.map(credential => credential.id);
    if (ids.length) {
      await tx.delete(emailSendersTable).where(and(eq(emailSendersTable.userId, userId),
        eq(emailSendersTable.type, 'gmail'), inArray(emailSendersTable.credentialId, ids)));
      await tx.update(channelCredentialsTable).set({ isActive: false, accessToken: null, refreshToken: null,
        sessionData: null, sessionCookies: null, tokenExpiry: null,
        deactivationReason: 'user_disconnected', deactivatedAt: new Date(), updatedAt: new Date(),
      }).where(and(eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, 'gmail_api'),
        inArray(channelCredentialsTable.id, ids)));
    }
    return { disconnectedAccounts: ids.length, remoteRevocationAttempted: revoked.size > 0,
      remoteRevocationComplete: revocationFailures === 0, revocationFailures,
      ...(revocationFailures ? { warning: 'Gmail is disconnected locally. Google authorization could not be fully revoked. Review access in your Google Account permissions.' } : {}),
    };
  });
}
