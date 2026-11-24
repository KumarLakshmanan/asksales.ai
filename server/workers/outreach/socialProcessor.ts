import { Job } from 'bullmq';
import { db } from '../../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { currentSupportTurn, runSupportConversationJob, supportConversationTurnsEnabled } from '../../services/agents/orchestration/SupportConversationTurn.js';

export async function processSocialWebhook(job: Job): Promise<Record<string, unknown>> {
  if (!currentSupportTurn() && supportConversationTurnsEnabled(job.data.channel)) {
    return runSupportConversationJob(job.data.channel === 'instagram' ? 'process_instagram_webhook' : 'process_facebook_webhook', job.data,
      data => processSocialWebhook({ ...job, data } as Job));
  }
  const {
    conversationId,
    userId,
    channel, // 'instagram' | 'facebook'
    senderId, // IGSID or PSID
    inboundText,
    messageId: _messageId,
    inboundMessageId,
    providerAccountId,
    voiceReplyRequested,
    privacyPreprotected,
  } = job.data as {
    conversationId: number;
    userId: number;
    channel: 'instagram' | 'facebook';
    senderId: string;
    inboundText: string;
    messageId?: string;
    inboundMessageId?: number;
    providerAccountId?: string;
    voiceReplyRequested?: boolean;
    privacyPreprotected?: { vaultId: number | null; piiTypes: string[]; tokenCount: number };
  };

  try {
    logger.info({ jobId: job.id, conversationId, userId, channel }, '[SocialProcessor] Processing inbound DM');

    // Load conversation + lead details
    const convLeadRes = await db.execute(sql`
      SELECT oc.provider_account_id, oc.channel, oc.lead_id AS lead_id, l.name AS lead_name, l.company AS lead_company
      FROM outreach_conversations oc
      LEFT JOIN leads l ON l.id = oc.lead_id
        AND l.user_id = oc.user_id
      WHERE oc.id = ${conversationId}
        AND oc.user_id = ${userId}
    `);

    if (convLeadRes.rows.length === 0) {
      logger.warn({ conversationId }, '[SocialProcessor] Conversation not found, skipping auto-reply');
      return { success: true, note: 'conversation_not_found' };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convRow = convLeadRes.rows[0] as any;

    if (!providerAccountId || convRow.provider_account_id !== providerAccountId || convRow.channel !== channel) {
      return { success: false, note: 'conversation_account_mismatch' };
    }

    const { channelGateway } = await import('../../services/agents/pipeline/ChannelGateway.js');
    const pipelineResult = await channelGateway.process({
      userId,
      conversationId,
      channel,
      senderIdentifier: senderId,
      inboundText,
      rawMessageId: _messageId || undefined,
      ...(inboundMessageId ? { messageId: inboundMessageId } : {}),
      leadId: convRow.lead_id ?? null,
      leadName: convRow.lead_name ?? null,
      leadCompany: convRow.lead_company ?? null,
      metadata: {
        ...(voiceReplyRequested === true
          ? { voiceReplyRequested: true, inboundAttachmentKind: 'voice' }
          : {}),
        ...(privacyPreprotected ? { privacyPreprotected } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
      },
    });

    if (!pipelineResult.success) {
      // An unassigned account or a disabled assistant runtime is a configured
      // state, not a transient failure: nothing was generated or sent, and a
      // retry would only repeat the same routing decision.
      if (pipelineResult.method === 'no_op' && pipelineResult.context?.metadata?.assistantRoutingBlocked === true) {
        logger.warn({ jobId: job.id, conversationId, userId, reason: pipelineResult.error },
          '[SocialProcessor] No automatic reply: assistant routing blocked');
        return { success: true, method: 'no_reply', note: 'assistant_routing_blocked', sentiment: pipelineResult.sentiment };
      }
      const deliveryActionId = Number(pipelineResult.context?.metadata?.deliveryActionId || 0);
      const deliveryStatus = String(pipelineResult.context?.metadata?.deliveryStatus || '');
      if (deliveryActionId > 0 && ['failed_retry_scheduled', 'uncertain'].includes(deliveryStatus)) {
        return { success: true, method: 'delivery_pending', deliveryStatus, sentiment: pipelineResult.sentiment };
      }
      throw new Error(pipelineResult.error || 'Pipeline execution failed');
    }

    // Map pipeline outcome to match previous webhook processor return structure
    let method = pipelineResult.method as string;
    if (method === 'auto_sent') {
      method = 'ai_reply';
    }

    return {
      success: true,
      method,
      sentiment: pipelineResult.sentiment,
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.error({ err, jobId: job.id }, '[SocialProcessor] AI Worker Failed to deliver Social Response');
    throw err;
  }
}
