import type { PipelineStage } from "../PipelineStage.js";
import type { PipelineContext } from "../ChannelGateway.js";
import { db } from "../../../../models/db.js";
import { sql } from "drizzle-orm";
import { logger } from "../../../../utils/logger.js";
import type { ToolOutcome } from "../../BaseOutreachAgent.js";
import { supportEffectLedgerService } from "../../orchestration/SupportEffectLedgerService.js";
import { playbookEngine } from '../../orchestration/PlaybookEngine.js';
import { handoffService } from '../HandoffService.js';
import { supportPreviewStore } from '../../orchestration/SupportPreviewStore.js';
import { permittedHandoffReason } from '../../orchestration/RestrictedHandoffPolicy.js';
import { recordNonHandoffEnquiry } from '../../orchestration/NonHandoffEnquiryService.js';
import { HandoffPolicyStage } from './HandoffPolicyStage.js';
import { hasCustomerHandoffConsent } from '../../orchestration/HandoffConsent.js';
import { checkpointSupportCommit } from '../../orchestration/SupportCommitCheckpoint.js';
import { applySupportCrmStage, supportCrmPipelineContext } from '../../orchestration/SupportCRMPipeline.js';

export function capabilityOutcomeStatus(
  capabilityName: string | undefined,
  toolOutcome: ToolOutcome | undefined,
  capabilityKind?: string,
): ToolOutcome['status'] | 'unavailable' | 'redirected' | undefined {
  // A required tool that produced no typed outcome is never successful. Read
  // context and effect capabilities have no tool outcome by design; their own
  // delivery/effect commit gates remain authoritative.
  if (!toolOutcome) return capabilityKind === 'tool' ? 'failed' : capabilityName ? 'success' : undefined;
  if (capabilityName !== 'availability.check' || toolOutcome.status !== 'success' || !toolOutcome.success) {
    return toolOutcome.status;
  }
  const payload = toolOutcome.result && typeof toolOutcome.result === 'object' && !Array.isArray(toolOutcome.result)
    ? toolOutcome.result as Record<string, unknown>
    : null;
  if (payload?.status === 'external_booking_search_ready') return 'redirected';
  if (payload?.available === false) return 'unavailable';
  if (Array.isArray(payload?.options) && payload.options.length === 0) return 'unavailable';
  return 'success';
}

export class PostProcessingStage implements PipelineStage {
  name = "PostProcessing";

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    // A read-only information answer must not commit an older undelivered
    // transition, including encrypted preview state, or create business effects.
    if (ctx.metadata?.playbookDirective?.readOnlyInformation === true) return ctx;
    if (ctx.message.metadata?.executionMode === 'preview' && ctx.metadata?.deliveryStatus === 'simulated') {
      const directive = ctx.metadata?.playbookDirective;
      if (directive?.capability?.name === 'asset.deliver' && !ctx.approvedDocument) return ctx;
      if (directive) await supportPreviewStore.commit(ctx.message.userId, ctx.message.conversationId, {
        capabilityName: directive.capability?.name,
        capabilityStatus: capabilityOutcomeStatus(directive.capability?.name,
          ctx.agentResult?.toolCallsExecuted?.find(tool => tool.name === directive.requiredAction), directive.capability?.kind),
        groundingStatus: ctx.agentResult?.groundingStatus,
      }, String(ctx.message.rawMessageId || (ctx.message.messageId ? `message:${ctx.message.messageId}` : '')).slice(0, 255));
    }
    if (ctx.message.metadata?.dryRun === true || ctx.message.metadata?.executionMode !== 'customer') return ctx;
    if (ctx.metadata?.suppressBusinessEffects === true) return ctx;
    if (['uncertain', 'failed_retry_scheduled', 'failed', 'pending_approval', 'blocked'].includes(ctx.metadata?.deliveryStatus)) return ctx;
    // Deferred channels have only produced an approved draft at this point.
    // Their adapter must acknowledge delivery before business effects commit.
    if (ctx.metadata?.deliveryDeferred === true && ctx.metadata?.deliveryStatus !== 'drafted') return ctx;
    // Deferred web/email delivery reconstructs its context. Reload authoritative
    // policy rather than trusting a serialized draft or reverting to defaults.
    if (ctx.metadata?.ownerHandoffPolicy === undefined) await new HandoffPolicyStage().execute(ctx);
    const result = ctx.agentResult;
    if (!result) return ctx;

    await this.executeOnce(ctx);
    if (ctx.metadata?.effectReconciliationRequired) return ctx;
    // Business effects are allowed in draft mode, but no customer interaction was delivered.
    if (ctx.metadata?.deliveryStatus === 'drafted') return ctx;

    const playbookRunId = Number(ctx.metadata?.playbookDirective?.runId || 0);
    const mediaReady = !result.mediaDeliveryAssertionRequired || result.mediaDeliverySucceeded === true;
    const capabilityName = ctx.metadata?.playbookDirective?.capability?.name as string | undefined;
    const capabilityKind = ctx.metadata?.playbookDirective?.capability?.kind as string | undefined;
    const requiredAction = ctx.metadata?.playbookDirective?.requiredAction as string | undefined;
    // AgentRouter serializes this marker only from the server-validated
    // callback.request consent=false directive for deferred delivery.
    const declinedCallback = ctx.metadata?.callbackDeclined === true
      && capabilityName === 'callback.request';
    const toolOutcome = requiredAction
      ? result.toolCallsExecuted?.find((tool) => tool.name === requiredAction)
      : undefined;
    const capabilityStatus = capabilityOutcomeStatus(capabilityName, toolOutcome, capabilityKind);
    // The negative consent path is a successful no-op once its safe reply has
    // been delivered; it must advance the playbook without committing an effect.
    const effectReady = capabilityKind !== 'effect' || ctx.metadata?.capabilityEffectCommitted === true || declinedCallback;
    const documentReceipt = ctx.metadata?.documentDelivery;
    const widgetReceipt = ctx.metadata?.widgetDocumentReceipt;
    const widgetDocumentReady = ctx.message.channel === 'web'
      && widgetReceipt?.sessionId === -ctx.message.conversationId
      && Number.isSafeInteger(widgetReceipt?.messageId) && widgetReceipt.messageId > 0
      && Number.isSafeInteger(widgetReceipt?.documentId) && widgetReceipt.documentId > 0
      && await (await import('../../../supportDocuments/SupportWidgetDocuments.js')).verifyWidgetDocumentReceipt(
        ctx.message.userId, ctx.message.conversationId, widgetReceipt);
    const documentReady = capabilityName !== 'asset.deliver' || (documentReceipt?.status === 'sent'
      && typeof documentReceipt.providerMessageId === 'string' && Boolean(documentReceipt.providerMessageId.trim())
      && Number.isSafeInteger(documentReceipt.actionId) && documentReceipt.actionId > 0) || widgetDocumentReady;
    if (playbookRunId && mediaReady && effectReady && documentReady) {
      await checkpointSupportCommit();
      await playbookEngine.commitProposedTransition(ctx.message.userId, playbookRunId, {
        capabilityName,
        capabilityStatus,
        groundingStatus: result.groundingStatus,
        deliveryStatus: 'sent',
      });
      ctx.metadata = { ...ctx.metadata, playbookTransitionCommitted: true };
    } else if (playbookRunId) {
      ctx.metadata = {
        ...ctx.metadata,
        playbookTransitionCommitted: false,
        playbookTransitionReason: !documentReady ? 'document_delivery_not_confirmed'
          : !mediaReady ? 'media_delivery_not_confirmed' : 'capability_effect_not_committed',
      };
    }
    return ctx;
  }

  private async runEffect(
    ctx: PipelineContext,
    effectType: string,
    effect: () => Promise<void>,
  ): Promise<boolean> {
    const identity = {
      userId: ctx.message.userId,
      conversationId: ctx.message.conversationId,
      channel: ctx.message.channel,
      inboundProviderMessageId: ctx.message.rawMessageId,
      inboundMessageId: ctx.message.messageId,
      effectType: effectType.slice(0, 80),
      version: 1,
    };
    try {
      const outcome = await supportEffectLedgerService.runOnce(identity, effect);
      return outcome === 'executed' || await supportEffectLedgerService.getStatus(identity) === 'success';
    } catch (error) {
      // The ledger has already marked this exact effect for reconciliation.
      // Do not rerun unrelated successful effects or misreport the delivered
      // customer reply as unsent.
      logger.error({ error, effectType }, '[PostProcessingStage] Effect requires reconciliation');
      ctx.metadata = { ...ctx.metadata, effectReconciliationRequired: true };
      return false;
    }
  }

  private async executeOnce(ctx: PipelineContext): Promise<void> {
    const result = ctx.agentResult;
    if (!result) return;

    const { userId, conversationId, channel, leadId } = ctx.message;

    // Specialist-owned state is proposed during generation and committed only
    // after the canonical delivery gate has succeeded.
    for (const [proposalIndex, proposal] of (result.effectProposals || []).entries()) {
      if (ctx.metadata?.deliveryStatus === 'drafted' && proposal.type === 'external_booking_referral') continue;
      const committed = await this.runEffect(ctx, `proposal:${proposal.type}:${proposalIndex}`, async () => {
        const contactDeclined = ['inquiry', 'callback'].includes(proposal.type) && proposal.payload.consent === false;
        if (contactDeclined || (['support_ticket', 'inquiry', 'callback'].includes(proposal.type)
          && (!permittedHandoffReason(ctx) || !hasCustomerHandoffConsent(ctx)))) {
          await recordNonHandoffEnquiry(ctx, proposal.type, proposal.payload);
          ctx.metadata = { ...ctx.metadata, enquiryRecordedWithoutHandoff: true };
          return;
        }
        if (proposal.type === 'lead_identity') {
        // Legacy queued booking drafts can still carry guest-identity
        // proposals. Guests are not necessarily the sender. Profile changes
        // now go exclusively through ContactProfileService's governed bindings.
        logger.warn({ userId, conversationId }, '[PostProcessingStage] Ignored legacy guest identity proposal');
      }
      if (proposal.type === 'lead_memory') {
        const proposalLeadId = Number(proposal.payload.leadId || 0);
        const score = Number(proposal.payload.score);
        const memory = proposal.payload.memory;
        if (proposalLeadId > 0 && memory && typeof memory === 'object') {
          const { salesIntelligence } = await import('../../SalesIntelligence.js');
          await salesIntelligence.saveMemory(proposalLeadId, memory as Parameters<typeof salesIntelligence.saveMemory>[1]);
          if (Number.isFinite(score)) {
            await db.execute(sql`
              UPDATE leads SET score = ${Math.max(0, Math.min(100, score))}, updated_at = NOW()
              WHERE id = ${proposalLeadId} AND user_id = ${userId}
            `);
          }
        }
      }
      if (proposal.type === 'conversation_state') {
        const state = { ...proposal.payload, committedAt: new Date().toISOString() };
        await db.execute(sql`
          UPDATE outreach_conversations
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(state)}::jsonb,
              updated_at = NOW()
          WHERE id = ${conversationId} AND user_id = ${userId}
        `);
      }
      if (proposal.type === 'lead_score') {
        const proposalLeadId = Number(proposal.payload.leadId || 0);
        const score = Number(proposal.payload.score);
        if (proposalLeadId > 0 && Number.isFinite(score)) {
          await db.execute(sql`
            UPDATE leads SET score = ${Math.max(0, Math.min(100, score))}, updated_at = NOW()
            WHERE id = ${proposalLeadId} AND user_id = ${userId}
          `);
        }
      }
      if (proposal.type === 'support_ticket') {
        const { supportService } = await import('../../../SupportService.js');
        await supportService.createTicket(userId, {
          leadId: Number(proposal.payload.leadId || 0) || undefined,
          outreachConversationId: conversationId,
          subject: String(proposal.payload.subject || 'Support request').slice(0, 240),
          description: String(proposal.payload.description || 'Customer requested support.').slice(0, 10_000),
          priority: String(proposal.payload.priority || 'medium'),
          category: String(proposal.payload.category || 'support'),
          tags: Array.isArray(proposal.payload.tags)
            ? proposal.payload.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
            : ['agent_created'],
          autoAssign: true,
        });
      }
      if (proposal.type === 'external_booking_referral') {
        const referral = {
          mode: 'external_booking',
          stage: proposal.payload.stage === 'search' ? 'search' : 'checkout',
          propertyId: Number(proposal.payload.propertyId) || null,
          roomTypeId: Number(proposal.payload.roomTypeId) || null,
          checkIn: String(proposal.payload.checkIn || '').slice(0, 10),
          checkOut: String(proposal.payload.checkOut || '').slice(0, 10),
          guests: Number(proposal.payload.guests),
          adults: Number(proposal.payload.adults) || null,
          children: Number.isSafeInteger(Number(proposal.payload.children))
            ? Number(proposal.payload.children) : null,
          rooms: Number(proposal.payload.rooms),
          stayType: proposal.payload.stayType === 'dayuse' ? 'dayuse' : 'overnight',
          urlFingerprint: String(proposal.payload.urlFingerprint || '').slice(0, 64),
          customerConfirmed: proposal.payload.customerConfirmed === true,
          channel,
          deliveryOutcome: 'sent',
          deliveredAt: new Date().toISOString(),
        };
        await db.execute(sql`
          UPDATE outreach_conversations
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                || ${JSON.stringify({ externalBookingReferral: referral })}::jsonb,
              updated_at = NOW()
          WHERE id = ${conversationId} AND user_id = ${userId}
        `);
        const activityIdempotencyKey = `support:${conversationId}:${ctx.message.messageId || ctx.message.rawMessageId || 'inbound'}:external_booking_referral`;
        await db.execute(sql`
          INSERT INTO crm_activities (
            user_id, contact_id, type, subject, body,
            outreach_conversation_id, outreach_message_id, metadata,
            idempotency_key, created_at, updated_at
          )
          SELECT ${userId}, c.id, 'external_booking_referral',
                 'External booking link delivered', NULL,
                 ${conversationId}, ${ctx.message.messageId || null},
                 ${JSON.stringify({
                   propertyId: referral.propertyId,
                   roomTypeId: referral.roomTypeId,
                   stage: referral.stage,
                   checkIn: referral.checkIn,
                   checkOut: referral.checkOut,
                   guests: referral.guests,
                   adults: referral.adults,
                   children: referral.children,
                   rooms: referral.rooms,
                   stayType: referral.stayType,
                   channel,
                   urlFingerprint: referral.urlFingerprint,
                   customerConfirmed: referral.customerConfirmed,
                 })}::jsonb,
                 ${activityIdempotencyKey}, NOW(), NOW()
          FROM crm_contacts c
          LEFT JOIN outreach_conversations oc
            ON oc.id = ${conversationId} AND oc.user_id = ${userId}
          WHERE c.user_id = ${userId}
            AND (c.id = oc.crm_contact_id OR (oc.crm_contact_id IS NULL AND c.lead_id = ${leadId || 0}))
            AND c.deleted_at IS NULL
          ORDER BY c.id ASC
          LIMIT 1
          ON CONFLICT (business_profile_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        `);
      }
      if (proposal.type === 'inquiry' || proposal.type === 'callback') {
        const reason = String(proposal.payload.reason || proposal.payload.category || proposal.type).slice(0, 2_000);
        const handoff = await handoffService.enqueue(ctx, reason, `playbook_${proposal.type}`);
        ctx.metadata = {
          ...ctx.metadata,
          capabilityHandoffId: handoff.id,
          capabilityHandoffCommitted: true,
        };
        if (!(channel === 'web' && conversationId < 0)) {
          await db.execute(sql`
            UPDATE outreach_conversations
            SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
              structuredInquiry: {
                type: proposal.type,
                capability: proposal.payload.capability,
                category: proposal.payload.category,
                preferredTime: proposal.payload.preferredTime,
                consent: proposal.payload.consent === true ? true : undefined,
                details: proposal.payload.details,
                contactReferences: proposal.payload.contactReferences,
                handoffId: handoff.id,
                committedAt: new Date().toISOString(),
              },
            })}::jsonb,
                updated_at = NOW()
            WHERE id = ${conversationId} AND user_id = ${userId}
          `);
        }
      }
      });
      if (committed && (proposal.type === 'inquiry' || proposal.type === 'callback')) {
        ctx.metadata = { ...ctx.metadata, capabilityEffectCommitted: true };
      }
    }

    // 1. CRM: auto-create / update contact
    let crmContactId: number | null = null;
    const existingRes = await db.execute(sql`
      SELECT c.id
      FROM crm_contacts c
      LEFT JOIN outreach_conversations oc ON oc.id = ${conversationId} AND oc.user_id = ${userId}
      WHERE c.user_id = ${userId} AND c.deleted_at IS NULL
        AND (c.id = oc.crm_contact_id OR (oc.crm_contact_id IS NULL
          AND c.lead_id = COALESCE(oc.lead_id, ${conversationId < 0 ? leadId || null : null})))
      ORDER BY c.id
      LIMIT 1
    `);
    const existedBefore = Boolean((existingRes.rows[0] as { id?: number } | undefined)?.id);
    if (!existedBefore && leadId) {
      await this.runEffect(ctx, 'crm_contact_sync', async () => {
        const { crmService } = await import("../../../CRMService.js");
        await crmService.ensureContactForInbound(userId, leadId, { source: 'agent_reply', channel, recordReply: false });
      });
    }

    // Fetch the contact ID for pipeline update / reminders. This read is safe
    // after both a fresh execution and a duplicate-effect suppression.
    const contactRes = existedBefore || !leadId ? existingRes : await db.execute(sql`
      SELECT c.id
      FROM crm_contacts c
      LEFT JOIN outreach_conversations oc ON oc.id = ${conversationId} AND oc.user_id = ${userId}
      WHERE c.user_id = ${userId} AND c.deleted_at IS NULL
        AND (c.id = oc.crm_contact_id OR (oc.crm_contact_id IS NULL
          AND c.lead_id = COALESCE(oc.lead_id, ${conversationId < 0 ? leadId || null : null})))
      ORDER BY c.id
      LIMIT 1
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    crmContactId = (contactRes.rows[0] as any)?.id || null;

    // Fire contact_created alert if it is new
    if (!existedBefore && crmContactId) {
      await this.runEffect(ctx, 'notification:contact_created', async () => {
        const { alertService } = await import("../../../AlertService.js");
        await alertService.fireEvent(userId, 'contact_created', { contactId: crmContactId! });
        logger.info({ crmContactId }, '[PostProcessingStage] Fired contact_created alert');
      });
    }

    // Fire lead_created alert if the lead itself was created very recently (within 10s)
    const leadRes = leadId ? await db.execute(sql`
      SELECT created_at FROM leads WHERE id = ${leadId} AND user_id = ${userId} LIMIT 1
    `) : { rows: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leadRow = leadRes.rows[0] as any;
    if (leadRow && Date.now() - new Date(leadRow.created_at).getTime() < 10000) {
      await this.runEffect(ctx, 'notification:lead_created', async () => {
        const { alertService } = await import("../../../AlertService.js");
        await alertService.fireEvent(userId, 'lead_created', { metadata: { leadId } });
        logger.info({ leadId }, '[PostProcessingStage] Fired lead_created alert');
      });
    }

    // 2. CRM: resolve semantic progress against the current saved configuration.
    const hasCrmSignal = Boolean(ctx.nlu?.crmStageDecision || result.crmStageDecision
      || result.crmPipelineStatus || result.toolCallsExecuted?.length);
    if (crmContactId && hasCrmSignal) {
      await this.runEffect(ctx, 'crm_pipeline_update', async () => {
        const applied = await applySupportCrmStage(userId, crmContactId!, {
          decision: ctx.nlu?.crmStageDecision || result.crmStageDecision,
          legacyStage: result.crmPipelineStatus, tools: result.toolCallsExecuted,
          conversation: channel === 'web' && conversationId < 0
            ? { kind: 'widget', id: -conversationId } : conversationId > 0
              ? { kind: 'outreach', id: conversationId } : undefined,
        });
        if (!applied) throw new Error('The CRM contact could not be resolved for this conversation.');
        result.crmPipelineStatus = applied.contact.pipelineStatus || 'new';
        ctx.metadata = { ...ctx.metadata, crmStage: { key: result.crmPipelineStatus,
          name: applied.stage?.label, type: applied.stage?.type, changed: applied.changed,
          automationTransitionId: applied.contact.automationTransitionId,
          automationHandoff: applied.contact.automationHandoff,
          automationReviewRequired: applied.contact.automationReviewRequired,
          refreshRequired: applied.contact.refreshRequired } };
        logger.info({ conversationId, crmContactId, stage: result.crmPipelineStatus, changed: applied.changed },
          '[PostProcessingStage] Applied configured CRM stage');
      });
    }
    if (ctx.metadata?.effectReconciliationRequired) return;
    // Replayed effects may arrive in a newly reconstructed deferred context.
    // Reload the current stage before deciding whether follow-ups are eligible.
    if (crmContactId && hasCrmSignal && !ctx.metadata?.crmStage) {
      try {
        const pipeline = await supportCrmPipelineContext(userId, conversationId, leadId);
        const current = pipeline.stages.find(stage => stage.key === pipeline.currentStageKey);
        result.crmPipelineStatus = pipeline.currentStageKey;
        ctx.metadata = { ...ctx.metadata, crmStage: { key: pipeline.currentStageKey,
          name: current?.label, type: current?.type, changed: false } };
      } catch (error) {
        logger.error({ error, conversationId }, '[PostProcessingStage] CRM stage reconciliation required');
        ctx.metadata = { ...ctx.metadata, effectReconciliationRequired: true };
        return;
      }
    }

    // 3. CRM: Update lead status & score based on intent/sentiment
    if (leadId) await this.runEffect(ctx, 'lead_status_score', async () => {
      let statusUpdate: string | null = null;
      let scoreAdjustment = 0;
      const statusOrIntent = (result.crmPipelineStatus || result.intent || '').toLowerCase();

      switch (statusOrIntent) {
        case 'won':
        case 'won_lead':
        case 'deal_won':
          statusUpdate = 'hot';
          scoreAdjustment = 30;
          break;
        case 'demo':
        case 'demo_request':
          statusUpdate = 'hot';
          scoreAdjustment = 25;
          break;
        case 'interested':
        case 'interested_lead':
          statusUpdate = 'hot';
          scoreAdjustment = 20;
          break;
        case 'negotiation':
        case 'negotiation_lead':
        case 'proposal_sent':
        case 'proposal_needed':
          statusUpdate = 'warm';
          scoreAdjustment = 10;
          break;
        case 'ticket_closed':
          statusUpdate = 'warm';
          scoreAdjustment = 5;
          break;
        case 'lost':
        case 'lost_lead':
          statusUpdate = 'cold';
          scoreAdjustment = -30;
          break;
        case 'ticket_open':
        case 'support_needed':
          scoreAdjustment = 5;
          break;
        default:
          if (ctx.sentiment?.sentiment === 'positive') {
            statusUpdate = 'warm';
            scoreAdjustment = 5;
          } else if (ctx.sentiment?.sentiment === 'negative') {
            statusUpdate = 'cold';
            scoreAdjustment = -10;
          }
          break;
      }

      // CRM owns lead lifecycle. Scoring records engagement without replacing
      // the configured Won/Lost outcome (or an active CRM status) with heat.
      if (crmContactId) statusUpdate = null;

      await db.execute(sql`
        UPDATE leads 
        SET 
          status = CASE WHEN status IN ('converted', 'won', 'lost', 'rejected') THEN status
            ELSE COALESCE(${statusUpdate}, status) END,
          lead_score = GREATEST(0, LEAST(100, COALESCE(lead_score, 50) + ${scoreAdjustment})),
          ${channel === 'email' ? sql`replied_emails = COALESCE(replied_emails, 0) + 1,` : sql``}
          last_activity_at = NOW(),
          updated_at = NOW(),
          enriched_data = COALESCE(enriched_data, '{}'::jsonb) || ${JSON.stringify({
            lastSentiment: ctx.sentiment?.sentiment || 'neutral',
            lastSentimentAt: new Date().toISOString(),
            sentimentScore: ctx.sentiment?.score || 0,
          })}::jsonb
        WHERE id = ${leadId} AND user_id = ${userId} AND deleted_at IS NULL
      `);
      logger.info({ leadId, statusUpdate, scoreAdjustment }, '[PostProcessingStage] Updated lead status and score');
    });

    // 4. Activity Reminder
    const reminder = result.scheduleReminder;
    if (reminder && (leadId || crmContactId) && result.followUp?.consent === 'granted') {
      await this.runEffect(ctx, 'reminder', async () => {
        const { reminderService } = await import("../../../ReminderService.js");
        await reminderService.createActivityReminder(userId, {
          contactId: crmContactId || undefined,
          reminderDueAt: reminder.dueAt,
          reminderType: reminder.reminderType,
          title: reminder.title,
          description: reminder.description,
        });
        logger.info(
          { conversationId, title: reminder.title },
          '[PostProcessingStage] Activity reminder scheduled',
        );
      });
    }

    // Automated check-ins are scheduled only by DeliveryOutboxService after
    // provider-confirmed delivery, using the published assistant's approved
    // templates, exact account binding and current reply/consent policy. Model
    // tool proposals must never enroll an independent outbound sequence here.
  }
}
