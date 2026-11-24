import { randomUUID } from 'node:crypto';
import { currentConversationRequest, assertConversationRequestActive, checkpointConversationRequest, ConversationRequestError } from '../../ConversationRequestCoordinator.js';
import type { PipelineStage } from "./PipelineStage.js";
import { PipelineHalt } from "./PipelineStage.js";
import { SentimentStage } from "./stages/SentimentStage.js";
import { IntentRiskClassifierStage } from "./stages/IntentRiskClassifierStage.js";
import { PostClassificationPolicyStage } from './stages/PostClassificationPolicyStage.js';
import { CanAIHandleGate } from "./stages/CanAIHandleGate.js";
import { KnowledgeRetrievalStage } from "./stages/KnowledgeRetrievalStage.js";
import { MediaRetrievalStage } from './stages/MediaRetrievalStage.js';
import { DocumentRetrievalStage } from './stages/DocumentRetrievalStage.js';
import type { ApprovedSupportDocument } from '../../supportDocuments/ApprovedSupportDocuments.js';
import { MediaSelectionStage } from './stages/MediaSelectionStage.js';
import { AgentDispatchStage } from "./stages/AgentDispatchStage.js";
import { GuardrailComplianceStage } from "./stages/GuardrailComplianceStage.js";
import { ConfidenceGate } from "./stages/ConfidenceGate.js";
import { DeliveryStage } from "./stages/DeliveryStage.js";
import { PostProcessingStage } from "./stages/PostProcessingStage.js";
import { AuditStage } from "./stages/AuditStage.js";
import { DecisionAuditStage } from './stages/DecisionAuditStage.js';
import { ConversationModeStage } from "./stages/ConversationModeStage.js";
import { PrivacyStage } from "./stages/PrivacyStage.js";
import { AgentConfigurationStage } from "./stages/AgentConfigurationStage.js";
import { ConversationContextStage } from "./stages/ConversationContextStage.js";
import { InboundGuardrailStage } from "./stages/InboundGuardrailStage.js";
import { ActivePlaybookSelectionStage } from './stages/ActivePlaybookSelectionStage.js';
import { CustomerCourtesyStage } from './stages/CustomerCourtesyStage.js';
import { PreGenerationPolicyStage } from "./stages/PreGenerationPolicyStage.js";
import { ExternalContentEnrichmentStage } from "./stages/ExternalContentEnrichmentStage.js";
import { PlaybookStage } from "./stages/PlaybookStage.js";
import { CustomerHistoryStage } from './stages/CustomerHistoryStage.js';
import { PlaybookComplianceStage } from "./stages/PlaybookComplianceStage.js";
import { OptOutStage, SemanticOptOutStage } from "./stages/OptOutStage.js";
import { RateLimitStage } from "./stages/RateLimitStage.js";
import { TicketAwareHandoffStage } from './stages/TicketAwareHandoffStage.js';
import { TicketAwareResponseStage } from './stages/TicketAwareResponseStage.js';
import { ReplyLanguageStage } from './stages/ReplyLanguageStage.js';
import { localizeGovernedReply, replyTargetLanguage } from '../orchestration/ReplyLanguage.js';
import { handoffService } from "./HandoffService.js";
import { HandoffPolicyStage } from './stages/HandoffPolicyStage.js';
import { permittedHandoffReason, prepareNonHandoffFallback } from '../orchestration/RestrictedHandoffPolicy.js';
import { auditService } from "./AuditService.js";
import { db } from "../../../models/db.js";
import { sql } from "drizzle-orm";
import { logger } from "../../../utils/logger.js";
import type { AgentResult } from "../BaseOutreachAgent.js";
import type { NLUResult } from "../NLUService.js";
import type { GuardrailResult } from "./GuardrailService.js";
import { deliveryOutboxService } from "../orchestration/DeliveryOutboxService.js";
import type { KnowledgeContextLanes } from '../../knowledge/types.js';
import type { MediaRetrievalResult, VerifiedSupportMedia } from '../../supportMedia/types.js';
import { assertSupportTurnFresh, currentSupportTurn, SupersededSupportTurn, supportTurnProviderReplyId } from '../orchestration/SupportConversationTurn.js';
import { resolveTurnAssistant, AssistantRoutingError, assertAssistantFresh, assistantAgentConfig } from '../../assistants/AssistantResolver.js';
import { withAssistantContext, type ResolvedAssistant } from '../../assistants/AssistantContext.js';
import { redactPiiWithStableTokens } from '../orchestration/PrivacyVaultService.js';
import { AssistantAvailabilityStage } from '../../assistants/AssistantAvailability.js';
import { HandoffConsentStage } from './stages/HandoffConsentStage.js';
import { HandoffOfferStage } from './stages/HandoffOfferStage.js';
import { hasCustomerHandoffConsent, prepareHandoffOffer } from '../orchestration/HandoffConsent.js';

export interface NormalizedMessage {
  userId: number;
  conversationId: number;
  channel: 'whatsapp' | 'instagram' | 'instagram_comment' | 'facebook' | 'facebook_comment' | 'email' | 'web';
  senderIdentifier: string;       // phone / IGSID / PSID / email
  inboundText: string;
  rawMessageId?: string;          // wamid / IG msg id / etc.
  messageId?: number;              // local outreach_messages id when already known
  phoneNumberId?: string;         // WhatsApp-specific
  leadId?: number | null;
  leadName?: string | null;
  leadCompany?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any> & { executionMode?: 'customer' | 'preview' | 'advisory' };
}

export interface PipelineContext {
  message: NormalizedMessage;
  sentiment?: { sentiment: string; score: number; keywords: string[] };
  nlu?: NLUResult;
  kbContext?: string[];
  contextLanes?: KnowledgeContextLanes;
  mediaRetrieval?: MediaRetrievalResult;
  verifiedMedia?: VerifiedSupportMedia[];
  approvedDocument?: ApprovedSupportDocument;
  agentResult?: AgentResult;
  confidence: number;
  guardrailResult?: GuardrailResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyViolations: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

export interface PipelineResult {
  success: boolean;
  method: 'auto_sent' | 'drafted' | 'ready_for_channel_delivery' | 'pending_approval' | 'human_handoff' | 'blocked' | 'no_op' | 'error';
  messageId?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sentiment?: any;
  error?: string;
  context?: PipelineContext;
}

export class ChannelGateway {
  private stages: PipelineStage[] = [
    new HandoffPolicyStage(),
    new PrivacyStage(),
    new ConversationContextStage(),
    new OptOutStage(),
    new ConversationModeStage(),
    new AgentConfigurationStage(),
    // Deterministic tenant policy must run before classifiers or playbooks can
    // process prohibited content.
    new PreGenerationPolicyStage(),
    new RateLimitStage(),
    new InboundGuardrailStage(),
    new AssistantAvailabilityStage(),
    // Exact owned offer choices still pass inbound safety and availability,
    // but a deterministic No need not wait for generative classification.
    new HandoffConsentStage(),
    // An exact response to the current published collect field is identified
    // before generic intent routing, but only after fixed safety checks.
    new ActivePlaybookSelectionStage(),
    new CustomerCourtesyStage(),
    new IntentRiskClassifierStage(),
    new SemanticOptOutStage(),
    new SentimentStage(),
    new TicketAwareHandoffStage(),
    new PostClassificationPolicyStage(),
    new CanAIHandleGate(),
    new CustomerHistoryStage(),
    new PlaybookStage(),
    new ExternalContentEnrichmentStage(),
    new KnowledgeRetrievalStage(),
    new DocumentRetrievalStage(),
    new MediaRetrievalStage(),
    new AgentDispatchStage(),
    new HandoffOfferStage(),
    new TicketAwareResponseStage(),
    new ReplyLanguageStage(),
    new GuardrailComplianceStage(),
    new MediaSelectionStage(),
    new PlaybookComplianceStage(),
    new ConfidenceGate(),
    new DecisionAuditStage(),
    new DeliveryStage(),
    new PostProcessingStage(),
    new AuditStage(),
  ];

  async process(msg: NormalizedMessage): Promise<PipelineResult> {
    const executionMode = msg.metadata?.executionMode || 'customer';
    const message: NormalizedMessage = {...msg,metadata:{...msg.metadata,executionMode,dryRun:msg.metadata?.dryRun === true || executionMode !== 'customer'}};
    try {
      const sourceConversationId = Number(message.metadata?.sourceConversationId || message.conversationId);
      if (message.channel === 'email' && sourceConversationId > 0) {
        const { conversationCampaignReplyContext, generateCampaignEmailReply } = await import('../../outreach/CampaignEmailReplyService.js');
        const campaign = await conversationCampaignReplyContext(message.userId, sourceConversationId);
        if (campaign) {
          if (!message.metadata?.dryRun) throw new AssistantRoutingError('Campaign replies must use the campaign email reply delivery pipeline.');
          const generated = await generateCampaignEmailReply({ userId: message.userId, context: campaign, inboundText: message.inboundText, leadId: message.leadId });
          return { success: true, method: 'auto_sent', context: { message, confidence: 1, policyViolations: [],
            metadata: { emailReplyContext: generated.context, suppressBusinessEffects: true },
            agentResult: { replyText: generated.body, escalated: false, effectProposals: [], toolCallsExecuted: [] } } };
        }
      }
      const assistant = await resolveTurnAssistant(message);
      return await withAssistantContext(assistant, () => this.processResolved(message,assistant));
    } catch (error) {
      if (!(error instanceof AssistantRoutingError)) throw error;
      logger.warn({conversationId:msg.conversationId,channel:msg.channel,reason:error.message},'[ChannelGateway] Assistant routing blocked');
      return {success:false,method:'no_op',error:error.message,context:{message:{...message,inboundText:redactPiiWithStableTokens(message.inboundText).redactedText},
        confidence:0,policyViolations:[],metadata:{assistantRoutingBlocked:true,suppressBusinessEffects:true}}};
    }
  }

  private async processResolved(msg: NormalizedMessage, assistant?: ResolvedAssistant): Promise<PipelineResult> {
    const turn = currentSupportTurn();
    if (turn) msg = { ...msg, metadata: { ...msg.metadata, turnMessageIds: turn.messageIds, turnMessages: turn.messages } };
    const startTime = Date.now();
    const executionMode = msg.metadata?.executionMode || 'customer';
    const normalizedMessage: NormalizedMessage = {
      ...msg,
      metadata: {
        ...msg.metadata,
        executionMode,
        // Every non-customer surface is a true simulation: no delivery,
        // tickets, CRM writes, handoffs, tools, or playbook transitions.
        dryRun: msg.metadata?.dryRun === true || executionMode !== 'customer',
      },
    };
    const stageTrace: Array<{ stage: string; status: string; durationMs: number }> = [];
    let ctx: PipelineContext = {
      message: normalizedMessage,
      confidence: 1.0,
      policyViolations: [],
      metadata: { startTime, traceId: randomUUID(), turnId: turn?.id || currentConversationRequest()?.requestId || null, stageTrace },
    };
    if (assistant) {
      ctx.metadata = {...ctx.metadata,assistant:assistant.provenance,
        agentConfig:assistantAgentConfig(assistant.configuration,assistant.provenance.assistantId),
        resolvedAssistant:{...assistant.provenance,configurationMode:assistant.preview && assistant.provenance.revision === 0 ? 'draft' : 'published',
          replyModel:assistant.configuration.replyModel,knowledgeIds:assistant.configuration.knowledge.ids,
          playbookIds:assistant.configuration.playbooks.assignments.map(a => a.playbookId),privacy:'mandatory'}};
    }

    try {
      logger.info({ conversationId: msg.conversationId, channel: msg.channel, executionMode }, '[ChannelGateway] Starting pipeline processing');

      for (const stage of this.stages) {
        if (ctx.metadata?.assistantAway && !['GuardrailCompliance','ConfidenceGate','DecisionAudit','Delivery','PostProcessing','Audit'].includes(stage.name)) continue;
        assertConversationRequestActive();
        await checkpointConversationRequest();
        await assertSupportTurnFresh();
        await assertAssistantFresh();
        const stageStart = Date.now();
        try {
          ctx = await stage.execute(ctx);
          ctx.metadata = { ...ctx.metadata, stageTrace };
          stageTrace.push({ stage: stage.name, status: 'completed', durationMs: Date.now() - stageStart });
        } catch (error) {
          stageTrace.push({ stage: stage.name, status: error instanceof PipelineHalt ? 'halted' : 'failed', durationMs: Date.now() - stageStart });
          throw error;
        }
      }

      const method = ctx.metadata?.deliveryStatus === 'drafted' ? 'drafted' as const : ctx.metadata?.deliveryDeferred === true
        && ctx.message.metadata?.dryRun !== true
        ? 'ready_for_channel_delivery' as const
        : ctx.metadata?.capabilityHandoffCommitted === true
          ? 'human_handoff' as const
          : 'auto_sent' as const;
      return {
        success: true,
        method,
        sentiment: ctx.sentiment,
        messageId: ctx.metadata?.externalMessageId || null,
        context: ctx,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      if (err instanceof SupersededSupportTurn || err instanceof ConversationRequestError) throw err;
      if (err instanceof PipelineHalt) {
        const halt = err;
        let outcome = halt.outcome;
        const reason = halt.reason;
        ctx = halt.ctx;

        // A proposed transfer is an offer until the current customer accepts.
        // Keep early privacy/safety failures closed; only a checked static
        // question may be delivered after normal channel eligibility ran.
        if (outcome === 'human_handoff' && !hasCustomerHandoffConsent(ctx)
          && ['customer','preview'].includes(ctx.message.metadata?.executionMode || 'customer')
          && ctx.metadata?.agentConfig && !ctx.metadata?.activeHandoff) {
          ctx.metadata = { ...ctx.metadata, proposedHandoffReason: reason };
          if (/safety|sensitive|privacy|credential|critical risk|moderation|prompt injection|prohibited/i.test(reason)) {
            prepareNonHandoffFallback(ctx, reason);
            prepareHandoffOffer(ctx, ctx.agentResult!.replyText);
          } else prepareHandoffOffer(ctx);
          try {
            await new ReplyLanguageStage().execute(ctx);
            await new GuardrailComplianceStage().execute(ctx);
            outcome = ctx.message.metadata?.forceApproval === true ? 'pending_approval' : 'blocked';
            ctx.metadata = { ...ctx.metadata, consentOfferReady: true };
          } catch {
            outcome = 'no_op';
          }
        }

        // Ticket eligibility is separate from content safety. Rejected content
        // stays rejected; only static safe fallback copy can be delivered.
        if (outcome === 'human_handoff' && !permittedHandoffReason(ctx)) {
          prepareNonHandoffFallback(ctx, reason);
          // Privacy may halt before opt-out, ownership and channel eligibility
          // have run. Never send a fallback until those delivery gates passed.
          outcome = !ctx.metadata?.agentConfig ? 'no_op'
            : ctx.message.metadata?.forceApproval === true ? 'pending_approval' : 'blocked';
        }

        logger.info(
          { conversationId: msg.conversationId, outcome, reason },
          `[ChannelGateway] Pipeline processing short-circuited/halted`
        );

        try {
          await assertSupportTurnFresh();
          // Halt paths can also create tickets, handoffs, and pending approvals.
          // Persist their decision record before any of those effects.
          await auditService.createDecision(ctx, startTime);
          // executionMode is normalized onto ctx.message before any stage runs.
          // Reading the caller's original object here allowed preview/advisory
          // halts to enqueue handoffs, approvals, and delivery notifications.
          const dryRun = ctx.message.metadata?.dryRun === true;
          if (outcome === 'blocked' && (ctx.metadata?.handoffSuppressed || ctx.metadata?.consentOfferReady)) {
            await new DeliveryStage().execute(ctx);
            outcome = ctx.metadata?.deliveryStatus === 'drafted' ? 'drafted' : ctx.metadata?.deliveryDeferred === true && !dryRun ? 'ready_for_channel_delivery' : 'auto_sent';
          }
          if (outcome === 'human_handoff' && !dryRun) {
            const handoff = await handoffService.enqueue(ctx, reason, 'low_confidence_or_risk');
            const acknowledgement = handoffService.customerAcknowledgement(ctx, reason, handoff);
            const ackLanguage = replyTargetLanguage(ctx.nlu?.customerLanguage);
            const notifyText = ackLanguage
              ? await localizeGovernedReply({ userId: msg.userId, text: acknowledgement, language: ackLanguage }).catch(() => null) || acknowledgement
              : acknowledgement;
            ctx.metadata = { ...ctx.metadata, handoffNotificationText: notifyText, handoffId: handoff.id };

            let externalMessageId: string | null = null;
            let sendSuccess = false;
            let deliveryActionId: number | null = null;
            try {
              if (msg.channel === 'email' || msg.channel === 'web') {
                // Email handoffs are visible in the support portal. Sending a
                // second automatic email here would bypass the threaded email
                // delivery ledger and can duplicate the eventual human reply.
                logger.info({ channel: msg.channel }, '[ChannelGateway] Email handoff notification deferred to support portal');
              } else {
                if (!msg.rawMessageId && !msg.messageId) {
                  throw new Error('A stable inbound message identifier is required for escalation delivery.');
                }
                const claim = await deliveryOutboxService.claim({
                  userId: msg.userId,
                  conversationId: msg.conversationId,
                  channel: msg.channel,
                  inboundProviderMessageId: msg.rawMessageId,
                  inboundMessageId: msg.messageId,
                  responseVersion: 1,
                  partIndex: 999,
                }, {
                  text: notifyText,
                  recipient: msg.senderIdentifier,
                  phoneNumberId: msg.phoneNumberId || undefined,
                  replyToProviderMessageId: supportTurnProviderReplyId(msg.rawMessageId) || null,
                  metadata: {
                    dispatchKind: 'pipeline_message',
                    isEscalationNotification: true,
                    ...(typeof msg.metadata?.providerAccountId === 'string'
                      ? { providerAccountId: msg.metadata.providerAccountId }
                      : {}),
                  },
                });
                deliveryActionId = claim.action.id;
                const heldAsDraft = claim.state === 'drafted' || (claim.state === 'claimed' && await deliveryOutboxService.holdIfDisabled(claim.action));
                if (claim.state === 'uncertain') {
                  // A previous attempt may already have reached the customer.
                  // Leave the action uncertain for reconciliation; never re-arm it.
                  deliveryActionId = null;
                  ctx.metadata = { ...ctx.metadata, deliveryActionId: claim.action.id, deliveryStatus: 'uncertain' };
                  logger.warn({ deliveryActionId: claim.action.id }, '[ChannelGateway] Escalation notification delivery is uncertain; resend suppressed');
                } else if (claim.state === 'already_sent') {
                  externalMessageId = claim.action.providerMessageId || null;
                  sendSuccess = true;
                } else if (heldAsDraft) {
                  ctx.metadata = { ...ctx.metadata, deliveryStatus: 'drafted' };
                } else {
                  // The outbox dispatcher records sent / retryable / uncertain
                  // outcomes exactly as for normal replies, so an ambiguous
                  // provider error is never retried into a duplicate message.
                  const sent = await deliveryOutboxService.sendClaimedPipelineMessage(claim.action);
                  externalMessageId = sent.providerMessageId;
                  sendSuccess = sent.sent;
                }
                if (claim.state !== 'uncertain') ctx.metadata = {
                  ...ctx.metadata,
                  deliveryActionId: claim.action.id,
                  deliveryStatus: heldAsDraft ? 'drafted' : sendSuccess ? 'sent' : 'failed_retry_scheduled',
                  externalMessageId,
                };
              }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (err: any) {
              // Provider outcomes are recorded by the outbox dispatcher. An error
              // here happened before any provider call, so a retry is safe.
              if (deliveryActionId) {
                await deliveryOutboxService.markFailed(
                  deliveryActionId,
                  err?.message || 'Escalation delivery failed',
                  false,
                ).catch(() => undefined);
              }
              logger.error({ err, channel: msg.channel }, '[ChannelGateway] Failed to send escalation notification');
            }
          } else if (outcome === 'pending_approval' && !dryRun) {
            const replyText = ctx.agentResult?.replyText || '';
            const metadata = {
              pendingApproval: true,
              sentimentScore: ctx.sentiment?.score || 0,
              channel: msg.channel,
            };

            if (msg.channel === 'web' && msg.conversationId < 0) {
              const widgetPending = await db.execute(sql`
                  UPDATE support_chat_sessions scs
                  SET metadata = COALESCE(scs.metadata, '{}'::jsonb) || ${JSON.stringify({
                        pendingApproval: {
                          replyText,
                          sentimentScore: ctx.sentiment?.score || 0,
                          createdAt: new Date().toISOString(),
                        },
                      })}::jsonb,
                      updated_at = NOW()
                  FROM team_members tm
                  WHERE scs.id = ${Math.abs(msg.conversationId)}
                    AND tm.id = scs.member_id
                    AND tm.user_id = ${msg.userId}
                  RETURNING scs.id
                `);
              if (widgetPending.rows.length !== 1) {
                throw new Error('Widget approval state could not be persisted.');
              }
            } else {
              await db.transaction(async (tx: typeof db) => {
                await tx.execute(sql`
                  INSERT INTO outreach_messages (
                    conversation_id, user_id, direction, message_kind, content, phone_number_id, message_type, status, is_ai_generated, metadata, created_at, updated_at
                  ) VALUES (
                    -- A drafted answer to the customer, not campaign outreach: the column
                    -- default ('outreach') put these in campaign Reports as needing review.
                    ${msg.conversationId}, ${msg.userId}, 'outbound', 'reply', ${replyText}, ${msg.phoneNumberId || null}, 'text', 'pending_approval', true,
                    ${JSON.stringify(metadata)}::jsonb,
                    NOW(), NOW()
                  )
                `);
                const pendingConversation = await tx.execute(sql`
                  UPDATE outreach_conversations
                  SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
                        pendingApproval: {
                          replyText,
                          sentimentScore: ctx.sentiment?.score || 0,
                          createdAt: new Date().toISOString(),
                        },
                      })}::jsonb,
                      updated_at = NOW()
                  WHERE id = ${msg.conversationId}
                    AND user_id = ${msg.userId}
                  RETURNING id
                `);
                if (pendingConversation.rows.length !== 1) {
                  throw new Error('Conversation approval state could not be persisted.');
                }
              });
            }
          }

          if (outcome === 'human_handoff' && (
            ctx.metadata?.playbookDirective?.escalate === true
            || ctx.metadata?.playbookDirective?.capability?.effectType === 'handoff'
          )) {
            if (ctx.message.metadata?.executionMode === 'preview') {
              const { supportPreviewStore } = await import('../orchestration/SupportPreviewStore.js');
              await supportPreviewStore.commit(ctx.message.userId, ctx.message.conversationId, {
                capabilityName: ctx.metadata?.playbookDirective?.capability?.name, capabilityStatus: 'success',
                groundingStatus: ctx.agentResult?.groundingStatus,
              }, String(ctx.message.rawMessageId || (ctx.message.messageId ? `message:${ctx.message.messageId}` : '')).slice(0, 255));
            } else if (!ctx.message.metadata?.dryRun && ctx.metadata?.deliveryStatus !== 'drafted') {
            const { playbookEngine } = await import('../orchestration/PlaybookEngine.js');
            await playbookEngine.commitProposedTransition(
              ctx.message.userId,
              Number(ctx.metadata.playbookDirective.runId),
              {
                capabilityName: ctx.metadata?.playbookDirective?.capability?.name,
                capabilityStatus: 'success',
                groundingStatus: ctx.agentResult?.groundingStatus,
                deliveryStatus: ctx.metadata?.deliveryStatus || 'handoff_created',
              },
            );
            }
          }

          // Write audit log
          await auditService.finalize(ctx, outcome, startTime);
        } catch (postHaltErr) {
          logger.error({ err: postHaltErr }, '[ChannelGateway] Error during pipeline halt execution');
          return {
            success: false,
            method: 'error',
            error: postHaltErr instanceof Error ? postHaltErr.message : 'Failed to persist halted pipeline outcome',
            context: ctx,
          };
        }

        return {
          success: true,
          method: outcome,
          sentiment: ctx.sentiment,
          messageId: ctx.metadata?.externalMessageId || null,
          context: ctx,
        };
      }

      logger.error({ err, conversationId: msg.conversationId }, '[ChannelGateway] Unhandled error during pipeline execution');
      
      try {
        await auditService.finalize(ctx, 'error', startTime);
      } catch (auditErr) {
        logger.error({ err: auditErr }, '[ChannelGateway] Failed to log error audit trail');
      }

      return {
        success: false,
        method: 'error',
        error: err?.message || 'Pipeline execution failed',
        context: ctx,
      };
    }
  }
}

export const channelGateway = new ChannelGateway();
