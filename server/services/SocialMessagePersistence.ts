import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { redactPiiWithStableTokens, privacyVaultService } from './agents/orchestration/PrivacyVaultService.js';
import { getOrCreateConversation } from '../models/outreachConversations/functions.js';
import { webSocketEmitter } from './agents/WebSocketEmitter.js';
import { outreachAttachmentService } from './OutreachAttachmentService.js';

export type SocialChannel = 'whatsapp' | 'instagram' | 'facebook';
type Executor = Pick<typeof db, 'execute'>;
export async function assertSocialAccountOwner(userId: number, channel: SocialChannel, accountId: string) {
  const scope = currentBusinessScope();
  if (!scope || scope.userId !== userId) throw new Error('Social ingestion requires the receiving business profile.');
  const binding = await db.execute(sql`SELECT id FROM channel_credentials WHERE user_id=${userId}
    AND business_profile_id=${scope.businessProfileId} AND is_active=TRUE
    AND platform=${channel === 'whatsapp' ? 'whatsapp' : `${channel}_api`} AND account_identifier=${accountId} LIMIT 1`);
  if (!binding.rows.length) throw new Error('The social webhook account is not connected to this business profile.');
}
export type { SocialMessageMetadata } from '../../shared/socialMessageMetadata.js';
import type { SocialMessageMetadata } from '../../shared/socialMessageMetadata.js';

/** Both webhook ingestion and API confirmation take this lock before binding a provider ID. */
export async function lockSocialProviderMessage(tx: Executor, userId: number, channel: string, account: string, providerId: string) {
  const key = JSON.stringify([currentBusinessScope()?.businessProfileId || '', userId, channel, account, providerId]);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Adopt an echo received before API confirmation; only exact, account-scoped IDs match. */
export async function reconcileSocialSend(tx: Executor, input: {
  userId: number; conversationId: number; providerId: string; messageId?: number; deliveryActionId?: number;
}): Promise<number | null> {
  const conversation = (await tx.execute(sql`SELECT channel,provider_account_id FROM outreach_conversations
    WHERE id=${input.conversationId} AND user_id=${input.userId}`)).rows[0];
  if (!conversation || !['whatsapp','instagram','facebook'].includes(String(conversation.channel)) || !conversation.provider_account_id) return null;
  await lockSocialProviderMessage(tx, input.userId, String(conversation.channel), String(conversation.provider_account_id), input.providerId);
  const rows = (await tx.execute(sql`SELECT m.id,m.conversation_id,m.metadata,m.delivery_action_id FROM outreach_messages m
    JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
    WHERE m.user_id=${input.userId} AND c.channel=${String(conversation.channel)}
      AND c.provider_account_id=${String(conversation.provider_account_id)} AND m.direction='outbound'
      AND (m.provider_message_id=${input.providerId} OR m.external_message_id=${input.providerId} OR m.waba_message_id=${input.providerId})
    FOR UPDATE OF m`)).rows;
  for (const row of rows) {
    const id = Number(row.id);
    if (id === input.messageId) return id;
    if (input.deliveryActionId && Number(row.delivery_action_id) === input.deliveryActionId) return id;
    const metadata = row.metadata as SocialMessageMetadata | null;
    if (!['native_app','external_app'].includes(String(metadata?.origin)) || row.delivery_action_id) {
      throw new Error('Provider message identity is already bound to another send.');
    }
    if (!input.messageId) {
      await tx.execute(sql`UPDATE outreach_messages SET delivery_action_id=${input.deliveryActionId || null},
        metadata=COALESCE(metadata,'{}'::jsonb)||'{"origin":"api"}'::jsonb WHERE id=${id}`);
      return id;
    }
    // The UI's original send-intent ID stays canonical. Move echo attachments before removing its duplicate.
    await tx.execute(sql`UPDATE outreach_message_attachments SET message_id=${input.messageId}
      WHERE message_id=${id} AND user_id=${input.userId}`);
    await tx.execute(sql`UPDATE outreach_messages SET sent_at=(SELECT sent_at FROM outreach_messages WHERE id=${id}),
      status=(SELECT status FROM outreach_messages WHERE id=${id}),
      delivered_at=(SELECT delivered_at FROM outreach_messages WHERE id=${id}),
      read_at=(SELECT read_at FROM outreach_messages WHERE id=${id}),
      attachments=COALESCE(attachments,(SELECT attachments FROM outreach_messages WHERE id=${id})) WHERE id=${input.messageId}`);
    await tx.execute(sql`DELETE FROM outreach_messages WHERE id=${id} AND user_id=${input.userId}`);
    await tx.execute(sql`UPDATE outreach_conversations SET total_messages=GREATEST(0,COALESCE(total_messages,0)-1)
      WHERE id=${Number(row.conversation_id)} AND user_id=${input.userId}`);
    return input.messageId;
  }
  return null;
}

export async function persistNativeSocialMessage(input: {
  userId: number; channel: SocialChannel; accountId: string; recipientId: string;
  providerMessageId: string; timestamp: Date; text: string; origin?: 'native_app' | 'external_app';
  eventType?: 'message' | 'edit' | 'revoke'; originalMessageId?: string;
  attachments?: Array<{ type?: string; name?: string; mimeType?: string; url?: string; mediaId?: string }>;
}): Promise<number> {
  if (!input.accountId || !input.recipientId || !input.providerMessageId || !Number.isFinite(input.timestamp.getTime())) {
    throw new Error('A native message requires an account, recipient, provider ID, and valid timestamp.');
  }
  await assertSocialAccountOwner(input.userId, input.channel, input.accountId);
  const providerId = input.originalMessageId || input.providerMessageId;
  const text = input.eventType === 'revoke' ? '[Message deleted]' : input.text || '[Attachment]';
  const protectedText = redactPiiWithStableTokens(text).redactedText;
  // Resolve the recipient independently from the sending business. Never create a lead for our own account.
  const identityKey = `${input.channel}_id`;
  let lead = (await db.execute(sql`SELECT id,name FROM leads WHERE user_id=${input.userId}
    AND (platform_extended->>${identityKey}=${input.recipientId}
      OR (${input.channel === 'whatsapp'} AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=${input.recipientId.replace(/\D/g,'')}))
    ORDER BY id LIMIT 1`)).rows[0];
  if (!lead) {
    // Serialize first-contact creation separately from provider-event deduplication.
    lead = await db.transaction(async (tx: typeof db) => {
      await lockSocialProviderMessage(tx, input.userId, input.channel, input.accountId, `recipient:${input.recipientId}`);
      const prior = (await tx.execute(sql`SELECT id,name FROM leads WHERE user_id=${input.userId}
        AND platform_extended->>${identityKey}=${input.recipientId} ORDER BY id LIMIT 1`)).rows[0];
      if (prior) return prior;
      return (await tx.execute(sql`INSERT INTO leads(uuid,user_id,name,first_name,source,status,phone,platform_extended)
        VALUES(gen_random_uuid(),${input.userId},${`${input.channel} contact`},${input.channel},${input.channel},'new',
          ${input.channel === 'whatsapp' ? input.recipientId : null},${JSON.stringify({ [identityKey]: input.recipientId })}::jsonb)
        RETURNING id,name`)).rows[0];
    });
  }
  const existingConversation = (await db.execute(sql`SELECT c.* FROM outreach_conversations c
    JOIN outreach_messages m ON m.conversation_id=c.id AND m.user_id=c.user_id
    WHERE c.user_id=${input.userId} AND c.channel=${input.channel} AND c.provider_account_id=${input.accountId}
      AND m.direction='outbound' AND (m.provider_message_id=${providerId} OR m.external_message_id=${providerId} OR m.waba_message_id=${providerId}) LIMIT 1`)).rows[0];
  const conversation = existingConversation ? { id: Number(existingConversation.id) } : await getOrCreateConversation({ userId: input.userId, leadId: Number(lead.id), channel: input.channel,
    providerAccountId: input.accountId, externalThreadId: input.recipientId, leadName: String(lead.name),
    integrationProvider: input.channel === 'whatsapp' ? 'whatsapp_cloud' : input.channel === 'instagram' ? 'instagram_api' : 'meta_api',
    ...(input.channel === 'whatsapp' ? { metadata: { phoneNumber: input.recipientId, phoneNumberId: input.accountId } } : {}) });
  const result = await db.transaction(async (tx: typeof db) => {
    await lockSocialProviderMessage(tx, input.userId, input.channel, input.accountId, providerId);
    const prior = (await tx.execute(sql`SELECT m.id,m.conversation_id,m.metadata,m.status,m.privacy_vault_id FROM outreach_messages m
      JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
      WHERE m.user_id=${input.userId} AND c.channel=${input.channel} AND c.provider_account_id=${input.accountId}
        AND m.direction='outbound' AND (m.provider_message_id=${providerId} OR m.external_message_id=${providerId} OR m.waba_message_id=${providerId})
      ORDER BY m.id LIMIT 1 FOR UPDATE OF m`)).rows[0];
    const metadata = { providerAccountId: input.accountId, origin: input.origin || 'native_app', replySurface: 'message',
      nativeEventAt: input.timestamp.toISOString(), nativeEventType: input.eventType || 'message',
      ...(input.eventType === 'revoke' ? { deleted: true } : {}) };
    if (prior) {
      const old = prior.metadata as Record<string, unknown> | null;
      const shouldEdit = Boolean(!old?.deleted && input.eventType && input.eventType !== 'message' &&
        (!old?.nativeEventAt || Date.parse(String(old.nativeEventAt)) <= input.timestamp.getTime()));
      if (shouldEdit) {
        await tx.execute(sql`UPDATE outreach_messages SET content=${protectedText},redacted_content=${protectedText},
          metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ nativeEventAt: metadata.nativeEventAt, nativeEventType: metadata.nativeEventType, deleted: input.eventType === 'revoke' })}::jsonb,
          updated_at=NOW() WHERE id=${Number(prior.id)}`);
      }
      if ((!input.eventType || input.eventType === 'message') && prior.status !== 'draft') {
        await tx.execute(sql`UPDATE outreach_messages SET sent_at=${input.timestamp},provider_call_state='confirmed',
          confirmed_at=COALESCE(confirmed_at,NOW()) WHERE id=${Number(prior.id)}`);
      }
      return { id: Number(prior.id), conversationId: Number(prior.conversation_id),
        deleted: shouldEdit ? input.eventType === 'revoke' : old?.deleted === true,
        protect: shouldEdit || (!prior.privacy_vault_id && old?.nativeEventType === 'message') };
    }
    const inserted = (await tx.execute(sql`INSERT INTO outreach_messages
      (user_id,conversation_id,direction,content,redacted_content,status,provider_call_state,provider_account_id,
       external_message_id,provider_message_id,waba_message_id,phone_number_id,message_kind,is_read,is_ai_generated,is_automatic,sent_at,confirmed_at,metadata)
      VALUES(${input.userId},${conversation.id},'outbound',${protectedText},${protectedText},'sent','confirmed',${input.accountId},
        ${providerId},${providerId},${input.channel === 'whatsapp' ? providerId : null},${input.channel === 'whatsapp' ? input.accountId : null},
        'reply',TRUE,FALSE,FALSE,${input.timestamp},NOW(),${JSON.stringify(metadata)}::jsonb) RETURNING id`)).rows[0];
    await tx.execute(sql`UPDATE outreach_conversations SET total_messages=COALESCE(total_messages,0)+1,
      last_message_preview=CASE WHEN last_message_at IS NULL OR last_message_at<=${input.timestamp} THEN ${protectedText.slice(0,200)} ELSE last_message_preview END,
      last_message_by=CASE WHEN last_message_at IS NULL OR last_message_at<=${input.timestamp} THEN 'user' ELSE last_message_by END,
      last_message_at=GREATEST(last_message_at,${input.timestamp}),updated_at=NOW()
      WHERE id=${conversation.id} AND user_id=${input.userId}`);
    return { id: Number(inserted.id), conversationId: conversation.id, protect: true, deleted: input.eventType === 'revoke' };
  });
  if (result.deleted) {
    await db.execute(sql`UPDATE outreach_message_attachments SET status='unavailable',extracted_text=NULL,
      metadata=COALESCE(metadata,'{}'::jsonb)||'{"objectAvailable":false,"deleted":true}'::jsonb,updated_at=NOW()
      WHERE message_id=${result.id} AND user_id=${input.userId}`);
    await db.execute(sql`UPDATE outreach_messages SET attachments='[]'::jsonb WHERE id=${result.id} AND user_id=${input.userId}`);
  }
  if (result.protect) await privacyVaultService.protectInbound({ userId: input.userId, conversationId: result.conversationId,
    channel: input.channel, rawText: text, providerMessageId: input.providerMessageId, messageId: result.id,
    entityType: 'outreach_message', entityId: result.id });
  for (const [index, attachment] of (result.deleted ? [] : input.attachments || []).entries()) {
    const params = { userId: input.userId, messageId: result.id, direction: 'outbound' as const,
      fileName: attachment.name || `${input.channel}-${attachment.type || 'attachment'}`,
      mimeType: attachment.mimeType, providerAttachmentId: `${input.accountId}:${input.providerMessageId}:${index}`,
      source: 'native_social', metadata: { origin: input.origin || 'native_app' } };
    if (attachment.mediaId && input.channel === 'whatsapp') {
      try {
        const { whatsappApiService } = await import('./whatsappApiService.js');
        const media = await whatsappApiService.downloadMedia(input.userId, attachment.mediaId, input.accountId);
        await outreachAttachmentService.persistInboundBuffer({ ...params, buffer: media.buffer, mimeType: media.mimeType });
      } catch (error) { await outreachAttachmentService.recordInboundFailure({ ...params, error }); }
    } else if (attachment.url) await outreachAttachmentService.persistInboundUrl({ ...params, url: attachment.url });
    else await outreachAttachmentService.recordInboundFailure({ ...params, error: new Error('The provider did not supply retrievable media.') });
  }
  webSocketEmitter.emit(input.userId, 'outreach_message_updated', { channel: input.channel, conversationId: result.conversationId });
  return result.id;
}

export async function persistMetaEcho(userId: number, channel: 'instagram' | 'facebook', accountId: string, event: Record<string, any>): Promise<void> {
  if (!event.message?.is_echo || event.message?.is_self) return;
  await persistNativeSocialMessage({ userId, channel, accountId, recipientId: String(event.recipient?.id || ''),
    providerMessageId: String(event.message.mid || ''), timestamp: new Date(event.timestamp), text: event.message.text || '',
    origin: event.message.app_id && String(event.message.app_id) !== '26390203743090' ? 'external_app' : 'native_app',
    eventType: event.message.is_deleted ? 'revoke' : 'message',
    attachments: (event.message.attachments || []).map((a: any) => ({ type: a.type, name: a.name, url: a.payload?.url || a.url })),
  });
}

/** Shared by canonical and legacy callbacks. Drafts and unconfirmed attempts are never receipts. */
export async function reconcileSocialReceipt(input: { userId: number; channel: SocialChannel; accountId: string;
  recipientId?: string; messageIds?: string[]; watermark?: number; state: 'delivered' | 'read' }) {
  await assertSocialAccountOwner(input.userId,input.channel,input.accountId);
  const receiptAt = new Date(input.watermark || Date.now());
  if (!Number.isFinite(receiptAt.getTime())) throw new Error('Invalid receipt timestamp.');
  const ids = (input.messageIds || []).filter(Boolean);
  if (!ids.length && !input.recipientId) return;
  await db.execute(sql`UPDATE outreach_messages AS message
    SET status=CASE WHEN message.status='read' THEN 'read' ELSE ${input.state} END,
      delivered_at=COALESCE(message.delivered_at,${receiptAt}),
      read_at=CASE WHEN ${input.state}='read' THEN COALESCE(message.read_at,${receiptAt}) ELSE message.read_at END
    FROM outreach_conversations AS conversation
    WHERE message.conversation_id=conversation.id AND message.user_id=${input.userId}
      AND conversation.user_id=${input.userId} AND conversation.channel=${input.channel}
      AND conversation.provider_account_id=${input.accountId} AND message.direction='outbound'
      AND message.status IN ('sent','delivered','read') AND message.provider_call_state='confirmed'
      AND COALESCE(message.provider_message_id,message.external_message_id) IS NOT NULL
      AND ${ids.length
        ? sql`(message.provider_message_id IN (${sql.join(ids.map(id => sql`${id}`),sql`, `)}) OR message.external_message_id IN (${sql.join(ids.map(id => sql`${id}`),sql`, `)}))`
        : sql`conversation.external_thread_id=${input.recipientId} AND message.sent_at<=${receiptAt}`}`);
  webSocketEmitter.emit(input.userId, 'message_status_updated', { channel: input.channel });
}

/** Meta edit/delete notifications mutate the original; they are never new AI input. */
export async function applyMetaMessageMutation(userId: number, channel: 'instagram' | 'facebook', accountId: string, event: Record<string, any>): Promise<boolean> {
  const deleted = event.message?.is_deleted === true;
  const edit = event.message_edit;
  if (!deleted && !edit) return false;
  if (event.message?.is_self) return true;
  const providerId = String(edit?.mid || event.message?.mid || '');
  const at = new Date(event.timestamp);
  if (!providerId || !Number.isFinite(at.getTime())) throw new Error('A message mutation needs a provider identity and timestamp.');
  await assertSocialAccountOwner(userId,channel,accountId);
  const text = deleted ? '[Message deleted]' : String(edit.text || '');
  const safe = redactPiiWithStableTokens(text).redactedText;
  const row = await db.transaction(async (tx: typeof db) => {
    await lockSocialProviderMessage(tx,userId,channel,accountId,providerId);
    const prior = (await tx.execute(sql`SELECT m.id,m.conversation_id,m.metadata FROM outreach_messages m
      JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
      WHERE m.user_id=${userId} AND c.channel=${channel} AND c.provider_account_id=${accountId}
        AND (m.external_message_id=${providerId} OR m.provider_message_id=${providerId}) LIMIT 1 FOR UPDATE OF m`)).rows[0];
    if (!prior || prior.metadata?.deleted || (prior.metadata?.nativeEventAt && Date.parse(prior.metadata.nativeEventAt)>at.getTime())) return null;
    await tx.execute(sql`UPDATE outreach_messages SET content=${safe},redacted_content=${safe},
      attachments=CASE WHEN ${deleted} THEN '[]'::jsonb ELSE attachments END,
      metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({deleted,nativeEventAt:at.toISOString(),nativeEventType:deleted?'revoke':'edit',metaEditCount:edit?.num_edit})}::jsonb,
      updated_at=NOW() WHERE id=${Number(prior.id)} AND user_id=${userId}`);
    if (deleted) await tx.execute(sql`UPDATE outreach_message_attachments SET status='unavailable',extracted_text=NULL,
      metadata=COALESCE(metadata,'{}'::jsonb)||'{"objectAvailable":false,"deleted":true}'::jsonb,updated_at=NOW()
      WHERE message_id=${Number(prior.id)} AND user_id=${userId}`);
    return prior;
  });
  if (row) {
    await privacyVaultService.protectInbound({userId,conversationId:Number(row.conversation_id),channel,rawText:text,
      providerMessageId:providerId,messageId:Number(row.id),entityType:'outreach_message',entityId:Number(row.id)});
    webSocketEmitter.emit(userId,'outreach_message_updated',{channel,conversationId:Number(row.conversation_id)});
  }
  return true;
}
