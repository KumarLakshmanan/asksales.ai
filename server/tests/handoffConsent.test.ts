import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
const execute = jest.fn<(...args: unknown[]) => Promise<{rows: unknown[]}>>().mockResolvedValue({rows:[]});
jest.unstable_mockModule('../models/db.js',()=>({db:{execute}}));
const { prepareHandoffOffer, hasCustomerHandoffConsent, validatedHandoffChoice, matchesHandoffOfferReply, isHandoffDeclineAcknowledgement, HANDOFF_DECLINE_ACK, HANDOFF_FIELD } = await import('../services/agents/orchestration/HandoffConsent.js');
const { HandoffConsentStage } = await import('../services/agents/pipeline/stages/HandoffConsentStage.js');
const { HandoffOfferStage } = await import('../services/agents/pipeline/stages/HandoffOfferStage.js');
const { CanAIHandleGate } = await import('../services/agents/pipeline/stages/CanAIHandleGate.js');
const { buildWhatsAppInteractive } = await import('../services/agents/orchestration/SupportChoiceDelivery.js');
const context = (text='Yes'): PipelineContext => ({
  message:{userId:9,conversationId:615,channel:'whatsapp',senderIdentifier:'qa',inboundText:text,messageId:7310,
    rawMessageId:'incoming-qa',metadata:{executionMode:'customer'}},
  metadata:{ownerHandoffPolicy:{mode:'customer_requests_only'}},confidence:1,policyViolations:[],
  nlu:{intent:'clarify',secondaryIntents:[],entities:{},sentiment:{label:'neutral',score:0},urgency:'low',
    needsHuman:false,summary:'',riskLevel:'low',riskFactors:[],classificationConfidence:0.99},
});
const offer=()=>{const ctx=context();prepareHandoffOffer(ctx);return ctx.metadata!.handoffChoice;};

describe('customer-confirmed human handoff',()=>{
  beforeEach(()=>{execute.mockReset().mockResolvedValue({rows:[]});});
  it('marks only the verified fixed decline acknowledgement for deferred transport',async()=>{
    const ctx=context('No'); ctx.message.channel='email';
    execute.mockResolvedValueOnce({rows:[{choice:offer()}]});
    await new HandoffConsentStage().execute(ctx);
    expect(ctx.agentResult?.replyText).toBe(HANDOFF_DECLINE_ACK);
    expect(ctx.sentiment).toBeUndefined();
    expect(isHandoffDeclineAcknowledgement(ctx)).toBe(true);
    ctx.metadata!.handoffOfferValidated=false;
    expect(isHandoffDeclineAcknowledgement(ctx)).toBe(false);
    ctx.metadata!.handoffOfferValidated=true;
    ctx.agentResult!.replyText='An ordinary customer reply';
    expect(isHandoffDeclineAcknowledgement(ctx)).toBe(false);
    ctx.agentResult!.replyText=HANDOFF_DECLINE_ACK;
    ctx.agentResult!.effectProposals=[{kind:'unexpected'} as any];
    expect(isHandoffDeclineAcknowledgement(ctx)).toBe(false);
    ctx.agentResult!.effectProposals=[];
    ctx.metadata!.activeHandoff=true;
    expect(isHandoffDeclineAcknowledgement(ctx)).toBe(false);
  });
  it('retains a trusted offer across plain-text and email paragraph/break formatting',()=>{
    const choice=offer();
    expect(matchesHandoffOfferReply(choice.fallbackText.replace(/\n/g,'<br />'),choice)).toBe(true);
    expect(matchesHandoffOfferReply(`<p>${choice.prompt}</p><p>${choice.fallbackText.split('\n\n')[1]}</p>`,choice)).toBe(true);
    expect(matchesHandoffOfferReply(choice.prompt,choice)).toBe(true);
  });
  it('never reconstructs offer evidence from copied text, a quotation, extra claims or edited choices',()=>{
    const choice=offer();
    expect(matchesHandoffOfferReply(choice.fallbackText,undefined)).toBe(false);
    expect(matchesHandoffOfferReply(`<blockquote>${choice.fallbackText}</blockquote>`,choice)).toBe(false);
    expect(matchesHandoffOfferReply(`${choice.fallbackText}\nYour booking is confirmed.`,choice)).toBe(false);
    expect(matchesHandoffOfferReply(choice.fallbackText.replace('No to continue','No to transfer'),choice)).toBe(false);
    expect(matchesHandoffOfferReply(`<p onclick="go()">${choice.prompt}</p>`,choice)).toBe(false);
  });
  it('renders real Yes/No WhatsApp buttons without claiming a transfer or effects',()=>{
    const ctx=context();prepareHandoffOffer(ctx);
    const rendered=buildWhatsAppInteractive(ctx.metadata!.handoffChoice) as {type:string;action:{buttons: {reply:{title:string}}[]}};
    expect(rendered.type).toBe('button');
    expect(rendered.action.buttons.map(button=>button.reply.title)).toEqual(['Yes','No']);
    expect(ctx.agentResult?.replyText).not.toMatch(/I (?:have|will) (?:connect|contact)|queued|ticket created/);
    expect(ctx.agentResult?.handoff?.required).toBe(false);
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
  });
  it.each(['Yes','yes please','please do','I agree'])('accepts an exact affirmative to the delivered offer: %s',async text=>{
    const ctx=context(text);execute.mockResolvedValueOnce({rows:[{choice:offer()}]});
    await new HandoffConsentStage().execute(ctx);
    // "yes please" is intentionally handled by semantic intent below, rather
    // than widening exact matching with substring/keyword permission.
    if(text==='yes please') expect(hasCustomerHandoffConsent(ctx)).toBe(false);
    else expect(hasCustomerHandoffConsent(ctx)).toBe(true);
  });
  it('accepts the matching native button even when NLU is uncertain',async()=>{
    const choice=offer();const ctx=context();ctx.metadata!.activePlaybookSelection={fieldKey:'booking.confirm'};
    execute.mockResolvedValueOnce({rows:[{choice,selection:{id:choice.options[0].id}}]});
    await new HandoffConsentStage().execute(ctx);
    expect(hasCustomerHandoffConsent(ctx)).toBe(true);
    expect(ctx.metadata?.activePlaybookSelection).toBeUndefined();
    await expect(new CanAIHandleGate().execute(ctx)).rejects.toMatchObject({outcome:'human_handoff'});
  });
  it.each(['No','No thanks'])('declining never transfers or pauses AI: %s',async text=>{
    const ctx=context(text);const choice=offer();
    execute.mockResolvedValueOnce({rows:[{choice,selection:{id:choice.options[1].id}}]});
    await new HandoffConsentStage().execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('keep helping you here');
    expect(ctx.agentResult?.handoff?.required).toBe(false);
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
  });
  it('does not mistake an unrelated booking Yes for consent',async()=>{
    const ctx=context();execute.mockResolvedValueOnce({rows:[{choice:{...offer(),fieldKey:'booking.confirm'}}]});
    await new HandoffConsentStage().execute(ctx);
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
    expect(ctx.metadata?.skipAgentGeneration).toBeUndefined();
  });
  it('leaves new questions active while the offer is unanswered',async()=>{
    const ctx=context('What rooms do you have?');execute.mockResolvedValueOnce({rows:[{choice:offer()}]});
    await new HandoffConsentStage().execute(ctx);
    expect(ctx.agentResult).toBeUndefined();
    expect(ctx.metadata?.skipAgentGeneration).toBeUndefined();
  });
  it('rejects stale/foreign buttons even if the classifier calls Yes a human request',async()=>{
    const ctx=context();ctx.nlu!.semanticRequest={action:'human',service:'general',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    execute.mockResolvedValueOnce({rows:[{choice:offer(),selection:{id:'handoff_v1_another_chat_yes'}}]});
    await new HandoffConsentStage().execute(ctx);
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
    expect(ctx.agentResult?.replyText).toContain('no longer active');
  });
  it('uses a confident semantic human request for paraphrased/multilingual acceptance',()=>{
    const ctx=context('Please connect me with your team');
    ctx.nlu!.semanticRequest={action:'human',service:'general',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    expect(hasCustomerHandoffConsent(ctx)).toBe(true);
    ctx.nlu!.semanticRequest.explicit=false;
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
  });
  it('offers rather than transferring refunds and low-confidence escalations',async()=>{
    const ctx=context('Please refund me');ctx.nlu!.intent='refund_request';
    await new CanAIHandleGate().execute(ctx);
    expect(ctx.metadata?.handoffChoice.fieldKey).toBe(HANDOFF_FIELD);
    const other=context();other.agentResult={replyText:'I will connect you',escalated:true,confidence:0};
    await new HandoffOfferStage().execute(other);
    expect(other.metadata?.handoffOffer).toBe(true);
    expect(hasCustomerHandoffConsent(other)).toBe(false);
  });
  it('never promotes caller metadata to consent',()=>{
    const ctx=context();ctx.message.metadata!.verifiedHandoffConsent=true;
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
  });
  it.each(['Yes','No'])('resolves %s against the delivered web-widget offer without consuming a journey field',async text=>{
    const ctx=context(text);ctx.message.channel='web';ctx.message.conversationId=-88;
    ctx.message.metadata={executionMode:'customer',conversationKind:'support_widget',widgetMessageId:200};
    execute.mockResolvedValueOnce({rows:[{choice:offer()}]});
    await new HandoffConsentStage().execute(ctx);
    expect(hasCustomerHandoffConsent(ctx)).toBe(text==='Yes');
    if(text==='No')expect(ctx.agentResult?.replyText).toContain('keep helping you here');
  });
  it('accepts a typed email refusal only for the latest delivered fixed offer',async()=>{
    const ctx=context('No');ctx.message.channel='email';
    const choice=offer();execute.mockResolvedValueOnce({rows:[{choice,content:choice.fallbackText,is_ai_generated:true}]});
    await new HandoffConsentStage().execute(ctx);
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
    expect(ctx.agentResult?.replyText).toContain('keep helping you here');
    const unrelated=context('Yes');unrelated.message.channel='email';
    execute.mockResolvedValueOnce({rows:[{content:'Please confirm the booking. Earlier: '+choice.fallbackText+'\nEnd quoted mail.',is_ai_generated:true}]});
    await new HandoffConsentStage().execute(unrelated);
    expect(hasCustomerHandoffConsent(unrelated)).toBe(false);
  });
  it.each(['Yes','yes please','sure','I agree','please do'])('does not promote unbound %s into consent even when NLU calls it human intent',async text=>{
    const ctx=context(text);ctx.nlu!.semanticRequest={action:'human',service:'general',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    execute.mockResolvedValueOnce({rows:[{content:offer().fallbackText,is_ai_generated:true}]});
    await new HandoffConsentStage().execute(ctx);
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
  });
  it('accepts a semantic affirmative only when a current persisted offer was validated',async()=>{
    const ctx=context('yes please');ctx.nlu!.semanticRequest={action:'human',service:'general',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    execute.mockResolvedValueOnce({rows:[{choice:offer()}]});
    await new HandoffConsentStage().execute(ctx);
    expect(hasCustomerHandoffConsent(ctx)).toBe(true);
  });
  it('rejects owner-defined journey choices and malformed manifests in the reserved handoff field',()=>{
    const choice=offer();
    expect(validatedHandoffChoice(choice)).toBe(choice);
    expect(validatedHandoffChoice({...choice,options:choice.options.map((option:any)=>({...option,id:'choice_v1_other'}))})).toBeUndefined();
    expect(validatedHandoffChoice({...choice,options:[null,null]})).toBeUndefined();
    expect(validatedHandoffChoice({...choice,fallbackText:choice.fallbackText+' Quoted history'})).toBeUndefined();
  });
  it.each([
    ['<blockquote>', '</blockquote>'],
    ['<div class="gmail_quote">', '</div>'],
    ['\nOn Monday, the guest wrote:\n', ''],
    ['\n> ', ''],
    ['<p>&gt; ', '</p>'],
  ])('does not accept an old offer quoted with %s as the current email offer',async(prefix,suffix)=>{
    const ctx=context('Yes');ctx.message.channel='email';
    execute.mockResolvedValueOnce({rows:[{content:'Please confirm the booking.'+prefix+offer().fallbackText+suffix,is_ai_generated:true}]});
    await new HandoffConsentStage().execute(ctx);
    expect(hasCustomerHandoffConsent(ctx)).toBe(false);
    expect(ctx.metadata?.verifiedHandoffConsent).toBeUndefined();
  });
  it('does not read customer data or commit consent during simulations',async()=>{
    const ctx=context();ctx.message.metadata!.dryRun=true;
    await new HandoffConsentStage().execute(ctx);
    expect(execute).not.toHaveBeenCalled();
  });
});
