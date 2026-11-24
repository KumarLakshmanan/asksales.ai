import type { ManualEnrollment } from '../../../shared/campaignManualFollowUps.js';
import { followUpSettingsRevision as manualChecksum } from '../../utils/followUpSettingsRevision.js';
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import * as messages from "../../models/outreachConversations/functions.js";
import { withBusinessScope } from "../../tenancy/businessContext.js";
import { jobDispatcher } from "../../queues/JobDispatcher.js";
import { activateSocialFollowUpForAnchor, parseUtcDatabaseTimestamp } from "../socialFollowUpService.js";
import {
  getCreationRecipients,
  getCreationTemplates,
  validateCreationTemplate,
  creationTemplateHash,
} from "./CreationService.js";
import { logger } from "../../utils/logger.js";
import { sanitizeEmailHtml } from "../../utils/contentTemplateRendering.js";
import type { InboxChannel } from "../../../shared/outreachInbox.js";
import type { OutreachFollowUp } from "../../../shared/outreachCompose.js";
import { assertApprovedTemplateDelivery, templateRecipientFromLead } from '../content/ApprovedTemplateResolver.js';
async function assertManualEnrollment(userId:number,enrollment:ManualEnrollment) {
  return (await import('./CampaignManualFollowUpService.js')).assertManualEnrollment(userId,enrollment);
}

interface CreationMetadata {
  version: number;
  delivery: Record<string, unknown> & {
    userId: number;
    channel: InboxChannel;
    leadId: number;
    conversationId: number;
    message: string;
    senderId?: number;
  };
  followUps: OutreachFollowUp[];
  followUpSource?: "channel_settings" | "campaign_manual" | "outreach";
  campaignManual?: ManualEnrollment;
  followUpsActivated?: boolean;
  whatsappOptInConfirmed?: boolean;
}

export async function checkCreationDelivery(
  userId: number,
  messageId: number,
  jobData: Record<string, unknown>,
): Promise<{ error: string; cancelled?: boolean } | null> {
  const message = await messages.getOutreachMessageById(messageId);
  if (!message || message.userId !== userId)
    return { error: "This message is unavailable." };
  const provenance = message.metadata as { sourceTemplateId?: unknown; sourceTemplateVersion?: unknown; templateDelivery?: Record<string, unknown>; outreachCreation?: CreationMetadata } | null;
  if (provenance?.sourceTemplateId !== undefined || provenance?.sourceTemplateVersion !== undefined) {
    const snapshot = provenance.templateDelivery ?? provenance.outreachCreation?.delivery;
    if (!snapshot || snapshot.userId !== userId || snapshot.conversationId !== message.conversationId ||
        snapshot.message !== message.content || snapshot.subject !== (message.subject || undefined) ||
        Object.keys(snapshot).some(field => JSON.stringify(snapshot[field]) !== JSON.stringify(jobData[field]))) {
      return { error: 'The queued message or recipient no longer matches the approved template send.' };
    }
    const conversation = await messages.getOutreachConversationById(message.conversationId);
    if (!conversation || conversation.userId !== userId || conversation.leadId !== snapshot.leadId || conversation.channel !== snapshot.channel)
      return { error: 'The template conversation is unavailable or changed.' };
    const { LeadModel } = await import('../../models/leads/functions.js');
    const lead = conversation.leadId ? await LeadModel.findByIdForUser(conversation.leadId, userId) : null;
    try {
      await assertApprovedTemplateDelivery(userId, conversation.channel === 'gmail' ? 'email' : conversation.channel,
        { ...provenance, content: message.content, subject: message.subject, htmlContent: message.htmlContent },
        templateRecipientFromLead(lead, conversation.channel));
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'The saved template could not be verified.' };
    }
  }
  const creation = (
    message.metadata as { outreachCreation?: CreationMetadata } | null
  )?.outreachCreation;
  if (creation?.version !== 1) return null;
  if (creation.followUpSource === 'outreach' && message.messageKind === 'follow_up') {
    const origin = await messages.getOutreachMessageById(message.followUpOriginMessageId!);
    const original = (origin?.metadata as { outreachCreation?: CreationMetadata } | null)?.outreachCreation;
    const step = original?.followUps?.[(message.followUpStep || 0) - 1];
    if (!origin || origin.userId !== userId || origin.conversationId !== message.conversationId
      || origin.providerAccountId !== message.providerAccountId || original?.followUpSource !== 'outreach'
      || !step || original.delivery.leadId !== creation.delivery.leadId || original.delivery.channel !== creation.delivery.channel
      || step.message !== message.content || (step.subject || original.delivery.subject || '') !== (message.subject || '')
      || (step.htmlContent || '') !== (message.htmlContent || '')
      || ['templateName', 'templateLanguage', 'templateComponents', 'templateDefinitionHash'].some(field =>
        manualChecksum(step[field as keyof OutreachFollowUp]) !== manualChecksum(creation.delivery[field])))
      return { error: 'This follow-up no longer matches the reviewed outreach, recipient, account or message.' };
  }
  if (creation.followUpSource === 'campaign_manual' || creation.campaignManual) {
    try {
      if (!creation.campaignManual) throw new Error('The manual campaign enrollment is missing.');
      await assertManualEnrollment(userId,creation.campaignManual);
      if (creation.delivery.channel !== creation.campaignManual.channel || creation.delivery.leadId !== creation.campaignManual.leadId) throw new Error('The manual campaign channel or lead changed.');
      if (message.messageKind === 'follow_up') {
        const origin = await messages.getOutreachMessageById(message.followUpOriginMessageId!);
        const original = (origin?.metadata as {outreachCreation?: CreationMetadata})?.outreachCreation;
        const step = original?.campaignManual?.steps[(message.followUpStep || 0)-1];
        if (!origin || origin.conversationId !== message.conversationId || !step || manualChecksum(original?.campaignManual)!==manualChecksum(creation.campaignManual)
          || step.message !== message.content || (step.subject || original?.delivery.subject || '') !== (message.subject || '')
          || (step.htmlContent || '') !== (message.htmlContent || '')
          || jobData.campaignManualReviewId !== creation.campaignManual.reviewId)
          throw new Error('This pending follow-up no longer matches its exact campaign, origin, and reviewed content.');
      } else if (manualChecksum(creation.followUps)!==manualChecksum(creation.campaignManual.steps)) throw new Error('The manual sequence changed after review.');
    } catch (error) { return {error:error instanceof Error?error.message:'Review the manual campaign sequence.'}; }
  }
  const delivery = creation.delivery;
  const reviewedFields = [
    "recipientEmail",
    "phone",
    "handle",
    "facebookId",
    "subject",
    "templateName",
    "templateLanguage",
    "templateDefinitionHash",
  ];
  if (
    reviewedFields.some((field) => delivery[field] !== jobData[field]) ||
    JSON.stringify(delivery.templateComponents) !==
      JSON.stringify(jobData.templateComponents)
  )
    return {
      error:
        "The queued recipient or template no longer matches the reviewed send intent.",
    };
  if (
    delivery.channel !== jobData.channel ||
    delivery.leadId !== jobData.leadId ||
    delivery.conversationId !== jobData.conversationId ||
    message.content !== jobData.message ||
    delivery.senderId !== jobData.senderId
  )
    return {
      error: "The queued message no longer matches its reviewed send intent.",
    };
  if (message.messageKind === "follow_up") {
    const state = (
      await db.execute(sql`
      SELECT origin.follow_up_cancelled_at, c.automation_mode, c.session_ended_at,
        EXISTS (SELECT 1 FROM outreach_messages reply WHERE reply.conversation_id=c.id AND reply.direction='inbound' AND reply.created_at > COALESCE(origin.sent_at,origin.created_at)) AS has_reply
      FROM outreach_messages origin JOIN outreach_conversations c ON c.id=origin.conversation_id
      WHERE origin.id=${message.followUpOriginMessageId} AND origin.user_id=${userId} AND origin.status IN ('sent','delivered','read')
    `)
    ).rows[0];
    if (
      !state ||
      state.follow_up_cancelled_at ||
      state.has_reply ||
      state.session_ended_at ||
      [
        "human_owned",
        "approval_pending",
        "resolved",
        "closed",
        "opted_out",
      ].includes(String(state.automation_mode))
    )
      return {
        error:
          "Follow-up stopped because the contact replied or conversation automation is paused.",
        cancelled: true,
      };
    if (!creation.campaignManual && creation.followUpSource !== 'channel_settings' && creation.followUpSource !== 'outreach')
      return {error:'CAMPAIGN_MANUAL_REVIEW_REQUIRED: This legacy manual follow-up has no reviewed campaign sequence. Owner review is required.'};
  }
  const checked = await getCreationRecipients(
    userId,
    delivery.channel,
    {
      providerAccountId: message.providerAccountId || undefined,
      senderId: delivery.senderId,
    },
    { ids: [delivery.leadId] },
  );
  const recipient = checked.recipients[0];
  if (!recipient?.eligible)
    return {
      error:
        recipient?.reason || "This contact is no longer eligible for outreach.",
    };
  const queuedRecipient =
    delivery.channel === "email"
      ? jobData.recipientEmail
      : delivery.channel === "whatsapp" || delivery.channel === "sms"
        ? jobData.phone
        : delivery.channel === "instagram"
          ? jobData.handle
          : jobData.facebookId;
  if (recipient.recipient !== queuedRecipient)
    return {
      error:
        "The recipient changed after review. Create a new message with the current contact details.",
    };
  if (delivery.channel === "whatsapp") {
    if (creation.whatsappOptInConfirmed !== true)
      return { error: "Recipient consent was not confirmed for this message." };
    if (jobData.templateName) {
      const templates = await getCreationTemplates(
        userId,
        message.providerAccountId!,
      );
      const template = templates.find(
        (item) =>
          item.name === jobData.templateName &&
          item.language === jobData.templateLanguage,
      );
      if (!template)
        return {
          error:
            "The selected WhatsApp template is no longer approved for this account.",
        };
      try {
        if (
          creationTemplateHash(template) !==
          creation.delivery.templateDefinitionHash
        )
          return {
            error:
              "The WhatsApp template changed after review. Reload and review the current template before sending.",
          };
        if (
          validateCreationTemplate(
            template,
            jobData.templateComponents,
          ).trim() !== message.content.trim()
        )
          return {
            error:
              "The queued WhatsApp message does not match the current template.",
          };
      } catch (error) {
        return { error: (error as Error).message };
      }
    } else if (recipient.requiresTemplate)
      return {
        error:
          "An approved WhatsApp template is required because the reply window has closed.",
      };
  }
  return null;
}

/** Repeated activation reuses durable message IDs and BullMQ IDs; it never repeats a provider send. */
export async function activateCreationFollowUps(
  userId: number,
  originMessageId: number,
): Promise<boolean> {
  const origin = await messages.getOutreachMessageById(originMessageId);
  if (!origin || origin.userId !== userId) return false;
  const creation = (
    origin.metadata as { outreachCreation?: CreationMetadata } | null
  )?.outreachCreation;
  if (creation?.version !== 1) return false;
  if (creation.followUps?.length && creation.followUpSource !== 'channel_settings' && creation.followUpSource !== 'outreach' && !creation.campaignManual) {
    // Inline/custom legacy sequences have no exact campaign revision. Do not
    // mint a new queue/assistant receipt for them during automatic recovery.
    await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachCreation,campaignManualReviewRequired}','true'::jsonb),updated_at=NOW()
      WHERE id=${origin.id} AND user_id=${userId}`);
    return true;
  }
  if (creation.followUpSource === "channel_settings") {
    // Email/SMS are picked up by the configured cron. Social channels retain
    // their existing conversation schedule, including recovery on worker retry.
    if (!creation.followUpsActivated && !origin.followUpCancelledAt && ["sent", "delivered", "read"].includes(origin.status) && origin.sentAt
      && ["instagram", "facebook", "whatsapp"].includes(creation.delivery.channel)) {
      await activateSocialFollowUpForAnchor(origin.id);
      await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachCreation,followUpsActivated}','true'::jsonb),updated_at=NOW() WHERE id=${origin.id} AND user_id=${userId}`);
    }
    return true;
  }
  if (
    !creation.followUps?.length ||
    creation.followUpsActivated ||
    origin.followUpCancelledAt
  )
    return true;
  if (!["sent", "delivered", "read"].includes(origin.status) || !origin.sentAt)
    return true;
  if (creation.campaignManual) await assertManualEnrollment(userId,creation.campaignManual);
  const sentAt = parseUtcDatabaseTimestamp(origin.sentAt);
  // The campaign card's receipt counts the initial batch. Later follow-ups have
  // their own messages and must not inflate that receipt's completion totals.
  const followUpDelivery = { ...creation.delivery };
  delete followUpDelivery.widgetId;
  delete followUpDelivery.expectedWidgetJobCount;
  for (const [index, step] of creation.followUps.entries()) {
    const dueAt = new Date(sentAt.getTime() + step.delayMinutes * 60_000);
    const delivery = {
      ...followUpDelivery,
      message: step.message,
      subject: step.subject || creation.delivery.subject,
      templateName: step.templateName,
      templateLanguage: step.templateLanguage,
      templateComponents: step.templateComponents,
      templateDefinitionHash: step.templateDefinitionHash,
      ...(creation.campaignManual ? {campaignManualReviewId:creation.campaignManual.reviewId} : {}),
    };
    const followUp = await messages.createOutreachMessage({
      conversationId: origin.conversationId,
      userId,
      direction: "outbound",
      content: step.message,
      subject:
        typeof delivery.subject === "string" ? delivery.subject : undefined,
      htmlContent: step.htmlContent
        ? sanitizeEmailHtml(step.htmlContent)
        : undefined,
      status: "pending",
      isAutomatic: true,
      messageKind: "follow_up",
      followUpOriginMessageId: origin.id,
      followUpStep: index + 1,
      sequenceStep: index + 1,
      // A follow-up is tracked under the outreach it follows.
      ...(origin.batchId ? { batchId: origin.batchId } : {}),
      ...(step.templateName ? { templateName: step.templateName, templateLanguage: step.templateLanguage } : {}),
      providerAccountId: origin.providerAccountId,
      confirmedAt: origin.confirmedAt,
      confirmationExpiresAt: new Date(dueAt.getTime() + 60 * 60_000),
      providerCallState: "not_started",
      idempotencyKey: `outreach-creation-follow-up:${userId}:${origin.id}:${index + 1}`,
      metadata: {
        scheduledAt: dueAt.toISOString(),
        senderId: creation.delivery.senderId,
        ...((origin.metadata as {outreachQueueOrigin?:unknown}|null)?.outreachQueueOrigin ? {
          outreachQueuePolicy:{version:1},outreachQueueOrigin:(origin.metadata as {outreachQueueOrigin:unknown}).outreachQueueOrigin,
        } : {}),
        outreachCreation: {
          version: 1,
          delivery,
          followUps: [],
          ...(creation.campaignManual ? {followUpSource:'campaign_manual',campaignManual:creation.campaignManual} : {followUpSource:'outreach'}),
          whatsappOptInConfirmed: creation.whatsappOptInConfirmed,
        },
      },
    });
    if (followUp.status !== "pending") continue;
    await jobDispatcher.dispatch(
      "send_outreach_message",
      { ...delivery, messageId: followUp.id },
      {
        delay: Math.max(0, dueAt.getTime() - Date.now()),
        jobId: `outreach-send-${followUp.sendIntentId}`,
      },
    );
  }
  await db.execute(
    sql`UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachCreation,followUpsActivated}','true'::jsonb),updated_at=NOW() WHERE id=${origin.id} AND user_id=${userId}`,
  );
  return true;
}

/** Called by the existing cron worker, including when global automatic follow-ups are disabled. */
export async function recoverCreationFollowUps(): Promise<void> {
  // Explicitly re-reviewed scheduled initial sends have a new immutable queue ID.
  // A lost queue acknowledgement remains recoverable without releasing old jobs.
  const requeues=await db.execute(sql`SELECT id,user_id,business_profile_id,send_intent_id,metadata FROM outreach_messages
    WHERE status='pending' AND provider_call_state='not_started' AND manual_review_required=false
      AND metadata->'outreachCreation'->>'campaignManualRequeue'='true' LIMIT 100`);
  for(const row of requeues.rows) {
    try { await withBusinessScope({userId:Number(row.user_id),businessProfileId:Number(row.business_profile_id)},async()=>{
      const creation=row.metadata.outreachCreation;
      await assertManualEnrollment(Number(row.user_id),creation.campaignManual);
      await jobDispatcher.dispatch('send_outreach_message',{...creation.delivery,messageId:Number(row.id)},
        {jobId:`outreach-send-${row.send_intent_id}`,delay:Math.max(0,parseUtcDatabaseTimestamp(row.metadata.scheduledAt||new Date()).getTime()-Date.now())});
      await db.execute(sql`UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachCreation,campaignManualRequeue}','false'::jsonb)
        WHERE id=${row.id} AND send_intent_id=${row.send_intent_id}`);
    }); }catch(error){logger.warn({err:error,messageId:row.id},'[CampaignManual] Reviewed enrollment requeue remains held for recovery');}
  }
  const pending = await db.execute(sql`
    SELECT id,user_id,business_profile_id FROM outreach_messages
    WHERE status IN ('sent','delivered','read') AND direction='outbound' AND message_kind='outreach'
      AND metadata->'outreachCreation'->>'version'='1'
      AND (jsonb_array_length(COALESCE(metadata->'outreachCreation'->'followUps','[]'::jsonb))>0
        OR (metadata->'outreachCreation'->>'followUpSource'='channel_settings'
          AND metadata->'outreachCreation'->'delivery'->>'channel' IN ('instagram','facebook','whatsapp')))
      AND COALESCE(metadata->'outreachCreation'->>'followUpsActivated','false')<>'true'
      AND follow_up_cancelled_at IS NULL ORDER BY id LIMIT 100
  `);
  for (const row of pending.rows) {
    if (!row.business_profile_id) continue;
    try {
      await withBusinessScope(
        {
          userId: Number(row.user_id),
          businessProfileId: Number(row.business_profile_id),
        },
        () => activateCreationFollowUps(Number(row.user_id), Number(row.id)),
      );
    } catch (error) {
      logger.warn(
        { err: error, messageId: row.id },
        "[OutreachCreation] Follow-up activation will retry",
      );
    }
  }
}
