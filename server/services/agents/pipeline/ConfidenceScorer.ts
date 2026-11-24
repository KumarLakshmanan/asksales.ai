import type { PipelineContext } from "./ChannelGateway.js";

export class ConfidenceScorer {
  score(ctx: PipelineContext): number {
    let score = 1.0;

    // 1. Intent Risk Level gating
    if (ctx.nlu?.riskLevel === 'critical') {
      return 0.0; // must escalate immediately
    }
    if (ctx.nlu?.riskLevel === 'high') {
      score -= 0.3; // high risk lowers confidence
    }

    // 2. NLU classification confidence
    if (ctx.nlu
      && typeof ctx.nlu.classificationConfidence === 'number'
      && !ctx.metadata?.activePlaybookSelection) {
      const diff = 1.0 - ctx.nlu.classificationConfidence;
      score -= diff * 0.4; // up to 40% weight
    }

    // 3. Needs Human binary flag
    // An exact value from the current immutable playbook field may use words
    // such as "Request a callback" without being an immediate ownership
    // handoff. ActivePlaybookSelectionStage establishes this narrowly, after
    // fixed safety checks and before generic NLU policy handling.
    if (ctx.nlu?.needsHuman && !ctx.metadata?.activePlaybookSelection) {
      score -= 0.5; // strong signal for human help
    }

    // 4. Sentiment Analysis
    if (ctx.sentiment) {
      if (ctx.sentiment.sentiment === 'negative') {
        if (ctx.sentiment.score < -0.8) {
          score -= 0.4;
        } else if (ctx.sentiment.score < -0.5) {
          score -= 0.2;
        }
      }
    }

    // 5. Tool Call execution errors
    if (ctx.agentResult?.toolCallsExecuted?.length) {
      const failures = ctx.agentResult.toolCallsExecuted.filter((call) =>
        call.status !== 'success' || call.success !== true,
      ).length;
      score -= Math.min(0.5, failures * 0.2);
    }

    // 6. Respect specialist-provided confidence instead of silently replacing it.
    if (typeof ctx.agentResult?.confidence === 'number') {
      score = score * 0.6 + Math.max(0, Math.min(1, ctx.agentResult.confidence)) * 0.4;
    }

    // 7. Factual intents should not auto-send without grounded context unless a
    // successful tool supplied the answer.
    const groundedIntents = new Set([
      'faq', 'availability_inquiry', 'pricing_question', 'payment_inquiry',
      'ticket_status', 'support_request', 'refund_request',
    ]);
    if (ctx.nlu?.intent && groundedIntents.has(ctx.nlu.intent)) {
      const hasKnowledge = ctx.contextLanes?.knowledge?.status === 'sufficient'
        && Boolean(ctx.contextLanes.knowledge.evidence.length);
      const hasSuccessfulTool = Boolean(ctx.agentResult?.toolCallsExecuted?.some((call) =>
        call.status === 'success' && call.success === true,
      ));
      const hasVerifiedExplicitMedia = ctx.mediaRetrieval?.intent === 'explicit'
        && ctx.mediaRetrieval.status === 'selected'
        && Boolean(ctx.verifiedMedia?.length);
      // A server-authored document caption/availability limitation makes no
      // commercial claims. Missing KB prose must not block an approved PDF.
      // Keep intent/risk confidence and every other approval gate unchanged;
      // the delivery boundary still validates the exact approved binary.
      const hasGovernedDocumentReply = ctx.metadata?.governedDocumentReply === true
        && ctx.metadata?.playbookCompliance?.passed === true
        && (ctx.metadata?.playbookDirective?.readOnlyInformation === true
          || ctx.metadata?.playbookDirective?.capability?.name === 'asset.deliver')
        && ctx.metadata?.playbookDirective?.compliance?.verbatim === ctx.agentResult?.replyText
        && ctx.agentResult?.groundingStatus === 'not_required'
        && !ctx.agentResult?.claimEvidence?.length
        && !ctx.agentResult?.effectProposals?.length;
      if (!hasKnowledge && !hasSuccessfulTool && !hasVerifiedExplicitMedia && !hasGovernedDocumentReply) score -= 0.3;
    }

    // Bound between 0.0 and 1.0
    return Math.max(0.0, Math.min(1.0, score));
  }
}

export const confidenceScorer = new ConfidenceScorer();
