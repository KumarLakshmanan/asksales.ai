import { and, eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';

/** Read only public account metadata and token presence, never token values.
 * Provider routes retain their own identifier fields and webhook contracts. */
export async function readOfficialOAuthStatus(userId: number, platform: 'twitter_api' | 'linkedin_api') {
  const [credential] = await db.select({
    credentialType: channelCredentialsTable.credentialType,
    hasAccessToken: sql<boolean>`${channelCredentialsTable.accessToken} IS NOT NULL AND ${channelCredentialsTable.accessToken} <> ''`,
    tokenExpiry: channelCredentialsTable.tokenExpiry,
    accountName: channelCredentialsTable.accountName,
    accountIdentifier: channelCredentialsTable.accountIdentifier,
  })
    .from(channelCredentialsTable)
    .where(and(
      eq(channelCredentialsTable.userId, userId),
      eq(channelCredentialsTable.platform, platform),
      eq(channelCredentialsTable.isActive, true),
    ))
    .limit(1);

  const hasOfficialApi = credential?.credentialType === 'oauth'
    && credential.hasAccessToken
    && !!credential.accountIdentifier;
  let tokenExpired = false;
  let expiresAt: string | null = null;
  if (hasOfficialApi && credential.tokenExpiry) {
    expiresAt = credential.tokenExpiry.toISOString();
    tokenExpired = new Date(credential.tokenExpiry) < new Date();
  }

  return {
    connected: hasOfficialApi && !tokenExpired,
    username: credential?.accountName || null,
    accountIdentifier: credential?.accountIdentifier || null,
    tokenExpired,
    expiresAt,
  };
}
