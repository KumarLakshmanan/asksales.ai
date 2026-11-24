import type { PipelineStage } from "../PipelineStage.js";
import type { PipelineContext } from "../ChannelGateway.js";
import { PipelineHalt } from "../PipelineStage.js";
import { confidenceScorer } from "../ConfidenceScorer.js";
import { logger } from "../../../../utils/logger.js";
import { policyRulesFromConfig } from '../PolicyRuleSchema.js';
import { isKnowledgeUncertaintyReply } from '../../orchestration/KnowledgeUncertaintyReply.js';
import { isHandoffOffer } from '../../orchestration/HandoffConsent.js';

export class ConfidenceGate implements PipelineStage {
  name = "ConfidenceGate";

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult && !ctx.metadata?.customerHistoryRecall && !ctx.metadata?.handoffOffer) {
      ctx.confidence = ctx.agentResult.confidence ?? 1;
      return ctx;
    }
    const { conversationId } = ctx.message;

    // A collect prompt is a server-verified rendering of the current,
    // published playbook field. Its field, option IDs, fallback, and wording
    // have already passed PlaybookComplianceStage; generic NLU/retrieval
    // confidence must not turn a valid answer such as `0` children into an
    // undelivered pending approval. Force-approval, escalation, and negative-
    // sentiment gates below still remain authoritative.
    const verifiedPlaybookCollect = ctx.metadata?.playbookDirective?.nodeType === 'collect'
      && ctx.agentResult?.outcome === 'clarification'
      && ctx.agentResult?.confidence === 1
      && (ctx.metadata?.deterministicPlaybookCollect === true
        || ctx.metadata?.governedPlaybookPresentation === true);

    // 1. Calculate composite confidence score
    const verifiedTicketReadOnly = ctx.metadata?.ticketReadOnlyVerified === true
      || ctx.metadata?.ticketReadOnlyFallback === true;
    // AgentDispatch marks a published question node reply made only of plain,
    // claim-free questions. Escalation, sentiment and forced approval below
    // still apply.
    const playbookQuestion = ctx.metadata?.playbookQuestionClarification === true
      && ctx.metadata?.playbookDirective?.nodeType === 'question';
    const score = isHandoffOffer(ctx) || isKnowledgeUncertaintyReply(ctx) || verifiedPlaybookCollect || verifiedTicketReadOnly || playbookQuestion
      || ctx.metadata?.publicBookingSearch === true || ctx.metadata?.customerHistoryRecall === true || ctx.metadata?.nonHandoffEnquiryAcknowledgement === true ? 1 : confidenceScorer.score(ctx);
    ctx.confidence = score;
    if (ctx.agentResult) ctx.agentResult.confidence = score;

    // The active agent policy is the single source of truth for final output
    // confidence. Runtime no longer falls back to a separate global setting.
    const thresholdRule = policyRulesFromConfig(ctx.metadata?.agentConfig?.escalationRules)
      .find((rule) => rule.enabled && rule.type === 'escalation_threshold');
    const threshold = Math.max(0, Math.min(Number(
      (thresholdRule?.config as { threshold?: number } | undefined)?.threshold ?? 0.8,
    ), 1));

    // 3. Gate the response
    const advisory = ctx.message.metadata?.executionMode === 'advisory';
    if (ctx.message.metadata?.forceApproval === true && !advisory) {
      throw new PipelineHalt(
        'This channel is configured for approval before public replies are published.',
        ctx,
        'pending_approval',
      );
    }
    if (ctx.agentResult?.escalated && !advisory) {
      throw new PipelineHalt(
        ctx.agentResult.escalationReason || "Agent requested human escalation.",
        ctx,
        'human_handoff'
      );
    }

    // Negative sentiment safety check: negative sentiment with score < -0.5 must be pending_approval
    const isNegativeSentiment = ctx.sentiment?.sentiment === 'negative' && ctx.sentiment.score < -0.5;
    if (isNegativeSentiment && !advisory) {
      throw new PipelineHalt(
        "Negative sentiment detected on inbound message. Routing to pending approval.",
        ctx,
        'pending_approval'
      );
    }

    if (score < threshold && !advisory) {
      const reason = `Confidence score ${score.toFixed(2)} is below threshold ${threshold.toFixed(2)}.`;
      logger.info({ conversationId, score, threshold }, `[ConfidenceGate] ${reason}`);

      if (score >= 0.5) {
        throw new PipelineHalt(
          `${reason} Routing to pending approval.`,
          ctx,
          'pending_approval'
        );
      } else {
        throw new PipelineHalt(
          `${reason} Direct human handoff triggered due to low confidence.`,
          ctx,
          'human_handoff'
        );
      }
    }

    return ctx;
  }
}
