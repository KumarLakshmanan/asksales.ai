import type { ChannelCredentialRecord } from '../models/channelCredentials/schema';
import { isDirectInstagramLogin } from '../utils/instagramOAuthCredential.js';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import type { MetaPageConnectionRecord } from '../models/metaPageConnections/schema';
import {
  findInstagramConnectionForUserAndAccount,
  findInstagramConnectionForUserAndRoutingId,
} from '../models/metaPageConnections/functions';

export interface InstagramAccountSelector {
  credentialId?: number;
  accountIdentifier?: string;
}

export interface InstagramAccountContext {
  credential: ChannelCredentialRecord;
  connection: MetaPageConnectionRecord | null;
}

/**
 * The single account-resolution boundary for user-initiated Instagram work.
 * With no explicit selector it resolves the publishing default. Webhook code
 * can pass the receiving provider account id to preserve account affinity.
 */
export async function resolveInstagramAccountContext(
  userId: number,
  selector: InstagramAccountSelector = {},
): Promise<InstagramAccountContext | null> {
  const credential = selector.credentialId
    ? await ChannelCredentialModel.findActiveAccountById(userId, 'instagram_api', selector.credentialId)
    : selector.accountIdentifier
      ? await ChannelCredentialModel.findActiveAccountByIdentifier(userId, 'instagram_api', selector.accountIdentifier)
      : await ChannelCredentialModel.findByUserAndPlatform(userId, 'instagram_api');

  if (!credential) return null;
  const connection = credential.accountIdentifier
    ? await findInstagramConnectionForUserAndAccount(userId, credential.accountIdentifier, isDirectInstagramLogin(credential) ? credential.accountIdentifier : undefined)
    : null;
  return { credential, connection };
}

/** Translate a webhook Page/account routing id into its Instagram account id. */
export async function resolveInstagramProviderAccountId(
  userId: number,
  routingId: string,
): Promise<string | null> {
  const connection = await findInstagramConnectionForUserAndRoutingId(userId, routingId);
  return connection?.instagramAccountId || null;
}
