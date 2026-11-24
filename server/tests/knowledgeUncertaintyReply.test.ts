import { describe, expect, it } from '@jest/globals';
import { prepareKnowledgeUncertaintyReply, isKnowledgeUncertaintyReply, KNOWLEDGE_UNCERTAINTY_REPLY } from '../services/agents/orchestration/KnowledgeUncertaintyReply.js';
import { ConfidenceGate } from '../services/agents/pipeline/stages/ConfidenceGate.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
const context=():PipelineContext=>({
  message:{userId:9,conversationId:99,channel:'whatsapp',senderIdentifier:'qa',inboundText:'When is breakfast?',metadata:{executionMode:'customer'}},
  metadata:{ownerHandoffPolicy:{mode:'customer_requests_only'},knowledgeQuery:{risk:'low'},
    playbookDirective:{capability:{name:'knowledge.answer'}}},
  nlu:{intent:'faq',secondaryIntents:[],entities:{},sentiment:{label:'neutral',score:0},urgency:'low',needsHuman:false,summary:'',riskLevel:'low',riskFactors:[],classificationConfidence:0.99},
  agentResult:{replyText:'Rejected assertion',confidence:0,escalated:false,effectProposals:[],toolCallsExecuted:[],answerVerification:{mayDeliver:false,answerGrounding:'blocked',reason:'insufficient',claims:[],unsupportedClaims:[]}},
  confidence:0,policyViolations:[],
} as PipelineContext);

describe('knowledge uncertainty as a non-transactional response',()=>{
  it('delivers an offer without committing the failed knowledge step or its effects',async()=>{
    const ctx=context();
    expect(prepareKnowledgeUncertaintyReply(ctx)).toBe(true);
    expect(ctx.agentResult?.replyText).toBe(KNOWLEDGE_UNCERTAINTY_REPLY);
    expect(ctx.metadata?.rejectedKnowledgeVerification.mayDeliver).toBe(false);
    expect(ctx.metadata?.suppressBusinessEffects).toBe(true);
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.agentResult?.handoff?.required).toBe(false);
    await expect(new ConfidenceGate().execute(ctx)).resolves.toBe(ctx);
    expect(ctx.confidence).toBe(1);
  });
  it('still requires explicit public-channel approval',async()=>{
    const ctx=context();ctx.message.metadata!.forceApproval=true;
    prepareKnowledgeUncertaintyReply(ctx);
    await expect(new ConfidenceGate().execute(ctx)).rejects.toThrow('configured for approval');
  });
  it.each(['risk','human','effects','transaction','internal','verified'])(
    'does not bypass %s policy',kind=>{
      const ctx=context();
      if(kind==='risk')ctx.nlu!.riskLevel='high';
      if(kind==='human')ctx.nlu!.needsHuman=true;
      if(kind==='effects')ctx.agentResult!.effectProposals=[{type:'callback',payload:{consent:true}}];
      if(kind==='transaction'){ctx.nlu!.intent='booking_request';ctx.metadata!.playbookDirective={capability:{name:'checkout.continue'}};}
      if(kind==='internal')ctx.message.metadata!.executionMode='advisory';
      if(kind==='verified')ctx.agentResult!.answerVerification!.mayDeliver=true;
      expect(prepareKnowledgeUncertaintyReply(ctx)).toBe(false);
    });
  it('does not trust the marker if the reply or effects change',()=>{
    const ctx=context();prepareKnowledgeUncertaintyReply(ctx);
    ctx.agentResult!.replyText+=' Your booking is confirmed.';
    expect(isKnowledgeUncertaintyReply(ctx)).toBe(false);
  });
  it('offers Yes/No for every business, without depending on an owner-specific rollout',()=>{
    const ctx=context();ctx.metadata!.ownerHandoffPolicy=undefined;
    expect(prepareKnowledgeUncertaintyReply(ctx)).toBe(true);
    expect(ctx.metadata?.handoffChoice.options.map((option: {label:string})=>option.label)).toEqual(['Yes','No']);
  });
});
