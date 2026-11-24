import { and, eq } from 'drizzle-orm';
import { db } from '../../../../models/db.js';
import { supportPlaybookRunsTable } from '../../../../models/supportOrchestration/schema.js';
import { playbookEngine } from '../../orchestration/PlaybookEngine.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';
import { isKnowledgeUncertaintyReply } from '../../orchestration/KnowledgeUncertaintyReply.js';
import { isHandoffOffer } from '../../orchestration/HandoffConsent.js';

export class PlaybookComplianceStage implements PipelineStage {
  name = 'PlaybookCompliance';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    // This asks permission for help; it neither satisfies nor advances the
    // failed knowledge capability. Business effects remain suppressed.
    if (isKnowledgeUncertaintyReply(ctx) || isHandoffOffer(ctx) || ctx.metadata?.handoffConsentRejected) return ctx;
    const directive = ctx.metadata?.playbookDirective;
    const reply = ctx.agentResult?.replyText;
    if (!directive || !reply) return ctx;
    const preDeliveryDirective = directive.compliance?.assertions?.some(
      (assertion: { type?: string }) => assertion.type === 'media_delivery_succeeded',
    ) ? {
      ...directive,
      compliance: {
        ...directive.compliance,
        assertions: directive.compliance.assertions.filter(
          (assertion: { type?: string }) => assertion.type !== 'media_delivery_succeeded',
        ),
      },
    } : directive;
    const result = playbookEngine.evaluateCompliance(preDeliveryDirective, {
      replyText: reply,
      intent: ctx.nlu?.intent,
      groundingStatus: ctx.agentResult?.groundingStatus,
      claims: ctx.agentResult?.answerVerification?.claims || ctx.agentResult?.claimEvidence,
      toolOutcomes: ctx.agentResult?.toolCallsExecuted,
      effectProposals: ctx.agentResult?.effectProposals,
      handoffRequired: ctx.agentResult?.handoff?.required === true || ctx.agentResult?.escalated === true,
      outcome: ctx.agentResult?.outcome,
      mediaIntent: ctx.agentResult?.mediaDecision?.intent,
      mediaSelected: Boolean(ctx.verifiedMedia?.length),
      // Provider acknowledgement is evaluated after DeliveryStage. Do not let a
      // pre-delivery check claim that an image was sent.
      mediaDeliverySucceeded: undefined,
    });
    ctx.metadata = { ...ctx.metadata, playbookCompliance: result };
    if (ctx.message.metadata?.dryRun !== true && directive.runId > 0) {
      await db.update(supportPlaybookRunsTable).set({
        complianceScore: result.score,
        updatedAt: new Date(),
      }).where(and(
        eq(supportPlaybookRunsTable.id, directive.runId),
        eq(supportPlaybookRunsTable.userId, ctx.message.userId),
      ));
    }
    if (!result.passed) {
      ctx.policyViolations.push({
        ruleId: `playbook:${directive.playbookId}:${directive.nodeId}`,
        ruleType: 'playbook_compliance',
        message: `Draft missed required playbook content: ${result.missing.join(', ')}`,
      });
      throw new PipelineHalt('AI draft did not satisfy the published playbook.', ctx, 'pending_approval');
    }
    return ctx;
  }
}
