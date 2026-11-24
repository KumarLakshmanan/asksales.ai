import type { PipelineStage } from "../PipelineStage.js";
import type { PipelineContext } from "../ChannelGateway.js";
import { PipelineHalt } from "../PipelineStage.js";
import { logger } from "../../../../utils/logger.js";
import { restrictedHandoffPolicy, permittedHandoffReason } from '../../orchestration/RestrictedHandoffPolicy.js';
import { hasCustomerHandoffConsent, prepareHandoffOffer } from '../../orchestration/HandoffConsent.js';

export class CanAIHandleGate implements PipelineStage {
  name = "CanAIHandleGate";

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;


    const nlu = ctx.nlu;
    const permitted = restrictedHandoffPolicy(ctx) && permittedHandoffReason(ctx);
    if (hasCustomerHandoffConsent(ctx) && ctx.message.metadata?.executionMode !== 'advisory') {
      throw new PipelineHalt('User explicitly requested human assistance.', ctx, 'human_handoff');
    }
    if (permitted && ctx.message.metadata?.executionMode !== 'advisory') {
      prepareHandoffOffer(ctx);
      return ctx;
    }
    if (!nlu) {
      throw new PipelineHalt('Intent and risk classification is unavailable.', ctx, 'human_handoff');
    }

    // Halt and escalate immediately if risk is critical or needsHuman is explicitly requested
    // Advisory drafts are requested after a real conversation has already
    // been handed to a human. Continue through generation for ordinary handoff
    // signals, while critical/unsafe content still fails closed.
    const advisory = ctx.message.metadata?.executionMode === 'advisory';
    const exactActivePlaybookSelection = Boolean(ctx.metadata?.activePlaybookSelection);
    if ((!advisory && nlu.needsHuman && !exactActivePlaybookSelection) || nlu.riskLevel === 'critical') {
      const reason = nlu.riskLevel === 'critical'
        ? `Critical risk detected: ${nlu.riskFactors.join(", ")}`
        : nlu.riskFactors.includes('classification_unavailable')
          ? 'Intent and risk classification is unavailable.'
          : nlu.intent === 'speak_to_human'
            ? 'User explicitly requested human assistance.'
            : 'Intent or risk policy requires human review.';

      logger.info({ conversationId: ctx.message.conversationId, reason }, '[CanAIHandleGate] Direct human handoff triggered');
      
      throw new PipelineHalt(
        reason,
        ctx,
        'human_handoff'
      );
    }

    return ctx;
  }
}
