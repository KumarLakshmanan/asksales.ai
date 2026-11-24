import type { PipelineStage } from "../PipelineStage.js";
import { supportTurnProviderReplyId } from '../../orchestration/SupportConversationTurn.js';
import type { PipelineContext } from "../ChannelGateway.js";
import { whatsappApiService } from "../../../whatsappApiService.js";
import { db } from "../../../../models/db.js";
import { sql } from "drizzle-orm";
import { logger } from "../../../../utils/logger.js";
import { formatMessageForChannel } from "../../../../utils/messageFormatter.js";
import { deliveryOutboxService } from "../../orchestration/DeliveryOutboxService.js";
import { renderExternalBookingMessage } from "../../../booking/ExternalBookingDelivery.js";
import type { SupportChoiceManifest } from '../../orchestration/SupportChoiceDelivery.js';
import { unavailableBrochureReply } from '../../orchestration/SupportInformationRequest.js';
import { PipelineHalt } from '../PipelineStage.js';
import { automaticSupportReplyAllowed, socialDraftChannel } from '../../orchestration/SupportAutoReplyService.js';

function splitMessageIntoParts(text: string): string[] {
  // If the text contains the explicit '|||' delimiter, split by it
  if (text.includes("|||")) {
    return text
      .split("|||")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }
  // Fallback: Split by double newlines, trim, and filter out empty paragraphs
  const parts = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  
  if (parts.length === 0) return [text.trim()];
  return parts;
}

export class DeliveryStage implements PipelineStage {
  name = "Delivery";

  private async draftReply(ctx: PipelineContext, text: string): Promise<void> {
    const { userId, conversationId, channel, rawMessageId, messageId, senderIdentifier, phoneNumberId } = ctx.message;
    if (!rawMessageId && !messageId) throw new Error('A stable inbound identifier is required for a draft.');
    const publicReply = channel.endsWith('_comment');
    const cohesive = ['verified_natural_knowledge_answer','verbatim_published_evidence'].includes(ctx.agentResult?.answerVerification?.reason || '')
      && text.length <= 4000 && !text.includes('|||');
    const parts = publicReply || cohesive || ctx.approvedDocument || ctx.message.metadata?.voiceReplyRequested
      || ctx.metadata?.handoffChoice || ctx.metadata?.playbookDirective?.choice || ctx.agentResult?.externalBookingHandoff ? [text] : splitMessageIntoParts(text);
    let actionId: number | undefined;
    for (const [partIndex, part] of parts.entries()) {
    const action = await deliveryOutboxService.draft({ userId, conversationId, channel,
      partIndex: ctx.approvedDocument && channel === 'whatsapp' ? 2000 : partIndex,
      inboundProviderMessageId: rawMessageId, inboundMessageId: messageId,
      ...(publicReply || ctx.approvedDocument ? {} : { playbookRunId: ctx.metadata?.playbookDirective?.runId, playbookNodeId: ctx.metadata?.playbookDirective?.nodeId }),
    }, { text: part, recipient: publicReply ? String(ctx.message.metadata?.commentId || rawMessageId || '') : senderIdentifier,
      phoneNumberId, metadata: { dispatchKind: publicReply ? 'public_comment' : 'pipeline_message',
        providerAccountId: ctx.message.metadata?.providerAccountId || phoneNumberId,
        sourceMessageIds: ctx.message.metadata?.turnMessageIds || (messageId ? [messageId] : []),
        draftMedia: partIndex === 0 ? ctx.verifiedMedia || [] : [], draftDocument: ctx.approvedDocument || null,
        preferredDelivery: ctx.message.metadata?.voiceReplyRequested ? 'voice' : 'text',
        ...(ctx.metadata?.suppressAssistantFollowUp === true ? { suppressAssistantFollowUp: true } : {}),
        publicReply,
      }, choice: publicReply ? undefined : ctx.metadata?.handoffChoice || ctx.metadata?.playbookDirective?.choice });
    actionId = action.id;
    }
    if (publicReply && ctx.agentResult?.externalBookingHandoff) {
      await deliveryOutboxService.draft({ userId, conversationId, channel: channel.replace(/_comment$/, ''),
        inboundProviderMessageId: rawMessageId, inboundMessageId: messageId, partIndex: 1 }, {
        text: renderExternalBookingMessage(ctx.agentResult.externalBookingHandoff, channel.replace(/_comment$/, ''), true),
        recipient: senderIdentifier, metadata: { dispatchKind: 'external_booking_private_handoff',
          providerAccountId: ctx.message.metadata?.providerAccountId, sourceMessageIds: messageId ? [messageId] : [] },
      });
    }
    if (publicReply) {
      for (const [index,media] of (ctx.verifiedMedia || []).slice(0,5).entries()) {
        await deliveryOutboxService.draft({ userId,conversationId,channel:channel.replace(/_comment$/, ''),
          inboundProviderMessageId:rawMessageId,inboundMessageId:messageId,partIndex:3000+index }, {
          text:media.caption || media.altText || media.name,recipient:senderIdentifier,
          metadata:{dispatchKind:'support_media',providerAccountId:ctx.message.metadata?.providerAccountId,draftMedia:[media]},
        });
      }
    }
    ctx.metadata = { ...ctx.metadata, deliveryStatus: 'drafted', deliveryActionId: actionId,
      deliveryDeferred: false, externalMessageId: null, sentMessageIds: [] };
  }

  private async deliverPostMediaText(input: {
    userId: number;
    conversationId: number;
    channel: 'whatsapp' | 'instagram' | 'facebook';
    senderIdentifier: string;
    phoneNumberId?: string;
    providerAccountId?: string;
    rawMessageId?: string;
    inboundMessageId?: number;
    playbookRunId?: number;
    playbookNodeId?: string;
    text: string;
    outcome: 'resume' | 'failure';
    choice?: SupportChoiceManifest;
  }): Promise<{ actionId: number; providerMessageId: string | null; drafted?: boolean }> {
    const claim = await deliveryOutboxService.claim({
      userId: input.userId,
      conversationId: input.conversationId,
      channel: input.channel,
      inboundProviderMessageId: input.rawMessageId,
      inboundMessageId: input.inboundMessageId,
      playbookRunId: input.playbookRunId,
      playbookNodeId: input.playbookNodeId,
      responseVersion: input.outcome === 'resume' ? 2 : 3,
      partIndex: 0,
    }, {
      text: input.text,
      recipient: input.senderIdentifier,
      phoneNumberId: input.phoneNumberId || null,
      ...(input.choice ? { choice: input.choice } : {}),
      metadata: {
        dispatchKind: input.outcome === 'resume' ? 'post_media_resume' : 'post_media_failure',
        ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
      },
    });

    if (claim.state === 'uncertain') {
      throw new Error(`Post-media delivery outcome is uncertain for action ${claim.action.id}; automatic resend was suppressed.`);
    }
    if (claim.state === 'already_sent') {
      return { actionId: claim.action.id, providerMessageId: claim.action.providerMessageId || null };
    }
    if (claim.state === 'drafted' || await deliveryOutboxService.holdIfDisabled(claim.action)) {
      return { actionId: claim.action.id, providerMessageId: null, drafted: true };
    }

    let providerCallStarted = false;
    try {
      let providerMessageId: string | null = null;
      providerCallStarted = true;
      if (input.channel === 'whatsapp') {
        const response = input.choice
          ? await whatsappApiService.sendChoice({
            userId: input.userId,
            phoneNumberId: input.phoneNumberId,
            to: input.senderIdentifier,
            text: input.text,
            choice: input.choice,
          })
          : await whatsappApiService.sendText({
            userId: input.userId,
            phoneNumberId: input.phoneNumberId,
            to: input.senderIdentifier,
            text: input.text,
          });
        providerMessageId = response.messages?.[0]?.id || null;
      } else if (input.channel === 'instagram') {
        const { sendInstagramDM } = await import('../../../instagramService.js');
        const response = await sendInstagramDM({
          recipientId: input.senderIdentifier,
          message: input.text,
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: 0,
          providerAccountId: input.providerAccountId,
          choice: input.choice,
        });
        if (!response.success) {
          providerCallStarted = response.deliveryAttempted === true;
          throw Object.assign(new Error(response.error || 'Instagram rejected the post-media reply.'), {
            deliveryAttempted: response.deliveryAttempted === true,
            outcomeUncertain: response.outcomeUnknown === true,
            retryable: response.retryable !== false,
          });
        }
        providerMessageId = response.externalMessageId || null;
      } else {
        const { sendFacebookDM } = await import('../../../FacebookMessengerService.js');
        const response = await sendFacebookDM({
          conversationId: input.conversationId,
          recipientId: input.senderIdentifier,
          message: input.text,
          userId: input.userId,
          providerAccountId: input.providerAccountId,
          choice: input.choice,
        });
        if (!response.success) {
          providerCallStarted = response.deliveryAttempted === true;
          throw Object.assign(new Error(response.error || 'Facebook rejected the post-media reply.'), {
            deliveryAttempted: response.deliveryAttempted === true,
            outcomeUncertain: response.outcomeUnknown === true,
            retryable: response.retryable !== false,
          });
        }
        providerMessageId = response.externalMessageId || null;
      }
      await deliveryOutboxService.completeClaimedAction(claim.action, providerMessageId);
      return { actionId: claim.action.id, providerMessageId };
    } catch (error) {
      const providerError = error as {
        message?: string;
        deliveryAttempted?: boolean;
        outcomeUncertain?: boolean;
        retryable?: boolean;
      };
      const outcomeUncertain = providerCallStarted
        && providerError.deliveryAttempted !== false
        && providerError.outcomeUncertain !== false;
      await deliveryOutboxService.markFailed(
        claim.action.id,
        providerError.message || 'Post-media delivery failed.',
        outcomeUncertain,
        providerError.retryable !== false,
      ).catch(() => undefined);
      throw error;
    }
  }

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (!ctx.agentResult?.replyText) return ctx;

    const { userId, conversationId, channel, phoneNumberId, senderIdentifier, rawMessageId } = ctx.message;
    
    // Format reply text based on channel formatting rules
    const isPublicComment = channel === 'instagram_comment' || channel === 'facebook_comment';
    const externalBookingHandoff = ctx.agentResult.externalBookingHandoff;
    const mediaOnlyResponse = ctx.metadata?.mediaOnlyResponse === true;
    const configuredPlaybookChoice = ctx.metadata?.handoffChoice || ctx.metadata?.playbookDirective?.choice;
    const playbookChoice = !externalBookingHandoff && !isPublicComment && !mediaOnlyResponse
      ? configuredPlaybookChoice
      : undefined;
    // A media playbook directive's `instruction` is platform-owned execution
    // guidance, never customer-visible copy. Media-only responses deliberately
    // withhold the outstanding question/choice until an attachment receives
    // provider acknowledgement below.
    const rawReply = playbookChoice
      ? playbookChoice.fallbackText
      : externalBookingHandoff
      ? renderExternalBookingMessage(externalBookingHandoff, channel, !isPublicComment)
      : ctx.agentResult.replyText;
    // The owner controller renders once after verification. In particular,
    // formatting here stripped Web Markdown and double-converted WhatsApp.
    const internalOwnerPreview = ['advisory', 'preview'].includes(ctx.message.metadata?.executionMode || '')
      && ctx.message.metadata?.conversationKind === 'owner_support';
    let replyText = internalOwnerPreview ? rawReply : formatMessageForChannel(rawReply, channel);
    ctx.agentResult.replyText = replyText;

    if (ctx.message.metadata?.dryRun === true) {
      ctx.metadata = { ...ctx.metadata, deliveryDeferred: true, deliveryStatus: 'simulated', simulated: true };
      return ctx;
    }

    if (socialDraftChannel(channel) && !await automaticSupportReplyAllowed(userId, channel,
      phoneNumberId || ctx.message.metadata?.providerAccountId)) {
      await this.draftReply(ctx, replyText);
      return ctx;
    }

    // Email owns a separate threaded sender and ledger today. Returning a draft
    // here prevents the former phantom "sent" record; InboundEmailService reads
    // the canonical decision outcome before it invokes the real email adapter.
    if (channel === 'email' || channel === 'web' || channel === 'instagram_comment' || channel === 'facebook_comment') {
      ctx.metadata = {
        ...ctx.metadata,
        deliveryDeferred: true,
        deliveryStatus: 'ready_for_channel_delivery',
        deliveryManifest: {
          text: replyText,
          ...(externalBookingHandoff ? {
            externalBooking: {
              mode: externalBookingHandoff.mode,
              requiresPrivateDelivery: isPublicComment,
              privateText: isPublicComment
                ? renderExternalBookingMessage(externalBookingHandoff, channel.replace('_comment', ''), true)
                : undefined,
            },
          } : {}),
          media: (ctx.verifiedMedia || []).map((media, order) => ({
            assetId: media.assetId,
            evidenceId: media.evidenceId,
            kind: 'image',
            caption: media.caption,
            altText: media.altText,
            order,
          })),
          ...(playbookChoice ? { choices: playbookChoice } : {}),
        },
      };
      return ctx;
    }

    if (!rawMessageId && !ctx.message.messageId) {
      throw new Error('A stable inbound message identifier is required for idempotent delivery.');
    }

    if (ctx.approvedDocument && channel === 'whatsapp'
      && (ctx.metadata?.playbookDirective?.readOnlyInformation === true
        || (ctx.metadata?.playbookDirective?.capability?.name === 'asset.deliver'
          && ctx.metadata.playbookDirective.documentService === ctx.approvedDocument.service))) {
      const { supportDocumentDelivery } = await import('../../../supportDocuments/SupportDocumentDelivery.js');
      const outcome = await supportDocumentDelivery.deliver({ document: ctx.approvedDocument, userId, conversationId,
        recipient: senderIdentifier, caption: replyText, phoneNumberId, inboundProviderMessageId: rawMessageId, inboundMessageId: ctx.message.messageId });
      ctx.metadata = { ...ctx.metadata, documentDelivery: outcome };
      if (outcome.status === 'drafted') {
        ctx.metadata = { ...ctx.metadata, deliveryStatus: 'drafted', deliveryActionId: outcome.actionId };
        return ctx;
      }
      if (outcome.status !== 'sent') {
        replyText = outcome.status === 'uncertain'
          ? 'I couldn’t confirm whether the document was delivered, so I haven’t sent it again.'
          : unavailableBrochureReply(ctx.nlu?.semanticRequest?.pricingRequested === true);
        ctx.agentResult.replyText = replyText;
        // A late ownership change or uncertain provider result is not permission
        // for another automated message. Leave an honest blocked audit, not a
        // phantom successful reply or a duplicate attachment.
        ctx.metadata.deliveryStatus = outcome.status;
        throw new PipelineHalt('The requested document delivery was not confirmed.', ctx, 'blocked');
      }
      ctx.metadata = { ...ctx.metadata, deliveryStatus: 'sent', deliveryActionId: outcome.actionId,
        externalMessageId: outcome.providerMessageId, sentMessageIds: outcome.providerMessageId ? [outcome.providerMessageId] : [] };
      return ctx;
    }

    logger.info({ conversationId, channel }, '[DeliveryStage] Delivering reply to customer');

    if (
      ctx.message.metadata?.voiceReplyRequested === true && !playbookChoice
      && (channel === 'whatsapp' || channel === 'instagram' || channel === 'facebook')
    ) {
      const { outreachVoiceReplyDeliveryService } = await import('../../../OutreachVoiceReplyDeliveryService.js');
      const voiceResult = await outreachVoiceReplyDeliveryService.deliver({
        userId,
        conversationId,
        channel,
        senderIdentifier: senderIdentifier || '',
        phoneNumberId: phoneNumberId || undefined,
        rawMessageId: rawMessageId || undefined,
        inboundMessageId: ctx.message.messageId,
        replyText,
        playbookRunId: ctx.metadata?.playbookDirective?.runId || undefined,
        playbookNodeId: ctx.metadata?.playbookDirective?.nodeId,
        providerAccountId: typeof ctx.message.metadata?.providerAccountId === 'string'
          ? ctx.message.metadata.providerAccountId
          : undefined,
      });
      ctx.metadata = {
        ...ctx.metadata,
        externalMessageId: voiceResult.externalMessageId,
        sentMessageIds: voiceResult.externalMessageId ? [voiceResult.externalMessageId] : [],
        deliveryActionId: voiceResult.deliveryActionId,
        voiceReplyDelivered: voiceResult.sentAsVoice,
        voiceFallbackReason: voiceResult.fallbackReason,
        deliveryStatus: voiceResult.drafted ? 'drafted' : 'sent',
      };
      if (voiceResult.persistedNew) {
        await db.execute(sql`
          UPDATE outreach_conversations
          SET last_message_at = NOW(),
              last_message_by = 'user',
              last_message_preview = ${replyText.substring(0, 200)},
              total_messages = COALESCE(total_messages, 0) + 1,
              unread_count = 0,
              updated_at = NOW()
          WHERE id = ${conversationId}
            AND user_id = ${userId}
        `);
      }
      return ctx;
    }

    // Chat channels split into multiple messages if there are double newlines
    const cohesiveKnowledgeReply = ['verified_natural_knowledge_answer', 'verbatim_published_evidence']
      .includes(ctx.agentResult?.answerVerification?.reason || '') && replyText.length <= 4000 && !replyText.includes('|||');
    const messagesToSend = playbookChoice || cohesiveKnowledgeReply
      ? [replyText]
      : externalBookingHandoff && channel === 'whatsapp'
      ? [replyText]
      : (channel === 'whatsapp' || channel === 'instagram' || channel === 'facebook')
      ? splitMessageIntoParts(replyText)
      : [replyText];

    let externalMessageId: string | null = null;
    const sentMessageIds: string[] = [];
    let drafted = false;

    for (let i = 0; i < messagesToSend.length; i++) {
      const partText = messagesToSend[i];
      const partChoice = playbookChoice && i === messagesToSend.length - 1 ? playbookChoice : undefined;
      
      // Delay between parts to mimic human typing order and speed (500ms)
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const claim = await deliveryOutboxService.claim({
        userId,
        conversationId,
        channel,
        inboundProviderMessageId: rawMessageId,
        inboundMessageId: ctx.message.messageId,
        playbookRunId: ctx.metadata?.playbookDirective?.runId || undefined,
        playbookNodeId: ctx.metadata?.playbookDirective?.nodeId,
        responseVersion: 1,
        partIndex: i,
      }, {
        text: partText,
        recipient: senderIdentifier || '',
        phoneNumberId: phoneNumberId || null,
        replyToProviderMessageId: i === 0 ? supportTurnProviderReplyId(rawMessageId) || null : null,
        ...(partChoice ? { choice: partChoice } : {}),
        metadata: {
          dispatchKind: partChoice ? 'pipeline_choice' : 'pipeline_message',
          ...(ctx.metadata?.suppressAssistantFollowUp === true ? { suppressAssistantFollowUp: true } : {}),
          partIndex: i,
          totalParts: messagesToSend.length,
          ...(typeof ctx.message.metadata?.providerAccountId === 'string'
            ? { providerAccountId: ctx.message.metadata.providerAccountId }
            : {}),
        },
      });

      if (claim.state === 'uncertain') {
        throw new Error(`Delivery outcome is uncertain for action ${claim.action.id}; automatic resend was suppressed.`);
      }
      if (claim.state === 'drafted' || (claim.state === 'claimed' && await deliveryOutboxService.holdIfDisabled(claim.action))) {
        drafted = true;
        ctx.metadata = { ...ctx.metadata, deliveryActionId: claim.action.id, deliveryStatus: 'drafted' };
        continue;
      }

      let partExternalId: string | null = claim.action.providerMessageId || null;
      if (claim.state === 'claimed') {
        let providerCallStarted = false;
        try {
          providerCallStarted = true;
          if (channel === 'whatsapp') {
            const sendResult = externalBookingHandoff && i === 0
              && process.env.SUPPORT_NATIVE_BOOKING_CTA_ENABLED !== 'false'
              ? await whatsappApiService.sendCtaUrl({
                userId,
                phoneNumberId: phoneNumberId || undefined,
                to: senderIdentifier || '',
                text: partText,
                url: externalBookingHandoff.url,
                title: externalBookingHandoff.title || 'Book now',
                contextMessageId: supportTurnProviderReplyId(rawMessageId),
                allowTextFallback: true,
              })
              : partChoice
              ? await whatsappApiService.sendChoice({
                userId,
                phoneNumberId: phoneNumberId || undefined,
                to: senderIdentifier || '',
                text: partText,
                choice: partChoice,
                contextMessageId: i === 0 ? supportTurnProviderReplyId(rawMessageId) : undefined,
              })
              : await whatsappApiService.sendText({
              userId,
              phoneNumberId: phoneNumberId || undefined,
              to: senderIdentifier || '',
              text: partText,
              contextMessageId: i === 0 ? supportTurnProviderReplyId(rawMessageId) : undefined,
              });
            partExternalId = sendResult.messages?.[0]?.id || null;
          } else if (channel === 'instagram') {
            const { sendInstagramDM } = await import('../../../instagramService.js');
            const sendResult = await sendInstagramDM({
              recipientId: senderIdentifier || '',
              message: partText,
              userId,
              conversationId,
              messageId: 0,
              providerAccountId: typeof ctx.message.metadata?.providerAccountId === 'string'
                ? ctx.message.metadata.providerAccountId
                : undefined,
              choice: partChoice,
            });
            if (!sendResult.success) {
              providerCallStarted = sendResult.deliveryAttempted === true;
              throw Object.assign(new Error(sendResult.error || 'Instagram rejected the reply.'), {
                deliveryAttempted: sendResult.deliveryAttempted === true,
                outcomeUncertain: sendResult.outcomeUnknown === true,
                retryable: sendResult.retryable !== false,
              });
            }
            partExternalId = sendResult.externalMessageId || null;
          } else if (channel === 'facebook') {
            const { sendFacebookDM } = await import('../../../FacebookMessengerService.js');
            const sendResult = await sendFacebookDM({
              conversationId,
              recipientId: senderIdentifier || '',
              message: partText,
              userId,
              providerAccountId: typeof ctx.message.metadata?.providerAccountId === 'string'
                ? ctx.message.metadata.providerAccountId
                : undefined,
              choice: partChoice,
              ...(externalBookingHandoff && i === 0
                && process.env.SUPPORT_NATIVE_BOOKING_CTA_ENABLED !== 'false'
                ? { webUrlAction: { title: externalBookingHandoff.title || 'Book now', url: externalBookingHandoff.url } }
                : {}),
            });
            if (!sendResult.success) {
              providerCallStarted = sendResult.deliveryAttempted === true;
              throw Object.assign(new Error(sendResult.error || 'Facebook rejected the reply.'), {
                deliveryAttempted: sendResult.deliveryAttempted === true,
                outcomeUncertain: sendResult.outcomeUnknown === true,
                retryable: sendResult.retryable !== false,
              });
            }
            partExternalId = sendResult.externalMessageId || null;
          } else {
            providerCallStarted = false;
            throw new Error(`No production delivery adapter is registered for ${channel}.`);
          }
          // Commit the provider outcome, outbound ledger row, and conversation
          // counters atomically. A crash after the provider accepts the send
          // must not leave a truthful "sent" action without message history.
          await deliveryOutboxService.completeClaimedAction(
            claim.action,
            partExternalId,
          );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          const message = err?.message || 'Unknown delivery API error';
          const outcomeUncertain = providerCallStarted
            && err?.deliveryAttempted !== false
            && err?.outcomeUncertain !== false;
          await deliveryOutboxService.markFailed(
            claim.action.id,
            message,
            outcomeUncertain,
            err?.retryable !== false,
          ).catch(() => undefined);
          ctx.metadata = {
            ...ctx.metadata,
            deliveryActionId: claim.action.id,
            deliveryStatus: outcomeUncertain ? 'uncertain' : 'failed_retry_scheduled',
          };
          logger.error({ err, channel, partIndex: i, deliveryActionId: claim.action.id }, '[DeliveryStage] Provider delivery failed');
          throw new Error(outcomeUncertain
            ? `Delivery outcome is uncertain: ${message}`
            : `Delivery failed: ${message}`);
        }
      }

      if (partExternalId) {
        sentMessageIds.push(partExternalId);
        if (i === messagesToSend.length - 1) {
          externalMessageId = partExternalId;
        }
      }

      // completeClaimedAction owns the atomic provider-result, message-ledger,
      // and conversation-counter commit. Replays load the same already-sent
      // outbox action, so writing the message a second time here is both
      // redundant and invalid against the partial unique index.
      ctx.metadata = { ...ctx.metadata, deliveryActionId: claim.action.id };
    }

    if (!ctx.metadata) ctx.metadata = {};
    ctx.metadata.externalMessageId = externalMessageId;
    ctx.metadata.sentMessageIds = sentMessageIds;
    ctx.metadata.deliveryStatus = drafted ? 'drafted' : 'sent';
    if (drafted) return ctx;

    if (ctx.verifiedMedia?.length && (channel === 'whatsapp' || channel === 'instagram' || channel === 'facebook')) {
      const { supportMediaDeliveryService } = await import('../../../supportMedia/SupportMediaDeliveryService.js');
      const mediaOutcome = await supportMediaDeliveryService.deliverDirect({
        userId,
        conversationId,
        channel,
        recipient: senderIdentifier || '',
        phoneNumberId: phoneNumberId || undefined,
        providerAccountId: typeof ctx.message.metadata?.providerAccountId === 'string'
          ? ctx.message.metadata.providerAccountId
          : undefined,
        inboundProviderMessageId: rawMessageId,
        inboundMessageId: ctx.message.messageId,
        decisionAuditId: Number(ctx.metadata?.auditLogId || 0) || undefined,
        media: ctx.verifiedMedia,
      });
      ctx.metadata.mediaDelivery = mediaOutcome;
      ctx.metadata.deliveryStatus = mediaOutcome.status;
      ctx.metadata.mediaRequirementSatisfied = ctx.agentResult.mediaDecision?.intent !== 'explicit' || mediaOutcome.sent > 0;
      ctx.agentResult.mediaDeliverySucceeded = mediaOutcome.sent > 0;

      if (mediaOnlyResponse) {
        const providerAccountId = typeof ctx.message.metadata?.providerAccountId === 'string'
          ? ctx.message.metadata.providerAccountId
          : undefined;
        const resumeQuestion = typeof ctx.metadata?.playbookDirective?.resumeQuestion === 'string'
          ? ctx.metadata.playbookDirective.resumeQuestion.trim()
          : '';
        if (mediaOutcome.sent > 0) {
          const resumeText = configuredPlaybookChoice?.fallbackText || resumeQuestion;
          if (resumeText) {
            const followUp = await this.deliverPostMediaText({
              userId,
              conversationId,
              channel,
              senderIdentifier: senderIdentifier || '',
              phoneNumberId: phoneNumberId || undefined,
              providerAccountId,
              rawMessageId,
              inboundMessageId: ctx.message.messageId,
              playbookRunId: ctx.metadata?.playbookDirective?.runId || undefined,
              playbookNodeId: ctx.metadata?.playbookDirective?.nodeId,
              text: formatMessageForChannel(resumeText, channel),
              outcome: 'resume',
              choice: configuredPlaybookChoice,
            });
            ctx.metadata.postMediaDeliveryActionId = followUp.actionId;
            if (followUp.drafted) ctx.metadata.deliveryStatus = 'drafted';
            if (followUp.providerMessageId) sentMessageIds.push(followUp.providerMessageId);
          }
        } else if (ctx.agentResult.mediaDecision?.intent === 'explicit') {
          const failureText = formatMessageForChannel(
            'I found matching images, but this channel could not attach them right now. Please try again later or use another connected channel.',
            channel,
          );
          const followUp = await this.deliverPostMediaText({
            userId,
            conversationId,
            channel,
            senderIdentifier: senderIdentifier || '',
            phoneNumberId: phoneNumberId || undefined,
            providerAccountId,
            rawMessageId,
            inboundMessageId: ctx.message.messageId,
            playbookRunId: ctx.metadata?.playbookDirective?.runId || undefined,
            playbookNodeId: ctx.metadata?.playbookDirective?.nodeId,
            text: failureText,
            outcome: 'failure',
          });
          ctx.metadata.postMediaDeliveryActionId = followUp.actionId;
            if (followUp.drafted) ctx.metadata.deliveryStatus = 'drafted';
          ctx.metadata.mediaFailureNoticeSent = !followUp.drafted;
          if (followUp.providerMessageId) sentMessageIds.push(followUp.providerMessageId);
        }
      }
    }
    if (ctx.agentResult.mediaDeliveryAssertionRequired && !ctx.verifiedMedia?.length) {
      ctx.agentResult.mediaDeliverySucceeded = false;
    }

    return ctx;
  }
}
