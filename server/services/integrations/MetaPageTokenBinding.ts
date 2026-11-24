import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { channelCredentialsTable } from '../../models/channelCredentials/schema.js';
import { metaPageConnectionsTable } from '../../models/metaPageConnections/schema.js';
import { encryptMetaSecret } from '../../utils/metaCredentialSecrets.js';

/**
 * For Meta OAuth credentials, apiKey holds the encrypted, account-bound Page
 * token; accessToken holds the user token. Pin legacy Page tokens before a new
 * consent updates the shared routing row, so another channel keeps its grants.
 * No token is included in the account chooser or status response.
 */
export async function preserveMetaPageTokenBindings(userId: number, pageId: string) {
  const [connection] = await db.select().from(metaPageConnectionsTable).where(and(
    eq(metaPageConnectionsTable.userId, userId), eq(metaPageConnectionsTable.pageId, pageId),
  )).limit(1);
  if (connection?.pageAccessToken) {
    await db.update(channelCredentialsTable).set({
      apiKey: encryptMetaSecret(connection.pageAccessToken),
      sessionData: sql`coalesce(${channelCredentialsTable.sessionData}, '{}'::jsonb) || '{"pageTokenBound":true}'::jsonb`,
    }).where(and(
      eq(channelCredentialsTable.userId, userId),
      eq(channelCredentialsTable.credentialType, 'oauth'),
      eq(channelCredentialsTable.isActive, true),
      isNull(channelCredentialsTable.apiKey),
      or(
        and(eq(channelCredentialsTable.platform, 'facebook_api'), eq(channelCredentialsTable.accountIdentifier, pageId)),
        ...(connection.instagramAccountId ? [and(eq(channelCredentialsTable.platform, 'instagram_api'), eq(channelCredentialsTable.accountIdentifier, connection.instagramAccountId))] : []),
      ),
    ));
  }
  return connection;
}
