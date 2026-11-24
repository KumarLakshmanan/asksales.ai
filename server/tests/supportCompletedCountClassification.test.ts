import { beforeEach, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import { withAssistantContext, type ResolvedAssistant } from '../services/assistants/AssistantContext.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const execute=jest.fn<(...args:any[])=>Promise<any>>();
const analyze=jest.fn<(...args:any[])=>Promise<any>>();
jest.unstable_mockModule('../models/db.js',()=>({db:{execute}}));
jest.unstable_mockModule('../services/agents/NLUService.js',()=>({nluService:{analyze}}));
jest.unstable_mockModule('../services/agents/orchestration/SupportCRMPipeline.js',()=>({supportCrmPipelineContext:async()=>undefined}));
jest.unstable_mockModule('../services/agents/orchestration/SupportPreviewStore.js',()=>({supportPreviewStore:{load:async()=>null}}));
const {ActivePlaybookSelectionStage}=await import('../services/agents/pipeline/stages/ActivePlaybookSelectionStage.js');
const {IntentRiskClassifierStage}=await import('../services/agents/pipeline/stages/IntentRiskClassifierStage.js');
const {CanAIHandleGate}=await import('../services/agents/pipeline/stages/CanAIHandleGate.js');
const {PostClassificationPolicyStage}=await import('../services/agents/pipeline/stages/PostClassificationPolicyStage.js');
const assistant={provenance:{assistantId:'qa',revision:4,bindingId:6,surface:'private',channel:'whatsapp'},
 configuration:{playbooks:{mode:'selected',assignments:[{playbookId:21}]},privacy:{permittedCollectionFields:[]}}} as unknown as ResolvedAssistant;
const context=(text:string):PipelineContext=>({message:{userId:9,conversationId:739,messageId:7558,channel:'whatsapp',
 senderIdentifier:'test',inboundText:text,metadata:{executionMode:'customer'}},confidence:0,policyViolations:[],
 metadata:{historyStatus:'available',agentConfig:{agentType:'hotel_sales'}}});
const classify=async(ctx:PipelineContext)=>withAssistantContext(assistant,async()=>{
 await new ActivePlaybookSelectionStage().execute(ctx);
 await new IntentRiskClassifierStage().execute(ctx);return ctx;
});
beforeEach(()=>{
 jest.clearAllMocks();execute.mockReset().mockResolvedValue({rows:[]});
 execute.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:416}]});
 analyze.mockResolvedValue({intent:'clarify',needsHuman:true,riskLevel:'low',riskFactors:['classification_unavailable'],classificationConfidence:0});
});
it.each(['Actually, make that 3 adults instead.','0 children','2 rooms'])('handles a verified exact correction without an unavailable classifier: %s',async text=>{
 const ctx=await classify(context(text));
 expect(analyze).not.toHaveBeenCalled();
 expect(ctx.nlu).toMatchObject({intent:'booking_request',needsHuman:false,entities:{},semanticRequest:{action:'correction',service:'stay'}});
 expect(ctx.metadata?.verifiedHandoffConsent).toBeUndefined();
 expect(ctx.metadata?.skipAgentGeneration).toBeUndefined();
 await expect(new CanAIHandleGate().execute(ctx)).resolves.toBe(ctx);
 const query=new PgDialect().sqlToQuery(execute.mock.calls[1][0] as SQL);
 expect(query.params).toEqual(expect.arrayContaining([9,739,7558,'qa','4','6',21]));
 expect(query.sql).toContain("r.state->>'deliveryStatus'='sent'");
});
it('does not classify a context-free count as a verified completed-search correction',async()=>{
 execute.mockReset().mockResolvedValue({rows:[]});
 const ctx=await classify(context('3 adults'));
 expect(analyze).toHaveBeenCalled();
 await expect(new CanAIHandleGate().execute(ctx)).rejects.toMatchObject({outcome:'human_handoff'});
});
it.each(['0 adults','21 children','3 adults and refund me','call a human','What is the room capacity?'])('does not bypass classification for %s',async text=>{
 await classify(context(text));expect(analyze).toHaveBeenCalled();expect(execute).toHaveBeenCalledTimes(1);
});
it('preserves configured booking-request escalation',async()=>{
 const ctx=context('3 adults');ctx.metadata!.agentConfig.escalationRules=[{id:'review',type:'auto_escalate_intent',enabled:true,config:{intents:['booking_request']}}];
 await classify(ctx);
 await expect(new PostClassificationPolicyStage().execute(ctx)).rejects.toMatchObject({outcome:'human_handoff'});
});
it('does not resume a human-owned chat',async()=>{
 const ctx=context('3 adults');ctx.metadata!.suspendPlaybookForHandoff=true;
 await classify(ctx);expect(execute).not.toHaveBeenCalled();expect(analyze).toHaveBeenCalled();
});
it('requires a durable owned inbound event',async()=>{
 const ctx=context('3 adults');delete ctx.message.messageId;
 await classify(ctx);expect(execute).toHaveBeenCalledTimes(1);expect(analyze).toHaveBeenCalled();
});
it('does not use a stale count marker for a changed message',async()=>{
 const ctx=await withAssistantContext(assistant,()=>new ActivePlaybookSelectionStage().execute(context('3 adults')));
 ctx.message.inboundText='4 adults';await new IntentRiskClassifierStage().execute(ctx);
 expect(analyze).toHaveBeenCalled();
});
