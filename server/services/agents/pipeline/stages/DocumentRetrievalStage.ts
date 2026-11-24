import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';
import { requestedDocumentService } from '../../../supportDocuments/ApprovedSupportDocuments.js';
import { selectSupportDocument } from '../../../supportDocuments/SupportDocumentSelection.js';
import { logger } from '../../../../utils/logger.js';

export class DocumentRetrievalStage implements PipelineStage {
  name = 'DocumentRetrieval';
  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    ctx.approvedDocument = undefined;
    if (ctx.metadata?.skipAgentGeneration || ctx.message.metadata?.forceApproval === true
      || !(ctx.metadata?.playbookDirective?.readOnlyInformation
        || ctx.metadata?.playbookDirective?.capability?.name === 'asset.deliver')
      || (ctx.metadata?.conversationMode && ctx.metadata.conversationMode !== 'ai_active')) return ctx;
    const service = requestedDocumentService({ semanticRequest: ctx.nlu?.semanticRequest, channel: ctx.message.channel,
      publicReply: ctx.message.metadata?.publicReply, outboundFirstTouch: ctx.message.metadata?.outboundFirstTouch,
      authenticatedWidget: ctx.message.metadata?.conversationKind === 'support_widget'
        && (!ctx.message.metadata?.executionMode || ctx.message.metadata.executionMode === 'customer')
        && ctx.message.metadata?.dryRun !== true
        && Number.isSafeInteger(ctx.message.metadata?.widgetSession?.id)
        && ctx.message.metadata?.widgetSession?.id === -ctx.message.conversationId
        && typeof ctx.message.metadata?.widgetSession?.token === 'string' && Boolean(ctx.message.metadata.widgetSession.token),
      playbookDirective: ctx.metadata?.playbookDirective });
    if (!service) return ctx;
    try {
      ctx.approvedDocument = await selectSupportDocument({ userId: ctx.message.userId,
        businessProfileId: Number(ctx.metadata?.businessProfileId || 0) || null, service,
        inboundText: ctx.message.inboundText }) || undefined;
      ctx.metadata = { ...ctx.metadata, documentRetrieval: { service, status: ctx.approvedDocument ? 'selected' : 'none',
        documentId: ctx.approvedDocument?.id } };
    } catch {
      // Missing migration or registry outage must not publish a guessed URL or
      // fall back to unrelated image galleries.
      logger.warn({ conversationId: ctx.message.conversationId }, '[SupportDocuments] Approved document lookup unavailable');
      ctx.metadata = { ...ctx.metadata, documentRetrieval: { service, status: 'unavailable' } };
    }
    return ctx;
  }
}
