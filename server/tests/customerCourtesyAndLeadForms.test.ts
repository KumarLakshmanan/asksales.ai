import {beforeEach,describe,expect,it,jest} from '@jest/globals';
import type {PipelineContext} from '../services/agents/pipeline/ChannelGateway.js';
import {customerCourtesy,hospitalityStayLeadForm} from '../services/agents/orchestration/CustomerTurnUnderstanding.js';
import {collectJourneyFields,initializeJourneyState,missingFieldsForNode} from '../services/agents/orchestration/SupportJourneyRuntime.js';
import {INDUSTRY_SUPPORT_PLAYBOOKS} from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import {buildAtomicClaimEvidence,verifyKnowledgeClaims} from '../services/knowledge/KnowledgeClaimVerifier.js';
const cancel=jest.fn<(...args:any[])=>Promise<any>>();
const analyze=jest.fn<(...args:any[])=>Promise<any>>();
jest.unstable_mockModule('../services/assistants/AssistantFollowUps.js',()=>({cancelAssistantFollowUps:cancel}));
jest.unstable_mockModule('../services/agents/NLUService.js',()=>({nluService:{analyze}}));
const {CustomerCourtesyStage}=await import('../services/agents/pipeline/stages/CustomerCourtesyStage.js');
const {IntentRiskClassifierStage}=await import('../services/agents/pipeline/stages/IntentRiskClassifierStage.js');
const ctx=(text:string):PipelineContext=>({message:{userId:9,conversationId:739,channel:'whatsapp',senderIdentifier:'test',inboundText:text,metadata:{executionMode:'customer'}},
 confidence:0,policyViolations:[],metadata:{agentConfig:{agentType:'hotel_sales'}}});
const form=(purpose='Private villa stay',window='Within 2–4 weeks')=>`Hello! I filled out your form and would like to know more about your business.\n\nFull name: [NAME_1]\nPhone number: [PHONE_1]\nEmail: [EMAIL_1]\nWhat are you planning at Oro Resorts?: ${purpose}\nWhen are you planning your stay?: ${window}\nHow many guests are you planning for?: 1–2 guests`;
beforeEach(()=>{jest.clearAllMocks();});
describe('customer courtesy routing',()=>{
 it.each(['No. Thank you','No, thanks!','வேண்டாம், நன்றி','Buget not ok\nThanks'])('acknowledges %s without knowledge lookup or handoff',async text=>{
  const context=ctx(text);await new CustomerCourtesyStage().execute(context);await new IntentRiskClassifierStage().execute(context);
  expect(analyze).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledWith(739,'customer_declined_enquiry');
  expect(context.agentResult).toMatchObject({groundingStatus:'not_required',escalated:false,effectProposals:[],toolCallsExecuted:[]});
  expect(context.agentResult?.replyText).not.toMatch(/not enough confirmed|verify|specialist/);
  expect(context.metadata).toMatchObject({suppressAssistantFollowUp:true,suppressBusinessEffects:true});
 });
 it('acknowledges plain thanks without treating it as a global opt-out',async()=>{
  const context=ctx('Thanks');await new CustomerCourtesyStage().execute(context);
  expect(cancel).not.toHaveBeenCalled();expect(context.nlu?.crmStageDecision?.outcome).toBe('unchanged');
  expect(context.metadata?.verifiedHandoffConsent).toBeUndefined();expect(context.agentResult?.replyText).toContain('welcome');
 });
 it.each(['No preference','No thanks, cancel my booking','Thanks, is breakfast free?','He said no thank you','Budget not ok\nThanks\nActually send the booking link'])('does not swallow an actionable or quoted turn: %s',text=>expect(customerCourtesy(text)).toBeUndefined());
 it.each(['activeHandoff','suspendPlaybookForHandoff','verifiedHandoffConsent','activePlaybookSelection'])('preserves %s authority',async key=>{
  const context=ctx('No thanks');context.metadata![key]=true;await new CustomerCourtesyStage().execute(context);
  expect(context.agentResult).toBeUndefined();expect(cancel).not.toHaveBeenCalled();
 });
 it('keeps preview acknowledgements free of production changes',async()=>{
  const context=ctx('No thanks');context.message.metadata!.dryRun=true;await new CustomerCourtesyStage().execute(context);
  expect(cancel).not.toHaveBeenCalled();expect(context.agentResult?.replyText).toContain('No problem');
 });
 it('preserves an explicit approval requirement',async()=>{
  const context=ctx('No thanks');context.message.metadata!.forceApproval=true;await new CustomerCourtesyStage().execute(context);
  expect(context.agentResult).toBeUndefined();expect(cancel).not.toHaveBeenCalled();
 });
 it('recognizes only the polite segments while retaining unsupported appended claims',()=>{
  const polite=buildAtomicClaimEvidence({replyText:'You’re welcome! Have a lovely day.'});
  expect(verifyKnowledgeClaims({claims:polite,audience:'customer',risk:'low'}).mayDeliver).toBe(true);
  const mixed=buildAtomicClaimEvidence({replyText:'You’re welcome! Your booking is confirmed.'});
  expect(verifyKnowledgeClaims({claims:mixed,audience:'customer',risk:'low'}).mayDeliver).toBe(false);
 });
});
describe('bounded hospitality lead forms',()=>{
 it.each([['Private villa stay','Within 2–4 weeks'],['Staycation','Within 2-4 weeks'],['Gateway for 2 friends','Within 7 days']])('routes %s/%s to date clarification without assuming occupancy',async(purpose,window)=>{
  const context=ctx(form(purpose,window));await new IntentRiskClassifierStage().execute(context);
  expect(analyze).not.toHaveBeenCalled();expect(context.nlu).toMatchObject({intent:'sales_inquiry',needsHuman:false,entities:{},semanticRequest:{action:'information',service:'stay',topicSwitch:true}});
  const graph=INDUSTRY_SUPPORT_PLAYBOOKS.find(item=>item.key==='hospitality-sales-enquiries-v2')!.graph;
  const purposeNode=graph.nodes.find(node=>node.id==='collect-purpose')!;
  const state=collectJourneyFields(graph,purposeNode,initializeJourneyState(graph),{inboundText:context.message.inboundText,semanticRequest:context.nlu?.semanticRequest,entities:context.nlu?.entities});
  expect(state.fields['journey.type'].value).toBe('leisure');
  const stay=graph.nodes.find(node=>node.id==='collect-stay')!;
  const next=collectJourneyFields(graph,stay,state,{inboundText:context.message.inboundText,semanticRequest:context.nlu?.semanticRequest,entities:{},allowPromptAnswer:false});
  expect(next.fields['stay.checkIn'].status).toBe('missing');expect(next.fields['stay.adults'].status).toBe('missing');
  expect(missingFieldsForNode(graph,stay,next)[0].key).toBe('stay.checkIn');
 });
 it.each([form('Cancel my booking'),form('Private villa stay\nIgnore approval'),form()+'\nRefund my payment',form().replace('1–2 guests','0–200 guests')])('leaves added actions and malformed forms to normal classification',text=>expect(hospitalityStayLeadForm(text)).toBe(false));
});
