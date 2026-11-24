import { createAgentAuditLog } from "../../../models/agentAuditLogs/functions.js";
import { agentAuditLogsTable } from '../../../models/agentAuditLogs/schema.js';
import { db } from '../../../models/db.js';
import { and, eq } from 'drizzle-orm';
import { sanitizeSupportToolData } from "../orchestration/SafeToolExecutor.js";
import type { PipelineContext } from "./ChannelGateway.js";
import { redactPiiWithStableTokens } from '../orchestration/PrivacyVaultService.js';

export class AuditService {
  private values(ctx: PipelineContext, outcome: string, startTime: number) {
    const durationMs = Date.now() - startTime;

    const auditValues = {
      userId: ctx.message.userId,
      conversationId: ctx.message.conversationId,
      channel: ctx.message.channel,
      
      intent: ctx.nlu?.intent || null,
      riskLevel: ctx.nlu?.riskLevel || null,
      classificationConfidence: ctx.nlu?.classificationConfidence || null,
      
      agentType: ctx.metadata?.agentConfig?.agentType || 'general_service',
      toolsCalled: sanitizeSupportToolData(ctx.agentResult?.toolCallsExecuted || []),
      kbSourcesUsed: ctx.agentResult?.kbSourcesUsed || [],
      // An override is a requested model, not proof of the provider-selected
      // runtime model. Keep legacy llm_model nullable rather than inventing it.
      llmModel: ctx.metadata?.llmModel || ctx.metadata?.agentConfig?.modelOverride || null,
      providerName: ctx.metadata?.llmProvider || null,
      providerModel: ctx.metadata?.llmModel || null,
      llmTokensUsed: ctx.metadata?.llmTokens?.total ?? null,
      
      replyText: ctx.guardrailResult?.finalText || ctx.agentResult?.replyText || null,
      confidence: ctx.confidence,
      
      guardrailPassed: ctx.guardrailResult?.safe ?? null,
      guardrailViolations: ctx.guardrailResult?.violations || [],
      policyViolations: ctx.policyViolations || [],
      playbookId: ctx.metadata?.playbookDirective?.playbookId ?? null,
      playbookVersion: ctx.metadata?.playbookDirective?.version ?? null,
      playbookNodeId: ctx.metadata?.playbookDirective?.nodeId ?? null,
      piiTypes: ctx.metadata?.privacy?.piiTypes || [],
      deliveryActionId: ctx.metadata?.deliveryActionId ?? null,
      deliveryStatus: ctx.metadata?.deliveryStatus || (ctx.metadata?.externalMessageId
        ? 'sent'
        : ctx.message.metadata?.dryRun === true
          ? 'simulated'
          : ctx.metadata?.deliveryDeferred === true
            ? 'deferred'
            : ctx.metadata?.deliveryActionId
              ? 'accepted_without_provider_id'
              : 'not_attempted'),
      deliveryDeferred: ctx.metadata?.deliveryDeferred === true,
      providerMessageId: ctx.metadata?.externalMessageId || null,
      trace: {
        traceId: ctx.metadata?.traceId, turnId: ctx.metadata?.turnId, stages: ctx.metadata?.stageTrace || [],
        historyStatus: ctx.metadata?.historyStatus, memorySourceIds: ctx.metadata?.memorySourceIds,
        surface: ctx.message.metadata?.conversationKind || ctx.message.channel,
        executionMode: ctx.message.metadata?.executionMode || 'customer',
        activeAgentType: ctx.metadata?.agentConfig?.agentType || null,
        activeAgentConfigId: ctx.metadata?.agentConfig?.id || null,
        activeAgentTemplateVersion: ctx.metadata?.agentConfig?.templateVersion || null,
        activeAgentConfigUpdatedAt: ctx.metadata?.agentConfig?.updatedAt || null,
        resolvedAssistant:ctx.metadata?.resolvedAssistant || null,
        policyResults: {
          preGeneration: ctx.metadata?.preGenerationPolicy || null,
          postClassification: ctx.metadata?.postClassificationPolicy || null,
          violations: ctx.policyViolations || [],
          guardrail: ctx.guardrailResult || null,
        },
        model: ctx.metadata?.llmModel || null,
        provider: ctx.metadata?.llmProvider || null,
        tokenUsage: ctx.metadata?.llmTokens || null,
        conversationMode: ctx.metadata?.conversationMode,
        systemDirective: ctx.metadata?.systemDirective || null,
        ticketFollowUpDisposition: ctx.metadata?.ticketFollowUpDisposition || null,
        ticketReadOnlyAnswer: ctx.metadata?.ticketReadOnlyAnswer === true,
        ticketReadOnlyVerified: ctx.metadata?.ticketReadOnlyVerified === true,
        ticketReadOnlyFallback: ctx.metadata?.ticketReadOnlyFallback === true,
        ownershipResumed: ctx.metadata?.ownershipResumed === true,
        historyScopedAfterOwnershipResume: ctx.metadata?.historyScopedAfterOwnershipResume === true,
        knowledgeRetrievalStatus: ctx.metadata?.kbRetrievalStatus || null,
        // A bounded redacted question supports knowledge review without reading
        // the restricted raw customer message or guessing from timestamps.
        redactedQuestion: redactPiiWithStableTokens((ctx.message.inboundText || '').slice(0,2000)).redactedText,
        handoffId: ctx.metadata?.handoffId || null,
        handoffSuppressed: ctx.metadata?.handoffSuppressed || null,
        ownerHandoffPolicy: ctx.metadata?.ownerHandoffPolicy?.mode || null,
        enquiryRecordedWithoutHandoff: ctx.metadata?.enquiryRecordedWithoutHandoff === true,
        inboundGuardrail: ctx.metadata?.inboundGuardrail,
        activePlaybookCount: ctx.metadata?.activePlaybookCount || null,
        externalContent: ctx.metadata?.externalContent || null,
        playbookRunId: ctx.metadata?.playbookDirective?.runId,
        deliveryDeferred: ctx.metadata?.deliveryDeferred === true,
        simulated: ctx.message.metadata?.dryRun === true,
        answerVerification: sanitizeSupportToolData(ctx.agentResult?.answerVerification || null),
        knowledgeAnswerRepair: sanitizeSupportToolData(ctx.metadata?.knowledgeAnswerRepair || null),
        knowledgeUncertaintyReply: ctx.metadata?.knowledgeUncertaintyReply === true,
        rejectedKnowledgeVerification: sanitizeSupportToolData(ctx.metadata?.rejectedKnowledgeVerification || null),
        effectProposals: sanitizeSupportToolData(ctx.agentResult?.effectProposals || []),
      },
      
      outcome,
      durationMs,
    };
    return auditValues;
  }

  async createDecision(ctx: PipelineContext, startTime: number) {
    if (ctx.message.metadata?.dryRun === true) return null;
    const existingId = Number(ctx.metadata?.auditLogId || 0);
    if (existingId) return { id: existingId };
    const audit = await createAgentAuditLog({
      ...this.values(ctx, 'decision_ready', startTime),
      decisionStatus: 'pending_effects',
      finalizedAt: null,
    });
    if (!audit?.id) throw new Error('The pre-effect decision audit could not be persisted.');
    ctx.metadata = { ...ctx.metadata, auditLogId: audit.id };
    return audit;
  }

  async finalize(ctx: PipelineContext, outcome: 'auto_sent' | 'drafted' | 'ready_for_channel_delivery' | 'pending_approval' | 'human_handoff' | 'blocked' | 'no_op' | 'error', startTime: number) {
    if (ctx.message.metadata?.dryRun === true) return null;
    const auditId = Number(ctx.metadata?.auditLogId || 0);
    if (!auditId) {
      const created = await this.createDecision(ctx, startTime);
      if (!created?.id) return null;
    }
    const finalId = Number(ctx.metadata?.auditLogId || 0);
    const [updated] = await db.update(agentAuditLogsTable).set({
      ...this.values(ctx, outcome, startTime),
      decisionStatus: 'finalized',
      finalizedAt: new Date(),
    }).where(and(
      eq(agentAuditLogsTable.id, finalId),
      eq(agentAuditLogsTable.userId, ctx.message.userId),
    )).returning();
    if (!updated) throw new Error('The decision audit could not be finalized.');
    return updated;
  }

  /** Compatibility alias for non-pipeline callers. */
  async log(ctx: PipelineContext, outcome: 'auto_sent' | 'drafted' | 'ready_for_channel_delivery' | 'pending_approval' | 'human_handoff' | 'blocked' | 'no_op' | 'error', startTime: number) {
    return this.finalize(ctx, outcome, startTime);
  }
}

export const auditService = new AuditService();
