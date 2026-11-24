import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { classifyMediaIntent } from '../../../supportMedia/MediaIntentClassifier.js';
import { mediaGateway } from '../../../supportMedia/MediaGateway.js';
import { redactPiiWithStableTokens } from '../../orchestration/PrivacyVaultService.js';
import { logger } from '../../../../utils/logger.js';
import { replyAudience } from '../ReplyAudience.js';

export class MediaRetrievalStage implements PipelineStage {
  name = 'MediaRetrieval';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const classified = classifyMediaIntent({
      semanticRequest: ctx.nlu?.semanticRequest,
      text: ctx.message.inboundText,
      intent: ctx.nlu?.intent,
      helpfulEnabled: true,
      publicReply: ctx.message.metadata?.publicReply === true,
      outboundFirstTouch: ctx.message.metadata?.outboundFirstTouch === true,
    });
    // ConversationModeStage is authoritative for human ownership. Once a
    // handoff or approval owns the conversation, do not attach automatic media
    // to the human-ownership acknowledgement.
    if (ctx.metadata?.skipAgentGeneration || (ctx.metadata?.playbookDirective?.readOnlyInformation === true && classified.intent !== 'explicit')
      || ctx.metadata?.playbookDirective?.capability?.name === 'asset.deliver') {
      // Brochure PDFs are not gallery images. Never substitute room photos for
      // a requested document, or imply the published KB text is an attachment.
      ctx.verifiedMedia = [];
      ctx.mediaRetrieval = undefined;
      return ctx;
    }
    const redacted = redactPiiWithStableTokens(ctx.message.inboundText).redactedText;
    ctx.mediaRetrieval = await mediaGateway.retrieve({
      tenantId: ctx.message.userId,
      businessProfileId: Number(ctx.metadata?.businessProfileId || 0) || null,
      conversationId: ctx.message.conversationId,
      purpose: 'support_answer',
      channel: ctx.message.channel,
      audience: replyAudience(ctx.message.metadata),
      redactedText: redacted,
      intent: ctx.nlu?.intent,
      entities: ctx.nlu?.entities as Record<string, string | string[]> | undefined,
      mediaIntent: classified.intent,
      limit: 5,
    });
    ctx.mediaRetrieval.reason = ctx.mediaRetrieval.status === 'selected' ? classified.reason : ctx.mediaRetrieval.reason;
    if (ctx.mediaRetrieval.status === 'selected') {
      try {
        const decision = mediaGateway.buildDecision(ctx.mediaRetrieval);
        ctx.verifiedMedia = await mediaGateway.verify(ctx.message.userId, ctx.message.channel, decision, {
          businessProfileId: Number(ctx.metadata?.businessProfileId || 0) || null,
          audience: replyAudience(ctx.message.metadata),
          purpose: 'support_answer',
        });
        if (!ctx.verifiedMedia.length) {
          ctx.mediaRetrieval = {
            ...ctx.mediaRetrieval,
            status: 'insufficient',
            evidence: [],
            reason: 'No selected media remained authorized at verification time.',
          };
        }
      } catch (error) {
        const failure = error as { name?: string; code?: string };
        logger.warn({
          errorName: failure.name,
          errorCode: failure.code,
          conversationId: ctx.message.conversationId,
        }, '[MediaRetrievalStage] Media verification unavailable');
        ctx.verifiedMedia = [];
        ctx.mediaRetrieval = {
          ...ctx.mediaRetrieval,
          status: 'unavailable',
          evidence: [],
          reason: 'Media verification is temporarily unavailable.',
        };
      }
    }
    return ctx;
  }
}
