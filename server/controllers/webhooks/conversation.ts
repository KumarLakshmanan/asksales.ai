/* eslint-disable @typescript-eslint/no-explicit-any */
/** Persists webhook messages to outreach conversations and triggers automatic replies. */
import { assertSocialAccountOwner, lockSocialProviderMessage } from '../../services/SocialMessagePersistence.js';
import crypto from 'crypto';
import { db } from '../../models/db';
import { sql, eq, and, or } from 'drizzle-orm';
import { leadsTable } from '../../models/leads/schema';
import { logger } from '../../utils/logger.js';
import { createOutreachMessage, getOrCreateConversation } from '../../models/outreachConversations/functions';
import { jobDispatcher } from '../../queues/JobDispatcher.js';
import { privacyVaultService, redactPiiWithStableTokens } from '../../services/agents/orchestration/PrivacyVaultService.js';
import { inboundContactResolver } from '../../services/InboundContactResolver.js';
import { sendInstagramCommentReply, sendFacebookCommentReply } from './socialReplies.js';

/**
 * Save webhook event to outreach conversation
 */
export async function saveWebhookToConversation(
  userId: number,
  data: {
    channel: string;
    externalSenderId: string;
    senderName?: string;
    senderPhone?: string;
    messageText: string;
    messageId: string;
    timestamp: number;
    eventType: string;
    providerAccountId?: string;

    rawData: any;
  }
): Promise<void> {
  try {
    if (['facebook', 'instagram'].includes(data.channel) && !data.providerAccountId) throw new Error('A receiving Meta account is required.');
    if (['facebook','instagram'].includes(data.channel)) await assertSocialAccountOwner(userId, data.channel as 'facebook' | 'instagram', data.providerAccountId!);
    const inboundPreview = redactPiiWithStableTokens(data.messageText || '');
    const duplicate = await db.execute(sql`
      SELECT message.id, message.conversation_id, COALESCE(message.redacted_content, message.content) AS content
      FROM outreach_messages message
      JOIN outreach_conversations conversation
        ON conversation.id = message.conversation_id
       AND conversation.user_id = message.user_id
      WHERE message.user_id = ${userId}
        AND message.external_message_id = ${data.messageId}
        AND conversation.channel = ${data.channel}
        AND (${data.providerAccountId || null}::text IS NULL OR conversation.provider_account_id = ${data.providerAccountId || null})
      ORDER BY message.id
      LIMIT 2
    `);
    if (duplicate.rows.length) {
      if (duplicate.rows.length > 1) throw new Error('Inbound provider identity is bound to multiple conversations.');
      // Compare the masked copy: WhatsApp keeps contact details visible in content.
      const prior = duplicate.rows[0] as { id: number; conversation_id: number; content: string };
      if (prior.content !== inboundPreview.redactedText) throw new Error('Inbound provider identity was replayed with different content.');
      await privacyVaultService.protectInbound({
        userId,
        conversationId: Number(prior.conversation_id),
        channel: data.channel,
        rawText: data.messageText || '',
        providerMessageId: data.messageId,
        messageId: Number(prior.id),
        entityType: 'outreach_message',
        entityId: Number(prior.id),
      });
      await inboundContactResolver.reconcile({
        userId,
        conversationId: Number(prior.conversation_id),
        channel: data.channel,
        messageId: Number(prior.id),
        providerMessageId: data.messageId,
        externalIdentifier: data.externalSenderId,
        displayName: data.senderName || undefined,
        source: data.channel,
        trust: 'provider',
        recordReply: true,
      });
      await queueSocialReply(userId, Number(prior.conversation_id), null, { ...data, inboundMessageId: Number(prior.id) });
      return;
    }
    // Try to find a lead matching this sender
    let lead = null;

    if (data.channel === 'instagram') {
      const leads = await db.select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.userId, userId),
            or(
              sql`${leadsTable.instagramHandle} = ${data.externalSenderId}`,
              sql`${leadsTable.instagram} = ${data.externalSenderId}`,
              sql`${leadsTable.platformExtended}->>'instagram_id' = ${data.externalSenderId}`
            )
          )
        )
        .limit(1);
      lead = leads[0];
    } else if (data.channel === 'whatsapp' && data.senderPhone) {
      const leads = await db.select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.userId, userId),
            or(
              eq(leadsTable.phone, data.senderPhone),
              sql`${leadsTable.platformExtended}->>'whatsapp' = ${data.senderPhone}`
            )
          )
        )
        .limit(1);
      lead = leads[0];
    } else if (data.channel === 'facebook') {
      const leads = await db.select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.userId, userId),
            sql`${leadsTable.platformExtended}->>'facebook_id' = ${data.externalSenderId}`
          )
        )
        .limit(1);
      lead = leads[0];
    } else if (data.channel === 'twitter') {
      const leads = await db.select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.userId, userId),
            or(
              sql`${leadsTable.platformExtended}->>'twitter_id' = ${data.externalSenderId}`,
              sql`${leadsTable.twitter} = ${data.externalSenderId}`
            )
          )
        )
        .limit(1);
      lead = leads[0];
    } else if (data.channel === 'linkedin') {
      const leads = await db.select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.userId, userId),
            or(
              sql`${leadsTable.platformExtended}->>'linkedin_urn' = ${data.externalSenderId}`,
              sql`${leadsTable.linkedin} = ${data.externalSenderId}`
            )
          )
        )
        .limit(1);
      lead = leads[0];
    }

    if (!lead) {
      // Native echoes and inbound callbacks share the same first-contact lock.
      const newLead = await db.transaction(async (tx: typeof db) => {
      if (['whatsapp','instagram','facebook'].includes(data.channel) && data.providerAccountId) {
        await lockSocialProviderMessage(tx,userId,data.channel,data.providerAccountId,`recipient:${data.externalSenderId}`);
        const [prior] = await tx.select().from(leadsTable).where(and(eq(leadsTable.userId,userId),
          sql`${leadsTable.platformExtended}->>${`${data.channel}_id`}=${data.externalSenderId}`)).limit(1);
        if (prior) return prior;
      }
      const [created] = await tx.insert(leadsTable).values({
        userId,
        name: data.senderName || `${data.channel} User`,
        firstName: data.senderName?.split(' ')[0] || data.channel,
        phone: data.senderPhone || null,
        instagramHandle: data.channel === 'instagram' ? data.externalSenderId : null,
        status: 'new',
        source: data.channel,
        platformExtended: {
          [`${data.channel}_id`]: data.externalSenderId,
        },
      }).returning();
      return created;
      });
      lead = newLead;
      logger.info({ channel: data.channel, leadId: lead.id }, '[WebhooksController] Created new lead from webhook');
    }

    // Get or create conversation
    const providerMap: Record<string, string> = {
      instagram: 'instagram_api',
      facebook: 'meta_api',
      whatsapp: 'whatsapp_cloud',
      twitter: 'twitter_api',
      linkedin: 'linkedin_api',
    };

    const conversation = await getOrCreateConversation({
      userId,
      leadId: lead.id,
      channel: data.channel,
      providerAccountId: data.providerAccountId,
      status: 'replied',
      leadName: lead.name || lead.firstName || 'Unknown',
      leadInstagram: data.channel === 'instagram' ? data.externalSenderId : undefined,
      leadCompany: lead.company || undefined,
      externalThreadId: data.externalSenderId,
      ...(providerMap[data.channel] ? { integrationProvider: providerMap[data.channel] } : {}),
      ...(data.senderPhone ? { metadata: { phoneNumber: data.senderPhone } } : {}),
    });

    // Persist only the protected representation, then bind the encrypted raw
    // payload to the exact returned message ID.
    const inboundMessage = await createOutreachMessage({
      conversationId: conversation.id,
      userId,
      direction: 'inbound',
      content: inboundPreview.redactedText,
      status: 'delivered',
      externalMessageId: data.messageId,
      providerAccountId: data.providerAccountId || null,
      sentAt: new Date(data.timestamp),
      isRead: false,
      idempotencyKey: `social-inbound:${crypto.createHash('sha256').update(JSON.stringify([data.channel,data.providerAccountId,data.messageId])).digest('hex')}`,
      metadata: { replySurface: data.eventType === 'comment' ? 'comment' : 'message',
        ...(data.eventType === 'comment' ? { commentId: data.messageId, postId: data.rawData?.post_id || data.rawData?.media?.id, parentCommentId: data.rawData?.parent_id } : {}) },
    });
    const protectedInbound = await privacyVaultService.protectInbound({
      userId,
      conversationId: conversation.id,
      channel: data.channel,
      rawText: data.messageText || '',
      providerMessageId: data.messageId,
      messageId: inboundMessage.id,
      entityType: 'outreach_message',
      entityId: inboundMessage.id,
    });
    await inboundContactResolver.reconcile({
      userId,
      conversationId: conversation.id,
      channel: data.channel,
      messageId: inboundMessage.id,
      providerMessageId: data.messageId,
      externalIdentifier: data.externalSenderId,
      displayName: data.senderName || undefined,
      source: data.channel,
      trust: 'provider',
      recordReply: true,
    });

    let attachmentContext = '';
    let voiceReplyRequested = false;
    let audioTranscriptionUnavailable = false;
    const rawAttachments = Array.isArray(data.rawData?.message?.attachments)
      ? data.rawData.message.attachments.slice(0, 5)
      : [];
    if (rawAttachments.length > 0) {
      const { outreachAttachmentService } = await import('../../services/OutreachAttachmentService.js');
      for (const [index, attachment] of rawAttachments.entries()) {
        const type = String(attachment?.type || 'file');
        if (type === 'audio') {
          voiceReplyRequested = true;
          audioTranscriptionUnavailable = true;
        }
        const attachmentUrl = attachment?.payload?.url || attachment?.url;
        if (typeof attachmentUrl !== 'string') {
          await outreachAttachmentService.recordInboundFailure({
            userId,
            messageId: inboundMessage.id,
            fileName: attachment?.name || `${data.channel}-${type}-${index + 1}`,
            providerAttachmentId: `${data.messageId}:${attachment?.payload?.id || index}`,
            source: `${data.channel}_webhook`,
            error: new Error(`${data.channel} did not provide a retrievable media URL.`),
            metadata: { isVoiceMessage: type === 'audio', providerAttachmentType: type },
          }).catch(() => {});
          continue;
        }
        const mimeType = type === 'image' ? 'image/jpeg'
          : type === 'video' ? 'video/mp4'
            : type === 'audio' ? 'audio/mpeg'
              : undefined;
        const persisted = await outreachAttachmentService.persistInboundUrl({
          userId,
          messageId: inboundMessage.id,
          url: attachmentUrl,
          fileName: attachment?.name || `${data.channel}-${type}-${index + 1}`,
          mimeType,
          providerAttachmentId: `${data.messageId}:${attachment?.payload?.id || index}`,
          source: `${data.channel}_webhook`,
          metadata: {
            isVoiceMessage: type === 'audio',
            providerAttachmentType: type,
          },
        }).catch((error) => {
          logger.warn({ err: error, messageId: data.messageId, attachmentIndex: index }, '[WebhooksController] Inbound attachment persistence failed');
          return null;
        });
        if (type === 'audio') {
          voiceReplyRequested = true;
          if (persisted?.extractionStatus === 'success') audioTranscriptionUnavailable = false;
        }
      }
      attachmentContext = redactPiiWithStableTokens(
        await outreachAttachmentService.getGroundedContext([inboundMessage.id], userId),
      ).redactedText;
    }

    logger.info({ channel: data.channel, conversationId: conversation.id }, '[WebhooksController] Saved message to conversation');

    // Trigger auto-reply based on event type
    await queueSocialReply(userId, conversation.id, lead, {
      ...data,
      inboundMessageId: inboundMessage.id,
      privacyPreprotected: protectedInbound,
      voiceReplyRequested,
      messageText: attachmentContext
          ? `${protectedInbound.redactedText}\n\nSuccessfully extracted attachment content:\n${attachmentContext}`
        : audioTranscriptionUnavailable
          ? `${protectedInbound.redactedText || '[Audio message]'}\n\nAudio transcription is unavailable. Do not claim to understand or quote the recording; reply safely and ask the sender to restate key details in text if needed.`
          : protectedInbound.redactedText,
    });
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Failed to save to conversation');
    throw error;
  }
}

export async function queueSocialReply(userId: number, conversationId: number, lead: any, data: Parameters<typeof triggerAutoReply>[3]) {
  if (data.channel === 'instagram') {
    const { ingestInstagramAutomation } = await import('../../services/instagramAutomations/InstagramAutomationRuntime.js');
    if (await ingestInstagramAutomation(userId, conversationId, data)) return;
  }
  if (data.eventType === 'comment' && ['instagram','facebook'].includes(data.channel)) {
    await jobDispatcher.dispatch('process_social_comment_webhook', { userId, conversationId,
      lead: lead ? { id: lead.id, name: lead.name, firstName: lead.firstName } : null,
      data: { ...data, messageText: redactPiiWithStableTokens(data.messageText).redactedText,
        rawData: { id: data.messageId, comment_id: data.messageId } },
    });
    return;
  }
  await triggerAutoReply(userId, conversationId, lead, data);
}

/** Route legacy per-user webhook URLs into the same canonical runtime. */
export async function triggerAutoReply(
  userId: number,
  conversationId: number,

  lead: any,
  data: {
    channel: string;
    externalSenderId: string;
    messageText: string;
    messageId: string;
    eventType: string;
    rawData: any;
    inboundMessageId?: number;
    privacyPreprotected?: {
      vaultId: number | null;
      piiTypes: string[];
      tokenCount: number;
    };
    voiceReplyRequested?: boolean;
    providerAccountId?: string;
    timestamp?: number;
    senderName?: string;
  }
): Promise<void> {
  try {
    if (!data.messageText) return;

    // WhatsApp is forwarded to whatsappController immediately after this path;
    // it owns canonical persistence and routing and must not be invoked twice.
    if (data.channel === 'whatsapp') return;

    if (data.eventType === 'message' && (data.channel === 'instagram' || data.channel === 'facebook')) {
      const jobName = data.channel === 'instagram'
        ? 'process_instagram_webhook'
        : 'process_facebook_webhook';
      await jobDispatcher.dispatch(jobName, {
        conversationId,
        userId,
        channel: data.channel,
        senderId: data.externalSenderId,
        inboundText: data.messageText,
        messageId: data.messageId,
        inboundMessageId: data.inboundMessageId,
        providerAccountId: data.providerAccountId,
        privacyPreprotected: data.privacyPreprotected,
        voiceReplyRequested: data.voiceReplyRequested,
      });
      return;
    }

    // Public comments use the canonical privacy/policy/playbook/guardrail path,
    // but retain a comment-specific delivery adapter.
    if (data.eventType !== 'comment' || !['instagram', 'facebook'].includes(data.channel)) return;
    const commentId = String(data.rawData?.comment_id || data.rawData?.id || data.messageId || '');
    if (!commentId) return;

    const { agentRouter } = await import('../../services/agents/AgentRouter.js');
    const result = await agentRouter.handle({
      userId,
      conversationId,
      channel: `${data.channel}_comment`,
      recipientPhone: data.externalSenderId,
      inboundText: data.messageText,
      leadId: lead?.id ?? null,
      leadName: lead?.name || lead?.firstName || null,
      rawMessageId: data.messageId,
      messageId: data.inboundMessageId,
      metadata: {
        publicReply: true,
        sourceChannel: `${data.channel}_comment`,
        commentId,
        privacyPreprotected: data.privacyPreprotected,
        providerAccountId: data.providerAccountId,
      },
    });
    const replyText = result?.deliveryOutcome === 'ready_for_channel_delivery' ? result.replyText : '';
    if (!result || !replyText) return;

    const { withPublishedAssistant,withPrivateAssistantForPublicDelivery } = await import('../../services/assistants/AssistantFreshness.js');
    await withPublishedAssistant(result.deferredEffectContext?.assistantProvenance, async () => {

    const { deliveryOutboxService } = await import('../../services/agents/orchestration/DeliveryOutboxService.js');
    const claim = await deliveryOutboxService.claim({
      userId,
      conversationId,
      channel: `${data.channel}_comment`,
      inboundProviderMessageId: data.messageId,
    }, {
      text: replyText,
      recipient: commentId,
      metadata: {
        publicReply: true,
        dispatchKind: 'public_comment',
        ...(data.providerAccountId ? { providerAccountId: data.providerAccountId } : {}),
      },
    });
    if (claim.state === 'drafted' || (claim.state === 'claimed' && await deliveryOutboxService.holdIfDisabled(claim.action))) {
      await agentRouter.commitDeferredDelivery(result, 'drafted');
      return;
    }
    if (claim.state === 'uncertain') return;

    let publicTextDelivered = claim.state === 'already_sent';
    if (claim.state === 'claimed') {
      const providerResult = data.channel === 'instagram'
        ? await sendInstagramCommentReply(userId, commentId, replyText, data.providerAccountId)
        : await sendFacebookCommentReply(userId, commentId, replyText, data.providerAccountId);
      if (providerResult.success && providerResult.providerMessageId) {
        await deliveryOutboxService.completeClaimedAction(claim.action, providerResult.providerMessageId);
        publicTextDelivered = true;
      } else {
        await deliveryOutboxService.markFailed(
          claim.action.id,
          providerResult.error || 'Provider rejected public comment reply',
          providerResult.outcomeUncertain || providerResult.success,
        );
      }
    }

    let externalBookingDelivered = !result?.externalBookingHandoff;
    if (publicTextDelivered && result?.externalBookingHandoff && data.externalSenderId) {
      await withPrivateAssistantForPublicDelivery(result.deferredEffectContext?.assistantProvenance, async () => {
      const { renderExternalBookingMessage } = await import('../../services/booking/ExternalBookingDelivery.js');
      const privateText = renderExternalBookingMessage(result.externalBookingHandoff!, data.channel, true);
      const privateClaim = await deliveryOutboxService.claim({
        userId,
        conversationId,
        channel: data.channel,
        inboundProviderMessageId: data.messageId,
        partIndex: 1,
      }, {
        text: privateText,
        recipient: data.externalSenderId,
        metadata: {
          dispatchKind: 'external_booking_private_handoff',
          sourceChannel: `${data.channel}_comment`,
          ...(data.providerAccountId ? { providerAccountId: data.providerAccountId } : {}),
        },
      });
      if (privateClaim.state === 'drafted' || (privateClaim.state === 'claimed' && await deliveryOutboxService.holdIfDisabled(privateClaim.action))) {
        await agentRouter.commitDeferredDelivery(result, 'drafted');
        return;
      }
      if (privateClaim.state === 'already_sent') {
        externalBookingDelivered = true;
      } else if (privateClaim.state === 'claimed') {
        const dmResult = data.channel === 'instagram'
          ? await (await import('../../services/instagramService.js')).sendInstagramDM({
            recipientId: data.externalSenderId,
            message: privateText,
            userId,
            conversationId,
            messageId: 0,
            providerAccountId: data.providerAccountId,
          })
          : await (await import('../../services/FacebookMessengerService.js')).sendFacebookDM({
            recipientId: data.externalSenderId,
            message: privateText,
            userId,
            skipOutreachLimits: true,
            conversationId,
            providerAccountId:data.providerAccountId,
          });
        if (dmResult.success && dmResult.externalMessageId) {
          await deliveryOutboxService.completeClaimedAction(privateClaim.action, dmResult.externalMessageId || null);
          externalBookingDelivered = true;
        } else {
          await deliveryOutboxService.markFailed(
            privateClaim.action.id,
            dmResult.error || 'Provider rejected the private booking-page delivery',
            dmResult.outcomeUnknown === true || dmResult.success === true,
            dmResult.retryable !== false,
          );
        }
      }
      });
    }

    // Public comments never expose private storage URLs. After the public text
    // succeeds, verified images are sent privately when the sender is DM-eligible.
    let mediaDeliverySucceeded = !result?.verifiedMedia?.length;
    if (publicTextDelivered && result?.verifiedMedia?.length && data.externalSenderId) {
      await withPrivateAssistantForPublicDelivery(result.deferredEffectContext?.assistantProvenance, async () => {
      const { supportMediaDeliveryService } = await import('../../services/supportMedia/SupportMediaDeliveryService.js');
      const mediaOutcome = await supportMediaDeliveryService.deliverDirect({
        userId,
        conversationId,
        channel: data.channel as 'instagram' | 'facebook',
        recipient: data.externalSenderId,
        providerAccountId: data.providerAccountId,
        inboundProviderMessageId: data.messageId,
        inboundMessageId: data.inboundMessageId,
        media: result.verifiedMedia!,
      });
      if (mediaOutcome.failed > 0) {
        logger.info({ userId, channel: data.channel, commentId, mediaOutcome }, '[WebhooksController] Public reply sent; private media delivery degraded');
      }
      mediaDeliverySucceeded = mediaOutcome.sent > 0;
      });
    }
    if (publicTextDelivered && result && externalBookingDelivered) {
      result.mediaDeliverySucceeded = mediaDeliverySucceeded;
      if (!result.mediaDeliveryAssertionRequired || mediaDeliverySucceeded) {
        await agentRouter.commitDeferredDelivery(result);
      }
    }

    // Claimed sends are persisted atomically by completeClaimedAction. An
    // already-sent action already owns its unique outbound ledger row.
    });
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Canonical webhook reply routing failed');
    throw error;
  }
}
