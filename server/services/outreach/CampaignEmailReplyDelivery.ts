import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { emailBodyToHtml } from '../../../shared/emailFormatting.js';
import {
  loadCampaignEmailReplyContext,
  type EmailReplyContext,
} from './CampaignEmailReplyService.js';
import { deliveryOutboxService } from '../agents/orchestration/DeliveryOutboxService.js';
import { withoutAssistantContext } from '../assistants/AssistantContext.js';
import { assertCustomerDeliveryReady, CustomerDeliverySetupError, deliverySetupFailure, withCustomerDeliveryReceipt } from '../assistants/CustomerDeliveryGate.js';

interface CampaignReplyReceipt {
  id: number;
  user_id: number;
  lead_id: number;
  lead_email: string;
  smart_reply: string | null;
  reply_context: EmailReplyContext;
  message_id: string | null;
  gmail_thread_id: string | null;
}

/** Revalidate the original campaign/account immediately before every provider attempt.
 * This delivery has no support assistant, brand wrapper, or lead-wide thread fallback. */
export async function sendCampaignEmailReply(
  message: CampaignReplyReceipt,
  customReply?: string,
  deliveryContext?: { actionId: number; conversationId: number },
): Promise<{ success: boolean; error?: string; mediaSent?: number; code?: string; reason?: string; setupUrl?: string }> {
  return withoutAssistantContext(async () => {
    let actionId: number | undefined;
    let providerStarted = false;
    try {
      const context = message.reply_context;
      if (
        String(message.lead_email || '')
          .trim()
          .toLowerCase() !== context.recipientEmail
      )
        throw new Error(
          'The campaign reply recipient changed. Review the original email.',
        );
      const campaign = await loadCampaignEmailReplyContext(
        message.user_id,
        context,
      );
      // Readiness authorizes delivery only; it never supplies support instructions or knowledge.
      const assistantReceipt = await assertCustomerDeliveryReady({ userId: message.user_id, channel: 'email', accountId: context.accountId || '' });
      const manualApproval = Boolean(customReply?.trim()) && !deliveryContext;
      if (
        !manualApproval &&
        (campaign.settings?.replyPolicy?.autoSend !== true ||
          !context.autoSendVerified)
      ) {
        throw new Error('This campaign reply requires human approval.');
      }
      if (
        campaign.lead_id !== message.lead_id ||
        campaign.automation_mode !== 'ai_active' ||
        ['unsubscribed', 'closed'].includes(campaign.conversation_status)
      )
        throw new Error(
          'This campaign conversation is not eligible for automatic delivery.',
        );
      if (
        deliveryContext &&
        deliveryContext.conversationId !== context.conversationId
      )
        throw new Error('Campaign reply delivery conversation changed.');
      const body = manualApproval
        ? customReply!.trim()
        : message.smart_reply || '';
      if (
        !body ||
        (!manualApproval &&
          createHash('sha256').update(body).digest('hex') !== context.draftHash)
      ) {
        throw new Error('Regenerate the campaign reply before sending.');
      }
      const inbound =
        await db.execute(sql`SELECT m.id,m.rfc_message_id FROM outreach_messages m
      JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
      WHERE m.user_id=${message.user_id} AND c.lead_id=${message.lead_id} AND m.direction='inbound'
        AND m.conversation_id=${context.conversationId}
        AND m.metadata->'inboundEmailReceipt'->>'sentMessageId'=${String(message.id)}
        AND NOT EXISTS (SELECT 1 FROM outreach_messages newer WHERE newer.conversation_id=c.id
          AND newer.user_id=c.user_id AND newer.direction='inbound' AND newer.id>m.id) LIMIT 2`);
      if (inbound.rows.length !== 1)
        throw new Error(
          'The campaign reply is superseded or its original inbound email is unresolved.',
        );
      const subject = `Re: ${(campaign.subject || '').replace(/^re:\s*/i, '')}`;
      const claim = await deliveryOutboxService.claim(
        {
          userId: message.user_id,
          conversationId: context.conversationId,
          channel: 'email',
          inboundProviderMessageId: `campaign-email-reply:${message.id}`,
          inboundMessageId: Number(inbound.rows[0].id),
        },
        {
          text: body,
          recipient: message.lead_email,
          subject,
          metadata: {
            dispatchKind: 'campaign_email_reply',
            sentMessageId: message.id,
            emailReplyContext: context,
            providerAccountId: context.accountId,
            campaignId: context.campaignId,
            autoReply: !manualApproval,
            isAiGenerated: !manualApproval,
            customerDeliveryAssistant: assistantReceipt,
          },
        },
      );
      actionId = claim.action.id;
      if (deliveryContext && deliveryContext.actionId !== actionId)
        throw new Error('The campaign delivery action changed.');
      if (claim.state === 'already_sent')
        return { success: true, mediaSent: 0 };
      if (claim.state !== 'claimed')
        return {
          success: false,
          error:
            'Campaign reply delivery is pending review or uncertain; resend suppressed.',
        };
      const savedAssistant = claim.action.payload.metadata?.customerDeliveryAssistant;
      if (!savedAssistant)
        throw new CustomerDeliverySetupError('queued_setup_review_required', 'This campaign reply has no saved assistant delivery review. Review and regenerate it after setup.');
      await assertCustomerDeliveryReady({ userId: message.user_id, channel: 'email', accountId: context.accountId || '', expected: savedAssistant as typeof assistantReceipt });
      if (
        claim.action.payload.text !== body ||
        claim.action.payload.recipient !== message.lead_email ||
        claim.action.conversationId !== context.conversationId
      )
        throw new Error('The saved campaign response or recipient changed.');
      // Recheck ownership, receiving account and opt-in after claiming durable delivery.
      const current = await loadCampaignEmailReplyContext(
        message.user_id,
        context,
      );
      if (
        current.automation_mode !== 'ai_active' ||
        ['unsubscribed', 'closed'].includes(current.conversation_status) ||
        (!manualApproval && current.settings?.replyPolicy?.autoSend !== true)
      )
        throw new Error(
          'Campaign automatic replies were disabled or this conversation changed ownership.',
        );
      if (
        !['gmail', 'resend'].includes(current.sender_type) ||
        (current.sender_type === 'gmail' && !current.credential_id)
      ) {
        throw new Error(
          'The original campaign email provider binding is unresolved.',
        );
      }
      const { resolveOfficialProviderBinding } =
        await import('./ProviderBindingService.js');
      const binding = await resolveOfficialProviderBinding(
        message.user_id,
        'email',
        {
          providerVariant: current.sender_type,
          ...(current.sender_type === 'gmail'
            ? { credentialId: current.credential_id! }
            : { providerAccountId: context.accountId!.split('@')[1] }),
        },
      );
      if (!binding)
        throw new Error(
          'The original campaign email provider is disconnected.',
        );
      const { emailService } = await import('../emailService.js');
      providerStarted = true;
      const result = await withCustomerDeliveryReceipt(assistantReceipt, () => emailService.sendEmailWithUserCredentials(
        message.user_id,
        {
          to: message.lead_email,
          subject,
          html: emailBodyToHtml(body),
          preservePresentation: true,
          text: body,
          leadId: message.lead_id,
          campaignId: context.campaignId,
          inReplyTo:
            inbound.rows[0].rfc_message_id || message.message_id || undefined,
          references: inbound.rows[0].rfc_message_id || undefined,
          threadId:
            message.gmail_thread_id || campaign.external_thread_id || undefined,
          skipConversationLog: true,
          isFollowUp: true,
          idempotencyKey: `campaign-email-reply:${actionId}`,
          expectedFromEmail: context.accountId,
          expectedProviderAccountId: binding.providerAccountId,
          expectedCredentialId: binding.credentialId,
        },
        context.senderId,
      ));
      if (!result.success) {
        if (result.code === 'ASSISTANT_SETUP_REQUIRED') {
          await db.execute(sql`UPDATE support_delivery_outbox SET status='setup_required',next_attempt_at=NULL,lease_expires_at=NULL,
            last_error=${result.error || 'Assistant setup required'},updated_at=NOW() WHERE id=${actionId} AND status='sending'`);
          return { ...result, mediaSent: 0 };
        }
        const uncertain =
          result.outcomeUncertain === true ||
          (result.deliveryAttempted !== false &&
            result.outcomeUncertain !== false);
        await deliveryOutboxService.markFailed(
          actionId,
          result.error || 'Campaign reply rejected',
          uncertain,
          !uncertain && result.retryable === true,
        );
        return {
          success: false,
          error: uncertain
            ? 'Campaign reply delivery is uncertain. Review provider history before retrying.'
            : result.error || 'Campaign reply rejected',
        };
      }
      await deliveryOutboxService.completeClaimedAction(
        claim.action,
        result.providerMessageId || result.messageId || null,
        async (tx: Pick<typeof db, 'execute'>) => {
          await tx.execute(sql`UPDATE sent_messages SET smart_reply_approved=true,smart_reply_sent_at=NOW(),updated_at=NOW()
          WHERE id=${message.id} AND user_id=${message.user_id}`);
        },
      );
      return { success: true, mediaSent: 0 };
    } catch (error) {
      const setup = deliverySetupFailure(error);
      if (setup) {
        if (actionId && !providerStarted) await db.execute(sql`UPDATE support_delivery_outbox SET status='setup_required',next_attempt_at=NULL,lease_expires_at=NULL,
          last_error=${`${setup.code}:${setup.reason}: ${setup.error}`},updated_at=NOW() WHERE id=${actionId} AND status IN ('pending','failed','sending')`);
        return setup;
      }
      if (actionId)
        await deliveryOutboxService.markFailed(
          actionId,
          error instanceof Error ? error.message : 'Campaign reply failed',
          providerStarted,
          false,
        );
      return {
        success: false,
        error: providerStarted
          ? 'Campaign reply delivery is uncertain. Review provider history before retrying.'
          : error instanceof Error
            ? error.message
            : 'Campaign reply could not be verified.',
      };
    }
  });
}
