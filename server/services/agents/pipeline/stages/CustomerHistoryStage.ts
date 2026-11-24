import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { confidentSemanticIntent } from '../../orchestration/SupportSemanticIntent.js';
import { recallCustomerHistory } from '../../orchestration/CustomerHistoryRecall.js';
import { isToolExposed } from '../../orchestration/SafeToolExecutor.js';

/** Recall is a temporary read-only interruption, not a playbook answer. */
export class CustomerHistoryStage implements PipelineStage {
  name = 'CustomerHistory';
  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration || ctx.metadata?.suspendPlaybookForHandoff) return ctx;
    const request = confidentSemanticIntent(ctx.nlu?.semanticRequest);
    if (request?.action !== 'history' || !request.explicit) return ctx;
    // Never retrieve private customer chats for public comments or synthetic
    // owner/member simulator identities. Existing ownership gates run first.
    const canRead = ['whatsapp', 'instagram', 'facebook', 'email'].includes(ctx.message.channel)
      && !ctx.message.metadata?.publicReply && ctx.message.conversationId > 0
      && ctx.message.metadata?.executionMode === 'customer' && !ctx.message.metadata?.dryRun
      && isToolExposed('get_customer_chat_history', ctx.metadata?.agentConfig?.toolsEnabled);
    ctx.agentResult = canRead ? await recallCustomerHistory({
      userId: ctx.message.userId, conversationId: ctx.message.conversationId,
      inboundText: ctx.message.inboundText, model: ctx.metadata?.agentConfig?.modelOverride,
    }) : {
      replyText: 'I can only retrieve earlier customer chats in an authorized private conversation.',
      confidence: 1, outcome: 'clarification', escalated: false, groundingStatus: 'not_required',
      toolCallsExecuted: [], effectProposals: [],
    };
    ctx.metadata = { ...ctx.metadata, skipAgentGeneration: true, suppressBusinessEffects: true, customerHistoryRecall: true };
    return ctx;
  }
}
