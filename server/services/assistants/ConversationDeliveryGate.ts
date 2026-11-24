import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { assertCustomerDeliveryReady, CustomerDeliverySetupError } from './CustomerDeliveryGate.js';
import { receivingAssistantAccount } from './AssistantResolver.js';
import type { NormalizedMessage } from '../agents/pipeline/ChannelGateway.js';

export async function assertConversationDeliveryReady(userId: number, conversationId: number, senderId?: number, surface: 'private' | 'public_comment' = 'private') {
  const scope = requireBusinessScope();
  const result = await db.execute(sql`SELECT channel,provider_account_id,
      (SELECT m.metadata->'outreachCreation'->'delivery'->>'senderId' FROM outreach_messages m
        WHERE m.conversation_id=c.id AND m.user_id=c.user_id AND m.direction='outbound'
          AND m.metadata->'outreachCreation' IS NOT NULL ORDER BY m.id LIMIT 1) AS original_sender_id
    FROM outreach_conversations c WHERE c.id=${conversationId} AND c.user_id=${userId} AND c.business_profile_id=${scope.businessProfileId}`);
  const row = result.rows[0];
  if (!row || scope.userId !== userId) throw new CustomerDeliverySetupError('business_scope_required', 'The original conversation business could not be verified.');
  const channel = String(row.channel).replace(/^gmail$/, 'email');
  let accountId: string;
  if (channel === 'email' && senderId) {
    const { getById } = await import('../../models/emailSenders/functions.js');
    const sender = await getById(userId, senderId);
    if (!sender?.isVerified || (row.original_sender_id && Number(row.original_sender_id) !== senderId)
      || (row.provider_account_id && ![sender.email.toLowerCase(), sender.email.split('@')[1]?.toLowerCase()].includes(String(row.provider_account_id).toLowerCase())))
      throw new CustomerDeliverySetupError('account_changed', 'The selected sender does not match the original conversation account. Review its assignment.');
    accountId = sender.email;
  } else {
    accountId = await receivingAssistantAccount({ userId, conversationId, channel: channel as NormalizedMessage['channel'], metadata: {} });
  }
  return assertCustomerDeliveryReady({ userId, channel, accountId, surface });
}
