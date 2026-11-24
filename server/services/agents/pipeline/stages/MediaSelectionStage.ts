import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { mediaGateway } from '../../../supportMedia/MediaGateway.js';
import { logger } from '../../../../utils/logger.js';
import { replyAudience } from '../ReplyAudience.js';

export class MediaSelectionStage implements PipelineStage {
  name = 'MediaSelection';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (!ctx.agentResult || !ctx.mediaRetrieval) return ctx;
    const decision = mediaGateway.buildDecision(ctx.mediaRetrieval);
    // A handoff/refusal/sensitive outcome always suppresses otherwise relevant media.
    if (ctx.agentResult.escalated || ctx.agentResult.handoff?.required || ctx.guardrailResult?.action !== 'allow') {
      decision.selections = [];
      decision.reason = 'Media was suppressed by the safety or handoff outcome.';
      decision.intent = 'none';
    }
    ctx.agentResult.mediaDecision = decision;
    ctx.agentResult.mediaDeliveryAssertionRequired = Boolean(
      ctx.metadata?.playbookDirective?.compliance?.assertions?.some(
        (assertion: { type?: string }) => assertion.type === 'media_delivery_succeeded',
      ),
    );
    try {
      ctx.verifiedMedia = await mediaGateway.verify(ctx.message.userId, ctx.message.channel, decision, {
      businessProfileId: Number(ctx.metadata?.businessProfileId || 0) || null,
      audience: replyAudience(ctx.message.metadata),
      purpose: 'support_answer',
      });
    } catch (error) {
      logger.warn({ err: error, userId: ctx.message.userId }, '[SupportMedia] Verification unavailable; continuing with text');
      ctx.verifiedMedia = [];
      decision.selections = [];
      decision.reason = 'Images could not be verified for delivery.';
    }
    if (ctx.metadata?.mediaOnlyResponse && !ctx.verifiedMedia.length) {
      ctx.agentResult.replyText = 'I could not attach the images right now. Please try again shortly.';
    }
    ctx.agentResult.verifiedMedia = ctx.verifiedMedia;
    return ctx;
  }
}
