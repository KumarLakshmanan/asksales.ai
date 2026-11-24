import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';
import { hasCustomerHandoffConsent, prepareHandoffOffer } from '../../orchestration/HandoffConsent.js';
import { permittedHandoffReason } from '../../orchestration/RestrictedHandoffPolicy.js';

export class HandoffOfferStage implements PipelineStage {
  name = 'HandoffOffer';
  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (!['customer','preview'].includes(ctx.message.metadata?.executionMode || 'customer')) return ctx;
    if (hasCustomerHandoffConsent(ctx) || ctx.metadata?.activeHandoff || ctx.metadata?.handoffOffer) return ctx;
    const result = ctx.agentResult;
    if (result?.escalated || result?.handoff?.required
      || (permittedHandoffReason(ctx) && result?.effectProposals?.some(effect => ['inquiry','callback','support_ticket'].includes(effect.type)))) {
      ctx.metadata = { ...ctx.metadata, proposedHandoffReason: result?.escalationReason || 'Assistant requested human help.' };
      prepareHandoffOffer(ctx);
    }
    return ctx;
  }
}
