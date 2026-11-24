/**
 * AgentRouter.ts
 *
 * Unified routing entry point for all outreach channels (WhatsApp, Instagram,
 * Facebook, Email). Called by each channel processor instead of inline routing.
 *
 * Responsibilities:
 *   1. Load the enabled agent config from DB (mutual exclusion — only one active)
 *   2. Dispatch to the correct typed agent class based on agentType
 *   3. Run shared post-processing after EVERY agent reply:
 *      - CRM: ensureContactForInbound (auto-create or bump activity)
 *      - CRM: updatePipelineStatus (if agent signals a stage change)
 *      - Alerts: fireEvent for contact_created / lead_created / deal_won / ticket events
 *      - Reminders: createActivityReminder (if agent signals one)
 *      - Sequences: enroll in follow-up sequence (if agent signals one)
 */

import type { AgentInput, AgentResult } from './BaseOutreachAgent.js';
import type { PipelineContext } from './pipeline/ChannelGateway.js';
import { currentAssistant } from '../assistants/AssistantContext.js';
import { withPublishedAssistant } from '../assistants/AssistantFreshness.js';
import { assistantAgentConfig } from '../assistants/AssistantResolver.js';
import { isHandoffDeclineAcknowledgement } from './orchestration/HandoffConsent.js';

// ── Public handle() arguments ──────────────────────────────────────────

export interface AgentRouterInput {
  userId: number;
  conversationId: number;
  channel: string;
  phoneNumberId?: string | null;
  inboundText: string;
  leadId?: number | null;
  leadName?: string | null;
  leadCompany?: string | null;
  recipientPhone?: string | null;
  sentiment?: { sentiment: string; score: number; keywords: string[] };
  rawMessageId?: string | null;
  messageId?: number | null;
  metadata?: Record<string, unknown>;
}

// ── AgentRouter ────────────────────────────────────────────────────────

class AgentRouter {
  private static instance: AgentRouter;

  static getInstance(): AgentRouter {
    if (!this.instance) this.instance = new AgentRouter();
    return this.instance;
  }

  /**
   * Main entry point — called by every channel processor.
   * Returns the AI reply text (or null if generation failed).
   */
  async handle(input: AgentRouterInput): Promise<AgentResult | null> {
    const { channelGateway } = await import('./pipeline/ChannelGateway.js');
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg: any = {
      userId: input.userId,
      conversationId: input.conversationId,
      channel: input.channel,
      senderIdentifier: input.recipientPhone || 'unknown',
      inboundText: input.inboundText,
      phoneNumberId: input.phoneNumberId || undefined,
      leadId: input.leadId,
      leadName: input.leadName,
      leadCompany: input.leadCompany,
      rawMessageId: input.rawMessageId || undefined,
      messageId: input.messageId || undefined,
      metadata: input.metadata,
    };

    const res = await channelGateway.process(msg);
    if (!res.context?.agentResult) {
      return {
        classifiedSentiment: res.context?.sentiment,
        replyText: '',
        escalated: res.method === 'human_handoff',
        escalationReason: res.error,
        confidence: res.context?.confidence ?? 0,
        deliveryOutcome: res.method,
        approvalRequired: res.method === 'pending_approval',
      };
    }

    const result = res.context.agentResult;
    result.crmStageDecision = res.context.nlu?.crmStageDecision;
    result.classifiedSentiment = res.context.sentiment;
    result.optOutApplied = res.context.metadata?.systemDirective === 'opt_out_confirmation';
    result.handoffDeclineAcknowledged = isHandoffDeclineAcknowledgement(res.context);
    result.verifiedMedia = res.context.verifiedMedia;
    result.approvedDocument = res.context.approvedDocument;
    result.provenance = {
      emailReplyContext: res.context.metadata?.emailReplyContext,
      assistant: res.context.metadata?.assistant,
      assistantAway: res.context.metadata?.assistantAway,
      assistantAwayReceipt: res.context.metadata?.assistantAwayReceipt,
      traceId: res.context.metadata?.traceId, turnId: res.context.metadata?.turnId, stages: res.context.metadata?.stageTrace,
      generationStatus: res.success ? 'completed' : 'failed',
      deliveryStatus: res.context.message?.metadata?.dryRun ? 'simulated' : res.context.metadata?.deliveryStatus || res.method,
      verification: result.answerVerification ? { grounding: result.answerVerification.answerGrounding,
        mayDeliver: result.answerVerification.mayDeliver, reason: result.answerVerification.reason } : null,
      tools: result.toolCallsExecuted?.map(tool => ({ name: tool.name, status: tool.status, success: tool.success })),
      playbook: res.context.metadata?.playbookDirective ? {
        id: res.context.metadata.playbookDirective.playbookId, version: res.context.metadata.playbookDirective.version,
        node: res.context.metadata.playbookDirective.nodeId,
      } : null,
      media: res.context.verifiedMedia?.map(media => ({ assetId: media.assetId, name: media.name })),
      knowledgeStatus: res.context.contextLanes?.knowledge?.status,
      handoffReason: result.escalationReason || res.error || null,
      mode: input.metadata?.executionMode || 'customer', timestamp: new Date().toISOString(),
    };
    result.choiceManifest = res.context?.metadata?.handoffChoice || res.context?.metadata?.playbookDirective?.choice;
    result.deliveryOutcome = res.method;
    result.approvalRequired = res.method === 'pending_approval';
    if (res.method === 'ready_for_channel_delivery') {
      result.deferredEffectContext = {
        assistantProvenance: res.context.metadata?.assistant,
        userId: input.userId,
        conversationId: input.conversationId,
        channel: input.channel,
        leadId: input.leadId,
        rawMessageId: input.rawMessageId,
        messageId: input.messageId,
        sentiment: res.context.sentiment,
        playbookRunId: Number(res.context?.metadata?.playbookDirective?.runId || 0) || null,
        playbookCapabilityName: typeof res.context?.metadata?.playbookDirective?.capability?.name === 'string'
          ? res.context.metadata.playbookDirective.capability.name : null,
        playbookCapabilityKind: typeof res.context?.metadata?.playbookDirective?.capability?.kind === 'string'
          ? res.context.metadata.playbookDirective.capability.kind : null,
        playbookRequiredAction: typeof res.context?.metadata?.playbookDirective?.requiredAction === 'string'
          ? res.context.metadata.playbookDirective.requiredAction : null,
        callbackDeclined: res.context?.metadata?.callbackDeclined === true
          && res.context?.metadata?.playbookDirective?.capability?.name === 'callback.request'
          && res.context?.metadata?.playbookDirective?.capability?.args?.consent === false,
        auditLogId: Number(res.context?.metadata?.auditLogId || 0) || null,
        suppressBusinessEffects: res.context?.metadata?.suppressBusinessEffects === true
          || res.context?.metadata?.playbookDirective?.readOnlyInformation === true,
      };
    }
    
    if (res.method === 'human_handoff') {
      result.escalated = true;
    }

    return result;
  }

  /** Commit business effects only after a deferred channel confirms delivery. */
  async commitDeferredDelivery(result: AgentResult, deliveryStatus: 'sent' | 'drafted' = 'sent'): Promise<void> {
    return withPublishedAssistant(result.deferredEffectContext?.assistantProvenance,
      () => this.commitResolvedDeferredDelivery(result, deliveryStatus));
  }

  private async commitResolvedDeferredDelivery(result: AgentResult, deliveryStatus: 'sent' | 'drafted'): Promise<void> {
    const commit = result.deferredEffectContext;
    if (!commit || result.deliveryOutcome !== 'ready_for_channel_delivery') {
      throw new Error('A ready deferred support decision is required to commit effects.');
    }
    const { PostProcessingStage } = await import('./pipeline/stages/PostProcessingStage.js');
    const deferredCtx: PipelineContext = {
      message: {
        userId: commit.userId,
        conversationId: commit.conversationId,
        channel: commit.channel as 'whatsapp' | 'instagram' | 'instagram_comment' | 'facebook' | 'facebook_comment' | 'email' | 'web',
        senderIdentifier: '[REDACTED]',
        inboundText: '[REDACTED]',
        rawMessageId: commit.rawMessageId || undefined,
        messageId: commit.messageId || undefined,
        leadId: commit.leadId,
        metadata: { executionMode: 'customer' },
      },
      sentiment: commit.sentiment,
      agentResult: result,
      confidence: result.confidence ?? 0,
      policyViolations: [],
      metadata: {
        ...(currentAssistant() ? {assistant:currentAssistant()!.provenance,agentConfig:assistantAgentConfig(currentAssistant()!.configuration,currentAssistant()!.provenance.assistantId)} : {}),
        deliveryStatus,
        widgetDocumentReceipt: result.widgetDocumentReceipt,
        suppressBusinessEffects: commit.suppressBusinessEffects === true,
        callbackDeclined: commit.callbackDeclined === true,
        ...(commit.playbookRunId ? {
          playbookDirective: {
            runId: commit.playbookRunId,
            requiredAction: commit.playbookRequiredAction || undefined,
            capability: commit.playbookCapabilityName ? {
              name: commit.playbookCapabilityName,
              kind: commit.playbookCapabilityKind || undefined,
            } : undefined,
          },
        } : {}),
      },
    };
    await new PostProcessingStage().execute(deferredCtx);
    if (deferredCtx.metadata?.effectReconciliationRequired) throw new Error('A deferred support effect requires reconciliation.');
    const capabilityHandoffCommitted = deferredCtx.metadata?.capabilityHandoffCommitted === true;
    if (commit.auditLogId) {
      const [{ db }, { agentAuditLogsTable }, { and, eq }] = await Promise.all([
        import('../../models/db.js'),
        import('../../models/agentAuditLogs/schema.js'),
        import('drizzle-orm'),
      ]);
      await db.update(agentAuditLogsTable).set({
        outcome: deliveryStatus === 'drafted' ? 'drafted' : capabilityHandoffCommitted ? 'human_handoff' : 'auto_sent',
        deliveryStatus,
        deliveryDeferred: false,
      }).where(and(
        eq(agentAuditLogsTable.id, commit.auditLogId),
        eq(agentAuditLogsTable.userId, commit.userId),
      ));
    }
    result.deliveryOutcome = deliveryStatus === 'drafted' ? 'drafted' : capabilityHandoffCommitted ? 'human_handoff' : 'auto_sent';
    delete result.deferredEffectContext;
  }

  // ── Agent dispatch ───────────────────────────────────────────────────

  public async dispatch(agentType: string, input: AgentInput): Promise<AgentResult> {
    switch (agentType) {
      case 'hotel_sales': {
        const { hotelSalesAgent } = await import('./HotelSalesAgent.js');
        return hotelSalesAgent.handle(input);
      }
      case 'tech_support': {
        const { techSupportAgent } = await import('./TechSupportAgent.js');
        return techSupportAgent.handle(input);
      }
      case 'lead_qualifier': {
        const { leadQualifierAgent } = await import('./LeadQualifierAgent.js');
        return leadQualifierAgent.handle(input);
      }
      case 'customer_success': {
        const { customerSuccessAgent } = await import('./CustomerSuccessAgent.js');
        return customerSuccessAgent.handle(input);
      }
      case 'general_service':
      default: {
        const { generalServiceAgent } = await import('./GeneralServiceAgent.js');
        return generalServiceAgent.handle(input);
      }
    }
  }
}

export const agentRouter = AgentRouter.getInstance();
