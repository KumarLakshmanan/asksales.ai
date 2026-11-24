import {beforeEach,describe,it,expect,jest} from '@jest/globals';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SubAgentContext} from '../services/agents/subagents/SubAgentBase.js';

const policy=jest.fn<any>(),chat=jest.fn<any>(),create=jest.fn<any>(),prepare=jest.fn<any>(),authorize=jest.fn<any>(),send=jest.fn<any>();
let catalog:any[],terms:string|null;
jest.unstable_mockModule('../models/db.js',()=>({db:{execute:async(statement:any)=>{
  const query=new PgDialect().sqlToQuery(statement);expect(query.params).toContain(9);
  return {rows:query.sql.includes('proposal_catalog')?catalog:[{terms_and_conditions:terms}]};
}}}));
jest.unstable_mockModule('../services/ProposalApprovalService.js',()=>({getProposalReviewPolicy:policy,reviewProposalForDelivery:authorize}));
jest.unstable_mockModule('../services/ProposalService.js',()=>({proposalService:{createProposal:create}}));
jest.unstable_mockModule('../services/ProposalDeliveryService.js',()=>({proposalDeliveryService:{prepare,send}}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js',()=>({LLMProviderFactory:{createProviderForUser:async()=>({defaultModel:'configured-model',createChatCompletion:chat})}}));
const {tryAutomaticSupportProposal}=await import('../services/AutomaticSupportProposalService.js');
const ctx={userId:9,conversationId:7,channel:'web',lead:{id:31},inboundText:'Send an offer for two reports',history:[],executionMode:'customer'} as unknown as SubAgentContext;
const plan=(overrides={})=>({intent:'send',coverNote:'Two requested reports.',currency:'USD',items:[{catalogId:1,quantity:2}],missingDetails:[],...overrides});
const args={title:'Reports'};
const call=(overrides={})=>tryAutomaticSupportProposal({...ctx,...overrides},args,'stable-action');
beforeEach(()=>{
  jest.clearAllMocks();catalog=[{id:1,name:'Report',description:'Approved scope',unit_price:'100',currency:'USD',unit:'report'}];terms='Payment on delivery.';
  policy.mockResolvedValue({requireReviewBeforeAiSend:false});chat.mockResolvedValue({success:true,content:JSON.stringify(plan())});
  create.mockResolvedValue({id:22,status:'draft'});prepare.mockResolvedValue({ready:true,proposal:{revision:1},targetFingerprint:'target',reviewFingerprint:'content'});
  authorize.mockResolvedValue({approved:true,revision:2});send.mockResolvedValue({delivery:{state:'sent'},publicUrl:'https://example.test/proposal/opaque'});
});
describe('optional automatic support proposals',()=>{
  it.each([{dryRun:true},{executionMode:'preview'},{executionMode:'advisory'}])('never writes or sends in simulations %j',async override=>{expect(await call(override)).toBeNull();expect(policy).not.toHaveBeenCalled();expect(chat).not.toHaveBeenCalled();});
  it('keeps the existing review workflow when required',async()=>{policy.mockResolvedValue({requireReviewBeforeAiSend:true});expect(await call()).toBeNull();expect(chat).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();});
  it('honors model-detected draft-only restrictions even with automatic sending enabled',async()=>{chat.mockResolvedValue({success:true,content:JSON.stringify(plan({intent:'draft_only'}))});expect(await call()).toBeNull();expect(create).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();});
  it('asks for permission when intent is unclear',async()=>{chat.mockResolvedValue({success:true,content:JSON.stringify(plan({intent:'unclear'}))});expect(await call()).toMatchObject({status:'needs_clarification',delivered:false});expect(send).not.toHaveBeenCalled();});
  it.each(['missing catalog','missing terms','foreign catalog','wrong currency','missing details'])('blocks an incomplete offer: %s',async kind=>{
    if(kind==='missing catalog')catalog=[];
    if(kind==='missing terms')terms=null;
    if(kind==='foreign catalog')chat.mockResolvedValue({success:true,content:JSON.stringify(plan({items:[{catalogId:999,quantity:2}]}))});
    if(kind==='wrong currency')chat.mockResolvedValue({success:true,content:JSON.stringify(plan({currency:'INR'}))});
    if(kind==='missing details')chat.mockResolvedValue({success:true,content:JSON.stringify(plan({missingDetails:['Which delivery date?']}))});
    expect(await call()).toMatchObject({status:'needs_information',delivered:false,seller_review_required:false});expect(create).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it('uses approved prices and terms, automatically authorizes and returns only a confirmed link',async()=>{
    expect(await call()).toMatchObject({delivered:true,public_url:'https://example.test/proposal/opaque'});
    expect(create).toHaveBeenCalledWith(9,expect.objectContaining({approvalRequired:false,termsAndConditions:terms,lineItems:[expect.objectContaining({catalogId:1,unitPrice:100,quantity:2})],metadata:expect.objectContaining({automaticSendEligible:true})}));
    expect(authorize).toHaveBeenCalledWith(9,22,expect.objectContaining({expectedRevision:1,expectedTargetFingerprint:'target',expectedReviewFingerprint:'content'}),'automatic');
    expect(send).toHaveBeenCalledWith(9,22,{channel:'web',outreachConversationId:7,idempotencyKey:'automatic:stable-action'});
  });
  it('keeps optional risky-offer review enforced',async()=>{authorize.mockResolvedValue({approved:false});expect(await call()).toMatchObject({status:'awaiting_seller_review',delivered:false});expect(send).not.toHaveBeenCalled();});
  it('does not send when the destination or readiness fails',async()=>{prepare.mockResolvedValue({ready:false,issues:[{code:'recipient_missing'}]});expect(await call()).toMatchObject({status:'needs_information',delivered:false});expect(authorize).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();});
  it.each(['failed','uncertain','queued'])('never exposes a link or claims receipt for %s',async state=>{send.mockResolvedValue({delivery:{state},publicUrl:'sensitive-undelivered-link'});const value=await call();expect(value).toMatchObject({delivered:false,status:state});expect(value).not.toHaveProperty('public_url');});
  it('reuses stable request data on replay without re-authorizing',async()=>{create.mockResolvedValue({id:22,status:'sent'});expect(await call()).toMatchObject({delivered:true});expect(authorize).not.toHaveBeenCalled();expect(send).toHaveBeenCalledWith(9,22,{channel:'web',outreachConversationId:7,idempotencyKey:'automatic:stable-action'});});
  it('links a new replacement without overwriting the original',async()=>{await tryAutomaticSupportProposal(ctx,args,'revision-action',11);expect(create).toHaveBeenCalledWith(9,expect.objectContaining({metadata:expect.objectContaining({revisionOf:11})}));});
  it('fails closed for invalid model output',async()=>{chat.mockResolvedValue({success:true,content:'invalid'});expect(await call()).toMatchObject({status:'needs_clarification',delivered:false});expect(create).not.toHaveBeenCalled();});
});
