import { Job } from 'bullmq';
import { logger } from '../../utils/logger.js';
import { db } from '../../models/db.js';
import { sql } from 'drizzle-orm';
import { currentSupportTurn, runSupportConversationJob, supportConversationTurnsEnabled } from '../../services/agents/orchestration/SupportConversationTurn.js';

export async function processWhatsAppWebhook(job: Job): Promise<Record<string, unknown>> {
  if (!currentSupportTurn() && supportConversationTurnsEnabled('whatsapp')) {
    return runSupportConversationJob('process_whatsapp_webhook', job.data,
      data => processWhatsAppWebhook({ ...job, data } as Job));
  }
  const {
    conversationId,
    userId,
    phoneNumberId,
    inboundText,
    messageId,
    inboundMessageId,
    voiceReplyRequested,
    privacyPreprotected,
  } = job.data;
  
  try {
    logger.info({ jobId: job.id, conversationId, userId }, '[WhatsAppProcessor] Processing inbound WhatsApp message');

    // Fetch conversation + lead details (also gives us the recipient phone)
    const convLeadResult = await db.execute(sql`
      SELECT oc.external_thread_id AS phone, oc.lead_id AS lead_id, l.name AS lead_name, l.company AS lead_company
      FROM outreach_conversations oc
      LEFT JOIN leads l ON l.id = oc.lead_id
        AND l.user_id = oc.user_id
      WHERE oc.id = ${conversationId}
        AND oc.user_id = ${userId}
    `);

    if (convLeadResult.rows.length === 0) {
      throw new Error('Conversation not found before AI reply could be generated.');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convRow = convLeadResult.rows[0] as any;
    const recipientPhone = convRow.phone;

    const { channelGateway } = await import('../../services/agents/pipeline/ChannelGateway.js');
    const pipelineMetadata = {
      ...(voiceReplyRequested === true
        ? { voiceReplyRequested: true, inboundAttachmentKind: 'voice' }
        : {}),
      ...(privacyPreprotected ? { privacyPreprotected } : {}),
    };
    const pipelineResult = await channelGateway.process({
      userId,
      conversationId,
      channel: 'whatsapp',
      senderIdentifier: recipientPhone,
      inboundText,
      rawMessageId: messageId || undefined,
      ...(inboundMessageId ? { messageId: inboundMessageId } : {}),
      phoneNumberId: phoneNumberId || undefined,
      leadId: convRow.lead_id ?? null,
      leadName: convRow.lead_name ?? null,
      leadCompany: convRow.lead_company ?? null,
      ...(Object.keys(pipelineMetadata).length > 0 ? { metadata: pipelineMetadata } : {}),
    });

    if (!pipelineResult.success) {
      // An unassigned account or a disabled assistant runtime is a configured
      // state, not a transient failure: nothing was generated or sent, and a
      // retry would only repeat the same routing decision.
      if (pipelineResult.method === 'no_op' && pipelineResult.context?.metadata?.assistantRoutingBlocked === true) {
        logger.warn({ jobId: job.id, conversationId, userId, reason: pipelineResult.error },
          '[WhatsAppProcessor] No automatic reply: assistant routing blocked');
        return { success: true, method: 'no_reply', note: 'assistant_routing_blocked', messageId: null, sentiment: pipelineResult.sentiment };
      }
      const deliveryActionId = Number(pipelineResult.context?.metadata?.deliveryActionId || 0);
      const deliveryStatus = String(pipelineResult.context?.metadata?.deliveryStatus || '');
      // The canonical outbox already owns provider retries. Re-running the
      // entire AI pipeline here would regenerate a potentially different
      // answer, create duplicate audits, and still target the same outbox key.
      // Acknowledge the inbound job once a durable delivery action exists;
      // non-delivery failures (privacy, policy, persistence, etc.) still fail
      // closed so BullMQ can retry or alert them.
      if (deliveryActionId > 0 && ['failed_retry_scheduled', 'uncertain'].includes(deliveryStatus)) {
        logger.warn({
          jobId: job.id,
          conversationId,
          userId,
          deliveryActionId,
          deliveryStatus,
        }, '[WhatsAppProcessor] Provider delivery deferred to the durable outbox');
        return {
          success: true,
          method: 'delivery_pending',
          deliveryStatus,
          messageId: null,
          sentiment: pipelineResult.sentiment,
        };
      }
      throw new Error(pipelineResult.error || 'Pipeline execution failed');
    }

    // Map pipeline outcome to match previous webhook processor return structure
    let method = pipelineResult.method as string;
    if (method === 'auto_sent') {
      method = 'ai_reply';
    }

    const sentMessageId = pipelineResult.messageId || null;

    return {
      success: true,
      method,
      messageId: sentMessageId,
      sentiment: pipelineResult.sentiment,
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.error({ err, jobId: job.id }, '[WhatsAppProcessor] AI Worker Failed to deliver WhatsApp Response');
    throw err;
  }
}
