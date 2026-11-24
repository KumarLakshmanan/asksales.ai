import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { AgentResult } from '../services/agents/BaseOutreachAgent.js';

const dispatch = jest.fn<(agentType: string, input: unknown) => Promise<AgentResult>>();
const recover = jest.fn<(input: unknown) => Promise<unknown>>();
const configuration = jest.fn(async () => ({ paymentMethodsEnabled: false,
  externalBooking: { url: 'https://bookings.example.com/?propertyId=10955&name=private&promo=old' } }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { dispatch } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeExtractiveAnswer.js', () => ({ recoverExtractiveKnowledgeAnswer: recover }));
jest.unstable_mockModule('../services/booking/PaymentProvider.js', () => ({ getHotelPaymentConfiguration: configuration }));
jest.unstable_mockModule('../services/booking/ExternalBookingUrl.js', () => ({
  validateExternalBookingUrlDestination: async (url: string) => url,
  safeExternalBookingUrl: (url: string) => url,
}));
jest.unstable_mockModule('../services/agents/orchestration/SupportPlaybookPresentationService.js', () => ({
  supportPlaybookPresentationService: { present: async () => ({ text: 'What date would you like to check in?', generated: false }) },
}));
const { AgentDispatchStage } = await import('../services/agents/pipeline/stages/AgentDispatchStage.js');
const { ConfidenceGate } = await import('../services/agents/pipeline/stages/ConfidenceGate.js');
const stage = new AgentDispatchStage();
function context(): PipelineContext {
  return { message: { userId: 9, conversationId: -10, channel: 'whatsapp', inboundText: 'Resort information',
    metadata: { executionMode: 'preview', dryRun: true } },
    nlu: { intent: 'faq', riskLevel: 'low' }, confidence: 1, policyViolations: [],
    metadata: { documentRetrieval: { status: 'none' }, agentConfig: { agentType: 'hotel_sales' }, knowledgeQuery: { tenantId: 9, risk: 'low', audience: 'customer' } },
    contextLanes: { knowledge: { status: 'sufficient', indexVersion: 'test', evidence: [{
      evidenceId: 'KB-1', documentId: 1, versionId: 1, chunkId: '1', title: 'Published facilities',
      excerpt: 'The garden has native trees.', authority: 'owner', scores: { fused: 1 },
    }], diagnostics: { queryFingerprint: 'q', candidateCount: 1, reranked: false, latencyMs: 1 } } },
  } as unknown as PipelineContext;
}
beforeEach(() => { jest.clearAllMocks(); recover.mockResolvedValue(null); });
describe('customer dispatch fixes', () => {
  it.each([
    ['Actually, make that 3 adults instead.','2','adults=3','children=1'],
    ['Actually, make that 2 children instead.','3','adults=3','children=2'],
  ])('updates the completed public search without restarting intake or reusing identity: %s',async(text,priorAdults,adults,children)=>{
    const ctx=context();ctx.message.inboundText=text;
    ctx.nlu!.intent='booking_request';ctx.nlu!.entities={adults:99,children:99,rooms:99,checkIn:'2099-01-01'};
    ctx.nlu!.semanticRequest={action:'booking',service:'stay',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    ctx.metadata!.playbookDirective={nodeId:'completed-journey-follow-up',nodeType:'knowledge',runId:42,readOnlyInformation:true,completedJourneyFollowUp:true,publicBookingSearchFollowUp:true};
    ctx.message.metadata!.conversationHistory=[{role:'assistant',content:`https://bookings.example.com/?propertyId=10955&checkIn=2026-11-18&checkOut=2026-11-20&adults=${priorAdults}&children=1&rooms=1&phone=private`}];
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('checkIn=2026-11-18');
    expect(ctx.agentResult?.replyText).toContain('checkOut=2026-11-20');
    expect(ctx.agentResult?.replyText).toContain(adults);
    expect(ctx.agentResult?.replyText).toContain(children);
    expect(ctx.agentResult?.replyText).toContain('rooms=1');
    expect(ctx.agentResult?.replyText).not.toMatch(/private|phone=|promo=|booking confirmed/i);
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.metadata?.suppressBusinessEffects).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each([
    {history:[]},
    {history:[{role:'user',content:'https://bookings.example.com/?propertyId=10955&checkIn=2026-11-18&checkOut=2026-11-20'}]},
    {history:[{role:'assistant',content:'https://foreign.example.com/?propertyId=10955&checkIn=2026-11-18&checkOut=2026-11-20'}]},
    {history:[{role:'assistant',content:'https://bookings.example.com/?propertyId=1&checkIn=2026-11-18&checkOut=2026-11-20'}]},
    {history:[{role:'assistant',content:'https://bookings.example.com/?propertyId=10955'}]},
  ])('asks for search details when acknowledged matching history is absent: %j',async ({history})=>{
    const ctx=context();ctx.message.inboundText='Actually, make that 3 adults instead.';
    ctx.message.metadata!.conversationHistory=history;
    ctx.metadata!.playbookDirective={nodeId:'completed-journey-follow-up',runId:42,readOnlyInformation:true,completedJourneyFollowUp:true,publicBookingSearchFollowUp:true};
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('Please confirm');
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('keeps public-search follow-ups subject to mandatory approval',async()=>{
    const ctx=context();ctx.message.inboundText='Actually, make that 3 adults instead.';
    ctx.message.metadata!.forceApproval=true;
    ctx.message.metadata!.conversationHistory=[{role:'assistant',content:'https://bookings.example.com/?propertyId=10955&checkIn=2026-11-18&checkOut=2026-11-20&adults=2&children=1&rooms=1'}];
    ctx.metadata!.playbookDirective={nodeId:'completed-journey-follow-up',runId:42,readOnlyInformation:true,completedJourneyFollowUp:true,publicBookingSearchFollowUp:true};
    await stage.execute(ctx);
    await expect(new ConfidenceGate().execute(ctx)).rejects.toThrow('configured for approval');
  });
  it('does not emit a partial search when a hinted count is invalid',async()=>{
    const ctx=context();ctx.message.inboundText='Actually, make that 0 adults instead.';
    ctx.nlu!.entities={adults:0};
    ctx.message.metadata!.conversationHistory=[{role:'assistant',content:'https://bookings.example.com/?propertyId=10955&checkIn=2026-11-18&checkOut=2026-11-20&adults=2&children=1&rooms=1'}];
    ctx.metadata!.playbookDirective={nodeId:'completed-journey-follow-up',runId:42,readOnlyInformation:true,completedJourneyFollowUp:true,publicBookingSearchFollowUp:true};
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('Please confirm');
    expect(ctx.agentResult?.replyText).not.toContain('https://');
    expect(ctx.agentResult?.effectProposals).toEqual([]);
  });
  it('repairs grounded owner email advice even when its coarse intent is a writing task rather than FAQ',async()=>{
    const ctx=context();ctx.message.channel='email';ctx.message.metadata={executionMode:'advisory',conversationKind:'owner_support'};
    ctx.nlu!.intent='clarify';ctx.metadata!.knowledgeQuery.audience='internal';
    ctx.contextLanes!.knowledge!.evidence[0].excerpt='Check-In: 2:00 PM\nCheck-Out: 11:00 AM';
    dispatch.mockResolvedValue({replyText:'Dear Guest,\nCheck-in: 2:00 PM\nCheck-out: 11:00 AM\nBest regards,\nInvented Hotel',escalated:false,toolCallsExecuted:[],effectProposals:[]});
    await stage.execute(ctx);
    expect(ctx.agentResult?.answerVerification?.mayDeliver).toBe(true);
    expect(ctx.agentResult?.replyText).toContain('2:00 PM');
    expect(ctx.agentResult?.replyText).not.toContain('Invented Hotel');
    expect(recover).not.toHaveBeenCalled();
  });
  it('also offers the public search page for a dated stay enquiry without treating it as booking consent',async()=>{
    const ctx=context();ctx.nlu!.intent='booking_request';ctx.nlu!.entities={checkIn:'2026-11-18',checkOut:'2026-11-20'};
    ctx.nlu!.semanticRequest={action:'information',service:'stay',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    ctx.metadata!.playbookDirective={nodeId:'privacy-blocked',nodeType:'knowledge',runId:0,readOnlyInformation:true};
    await stage.execute(ctx);
    expect(ctx.metadata?.publicBookingSearch).toBe(true);
    expect(ctx.agentResult?.replyText).toContain('checkIn=2026-11-18');
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.agentResult?.escalated).toBe(false);
  });
  it('offers the approved public booking page when intake contact fields are not permitted',async()=>{
    const ctx=context();ctx.message.inboundText='I want a stay';
    ctx.nlu!.semanticRequest={action:'booking',service:'stay',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    ctx.nlu!.entities={checkIn:'2026-11-18',checkOut:'2026-11-20',adults:2,children:1,rooms:1,guestEmail:'private@example.test'};
    ctx.metadata!.playbookDirective={nodeId:'privacy-blocked',nodeType:'knowledge',runId:0,readOnlyInformation:true};
    await stage.execute(ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.agentResult?.replyText).toContain('propertyId=10955');
    expect(ctx.agentResult?.replyText).toContain('checkIn=2026-11-18');
    expect(ctx.agentResult?.replyText).toContain('children=1');
    expect(ctx.agentResult?.replyText).not.toMatch(/private|promo=|confirmed your booking/);
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.metadata?.suppressBusinessEffects).toBe(true);
    expect(ctx.metadata?.publicBookingSearch).toBe(true);
    await expect(new ConfidenceGate().execute(ctx)).resolves.toBe(ctx);
  });
  it('keeps the public booking fallback subject to approval',async()=>{
    const ctx=context();ctx.message.metadata!.forceApproval=true;
    ctx.nlu!.semanticRequest={action:'booking_link',service:'stay',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    ctx.metadata!.playbookDirective={nodeId:'privacy-blocked',nodeType:'knowledge',runId:0,readOnlyInformation:true};
    await stage.execute(ctx);
    await expect(new ConfidenceGate().execute(ctx)).rejects.toThrow('configured for approval');
  });
  it('can acknowledge explicitly requested verified gallery images without collecting playbook contact fields', async () => {
    const ctx = context(); ctx.contextLanes!.knowledge!.status = 'unavailable';
    ctx.metadata!.playbookDirective = { nodeId: 'privacy-blocked', nodeType: 'knowledge', runId: 0, readOnlyInformation: true };
    ctx.mediaRetrieval = { intent: 'explicit', status: 'selected', evidence: [], reason: 'Matching published gallery', diagnostics: { queryFingerprint: 'media-test', candidateCount: 1, latencyMs: 0 } };
    ctx.verifiedMedia = [{ evidenceId: 'MEDIA-1', caption: 'Owner-approved image' }] as PipelineContext['verifiedMedia'];
    await stage.execute(ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.agentResult?.replyText).toBe('I found matching images for your request.');
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.metadata!.suppressBusinessEffects).toBe(true);
    expect(ctx.metadata!.mediaOnlyResponse).toBe(true);
  });
  it('answers a privacy-blocked knowledge question without falsely reporting a document outage', async () => {
    const ctx = context();
    ctx.message.inboundText = 'What activities are included in the day-out package?';
    ctx.nlu!.semanticRequest = { action: 'information', service: 'day_outing', explicit: true, topicSwitch: false, pricingRequested: false, media: 'none', confidence: 0.99 };
    delete ctx.metadata!.documentRetrieval;
    ctx.metadata!.playbookDirective = { nodeId: 'privacy-blocked', nodeType: 'knowledge', runId: 0, readOnlyInformation: true };
    dispatch.mockResolvedValue({ replyText: 'The garden has native trees.', escalated: false,
      claimEvidence: [{ claim: 'The garden has native trees.', claimId: '1', origin: 'knowledge', evidenceIds: ['KB-1'], verdict: 'supported' }],
      toolCallsExecuted: [{ name: 'answer_from_knowledge_base', args: {}, status: 'success', success: true, result: {}, confirmedSideEffect: false }] });
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toBe('The garden has native trees.');
    expect(ctx.agentResult?.replyText).not.toMatch(/documents|brochure|connect you/);
    expect(ctx.metadata!.suppressBusinessEffects).toBe(true);
    expect(ctx.agentResult?.effectProposals).toEqual([]);
  });
  it('uses a general uncertainty message when an ordinary read-only question cannot be grounded', async () => {
    const ctx = context(); ctx.contextLanes!.knowledge!.status = 'unavailable';
    ctx.metadata!.playbookDirective = { nodeId: 'privacy-blocked', runId: 0, readOnlyInformation: true };
    await stage.execute(ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.agentResult?.replyText).toContain('confirmed information available');
    expect(ctx.agentResult?.replyText).not.toMatch(/documents|brochure/);
    expect(ctx.metadata?.handoffChoice.options.map((option: {label:string})=>option.label)).toEqual(['Yes','No']);
  });
  it('passes server-owned restrictions to recovery and offers help when the source cannot be confirmed', async () => {
    const ctx = context();
    ctx.message.inboundText = 'What time does breakfast finish?';
    ctx.nlu!.riskFactors = [];
    ctx.metadata!.ownerHandoffPolicy = { mode: 'customer_requests_only' };
    ctx.metadata!.agentConfig.systemPrompt = 'Breakfast hours are unconfirmed; do not quote them.';
    ctx.metadata!.playbookDirective = { nodeType: 'capability', instruction: 'Answer the direct question only.',
      capability: { name: 'knowledge.answer', kind: 'tool', args: { query: ctx.message.inboundText } } };
    dispatch.mockResolvedValue({ replyText: 'Breakfast ends at 10 PM.', escalated: false, toolCallsExecuted: [] });
    await stage.execute(ctx);
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ answerRestrictions: [
      'Breakfast hours are unconfirmed; do not quote them.', 'Answer the direct question only.',
    ] }));
    expect(ctx.agentResult?.replyText).toContain('Would you like me to connect you with a human support agent?');
    expect(ctx.agentResult?.replyText).not.toContain('10 PM');
    expect(ctx.agentResult?.handoff?.required).toBe(false);
    expect(ctx.metadata?.suppressBusinessEffects).toBe(true);
  });
  it.each([true, false])('renders the approved file menu with availability=%s without inventing facts', async available => {
    const ctx = context(); ctx.contextLanes!.knowledge!.status = 'unavailable';
    ctx.metadata!.playbookDirective = { documentService: 'resort', capability: { name: 'asset.deliver', kind: 'context' },
      resumeQuestion: 'What would you like next?\n1. More information\n2. Leisure stay\n3. Callback' };
    if (available) ctx.approvedDocument = { id: 1, userId: 9, storageFileId: 249, businessProfileId: null,
      title: 'Resort factsheet', service: 'resort', checksum: 'a'.repeat(64) };
    await stage.execute(ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.agentResult?.toolCallsExecuted).toEqual([]);
    if (available) expect(ctx.agentResult?.replyText).toContain('3. Callback');
    else {
      expect(ctx.agentResult?.replyText).toContain('We don’t have an approved document matching that request to share right now.');
      expect(ctx.metadata?.handoffChoice.options.map((option: {label:string})=>option.label)).toEqual(['Yes','No']);
      expect(ctx.agentResult?.replyText).not.toContain('Please see');
    }
    expect(ctx.metadata!.playbookDirective.compliance.verbatim).toBe(ctx.agentResult?.replyText);
  });
  it('preserves preferred contact vault references on a consented service enquiry', async () => {
    const ctx = context();
    ctx.metadata!.ownerHandoffPolicy = { mode: 'customer_requests_only' };
    ctx.metadata!.playbookDirective = { nodeType: 'capability',
      capability: { name: 'inquiry.create', kind: 'effect', effectType: 'inquiry', args: { category: 'spa', consent: true, details: { preferredDateTime: 'Tomorrow at 4 PM' } } },
      journey: { fields: { 'callback.preferredPhone': { value: '[PHONE_2]', status: 'collected', source: 'customer', vaultRef: 99 } } } };
    dispatch.mockResolvedValue({ replyText: 'Your enquiry has been noted.', escalated: false, toolCallsExecuted: [] });
    await stage.execute(ctx);
    expect(ctx.agentResult?.effectProposals).toContainEqual({ type: 'inquiry', payload: expect.objectContaining({ consent: true,
      contactReferences: [{ fieldKey: 'callback.preferredPhone', placeholder: '[PHONE_2]', vaultRef: 99 }] }) });
  });
  it('honors top-level service contact refusal without invoking a model or scheduling a callback', async () => {
    const ctx = context();
    ctx.metadata!.playbookDirective = { nodeType: 'capability',
      capability: { name: 'inquiry.create', kind: 'effect', effectType: 'inquiry', args: { category: 'spa', consent: false } } };
    await stage.execute(ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.agentResult?.replyText).toContain('No callback will be requested or scheduled');
    expect(ctx.agentResult?.effectProposals).toContainEqual({ type: 'inquiry', payload: expect.objectContaining({ consent: false }) });
  });
  function brochureContext(): PipelineContext {
    const ctx = context();
    ctx.message.inboundText = 'Could you please share the corporate brochure and pricing details for the one day office setup?';
    ctx.nlu!.intent = 'pricing_question';
    ctx.nlu!.semanticRequest = { action: 'document', service: 'corporate', explicit: true, topicSwitch: false, pricingRequested: true, media: 'none', confidence: 0.99 };
    ctx.metadata!.knowledgeQuery.risk = 'transactional';
    ctx.metadata!.playbookDirective = { runId: 0, readOnlyInformation: true, nodeType: 'capability',
      requiredAction: 'answer_from_knowledge_base', capability: { name: 'knowledge.answer', kind: 'tool', args: { query: ctx.message.inboundText } } };
    return ctx;
  }
  it.each(['insufficient', 'unavailable', 'access_denied'])('does not restart brochure intake when knowledge is %s', async (status) => {
    const ctx = brochureContext();
    ctx.contextLanes!.knowledge!.status = status as any;
    ctx.contextLanes!.knowledge!.evidence = [];
    await stage.execute(ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.agentResult?.replyText).toContain('don’t have an approved document matching that request');
    expect(ctx.agentResult?.replyText).toContain('can’t confirm the requested price');
    expect(ctx.agentResult?.replyText).not.toMatch(/company name|how many|dates|attached|₹|\$/i);
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.agentResult?.escalated).toBe(false);
    expect(ctx.metadata!.playbookDirective.compliance).toEqual({ verbatim: ctx.agentResult?.replyText });
  });
  it('does not ask the corporate questions again after provider failure', async () => {
    const ctx = brochureContext();
    dispatch.mockRejectedValue(new Error('provider unavailable'));
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('Would you like me to connect you with a human support agent?');
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.agentResult?.escalated).toBe(false);
  });
  it('can deliver an explicitly approved PDF without pretending its prices were independently verified', async () => {
    const ctx = brochureContext();
    ctx.nlu!.semanticRequest!.service = 'day_outing';
    ctx.approvedDocument = { id: 1, userId: 9, businessProfileId: null, storageFileId: 250,
      title: 'Day outing brochure', service: 'day_outing', checksum: 'a'.repeat(64) };
    ctx.contextLanes!.knowledge!.status = 'unavailable';
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('requested document');
    expect(ctx.agentResult?.replyText).toContain('can’t confirm a tailored price');
    expect(ctx.agentResult?.replyText).not.toContain('can’t provide a verified brochure');
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.agentResult?.handoff?.required).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('lets a static missing-document offer pass without KB prose, retaining approval and sentiment gates', async () => {
    const ctx = brochureContext();
    ctx.message.metadata = { executionMode: 'customer' };
    ctx.contextLanes!.knowledge!.status = 'unavailable';
    ctx.nlu!.classificationConfidence = 0.99;
    await stage.execute(ctx);
    ctx.metadata!.playbookCompliance = { passed: true };
    const gate = new ConfidenceGate();
    const scored = structuredClone(ctx);
    await expect(gate.execute(scored)).resolves.toBe(scored);
    expect(scored.confidence).toBeGreaterThan(0.9);
    const unchecked = structuredClone(ctx); unchecked.metadata!.playbookCompliance.passed = false;
    await expect(gate.execute(unchecked)).resolves.toBe(unchecked);
    expect(unchecked.agentResult?.effectProposals).toEqual([]);
    const changed = structuredClone(ctx); changed.agentResult!.replyText = 'An unsupported claim';
    await expect(gate.execute(changed)).rejects.toMatchObject({ outcome: 'pending_approval' });
    const forced = structuredClone(ctx); forced.message.metadata!.forceApproval = true;
    await expect(gate.execute(forced)).rejects.toMatchObject({ outcome: 'pending_approval' });
    const negative = structuredClone(ctx); negative.sentiment = { sentiment: 'negative', score: -0.7 } as PipelineContext['sentiment'];
    await expect(gate.execute(negative)).rejects.toMatchObject({ outcome: 'pending_approval' });
  });
  it.each(['I have attached the corporate brochure.', 'Download the brochure: https://invented.example/brochure.pdf'])('does not forward a fabricated brochure delivery: %s', async (replyText) => {
    const ctx = brochureContext();
    dispatch.mockResolvedValue({ replyText, escalated: false, toolCallsExecuted: [] });
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).not.toMatch(/attached|https?:/i);
    expect(ctx.agentResult?.replyText).toContain('don’t have an approved document matching that request');
    expect(ctx.agentResult?.effectProposals).toEqual([]);
  });
  it('keeps verified information but makes no brochure attachment or proposal promise', async () => {
    const ctx = brochureContext();
    dispatch.mockResolvedValue({ replyText: 'The garden has native trees. May I have your company name?', escalated: false,
      claimEvidence: [{ claim: 'The garden has native trees.', claimId: '1', origin: 'knowledge', evidenceIds: ['KB-1'], verdict: 'supported' }],
      toolCallsExecuted: [{ name: 'answer_from_knowledge_base', args: {}, status: 'success', success: true, result: {}, confirmedSideEffect: false }] });
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('native trees');
    expect(ctx.agentResult?.replyText).toContain('don’t have an approved document matching that request');
    expect(ctx.agentResult?.replyText).not.toMatch(/company name|proposal|attached/i);
    expect(ctx.agentResult?.answerVerification?.mayDeliver).toBe(true);
    expect(dispatch).toHaveBeenCalledWith('hotel_sales', expect.objectContaining({ conversationHistory: [],
      nlu: expect.objectContaining({ riskLevel: 'low' }) }));
    expect(ctx.metadata!.knowledgeQuery.risk).toBe('transactional');
  });
  it.each(['hotel_sales', 'tech_support', 'lead_qualifier', 'customer_success', 'general_service'])(
    'answers the resolved knowledge menu question for %s despite a clarify classification and stale journey history', async (agentType) => {
      const ctx = context();
      const query = 'published resort overview and facilities';
      ctx.message.inboundText = '1';
      ctx.nlu!.intent = 'clarify';
      ctx.metadata!.agentConfig.agentType = agentType;
      ctx.message.metadata!.conversationHistory = [{ role: 'assistant', content: 'What date is your wedding site visit?' }];
      ctx.metadata!.knowledgeQuery.redactedText = query;
      ctx.metadata!.playbookDirective = { nodeType: 'capability', requiredAction: 'answer_from_knowledge_base',
        capability: { name: 'knowledge.answer', kind: 'tool', args: { query } } };
      dispatch.mockResolvedValue({ replyText: 'Thanks! Could you please clarify what “1” refers to? For the wedding site visit, please share your preferred date.', escalated: false,
        toolCallsExecuted: [{ name: 'answer_from_knowledge_base', args: { query }, status: 'success', success: true,
          result: { grounding_status: 'sufficient' }, confirmedSideEffect: false }] });
      recover.mockResolvedValue({ replyText: 'The garden has native trees.',
        verification: { mayDeliver: true, answerGrounding: 'grounded', unsupportedClaims: [],
          claims: [{ claim: 'The garden has native trees.', claimId: '1', origin: 'knowledge', evidenceIds: ['KB-1'], verdict: 'supported' }] } });
      await stage.execute(ctx);
      expect(dispatch).toHaveBeenCalledWith(agentType, expect.objectContaining({ inboundText: query,
        conversationHistory: [], nlu: expect.objectContaining({ intent: 'faq' }) }));
      expect(ctx.agentResult?.replyText).toBe('The garden has native trees.');
      expect(ctx.agentResult?.answerVerification?.mayDeliver).toBe(true);
      expect(ctx.agentResult?.escalated).toBe(false);
      expect(ctx.message.inboundText).toBe('1');
    });

  it('does not count a clarification as a completed knowledge answer when source selection fails', async () => {
    const ctx = context();
    ctx.nlu!.intent = 'clarify';
    ctx.metadata!.playbookDirective = { nodeType: 'capability', requiredAction: 'answer_from_knowledge_base',
      capability: { name: 'knowledge.answer', kind: 'tool', args: { query: 'resort facilities' } } };
    dispatch.mockResolvedValue({ replyText: 'Could you please share more details?', escalated: false });
    await stage.execute(ctx);
    expect(ctx.agentResult?.answerVerification?.mayDeliver).toBe(false);
    expect(ctx.agentResult?.replyText).not.toContain('share more details');
  });

  it.each(['hotel_sales', 'tech_support', 'lead_qualifier', 'customer_success', 'general_service'])(
    'offers opt-in help without committing a handoff after an unsupported %s information answer', async agentType => {
      const ctx = context();
      ctx.metadata!.agentConfig.agentType = agentType;
      ctx.metadata!.ownerHandoffPolicy = { mode: 'customer_requests_only' };
      Object.assign(ctx.nlu!, { classificationConfidence: 0.99, riskFactors: [],
        semanticRequest: { action: 'information', service: 'location', explicit: true,
          topicSwitch: true, pricingRequested: false, media: 'none', confidence: 0.99 } });
      ctx.metadata!.playbookDirective = { nodeType: 'capability', requiredAction: 'answer_from_knowledge_base',
        capability: { name: 'knowledge.answer', kind: 'tool', args: { query: 'Exact resort address' } } };
      dispatch.mockResolvedValue({ replyText: 'The resort is at 123 Invented Road.', escalated: true,
        escalationReason: 'Draft requested a specialist', escalationType: 'support', handoff: { required: true } });
      await stage.execute(ctx);
      expect(ctx.agentResult?.replyText).not.toMatch(/Invented Road|specialist|call|phone|name/i);
      expect(ctx.agentResult?.replyText).toBe('I’m not sure about that from the information I have. Would you like me to connect you with a human support agent?');
      expect(ctx.agentResult?.escalated).toBe(false);
      expect(ctx.agentResult?.handoff).toEqual({ required: false });
      expect(ctx.agentResult?.escalationReason).toBeUndefined();
      expect(ctx.metadata?.rejectedKnowledgeVerification?.mayDeliver).toBe(false);
      expect(ctx.metadata?.suppressBusinessEffects).toBe(true);
      expect(ctx.agentResult?.effectProposals).toEqual([]);
      expect(ctx.agentResult?.confidence).toBe(1);
    });

  it('retains normal review eligibility without promising an uncommitted staff connection', async () => {
    const ctx = context();
    dispatch.mockResolvedValue({ replyText: 'The resort is at 123 Invented Road.', escalated: false });
    await stage.execute(ctx);
    expect(ctx.agentResult?.answerVerification?.mayDeliver).toBe(false);
    expect(ctx.agentResult?.escalated).toBe(true);
    expect(ctx.agentResult?.handoff?.required).toBe(true);
    expect(ctx.agentResult?.replyText).not.toMatch(/connect|specialist|call/i);
  });

  it.each(['medium', 'high', 'transactional'])('preserves a verified %s-risk knowledge answer without low-risk extraction', async (risk) => {
    const ctx = context();
    ctx.nlu!.riskLevel = risk === 'transactional' ? 'high' : risk as 'medium' | 'high';
    ctx.nlu!.intent = risk === 'transactional' ? 'refund_request' : 'faq';
    ctx.metadata!.knowledgeQuery.risk = risk;
    ctx.metadata!.playbookDirective = { nodeType: 'capability', requiredAction: 'answer_from_knowledge_base',
      capability: { name: 'knowledge.answer', kind: 'tool', args: { query: 'published garden facilities' } } };
    dispatch.mockResolvedValue({ replyText: 'The garden has native trees.', escalated: false,
      claimEvidence: [{ claim: 'The garden has native trees.', claimId: '1', origin: 'knowledge', evidenceIds: ['KB-1'], verdict: 'supported' }],
      toolCallsExecuted: [{ name: 'answer_from_knowledge_base', args: {}, status: 'success', success: true,
        result: { grounding_status: 'sufficient' }, confirmedSideEffect: false }] });
    await stage.execute(ctx);
    expect(ctx.agentResult?.answerVerification?.mayDeliver).toBe(true);
    expect(ctx.agentResult?.replyText).toBe('The garden has native trees.');
    expect(recover).not.toHaveBeenCalled();
  });

  it('still blocks unsupported higher-risk knowledge answers', async () => {
    const ctx = context();
    ctx.nlu!.riskLevel = 'high';
    ctx.metadata!.knowledgeQuery.risk = 'high';
    ctx.metadata!.playbookDirective = { nodeType: 'capability', requiredAction: 'answer_from_knowledge_base',
      capability: { name: 'knowledge.answer', kind: 'tool', args: { query: 'published refund policy' } } };
    dispatch.mockResolvedValue({ replyText: 'Your refund is guaranteed within one hour.', escalated: false });
    await stage.execute(ctx);
    expect(ctx.agentResult?.answerVerification?.mayDeliver).toBe(false);
    expect(ctx.agentResult?.replyText).not.toContain('guaranteed');
  });

  it('uses verbatim source recovery after a successful KB tool rather than handing off the whole FAQ', async () => {
    const ctx = context();
    dispatch.mockResolvedValue({ replyText: 'Our pool opens at 8 AM.', escalated: false,
      toolCallsExecuted: [{ name: 'answer_from_knowledge_base', args: {}, status: 'success', success: true,
        result: { grounding_status: 'sufficient' }, confirmedSideEffect: false, reconciliationStatus: 'not_required' }] });
    recover.mockResolvedValue({ replyText: 'From the published knowledge base:\nThe garden has native trees.',
      verification: { mayDeliver: true, answerGrounding: 'grounded', unsupportedClaims: [], reason: 'verbatim_published_evidence',
        claims: [{ claim: 'The garden has native trees.', claimId: '1', origin: 'knowledge', evidenceIds: ['KB-1'], verdict: 'supported' }] } });
    await stage.execute(ctx);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(ctx.agentResult?.escalated).toBe(false);
    expect(ctx.agentResult?.replyText).toContain('native trees');
    expect(ctx.metadata?.knowledgeAnswerRepair.strategy).toBe('verbatim_published_evidence');
  });
  it('does not recover failed transactions as FAQs', async () => {
    const ctx = context();
    dispatch.mockResolvedValue({ replyText: 'Your booking is confirmed.', escalated: false,
      toolCallsExecuted: [{ name: 'create_booking', args: {}, status: 'success', success: true,
        result: {}, confirmedSideEffect: false, reconciliationStatus: 'not_required' }] });
    await stage.execute(ctx);
    expect(recover).not.toHaveBeenCalled();
    expect(ctx.agentResult?.escalated).toBe(true);
  });
  it('acknowledges the price request and includes only the approved identity-free search page', async () => {
    const ctx = context();
    ctx.nlu!.intent = 'pricing_question';
    ctx.message.inboundText = 'What is price';
    ctx.nlu!.semanticRequest = { action: 'information', service: 'stay', explicit: true, topicSwitch: false, pricingRequested: true, media: 'none', confidence: 0.99 };
    ctx.metadata!.playbookDirective = { nodeType: 'collect', instruction: 'What is the check-in date?',
      journey: { missingFields: ['stay.checkIn'], fields: {} } };
    await stage.execute(ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.agentResult?.replyText).toContain('check the price');
    expect(ctx.agentResult?.replyText).toContain('https://bookings.example.com/?propertyId=10955');
    expect(ctx.agentResult?.replyText).not.toMatch(/name=|promo=|private/);
    expect(ctx.agentResult?.toolCallsExecuted).toEqual([]);
  });
  it('does not repeat pricing/link text when NLU carries pricing into a date answer', async () => {
    const ctx = context();
    ctx.nlu!.intent = 'pricing_question';
    ctx.message.inboundText = '27th sept check in';
    ctx.nlu!.semanticRequest = { action: 'continue', service: 'stay', explicit: true, topicSwitch: false, pricingRequested: false, media: 'none', confidence: 0.99 };
    ctx.metadata!.playbookDirective = { nodeType: 'collect', instruction: 'What is the check-out date?',
      journey: { missingFields: ['stay.checkOut'], fields: {
        'stay.checkIn': { value: '2026-09-27', status: 'collected', source: 'customer' },
      } } };
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('I have your check-in as 2026-09-27');
    expect(ctx.agentResult?.replyText).not.toMatch(/check the price|booking page/);
    expect(configuration).not.toHaveBeenCalled();
  });
});

describe('read-only recovery and search corrections',()=>{
  it('answers verified read-only questions before the blocked intake specialist can replace them',async()=>{
    const ctx=context(); ctx.metadata!.playbookDirective={nodeId:'privacy-blocked',readOnlyInformation:true};
    ctx.nlu!.semanticRequest={action:'information',service:'resort',explicit:true,topicSwitch:true,pricingRequested:false,media:'none',confidence:0.99};
    recover.mockResolvedValue({replyText:'Gym: 6:00 AM to 9:00 PM',verification:{mayDeliver:true,answerGrounding:'grounded',claims:[],unsupportedClaims:[]}});
    await stage.execute(ctx);
    expect(dispatch).not.toHaveBeenCalled(); expect(ctx.agentResult?.replyText).toContain('6:00 AM');
    expect(ctx.metadata?.suppressBusinessEffects).toBe(true);
  });
  it('preserves approved search dates on a guest correction without personal query data',async()=>{
    const ctx=context();ctx.metadata!.playbookDirective={nodeId:'privacy-blocked',readOnlyInformation:true};
    ctx.message.metadata!.conversationHistory=[{role:'assistant',content:'https://bookings.example.com/?propertyId=10955&checkIn=2026-11-21&checkOut=2026-11-23&adults=3&children=0&rooms=1&email=secret'}];
    ctx.nlu!.entities={adults:2,checkIn:'',checkOut:'',children:null,rooms:''};ctx.nlu!.semanticRequest={action:'correction',service:'stay',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99};
    await stage.execute(ctx);
    expect(ctx.agentResult?.replyText).toContain('checkIn=2026-11-21');expect(ctx.agentResult?.replyText).toContain('adults=2');
    expect(ctx.agentResult?.replyText).toContain('children=0');expect(ctx.agentResult?.replyText).not.toContain('secret');
  });
});
