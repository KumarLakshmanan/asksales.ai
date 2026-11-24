import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';
import { buildUnavailableExternalReply, externalContentEnrichmentService } from '../../../ExternalContentEnrichmentService.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Deterministically resolves public links before knowledge/model generation.
 * This is platform preprocessing, not a model-selected tool, so every support
 * specialist and draft surface receives the same bounded verified context.
 */
export class ExternalContentEnrichmentStage implements PipelineStage {
  name = 'ExternalContentEnrichment';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    try {
      const result = await externalContentEnrichmentService.enrich({
        userId: ctx.message.userId,
        conversationId: ctx.message.conversationId,
        messageId: ctx.message.messageId,
        channel: ctx.message.channel,
        text: ctx.message.inboundText,
        publicReply: ctx.message.metadata?.publicReply === true,
      });
      if (result.links.length === 0) return ctx;

      const existingContext = typeof ctx.message.metadata?.referenceContext === 'string'
        ? ctx.message.metadata.referenceContext
        : '';
      ctx.message.metadata = {
        ...ctx.message.metadata,
        referenceContext: [existingContext, result.referenceContext].filter(Boolean).join('\n\n').slice(0, 20_000),
      };
      ctx.metadata = {
        ...ctx.metadata,
        externalContent: {
          total: result.links.length,
          resolved: result.links.filter((link) => link.status === 'resolved').length,
          unavailable: result.links.filter((link) => link.status === 'unavailable').length,
          latencyMs: result.latencyMs,
          references: result.links.map((link) => ({
            platform: link.platform,
            status: link.status,
            source: link.source,
            actorId: link.actorId,
            actorRunId: link.actorRunId,
            errorCode: link.errorCode,
            cacheHit: link.cacheHit === true,
            latencyMs: link.latencyMs,
          })),
        },
      };

      if (result.allUnavailable && result.fallbackReply) {
        ctx.agentResult = {
          replyText: result.fallbackReply,
          escalated: false,
          confidence: 1,
          intent: ctx.nlu?.intent,
        };
        ctx.metadata.skipAgentGeneration = true;
      }
    } catch (error) {
      logger.warn({ err: error, conversationId: ctx.message.conversationId }, '[ExternalContent] Enrichment stage failed closed for link understanding');
      // If the service itself fails before it can return its deterministic
      // outcome, do not let the model describe an unverified URL.
      if (/https?:\/\//i.test(ctx.message.inboundText)) {
        const publicReply = ctx.message.metadata?.publicReply === true
          || ['instagram_comment', 'facebook_comment'].includes(ctx.message.channel);
        ctx.agentResult = {
          replyText: buildUnavailableExternalReply(ctx.message.channel, publicReply),
          escalated: false,
          confidence: 1,
        };
        ctx.metadata = { ...ctx.metadata, skipAgentGeneration: true, externalContent: { failedClosed: true } };
      }
    }
    return ctx;
  }
}
