import { db } from '../models/db.js';
import { supportTurnProviderReplyId } from './agents/orchestration/SupportConversationTurn.js';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { deliveryOutboxService } from './agents/orchestration/DeliveryOutboxService.js';
import { outreachAttachmentService } from './OutreachAttachmentService.js';
import { storageService } from './StorageService.js';
import { synthesizeApprovedVoiceReply } from './OutreachAudioService.js';
import { whatsappApiService } from './whatsappApiService.js';

type VoiceReplyChannel = 'whatsapp' | 'instagram' | 'facebook';

export type VoiceReplyDeliveryInput = {
  userId: number;
  conversationId: number;
  channel: VoiceReplyChannel;
  senderIdentifier: string;
  phoneNumberId?: string;
  rawMessageId?: string;
  inboundMessageId?: number;
  replyText: string;
  playbookRunId?: number;
  playbookNodeId?: string;
  providerAccountId?: string;
};

export type VoiceReplyDeliveryResult = {
  drafted?: boolean;
  externalMessageId: string | null;
  deliveryActionId: number;
  sentAsVoice: boolean;
  fallbackReason?: string;
  persistedNew: boolean;
};

async function ensureOutboundMessage(input: VoiceReplyDeliveryInput, deliveryActionId: number): Promise<{ id: number; inserted: boolean; messageType: string }> {
  const inserted = await db.execute(sql`
    INSERT INTO outreach_messages (
      conversation_id, user_id, direction, message_kind, content, phone_number_id, message_type,
      status, is_ai_generated, metadata, delivery_action_id, created_at, updated_at
    ) VALUES (
      -- An answer to the customer's voice note; the column default would file it as campaign outreach.
      ${input.conversationId}, ${input.userId}, 'outbound', 'reply', ${input.replyText},
      ${input.phoneNumberId || null}, 'text', 'pending', true,
      ${JSON.stringify({
        channel: input.channel,
        voiceReplyRequested: true,
        replyToProviderMessageId: supportTurnProviderReplyId(input.rawMessageId) || null,
      })}::jsonb,
      ${deliveryActionId}, NOW(), NOW()
    )
    ON CONFLICT (delivery_action_id) WHERE delivery_action_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  const insertedId = Number((inserted.rows[0] as { id?: number } | undefined)?.id || 0);
  if (insertedId) return { id: insertedId, inserted: true, messageType: 'text' };
  const existing = await db.execute(sql`
    SELECT id, message_type
    FROM outreach_messages
    WHERE user_id = ${input.userId}
      AND conversation_id = ${input.conversationId}
      AND delivery_action_id = ${deliveryActionId}
    LIMIT 1
  `);
  const existingId = Number((existing.rows[0] as { id?: number } | undefined)?.id || 0);
  if (!existingId) throw new Error('The voice reply message could not be created or recovered.');
  return {
    id: existingId,
    inserted: false,
    messageType: String((existing.rows[0] as { message_type?: string }).message_type || 'text'),
  };
}

async function finalizeMessage(params: {
  input: VoiceReplyDeliveryInput;
  messageId: number;
  externalMessageId: string | null;
  sentAsVoice: boolean;
  fallbackReason?: string;
  deliveryActionId: number;
}): Promise<void> {
  await db.transaction(async (tx: typeof db) => {
    if (params.externalMessageId) {
      const { reconcileSocialSend } = await import('./SocialMessagePersistence.js');
      await reconcileSocialSend(tx, { userId: params.input.userId, conversationId: params.input.conversationId, providerId: params.externalMessageId, messageId: params.messageId });
    }
    await tx.execute(sql`
    UPDATE outreach_messages
    SET status = CASE WHEN status IN ('delivered','read') THEN status ELSE 'sent' END,
        provider_message_id = ${params.externalMessageId},
        provider_call_state = 'confirmed',
        confirmed_at = COALESCE(confirmed_at,NOW()),
        provider_account_id = ${params.input.providerAccountId || params.input.phoneNumberId || null},
        message_kind = 'reply',
        message_type = ${params.sentAsVoice ? 'audio' : 'text'},
        external_message_id = ${params.externalMessageId},
        waba_message_id = ${params.input.channel === 'whatsapp' ? params.externalMessageId : null},
        sent_at = COALESCE(sent_at, NOW()),
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          channel: params.input.channel,
          voiceReplyRequested: true,
          voiceReplyDelivered: params.sentAsVoice,
          voiceFallbackReason: params.fallbackReason || null,
          deliveryActionId: params.deliveryActionId,
        })}::jsonb,
        updated_at = NOW()
    WHERE id = ${params.messageId}
      AND user_id = ${params.input.userId}
    `);
  });
  try {
    const { activateSocialFollowUpForAnchor } = await import('./socialFollowUpService.js');
    await activateSocialFollowUpForAnchor(params.messageId);
  } catch (error) {
    logger.warn({ err: error, messageId: params.messageId }, 'Could not schedule voice support follow-up');
  }
}

async function markMessageFailed(input: VoiceReplyDeliveryInput, messageId: number, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE outreach_messages
    SET status = 'failed',
        error_message = ${error.slice(0, 500)},
        failed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${messageId}
      AND user_id = ${input.userId}
  `);
}

async function sendTextFallback(input: VoiceReplyDeliveryInput): Promise<{ externalMessageId: string | null }> {
  if (input.channel === 'whatsapp') {
    const result = await whatsappApiService.sendText({
      userId: input.userId,
      phoneNumberId: input.phoneNumberId,
      to: input.senderIdentifier,
      text: input.replyText,
      contextMessageId: supportTurnProviderReplyId(input.rawMessageId),
    });
    return { externalMessageId: result.messages?.[0]?.id || null };
  }
  if (input.channel === 'instagram') {
    const { sendInstagramDM } = await import('./instagramService.js');
    const result = await sendInstagramDM({
      recipientId: input.senderIdentifier,
      message: input.replyText,
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: 0,
      providerAccountId: input.providerAccountId,
    });
    if (!result.success) {
      const error = new Error(result.error || 'Instagram rejected the text fallback.') as Error & { deliveryAttempted?: boolean };
      error.deliveryAttempted = false;
      throw error;
    }
    return { externalMessageId: result.externalMessageId || null };
  }
  const { sendFacebookDM } = await import('./FacebookMessengerService.js');
  const result = await sendFacebookDM({
    conversationId: input.conversationId,
    recipientId: input.senderIdentifier,
    message: input.replyText,
    userId: input.userId,
    providerAccountId: input.providerAccountId,
  });
  if (!result.success) {
    const error = new Error(result.error || 'Facebook rejected the text fallback.') as Error & { deliveryAttempted?: boolean };
    error.deliveryAttempted = false;
    throw error;
  }
  return { externalMessageId: result.externalMessageId || null };
}

export class OutreachVoiceReplyDeliveryService {
  async deliver(input: VoiceReplyDeliveryInput): Promise<VoiceReplyDeliveryResult> {
    if (!input.rawMessageId && !input.inboundMessageId) {
      throw new Error('A stable inbound message identifier is required for idempotent voice delivery.');
    }
    const claim = await deliveryOutboxService.claim({
      userId: input.userId,
      conversationId: input.conversationId,
      channel: input.channel,
      inboundProviderMessageId: input.rawMessageId,
      inboundMessageId: input.inboundMessageId,
      playbookRunId: input.playbookRunId,
      playbookNodeId: input.playbookNodeId,
      responseVersion: 1,
      partIndex: 0,
    }, {
      text: input.replyText,
      recipient: input.senderIdentifier,
      phoneNumberId: input.phoneNumberId || null,
      replyToProviderMessageId: supportTurnProviderReplyId(input.rawMessageId) || null,
      metadata: {
        dispatchKind: 'voice_reply',
        providerAccountId: input.providerAccountId || input.phoneNumberId,
        preferredDelivery: 'voice',
        generatedFromApprovedText: true,
      },
    });

    if (claim.state === 'uncertain') {
      throw new Error(`Voice delivery outcome is uncertain for action ${claim.action.id}; automatic resend was suppressed.`);
    }
    if (claim.state === 'drafted' || (claim.state === 'claimed' && await deliveryOutboxService.holdIfDisabled(claim.action))) {
      return { externalMessageId: null, deliveryActionId: claim.action.id, sentAsVoice: false, persistedNew: false, drafted: true };
    }
    const message = await ensureOutboundMessage(input, claim.action.id);
    if (claim.state === 'already_sent') {
      await finalizeMessage({
        input,
        messageId: message.id,
        externalMessageId: claim.action.providerMessageId || null,
        sentAsVoice: message.messageType === 'audio',
        deliveryActionId: claim.action.id,
      });
      return {
        externalMessageId: claim.action.providerMessageId || null,
        deliveryActionId: claim.action.id,
        sentAsVoice: message.messageType === 'audio',
        persistedNew: message.inserted,
      };
    }

    const heldResult = async (): Promise<VoiceReplyDeliveryResult | null> => await deliveryOutboxService.holdIfDisabled(claim.action)
      ? { externalMessageId: null, deliveryActionId: claim.action.id, sentAsVoice: false, persistedNew: false, drafted: true } : null;
    let attachmentId: string | null = null;
    let providerCallStarted = false;
    let fallbackReason: string | undefined;
    try {
      const speech = await synthesizeApprovedVoiceReply(input.replyText);
      if (speech.status !== 'success' || !speech.buffer || !speech.mimeType || !speech.fileName) {
        fallbackReason = speech.error || 'Voice reply generation was unavailable.';
      } else {
        const attachment = await outreachAttachmentService.persistGeneratedOutboundBuffer({
          userId: input.userId,
          messageId: message.id,
          buffer: speech.buffer,
          mimeType: speech.mimeType,
          fileName: speech.fileName,
          sourceKey: `tts:${claim.action.id}`,
          source: 'tts',
          metadata: {
            voice: speech.voice,
            replyToProviderMessageId: supportTurnProviderReplyId(input.rawMessageId) || null,
            deliveryActionId: claim.action.id,
          },
        });
        attachmentId = attachment.id;

        if (input.channel === 'whatsapp') {
          let uploaded: { id: string };
          try {
            uploaded = await whatsappApiService.uploadMedia({
              userId: input.userId,
              phoneNumberId: input.phoneNumberId,
              buffer: speech.buffer,
              mimeType: speech.mimeType,
              fileName: speech.fileName,
            });
          } catch (error) {
            fallbackReason = error instanceof Error ? `Voice upload unavailable: ${error.message}` : 'Voice upload unavailable.';
            uploaded = { id: '' };
          }
          if (!fallbackReason) {
            await outreachAttachmentService.markProviderMediaPrepared({
              publicId: attachment.id,
              messageId: message.id,
              userId: input.userId,
              providerMediaId: uploaded.id,
            });
            const held = await heldResult();
            if (held) return held;
            providerCallStarted = true;
            let result: { messages?: Array<{ id?: string }> };
            try {
              result = await whatsappApiService.sendMedia({
                userId: input.userId,
                phoneNumberId: input.phoneNumberId,
                to: input.senderIdentifier,
                mediaType: 'audio',
                mediaId: uploaded.id,
              });
            } catch (error) {
              const knownRejection = typeof error === 'object'
                && error !== null
                && 'outcomeUncertain' in error
                && (error as { outcomeUncertain?: boolean }).outcomeUncertain === false;
              if (!knownRejection) throw error;
              providerCallStarted = false;
              fallbackReason = error instanceof Error ? `WhatsApp rejected the voice reply: ${error.message}` : 'WhatsApp rejected the voice reply.';
              result = {};
            }
            if (fallbackReason) {
              // A confirmed provider rejection is safe to follow with text.
            } else {
            const externalMessageId = result.messages?.[0]?.id || null;
            if (!externalMessageId) throw new Error('WhatsApp did not return a voice message ID.');
            await outreachAttachmentService.markAttachmentDelivery({
              publicId: attachment.id,
              messageId: message.id,
              userId: input.userId,
              status: 'sent',
              providerAttachmentId: externalMessageId,
              providerMediaId: uploaded.id,
            });
            await finalizeMessage({ input, messageId: message.id, externalMessageId, sentAsVoice: true, deliveryActionId: claim.action.id });
            await deliveryOutboxService.markSent(claim.action.id, externalMessageId);
            return { externalMessageId, deliveryActionId: claim.action.id, sentAsVoice: true, persistedNew: message.inserted };
            }
          }
        } else {
          const signedUrl = attachment.fileId
            ? await storageService.getFileUrl(attachment.fileId, input.userId, 300)
            : null;
          if (!signedUrl || !/^https:\/\//.test(signedUrl)) {
            fallbackReason = `${input.channel} voice delivery requires the official API and private S3 object storage.`;
          } else if (input.channel === 'instagram') {
            const { getInstagramApiForUser } = await import('./instagramGraphApiService.js');
            const api = await getInstagramApiForUser(
              input.userId,
              input.providerAccountId ? { accountIdentifier: input.providerAccountId } : {},
            );
            if (!api) {
              fallbackReason = 'Instagram voice delivery requires an active official Graph API connection.';
            } else {
              const held = await heldResult();
            if (held) return held;
            providerCallStarted = true;
              const result = await api.sendMessageWithAttachment(input.senderIdentifier, 'audio', signedUrl);
              if (!result.success || !result.messageId) {
                if (result.outcomeUncertain) throw Object.assign(new Error(result.error || 'Instagram voice delivery failed.'), { deliveryAttempted: true });
                providerCallStarted = false;
                fallbackReason = result.error || 'Instagram rejected the voice reply.';
              } else {
                await outreachAttachmentService.markAttachmentDelivery({
                  publicId: attachment.id,
                  messageId: message.id,
                  userId: input.userId,
                  status: 'sent',
                  providerAttachmentId: result.messageId,
                });
                await finalizeMessage({ input, messageId: message.id, externalMessageId: result.messageId, sentAsVoice: true, deliveryActionId: claim.action.id });
                await deliveryOutboxService.markSent(claim.action.id, result.messageId);
                return { externalMessageId: result.messageId, deliveryActionId: claim.action.id, sentAsVoice: true, persistedNew: message.inserted };
              }
            }
          } else {
            const { getFacebookApiForUser } = await import('./FacebookMessengerService.js');
            const api = await getFacebookApiForUser(input.userId, input.providerAccountId);
            if (!api) {
              fallbackReason = 'Facebook voice delivery requires an active official Graph API connection.';
            } else {
              const held = await heldResult();
            if (held) return held;
            providerCallStarted = true;
              const result = await api.sendMessageWithAttachment(input.senderIdentifier, 'audio', signedUrl);
              if (!result.success || !result.messageId) {
                if (result.outcomeUncertain) throw Object.assign(new Error(result.error || 'Facebook voice delivery failed.'), { deliveryAttempted: true });
                providerCallStarted = false;
                fallbackReason = result.error || 'Facebook rejected the voice reply.';
              } else {
                await outreachAttachmentService.markAttachmentDelivery({
                  publicId: attachment.id,
                  messageId: message.id,
                  userId: input.userId,
                  status: 'sent',
                  providerAttachmentId: result.messageId,
                });
                await finalizeMessage({ input, messageId: message.id, externalMessageId: result.messageId, sentAsVoice: true, deliveryActionId: claim.action.id });
                await deliveryOutboxService.markSent(claim.action.id, result.messageId);
                return { externalMessageId: result.messageId, deliveryActionId: claim.action.id, sentAsVoice: true, persistedNew: message.inserted };
              }
            }
          }
        }
      }

      if (attachmentId) {
        await outreachAttachmentService.markAttachmentDelivery({
          publicId: attachmentId,
          messageId: message.id,
          userId: input.userId,
          status: 'unsupported',
          error: fallbackReason || 'Voice delivery was unavailable; a text reply was sent instead.',
        });
      }
      const held = await heldResult();
      if (held) return held;
      providerCallStarted = true;
      const textResult = await sendTextFallback(input);
      await finalizeMessage({
        input,
        messageId: message.id,
        externalMessageId: textResult.externalMessageId,
        sentAsVoice: false,
        fallbackReason,
        deliveryActionId: claim.action.id,
      });
      await deliveryOutboxService.markSent(claim.action.id, textResult.externalMessageId);
      return {
        externalMessageId: textResult.externalMessageId,
        deliveryActionId: claim.action.id,
        sentAsVoice: false,
        fallbackReason,
        persistedNew: message.inserted,
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Voice reply delivery failed.';
      const deliveryAttempted = typeof error === 'object'
        && error !== null
        && 'outcomeUncertain' in error
        && typeof (error as { outcomeUncertain?: unknown }).outcomeUncertain === 'boolean'
        ? (error as { outcomeUncertain: boolean }).outcomeUncertain
        : typeof error === 'object'
          && error !== null
          && 'deliveryAttempted' in error
          ? (error as { deliveryAttempted?: boolean }).deliveryAttempted === true
          : providerCallStarted;
      await deliveryOutboxService.markFailed(claim.action.id, messageText, deliveryAttempted).catch(() => undefined);
      if (attachmentId) {
        await outreachAttachmentService.markAttachmentDelivery({
          publicId: attachmentId,
          messageId: message.id,
          userId: input.userId,
          status: 'failed',
          error: deliveryAttempted
            ? `Voice delivery outcome is uncertain: ${messageText}`
            : messageText,
        }).catch(() => undefined);
      }
      await markMessageFailed(input, message.id, deliveryAttempted
        ? `Voice delivery outcome is uncertain: ${messageText}`
        : messageText).catch(() => undefined);
      logger.error({ err: error, channel: input.channel, deliveryActionId: claim.action.id }, '[VoiceReply] Delivery failed');
      throw new Error(deliveryAttempted
        ? `Voice delivery outcome is uncertain: ${messageText}`
        : `Voice reply delivery failed: ${messageText}`);
    }
  }
}

export const outreachVoiceReplyDeliveryService = new OutreachVoiceReplyDeliveryService();
