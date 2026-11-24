import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { getBrandInfo, renderBrandedEmail } from '../utils/emailTemplates.js';
import { deliveryOutboxService } from './agents/orchestration/DeliveryOutboxService.js';
import { storageService } from './StorageService.js';
import { plainTextEmailFallback } from './booking/ExternalBookingDelivery.js';
import { currentAssistant } from './assistants/AssistantContext.js';
import { assertAssistantFresh, withPublishedAssistant } from './assistants/AssistantFreshness.js';
import { sendCampaignEmailReply } from './outreach/CampaignEmailReplyDelivery.js';
import { assertResolvedEmailTemplate } from '../utils/emailTemplateVariables.js';
import { matchesHandoffOfferReply, validatedHandoffChoice } from './agents/orchestration/HandoffConsent.js';
import { escapeHtml } from '../../shared/html.js';

/**
 * Thread headers must come from an actual RFC Message-ID, never a provider ID.
 */
function normalizeMessageIdToRfc5322(id: string | undefined | null): string | undefined {
  return id && /^<[^<>@\s]+@[^<>\s]+>$/.test(id) ? id : undefined;
}

/**
 * Delivers replies bound to their original campaign or published support assistant.
 * 
 * Inbound emails are handled by:
 * - Resend webhooks (email.received) → server/controllers/resendWebhookController.ts
 * - Gmail Pub/Sub → server/services/gmailApiService.ts
 */

class EmailReplyService {
  /**
   * Approve and send a smart reply
   */
  async sendSmartReply(
    messageId: number,
    customReply?: string,
    expectedUserId?: number,
    supportMedia: import('./supportMedia/types.js').VerifiedSupportMedia[] = [],
    deliveryContext?: { actionId: number; conversationId: number },
  ): Promise<{ success: boolean; error?: string; mediaSent?: number; code?: string; reason?: string; setupUrl?: string }> {
    let reservationTransactionId: number | undefined;
    let providerCallStarted = false;
    let claimed = false;
    let messageUserId: number | undefined;
    let deliveryActionId: number | undefined;

    try {
      const messageResult = await db.execute(sql`
        SELECT sm.*, l.email as lead_email, l.name as lead_name
        FROM sent_messages sm
        LEFT JOIN leads l ON sm.lead_id = l.id
        WHERE sm.id = ${messageId}
          AND (${expectedUserId ?? null}::int IS NULL OR sm.user_id = ${expectedUserId ?? null})
      `);

      if (messageResult.rows.length === 0) {
        return { success: false, error: 'Message not found' };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = messageResult.rows[0] as any;
      messageUserId = Number(message.user_id);

      if (message.reply_context?.kind === 'campaign') return sendCampaignEmailReply(message, customReply, deliveryContext);
      if (message.campaign_id || message.reply_context?.kind !== 'support') {
        return { success: false, error: 'Regenerate this reply with its original campaign context before sending.' };
      }

      if (!currentAssistant()) {
        if (!message.smart_reply_assistant) return {success:false,error:'Regenerate this reply with the assigned assistant before sending.'};
        return withPublishedAssistant(message.smart_reply_assistant,()=>this.sendSmartReply(messageId,customReply,expectedUserId,supportMedia,deliveryContext));
      }

      // Durable retries must keep the original action/thread, even when a
      // different conversation with this lead has become more recent.
      const boundActions = await db.execute(sql`
        SELECT id, conversation_id, payload FROM support_delivery_outbox
        WHERE user_id = ${messageUserId} AND channel = 'email'
          AND inbound_provider_message_id = ${`email-smart-reply:${messageId}`}
          AND (${deliveryContext?.actionId ?? null}::bigint IS NULL OR id = ${deliveryContext?.actionId ?? null})
        LIMIT 2
      `);
      if (boundActions.rows.length > 1) return { success: false, error: 'Smart reply has ambiguous delivery actions. Review the existing actions before retrying.' };
      const boundAction = boundActions.rows[0] as {
        id: number; conversation_id: number;
        payload: { text: string; recipient: string; metadata?: Record<string, unknown>; choice?: unknown };
      } | undefined;
      if (deliveryContext && (!boundAction || Number(boundAction.id) !== deliveryContext.actionId
        || Number(boundAction.conversation_id) !== deliveryContext.conversationId)) {
        return { success: false, error: 'Smart reply delivery action does not match the requested conversation.' };
      }
      if (boundAction && Number(boundAction.payload.metadata?.sentMessageId) !== messageId) {
        return { success: false, error: 'Smart reply delivery action does not match the saved draft.' };
      }
      if (boundAction && String(boundAction.payload.recipient || '').trim().toLowerCase() !== String(message.lead_email || '').trim().toLowerCase()) {
        return { success: false, error: 'The saved email delivery recipient changed. Review the saved delivery before retrying.' };
      }

      const storedConversationId = Number(message.reply_context.conversationId || 0);
      if (storedConversationId !== Number(message.smart_reply_assistant?.conversationId)
        || (boundAction && Number(boundAction.conversation_id) !== storedConversationId)) {
        return {success:false,error:'The original email conversation does not match the assigned assistant.'};
      }
      if (currentAssistant() && !boundAction && !Number.isSafeInteger(storedConversationId)) {
        return {success:false,error:'The original email conversation cannot be verified.'};
      }
      if (currentAssistant() && !boundAction && storedConversationId <= 0) {
        return {success:false,error:'Regenerate this reply in its original email conversation.'};
      }
      const conversationResult = await db.execute(sql`
        SELECT id, brand_toolkit_id FROM outreach_conversations
        WHERE user_id = ${message.user_id}
          AND lead_id = ${message.lead_id}
          AND channel IN ('email', 'gmail')
          AND id = ${storedConversationId}
        LIMIT 1
      `);
      if (!conversationResult.rows[0]) return { success: false, error: 'The exact email delivery conversation is no longer available.' };
      const deliveryConversationId = Number(conversationResult.rows[0].id);
      // Replies keep the brand saved on this outreach thread, not the current default.
      const conversationBrandToolkitId = (conversationResult.rows[0] as { brand_toolkit_id?: number | null }).brand_toolkit_id ?? null;
      const savedChoice = validatedHandoffChoice(message.reply_context?.handoffChoice);
      const replyChoice = boundAction ? validatedHandoffChoice(boundAction.payload.choice)
        : customReply === undefined && savedChoice && matchesHandoffOfferReply(String(message.smart_reply || ''), savedChoice) ? savedChoice : undefined;
      const outboundText = String(boundAction ? boundAction.payload.text : replyChoice?.fallbackText || customReply || message.smart_reply || '');
      assertResolvedEmailTemplate({ text: outboundText, subject: String(message.subject || 'Inquiry') });
      const { prepareDesignedEmail } = await import('./EmailDesignService.js');
      const { formatMessageForChannel: formatForDesign } = await import('../utils/messageFormatter.js');
      const emailHtml = await prepareDesignedEmail(messageUserId, formatForDesign(outboundText, 'email'), 'assistant', undefined, conversationBrandToolkitId);
      const deliveryClaim = await deliveryOutboxService.claim({
        userId: messageUserId,
        conversationId: deliveryConversationId,
        channel: 'email',
        inboundProviderMessageId: `email-smart-reply:${messageId}`,
      }, {
        text: outboundText,
        choice: replyChoice,
        recipient: String(message.lead_email || ''),
        subject: String(message.subject || 'Inquiry'),
        metadata: { ...boundAction?.payload.metadata, dispatchKind: 'email_smart_reply', emailHtml, providerAccountId: currentAssistant()?.provenance.accountId || message.reply_context?.accountId, sentMessageId: messageId, autoReply: !customReply },
      });
      deliveryActionId = deliveryClaim.action.id;
      if (deliveryClaim.state === 'uncertain') {
        return { success: false, error: 'Reply delivery is already in progress or uncertain. Automatic resend was suppressed.' };
      }
      if (deliveryClaim.state === 'already_sent') {
        await db.execute(sql`
          UPDATE sent_messages SET smart_reply_approved = true,
            smart_reply_sent_at = COALESCE(smart_reply_sent_at, NOW()), updated_at = NOW()
          WHERE id = ${messageId}
        `);
        return { success: true, mediaSent: 0 };
      }
      if (deliveryClaim.state !== 'claimed') return {success:false,error:'This email reply is held for human review.'};

      const claim = await db.execute(sql`
        UPDATE sent_messages
        SET smart_reply_approved = true, updated_at = NOW()
        WHERE id = ${messageId}
          AND smart_reply_sent_at IS NULL
          AND COALESCE(smart_reply_approved, false) = false
        RETURNING id
      `);
      if (claim.rows.length === 0) {
        if (message.smart_reply_sent_at) {
          await deliveryOutboxService.markSent(deliveryActionId, null);
          return { success: true };
        }
        await deliveryOutboxService.markFailed(deliveryActionId, 'Smart reply is already claimed by another worker', false);
        return { success: false, error: 'Smart reply is already claimed by another worker' };
      }
      claimed = true;
      const { formatMessageForChannel } = await import('../utils/messageFormatter.js');
      const rawReplyContent = deliveryClaim.action.payload?.text || outboundText;
      const replyContent = formatMessageForChannel(rawReplyContent || '', 'email');
      const plainTextReply = plainTextEmailFallback(replyContent);

      if (!replyContent) {
        if (deliveryActionId) await deliveryOutboxService.markFailed(deliveryActionId, 'No smart reply content available', false);
        return { success: false, error: 'No smart reply content available' };
      }

      // Wrap smart reply in branded email template only if it's not already a full HTML document
      let brandedReply = typeof deliveryClaim.action.payload?.metadata?.emailHtml === 'string' ? deliveryClaim.action.payload?.metadata.emailHtml : replyContent;
      const isAlreadyBrandedHtml = brandedReply.trim().startsWith('<!DOCTYPE');
      if (!isAlreadyBrandedHtml) {
        try {
          const brand = await getBrandInfo(message.user_id, conversationBrandToolkitId);
          brandedReply = renderBrandedEmail({
            brand,
            preheader: message.subject ? `Re: ${message.subject}` : 'Reply to your message',
            recipientName: undefined,
            body: replyContent,
          });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (brandErr: any) {
          logger.warn({ err: brandErr, userId: message.user_id }, '[EmailReplyService] Failed to wrap smart reply in branded template, sending raw');
        }
      }

      const emailAttachments: Array<{ content: Buffer; contentType: string; filename: string; contentId?: string }> = [];
      const emailMedia = [] as Array<{ media: import('./supportMedia/types.js').VerifiedSupportMedia; contentId: string }>;
      let aggregateMediaBytes = 0;
      for (const media of supportMedia.slice(0, 5)) {
        const stored = await storageService.downloadFile(media.derivativeStorageFileId, messageUserId);
        if (!stored || aggregateMediaBytes + stored.buffer.length > 15 * 1024 * 1024) continue;
        aggregateMediaBytes += stored.buffer.length;
        const contentId = `support-media-${media.assetId}-${media.checksum.slice(0, 12)}@asksales`;
        emailAttachments.push({ content: stored.buffer, contentType: media.mimeType, filename: `${media.name}.jpg`, contentId });
        emailMedia.push({ media, contentId });
      }
      if (emailMedia.length) {
        const gallery = `<div role="group" aria-label="Related images" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:20px 0">${emailMedia.map(({ media, contentId }) => `<figure style="margin:0"><img src="cid:${contentId}" alt="${escapeHtml(media.altText)}" style="display:block;width:100%;height:auto;border-radius:8px"><figcaption style="font-size:12px;color:#667085;margin-top:6px">${escapeHtml(media.caption || media.name)}</figcaption></figure>`).join('')}</div>`;
        brandedReply = brandedReply.includes('</body>') ? brandedReply.replace('</body>', `${gallery}</body>`) : `${brandedReply}${gallery}`;
      }

      // Import emailService to send the reply
      const { emailService } = await import('./emailService');
      const { creditService } = await import('./CreditService.js');

      const reservation = await creditService.reserveOutreachCredit({
        userId: messageUserId,
        channel: 'email',
        referenceId: `smart-reply:${messageId}`,
        service: 'EmailReplyService',
      });
      if (!reservation.success) {
        if (deliveryActionId) await deliveryOutboxService.markFailed(deliveryActionId, reservation.error || 'Insufficient credits', false);
        await db.execute(sql`
          UPDATE sent_messages SET smart_reply_approved = false, updated_at = NOW()
          WHERE id = ${messageId} AND smart_reply_sent_at IS NULL
        `);
        return { success: false, error: reservation.error || 'Insufficient credits. Recharge your wallet before sending.' };
      }
      reservationTransactionId = reservation.transactionId;

      const subjectStr = message.is_reply 
         ? (message.subject?.toLowerCase().startsWith('re:') ? message.subject : `Re: ${message.subject || 'Inquiry'}`) 
         : `Re: ${message.subject || 'Inquiry'}`;

      // Build proper threading context from the outreach conversation
      // so support auto-replies show in the same email thread.
      let inReplyTo = normalizeMessageIdToRfc5322(message.message_id);
      let references: string | undefined = inReplyTo;
      let threadId: string | undefined = message.gmail_thread_id || undefined;

      if (message.lead_id && message.user_id) {
        try {
          const { getFullReferenceChain } = await import('../models/outreachConversations/functions');
          const convResult = await db.execute(sql`
            SELECT id, external_thread_id, subject
            FROM outreach_conversations
            WHERE user_id = ${message.user_id}
              AND lead_id = ${message.lead_id}
              AND channel IN ('email', 'gmail')
              AND id = ${deliveryConversationId}
            LIMIT 1
          `);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const conv = convResult.rows[0] as any;
          if (conv) {
            // Use Gmail thread ID from conversation if not on the message
            if (!threadId && conv.external_thread_id) {
              threadId = conv.external_thread_id;
            }
            // Build proper References header from ALL messages in the thread
            const fullChain = await getFullReferenceChain(conv.id);
            if (fullChain) {
              references = fullChain;
            }
            // If message has no message_id (e.g. ticket confirmation inserts),
            // use the last message in the conversation thread for inReplyTo
            if (!inReplyTo) {
              const { getLastMessageExternalId } = await import('../models/outreachConversations/functions');
              const lastMsgId = await getLastMessageExternalId(conv.id);
              inReplyTo = normalizeMessageIdToRfc5322(lastMsgId || undefined);
              if (!references && inReplyTo) {
                references = inReplyTo;
              }
            }
          }
        } catch (convErr) {
          logger.warn({ err: convErr, leadId: message.lead_id }, '[EmailReplyService] Failed to load conversation threading context — using message-level fallback');
        }
      }

      let verifiedSenderId=message.sender_id ? Number(message.sender_id) : undefined;
      if (currentAssistant()) {
        const sender=await db.execute(sql`SELECT id FROM email_senders WHERE user_id=${messageUserId} AND is_verified
          AND lower(email)=${currentAssistant()!.provenance.accountId} LIMIT 2`);
        if (sender.rows.length !== 1 || (verifiedSenderId && verifiedSenderId !== Number(sender.rows[0].id))) {
          throw new Error('The original receiving email account cannot be verified.');
        }
        verifiedSenderId=Number(sender.rows[0].id);
        await assertAssistantFresh();
        if (await deliveryOutboxService.holdIfDisabled(deliveryClaim.action)) throw new Error('The assigned assistant is no longer enabled.');
      }
      providerCallStarted = true;
      const result = await emailService.sendPersonalizedEmail(
        message.lead_id,
        subjectStr,
        brandedReply,
        message.campaign_id,
        (message.sequence_step || 0) + 1,
        message.user_id,
        {
          idempotencyKey: `email-smart-reply:${deliveryActionId}`,
          text: plainTextReply,
          inReplyTo,
          references,
          threadId,
          // Route the reply via the same Gmail OAuth sender that received the inbound email,
          // preventing Resend from being used for Gmail-received emails (breaks threading).
          senderId: verifiedSenderId,
          skipCreditDeduction: true,
          // The outbox owns the exact original conversation and confirmed receipt.
          // The email logger must not guess another thread or create a duplicate.
          skipConversationLog: true,
          attachments: emailAttachments,
        }
      );

      if (result.success) {
        if (!result.providerMessageId && !result.messageId) throw new Error('The email provider did not return a delivery acknowledgement.');
        if (emailMedia.length) {
          const { supportMediaDeliveryService } = await import('./supportMedia/SupportMediaDeliveryService.js');
          await supportMediaDeliveryService.recordDeferredAcknowledgement({
            userId: messageUserId,
            conversationId: deliveryConversationId,
            channel: 'email',
            inboundId: `email-smart-reply:${messageId}`,
            providerMessageId: result.providerMessageId || result.messageId,
            media: emailMedia.map((item) => item.media),
          });
        }
        const deliveryOwnerId = messageUserId;
        if (!Number.isSafeInteger(deliveryOwnerId) || !deliveryOwnerId) {
          throw new Error('Email delivery tenant identity is unavailable.');
        }
        await deliveryOutboxService.completeClaimedAction(deliveryClaim.action,result.providerMessageId || result.messageId || null);
        await db.transaction(async (tx: typeof db) => {
          const sentMessage = await tx.execute(sql`
            UPDATE sent_messages
            SET smart_reply_approved = true,
                smart_reply_sent_at = NOW(),
                updated_at = NOW()
            WHERE id = ${messageId}
              AND user_id = ${deliveryOwnerId}
            RETURNING id
          `);
          if (sentMessage.rows.length !== 1) {
            throw new Error('Exact inbound email row could not be marked replied.');
          }
        });


        // Stop follow-up sequences for this lead since a reply has been sent
        try {
          await db.execute(sql`
            UPDATE followup_sequences
            SET completed = true, replied_at = NOW(), updated_at = NOW()
            WHERE lead_id = ${message.lead_id}
              AND user_id = ${message.user_id}
              AND completed = false
          `);
          await db.execute(sql`
            UPDATE sequence_executions
            SET status = 'paused', updated_at = NOW()
            WHERE lead_id = ${message.lead_id}
              AND status = 'active'
          `);
          // Also mark seed messages as fully followed-up so cron system stops
          await db.execute(sql`
            UPDATE sent_messages
            SET follow_up_step = 9999, updated_at = NOW()
            WHERE lead_id = ${message.lead_id}
              AND user_id = ${message.user_id}
              AND is_reply = false
              AND channel IN ('email', 'gmail', 'resend')
              AND (follow_up_step IS NULL OR follow_up_step < 9999)
          `);
          logger.info({ leadId: message.lead_id, userId: message.user_id }, '[EmailReplyService] Stopped follow-up sequences after smart reply');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (seqErr: any) {
          logger.warn({ err: seqErr }, '[EmailReplyService] Failed to stop follow-up sequences after smart reply');
        }

        return { success: true, mediaSent: emailMedia.length };
      }

      if (reservationTransactionId) {
        await creditService.refundDeduction({
          userId: messageUserId,
          transactionId: reservationTransactionId,
          description: `Refund for rejected smart reply ${messageId}`,
        });
      }
      if (deliveryActionId) await deliveryOutboxService.markFailed(deliveryActionId, result.error || 'Email provider rejected the reply', false);
      await db.execute(sql`
        UPDATE sent_messages SET smart_reply_approved = false, updated_at = NOW()
        WHERE id = ${messageId} AND smart_reply_sent_at IS NULL
      `);
      return { success: false, error: result.error || 'Failed to send reply' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EmailReplyService] Error sending smart reply');
      if (deliveryActionId) {
        await deliveryOutboxService.markFailed(
          deliveryActionId,
          error?.message || 'Email delivery failed',
          providerCallStarted,
        ).catch(() => undefined);
      }
      if (!providerCallStarted && reservationTransactionId && messageUserId) {
        const { creditService } = await import('./CreditService.js');
        await creditService.refundDeduction({
          userId: messageUserId,
          transactionId: reservationTransactionId,
          description: `Refund for interrupted smart reply ${messageId}`,
        });
      }
      if (!providerCallStarted && claimed) {
        await db.execute(sql`
          UPDATE sent_messages SET smart_reply_approved = false, updated_at = NOW()
          WHERE id = ${messageId} AND smart_reply_sent_at IS NULL
        `).catch(() => {});
      }
      if (providerCallStarted) {
        return { success: false, error: 'Reply delivery outcome is uncertain. Review provider history before retrying.' };
      }
      return { success: false, error: error.message };
    }
  }

}

export const emailReplyService = new EmailReplyService();
