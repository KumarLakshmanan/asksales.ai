import type { PipelineContext } from '../pipeline/ChannelGateway.js';
import { onlyReadOnlyKnowledgeTools } from '../../knowledge/KnowledgeClaimVerifier.js';
import { prepareHandoffOffer } from './HandoffConsent.js';

export const KNOWLEDGE_UNCERTAINTY_REPLY = 'I’m not sure about that from the information I have. Would you like me to connect you with a human support agent?';

/** A fixed, non-factual offer replaces a rejected FAQ, not its verification.
 * It cannot authorize tools, commit a journey, or bypass output safety/public
 * approval. Keep the rejected answer's verification in the audit metadata. */
export function prepareKnowledgeUncertaintyReply(ctx: PipelineContext): boolean {
  const result=ctx.agentResult;
  const mode=ctx.message.metadata?.executionMode || 'customer';
  if (!result || !['customer','preview'].includes(mode)
    || ctx.nlu?.riskLevel !== 'low' || ctx.nlu.needsHuman
    || !Array.isArray(ctx.nlu.riskFactors) || ctx.nlu.riskFactors.length > 0
    || result.answerVerification?.mayDeliver !== false
    || !(ctx.nlu.intent === 'faq' || ctx.metadata?.playbookDirective?.capability?.name === 'knowledge.answer')
    || !onlyReadOnlyKnowledgeTools(result.toolCallsExecuted)
    || result.effectProposals?.some(effect=>!['lead_memory','conversation_state'].includes(effect.type))) return false;
  ctx.metadata={...ctx.metadata,knowledgeUncertaintyReply:true,suppressBusinessEffects:true,
    rejectedKnowledgeVerification:result.answerVerification};
  prepareHandoffOffer(ctx, 'I’m not sure about that from the information I have.');
  return true;
}

export function isKnowledgeUncertaintyReply(ctx: PipelineContext): boolean {
  return ctx.metadata?.knowledgeUncertaintyReply === true && ctx.metadata?.suppressBusinessEffects === true
    && ctx.agentResult?.replyText === KNOWLEDGE_UNCERTAINTY_REPLY
    && !ctx.agentResult.effectProposals?.length && !ctx.agentResult.toolCallsExecuted?.length;
}
