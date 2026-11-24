import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PlaybookGraph, PlaybookRunStateV2 } from '../models/supportOrchestration/schema.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';
import type { SupportSemanticIntent } from '../services/agents/orchestration/SupportSemanticIntent.js';

let graph: PlaybookGraph;
let run: any;
const execute = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ rows: [] });
const update = jest.fn();
const savePreview = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
const fixtureDb: any = {
  execute, update,
  select: () => ({ from: (table: any) => {
    const chain: any = { where: () => chain, orderBy: () => chain, limit: async () => {
      const name = getTableName(table);
      if (name === 'support_playbook_runs') return [run];
      if (name === 'support_playbooks') return [{ agentType: 'hotel_sales' }];
      if (name === 'support_playbook_versions') return [{ graph }];
      throw new Error(`Unexpected fixture read: ${name}`);
    } };
    return chain;
  } }),
  transaction: async (callback: any) => callback(fixtureDb),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: fixtureDb }));
jest.unstable_mockModule('../services/agents/orchestration/SupportPreviewStore.js', () => ({ supportPreviewStore: {
  load: async () => ({ run, graph }), save: savePreview,
} }));
jest.unstable_mockModule('../services/booking/AvailabilityProvider.js', () => ({ getAvailabilityProvider: () => { throw new Error('Live availability forbidden'); } }));
jest.unstable_mockModule('../services/booking/RecommendationService.js', () => ({ recommendationService: {} }));
jest.unstable_mockModule('../services/booking/PaymentProvider.js', () => ({
  getHotelPaymentConfiguration: async () => ({ paymentMethodsEnabled: false, externalBooking: { url: 'https://checkout.example.test' } }),
  validateExternalBookingUrlDestination: async () => 'https://checkout.example.test',
}));

const { INDUSTRY_SUPPORT_PLAYBOOKS } = await import('../services/agents/orchestration/DefaultSupportConfiguration.js');
const { initializeJourneyState, collectJourneyFields, correctJourneyFields, explicitCustomerConfirmation } = await import('../services/agents/orchestration/SupportJourneyRuntime.js');
const { playbookEngine } = await import('../services/agents/orchestration/PlaybookEngine.js');
const { explicitSpaBookingRequest } = await import('../services/agents/orchestration/HospitalityJourneyIntent.js');
const { isBrochureInformationRequest } = await import('../services/agents/orchestration/SupportInformationRequest.js');
const { bookingSubAgent } = await import('../services/agents/subagents/BookingSubAgent.js');
const turn = (inboundText: string, entities: Record<string, unknown> = {}, semanticRequest?: SupportSemanticIntent) => playbookEngine.resolve({
  userId: 9, conversationId: 10, channel: 'web', agentType: 'hotel_sales', inboundText, entities,
  semanticRequest,
  privacyVaultId: 10, contactAvailable: true, dryRun: true,
});
const spaIntent = semanticIntent('booking', 'spa', { topicSwitch: true });
const documentIntent = semanticIntent('document', 'corporate', { pricingRequested: true });
const spaTurn = (text: string) => turn(text, {}, spaIntent);
const correctionTurn = (text: string, entities: Record<string, unknown> = {}) => turn(text, entities, semanticIntent('correction', 'stay'));
function confirmedSummaryState(): PlaybookRunStateV2 {
  const state = initializeJourneyState(graph);
  const values = { 'stay.checkIn': '2030-10-10', 'stay.checkOut': '2030-10-12', 'stay.adults': 2,
    'stay.children': 0, 'stay.rooms': 1, 'stay.roomPreference': 'No preference',
    'stay.selectedRoom': 'Garden Villa', 'stay.nextStep': 'book', 'contact.fullName': '[NAME_1]' };
  for (const [key, value] of Object.entries(values)) state.fields[key] = { value, status: 'collected', source: 'customer' };
  state.pendingConfirmation = { summaryFingerprint: 'old-summary', confirmed: false };
  state.capabilityStatus = { 'availability.check': 'success' };
  return state;
}
beforeEach(() => {
  jest.clearAllMocks();
  update.mockImplementation(() => ({ set: (values: any) => ({ where: () => ({ returning: async () => {
    Object.assign(run, values);
    return [{ ...run }];
  } }) }) }));
  graph = structuredClone(INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!.graph);
  run = { id: 1, userId: 9, conversationId: 10, playbookId: 2, playbookVersion: 1,
    currentNodeId: 'collect-purpose', status: 'active', state: { ...initializeJourneyState(graph), agentType: 'hotel_sales' } };
});

describe('current-prompt journey execution', () => {
  it('advances a leisure selection without requiring generative booking intent', async () => {
    const result = await turn('Leisure stay', {}, semanticIntent('other', 'stay', { explicit: false }));
    expect(result?.nodeId).toBe('collect-stay');
    expect(result?.journey?.fields['journey.type'].value).toBe('leisure');
    expect(result?.journey?.missingFields[0]).toBe('stay.checkIn');
  });
  it('advances a room preference only to availability without reservation consent', async () => {
    run.currentNodeId = 'collect-stay';
    run.state = confirmedSummaryState();
    run.state.fields['journey.type'] = { value: 'leisure', status: 'collected', source: 'customer' };
    run.state.fields['stay.roomPreference'] = { status: 'missing' };
    const result = await turn('No preference', {}, semanticIntent('other', 'stay', { explicit: false }));
    expect(result?.nodeId).toBe('check-availability');
    expect(result?.journey?.fields['stay.roomPreference'].value).toBe('No preference');
    expect(result?.capability?.name).toBe('availability.check');
  });
  it('starts a new stay enquiry from broad lead-form ranges without guessing exact dates',async()=>{
    const result=await turn('Hello! I filled out your form and would like to know more about your business.\nWhat are you planning at Oro Resorts?: Private villa stay\nWhen are you planning your stay?: Within 2–4 weeks\nHow many guests are you planning for?: 1–2 guests',{},semanticIntent('information','stay',{topicSwitch:true}));
    expect(result?.nodeId).toBe('collect-stay');
    expect(result?.journey?.missingFields?.[0]).toBe('stay.checkIn');
    expect(result?.journey?.fields['stay.adults'].status).toBe('missing');
  });
  it.each(['What is the hotel address?', 'ஹோட்டலின் முகவரியை தமிழில் சொல்லுங்கள்.'])('answers a factual interruption without replaying intake: %s', async inboundText => {
    run.currentNodeId = 'collect-stay';
    run.state.fields['stay.checkIn'] = { value: '2030-10-10', status: 'collected', source: 'customer' };
    const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'web',
      agentType: 'hotel_sales', inboundText, intent: 'faq', entities: {}, dryRun: true,
      semanticRequest: semanticIntent('information', 'general'), contactAvailable: true });
    expect(result?.nodeId).toBe('collect-stay:knowledge-interruption');
    expect(result?.resumeQuestion).toBeUndefined();
    expect(result?.choice).toBeUndefined();
    expect(result?.instruction).toContain('requested language');
    const snapshot = savePreview.mock.calls.at(-1)?.[2];
    expect(snapshot.run.currentNodeId).toBe('collect-stay');
    expect(snapshot.run.state.fields['stay.checkIn'].value).toBe('2030-10-10');
    expect(snapshot.run.state.fields['stay.checkOut'].status).toBe('missing');
    expect(snapshot.run.state.proposedCompleted).toBe(false);
  });
  it.each(['dining','day_outing'] as const)('routes an explicit %s request out of room intake without old consent', async service => {
    run.currentNodeId='collect-stay';
    run.state.fields['callback.consent']={value:true,status:'collected',source:'customer'};
    run.state.fields['service.dateTime']={value:'OLD DATE',status:'collected',source:'customer'};
    const result=await turn('A request to arrange the selected service',{},semanticIntent('booking',service,{topicSwitch:true}));
    expect(result?.nodeId).toBe('collect-service-request');
    expect(result?.journey?.fields['resort.topic'].value).toBe(service);
    expect(result?.journey?.fields['callback.consent'].status).toBe('missing');
    expect(result?.journey?.fields['service.dateTime'].status).toBe('missing');
    expect(result?.instruction).not.toMatch(/check-in|check-out/);
  });
  it.each(['spa', 'general'] as const)('retains the exploratory service and corrected time across consecutive preview turns (%s)', async service => {
    // Model decisions are fixtures here; exercise the real engine on each turn.
    // Advance the in-memory preview only after its simulated delivery succeeds.
    const deliver = async (text: string, entities: Record<string, unknown>, intent: SupportSemanticIntent) => {
      const result = await turn(text, entities, intent);
      const snapshot = savePreview.mock.calls.at(-1)?.[2];
      expect(snapshot).toBeDefined();
      run = structuredClone(snapshot.run);
      run.currentNodeId = run.state.proposedNodeId;
      delete run.state.proposedNodeId;
      delete run.state.correctionPendingTransition;
      return result;
    };
    run.currentNodeId = 'collect-corporate';
    run.state.fields['journey.type'] = { value: 'corporate', status: 'collected', source: 'customer' };
    const switched = await deliver('Forget corporate; explore spa, do not book.', {},
      semanticIntent('information', 'spa', { topicSwitch: true }));
    expect(switched?.nodeId).toBe('collect-spa-request');
    await deliver('September 30, 2026 at 3 PM. Preview only.',
      { 'service.dateTime': 'September 30, 2026 at 3 PM' }, semanticIntent('continue', 'spa'));
    expect(run.state.fields['service.dateTime'].value).toBe('September 30, 2026 at 3 PM');
    const corrected = await deliver('Correction: one hour later that day. Do not confirm a booking.',
      { 'service.dateTime': 'September 30, 2026 at 4 PM' }, semanticIntent('correction', service));
    expect(corrected?.instruction).toContain('preferred date and time have been updated');
    expect(corrected?.instruction).not.toContain('name');
    expect(corrected?.presentation).toBeUndefined();
    expect(run.state.fields['service.dateTime'].value).toBe('September 30, 2026 at 4 PM');
    expect(run.state.fields['resort.topic'].value).toBe('spa');
    expect(run.state.fields['spa.nextStep'].value).not.toBe('book');
    expect(run.state.fields['callback.consent']?.value).not.toBe(true);
    expect(run.state.pendingConfirmation?.confirmed).not.toBe(true);
  });
  it('switches an exploratory spa request away from corporate without authorizing booking or reusing consent', async () => {
    run.currentNodeId = 'collect-corporate';
    run.state.fields['journey.type'] = { value: 'corporate', status: 'collected', source: 'customer' };
    run.state.fields['callback.consent'] = { value: true, status: 'collected', source: 'customer' };
    const result = await turn('Actually, forget the corporate event. Explore a spa appointment instead; do not book anything.', {},
      semanticIntent('information', 'spa', { topicSwitch: true }));
    expect(result?.nodeId).toBe('collect-spa-request');
    expect(result?.journey?.fields['resort.topic'].value).toBe('spa');
    expect(result?.journey?.fields['spa.nextStep'].status).toBe('missing');
    expect(result?.journey?.fields['callback.consent'].status).toBe('missing');
    expect(result?.instruction).not.toContain('company name');
  });
  it.each([
    { explicit: false, topicSwitch: true }, { explicit: true, topicSwitch: false },
    { explicit: true, topicSwitch: true, confidence: 0.4 },
  ])('does not reset a journey for an unrequested/uncertain information switch: %j', async flags => {
    run.currentNodeId = 'collect-corporate';
    const result = await turn('A spa was mentioned.', {}, semanticIntent('information', 'spa', flags));
    expect(result?.nodeId).not.toBe('collect-spa-request');
  });
  it('collects a spa date and accepts an explicit semantic correction without field-label wording', () => {
    const node = graph.nodes.find(node => node.id === 'collect-spa-request')!;
    const first = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: 'September 30, 2026 at 3 PM. Do not create a real booking.',
      entities: { 'service.dateTime': 'September 30, 2026 at 3 PM' },
      semanticRequest: semanticIntent('continue', 'spa'),
    });
    expect(first.fields['service.dateTime'].value).toBe('September 30, 2026 at 3 PM');
    const corrected = correctJourneyFields(graph, first, {
      inboundText: 'Actually, one hour later on the same day. No booking confirmation.',
      entities: { 'service.dateTime': 'September 30, 2026 at 4 PM' },
      semanticRequest: semanticIntent('correction', 'spa'),
    });
    expect(corrected.changedFields).toContain('service.dateTime');
    expect(corrected.state.fields['service.dateTime'].value).toBe('September 30, 2026 at 4 PM');
    expect(corrected.state.fields['callback.consent']?.value).not.toBe(true);
  });
  const brochureRequest = 'Could you please share the corporate brochure and pricing details for the one day office setup?';
  it.each([
    semanticIntent('information', 'corporate'),
    { ...documentIntent, explicit: false },
    { ...documentIntent, confidence: 0.5 },
  ])('does not broaden FAQ assignment without a confident explicit document intent: %j', async semanticRequest => {
    run = undefined;
    execute.mockResolvedValue({ rows: [] });
    await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'web', agentType: 'hotel_sales',
      inboundText: brochureRequest, intent: 'pricing_question', semanticRequest });
    const query = execute.mock.calls.map(([sql]) => new PgDialect().sqlToQuery(sql))
      .find(query => query.sql.includes('support_playbook_assignments'))!;
    const faqParameter = Number(query.sql.match(/\$(\d+) AND a\.intent = 'faq'/)?.[1]);
    expect(faqParameter).toBeGreaterThan(0);
    expect(query.params[faqParameter - 1]).toBe(false);
  });
  it.each([true, false])('handles document requests in legacy message-only playbooks (existing run: %s)', async existingRun => {
    graph = { entryNodeId: 'faq', nodes: [{ id: 'faq', type: 'message', position: { x: 0, y: 0 },
      data: { instruction: 'Answer from verified knowledge.' } }], edges: [] };
    if (!existingRun) {
      run = undefined;
      execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
        playbook_id: 3, active_version: 1, agent_type: 'hotel_sales', traffic_percent: 100, graph,
      }] });
    }
    const before = structuredClone(run);
    const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'web', agentType: 'hotel_sales',
      inboundText: brochureRequest, intent: 'pricing_question', semanticRequest: documentIntent });
    expect(result).toMatchObject({ runId: 0, readOnlyInformation: true, requiredAction: 'answer_from_knowledge_base' });
    expect(result?.journey).toBeUndefined();
    expect(result?.resumeQuestion).toBeUndefined();
    expect(run).toEqual(before);
    expect(update).not.toHaveBeenCalled();
    if (!existingRun) {
      const query = execute.mock.calls.map(([sql]) => new PgDialect().sqlToQuery(sql))
        .find(query => query.sql.includes('support_playbook_assignments'))!;
      expect(query.sql).toContain("AND a.intent = 'faq'");
      expect(query.params).toContain(true);
    }
  });
  it.each(['faq', 'pricing_question', 'booking_request'])('answers the screenshot brochure request without consuming intake despite %s classification', async (intent) => {
    run.currentNodeId = 'collect-corporate';
    run.state.fields['corporate.companyName'] = { value: '[COMPANY_1]', status: 'collected', source: 'customer' };
    run.state.fields['corporate.attendees'] = { value: 35, status: 'collected', source: 'customer' };
    run.state.proposedNodeId = 'collect-corporate-contact';
    run.state.proposedEventKey = 'older-undelivered-event';
    const before = structuredClone(run);
    const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'whatsapp', agentType: 'hotel_sales',
      inboundText: brochureRequest, intent, semanticRequest: documentIntent, dryRun: true });
    expect(result).toMatchObject({ runId: 0, readOnlyInformation: true, requiredAction: 'answer_from_knowledge_base',
      capability: { name: 'knowledge.answer', args: { query: brochureRequest } } });
    expect(result?.journey).toBeUndefined();
    expect(result?.resumeQuestion).toBeUndefined();
    expect(run).toEqual(before);
    expect(update).not.toHaveBeenCalled();
  });
  it('does not create a fresh enquiry after the previous corporate run has completed', async () => {
    run = undefined;
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      playbook_id: 21, active_version: 13, agent_type: 'hotel_sales', traffic_percent: 100, graph,
    }] });
    const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'whatsapp', agentType: 'hotel_sales',
      inboundText: brochureRequest, intent: 'pricing_question', semanticRequest: documentIntent });
    expect(result).toMatchObject({ runId: 0, readOnlyInformation: true, playbookId: 21, version: 13 });
    expect(result?.requiredAction).toBe('answer_from_knowledge_base');
    expect(update).not.toHaveBeenCalled();
    // The fixture deliberately has no insert method: starting intake is a failure.
  });
  it.each(['proposal_create', 'booking', 'refund', 'unclear'] as const)('does not swallow model action %s', action => {
    expect(isBrochureInformationRequest(semanticIntent(action))).toBe(false);
  });
  it('requires affirmative confident AI classification, not matching words', () => {
    expect(explicitSpaBookingRequest(spaIntent)).toBe(true);
    for (const request of [undefined, semanticIntent('information', 'spa'), semanticIntent('booking', 'stay'),
      semanticIntent('booking', 'spa', { explicit: false }), semanticIntent('booking', 'spa', { confidence: 0.5 })]) {
      expect(explicitSpaBookingRequest(request)).toBe(false);
    }
    expect(isBrochureInformationRequest(semanticIntent('document', 'corporate', { explicit: false }))).toBe(false);
  });
  it('switches even with stale FAQ classification and then collects only spa fields', async () => {
    run.currentNodeId = 'collect-corporate';
    const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'whatsapp',
      agentType: 'hotel_sales', inboundText: "I'd like to book a Spa Slot", intent: 'faq', semanticRequest: spaIntent, dryRun: true });
    expect(result?.nodeId).toBe('collect-spa-request');
    run.currentNodeId = result!.nodeId;
    run.state = { ...initializeJourneyState(graph), fields: result!.journey!.fields };
    const date = await turn('Tomorrow at 4 PM', { 'service.dateTime': 'Tomorrow at 4 PM' }, semanticIntent('continue', 'spa'));
    expect(date?.journey?.fields['service.dateTime'].value).toBe('Tomorrow at 4 PM');
    expect(date?.journey?.missingFields).toEqual(['contact.fullName', 'callback.preferredPhone', 'callback.consent']);
    expect(date?.requiredAction).not.toBe('create_booking');
  });
  it('supports immutable v13 shared intake without asking spa guest counts', async () => {
    graph.nodes = graph.nodes.filter(node => node.id !== 'collect-spa-request');
    graph.edges = graph.edges.filter(edge => edge.source !== 'collect-spa-request');
    graph.edges.find(edge => edge.source === 'collect-spa-next' && edge.condition?.value === 'book')!.target = 'collect-service-request';
    const result = await spaTurn("I'd like to book a Spa Slot");
    expect(result?.nodeId).toBe('collect-service-request');
    expect(result?.journey?.missingFields).not.toEqual(expect.arrayContaining(['service.adults', 'service.children']));
    run.currentNodeId = result!.nodeId;
    run.state = { ...run.state, fields: result!.journey!.fields };
    const date = await turn('Tomorrow at 4 PM', { adults: 2, children: 0 });
    expect(date?.journey?.fields['service.adults'].status).toBe('missing');
    expect(date?.journey?.missingFields[0]).toBe('contact.fullName');
  });
  it.each(['collect-spa-request', 'collect-service-request'])('does not restart %s for an AI-classified spa booking continuation', async nodeId => {
    if (nodeId === 'collect-service-request') {
      graph.nodes = graph.nodes.filter(node => node.id !== 'collect-spa-request');
      graph.edges = graph.edges.filter(edge => edge.source !== 'collect-spa-request');
      graph.edges.find(edge => edge.source === 'collect-spa-next' && edge.condition?.value === 'book')!.target = nodeId;
    }
    run.currentNodeId = nodeId;
    run.state.fields['resort.topic'] = { value: 'spa', status: 'collected', source: 'customer' };
    const result = await turn('23 September 2026 at 4 PM.', { 'service.dateTime': '23 September 2026 at 4 PM.' },
      semanticIntent('booking', 'spa', { topicSwitch: false }));
    expect(result?.journey?.fields['service.dateTime']).toMatchObject({ value: '23 September 2026 at 4 PM.', status: 'collected' });
    expect(result?.journey?.missingFields[0]).toBe('contact.fullName');
    expect(result?.requiredAction).not.toBe('create_booking');
  });
  it('does not store a repeated spa booking request as a date', async () => {
    run.currentNodeId = 'collect-spa-request';
    run.state.fields['resort.topic'] = { value: 'spa', status: 'collected', source: 'customer' };
    const result = await turn("I'd like to book a Spa Slot", {}, semanticIntent('booking', 'spa'));
    expect(result?.journey?.fields['service.dateTime'].status).toBe('missing');
    expect(result?.journey?.missingFields[0]).toBe('service.dateTime');
    expect(result?.requiredAction).not.toBe('create_booking');
  });
  it.each(['spa', 'dining', 'day_outing'] as const)('does not store an undated %s continuation as a date', async service => {
    run.currentNodeId = service === 'spa' ? 'collect-spa-request' : 'collect-service-request';
    run.state.fields['resort.topic'] = { value: service, status: 'collected', source: 'customer' };
    const result = await turn("I haven't chosen a date yet.", {}, semanticIntent('continue', service, { explicit: false }));
    expect(result?.journey?.fields['service.dateTime'].status).toBe('missing');
    expect(result?.journey?.missingFields[0]).toBe('service.dateTime');
  });
  it('does not route into a service absent from the published graph', async () => {
    graph.edges = graph.edges.filter(edge => edge.source !== 'collect-spa-next');
    run.currentNodeId = 'collect-corporate';
    expect((await spaTurn("I'd like to book a Spa Slot"))?.nodeId).toBe('collect-corporate');
  });
  it.each(['No', 'No callback needed', 'No thanks'])('finishes a spa enquiry with refusal %s, without booking or guest counts', async (refusal) => {
    run.currentNodeId = 'collect-corporate';
    let result = await spaTurn("I'd like to book a Spa Slot tomorrow");
    for (const answer of ['Tomorrow at 4 PM', '[NAME_1]', '[PHONE_1]', refusal]) {
      run.currentNodeId = result!.nodeId;
      run.state = { ...run.state, fields: result!.journey!.fields };
      result = await turn(answer);
    }
    expect(result?.nodeId).toBe('create-service-inquiry');
    expect(result?.capability?.validationErrors).toBeUndefined();
    expect(result?.capability?.args).toMatchObject({ category: 'spa', details: { preferredDateTime: 'Tomorrow at 4 PM' }, consent: false });
    expect(result?.journey?.fields['service.adults'].status).toBe('missing');
    expect(result?.journey?.fields['service.children'].status).toBe('missing');
    expect(result?.instruction).toContain('Do not claim');
  });
  it('holds a spa switch on the proposed node until its prompt is delivered', async () => {
    run.currentNodeId = 'collect-corporate';
    const input = { userId: 9, conversationId: 10, channel: 'whatsapp', agentType: 'hotel_sales',
      inboundText: "I'd like to book a Spa Slot", semanticRequest: spaIntent, eventKey: 'spa-switch-1' };
    await playbookEngine.resolve(input);
    expect(run.currentNodeId).toBe('collect-corporate');
    expect(run.state.proposedNodeId).toBe('collect-spa-request');
    expect(run.state.correctionPendingTransition).toBe(true);
    expect((await playbookEngine.resolve(input))?.nodeId).toBe('collect-spa-request');
    const recovery = await playbookEngine.resolve({ ...input, inboundText: 'Yes', eventKey: 'spa-switch-2' });
    expect(recovery?.nodeId).toBe('collect-spa-request');
    expect(recovery?.journey?.fields['service.dateTime'].status).toBe('missing');
    await playbookEngine.commitProposedTransition(9, run.id, { deliveryStatus: 'delivered' });
    expect(run.currentNodeId).toBe('collect-spa-request');
    expect(run.state.correctionPendingTransition).toBeUndefined();
  });
  it.each(['collect-corporate', 'collect-stay', 'start', 'collect-resort-topic'])('routes the screenshot spa request away from %s', async (nodeId) => {
    run.currentNodeId = nodeId;
    run.state.fields['journey.type'] = { value: 'corporate', status: 'collected', source: 'customer' };
    for (const [key, value] of Object.entries({ 'corporate.companyName': '[COMPANY_1]', 'corporate.attendees': 20, 'corporate.preferredDates': 'Tomorrow' })) {
      run.state.fields[key] = { value, status: 'collected', source: 'customer' };
    }
    run.state.fields['callback.consent'] = { value: true, status: 'collected', source: 'customer' };
    const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'whatsapp', agentType: 'hotel_sales',
      inboundText: "I'd like to book a Spa Slot", intent: 'booking_request', semanticRequest: spaIntent, dryRun: true });
    expect(result?.nodeId).toBe('collect-spa-request');
    expect(result?.journey?.fields['resort.topic'].value).toBe('spa');
    expect(result?.journey?.fields['service.dateTime'].status).toBe('missing');
    expect(result?.journey?.fields['callback.consent'].status).toBe('missing');
    expect(result?.journey?.missingFields).toEqual(['service.dateTime', 'contact.fullName', 'callback.preferredPhone', 'callback.consent']);
    expect(result?.instruction).toContain('What date and time');
    expect(result?.instruction).not.toMatch(/nights|meeting|rooms|adults|children/i);
    expect(run.currentNodeId).toBe(nodeId);
  });

  it('consumes the requested factual follow-up instead of repeating its question prompt', async () => {
    run.currentNodeId = 'collect-information-question';
    const inboundText = 'What are the check-in and check-out times?';
    const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'web', agentType: 'hotel_sales',
      inboundText, intent: 'faq', privacyVaultId: 10, contactAvailable: true, dryRun: true });
    expect(result?.nodeId).toBe('answer-information-question');
    expect(result?.capability?.args.query).toBe(inboundText);
    expect(result?.resumeQuestion).toBeUndefined();
  });

  it.each([
    ['collect-dining-next', 'dining', 'collect-information-callback'],
    ['collect-spa-next', 'spa', 'collect-information-callback'],
    ['collect-outing-next', 'day_outing', 'collect-information-callback'],
  ])('follows the documented callback details at %s', async (node, topic, destination) => {
    run.currentNodeId = node;
    run.state.fields['resort.topic'] = { value: topic, status: 'collected', source: 'customer' };
    const result = await turn('2');
    expect(result?.nodeId).toBe(destination);
    expect(result?.journey?.missingFields).toEqual(graph.nodes.find(item => item.id === destination)!.data!.fieldKeys);
    expect(result?.journey?.missingFields).toContain('callback.preferredPhone');
    expect(result?.journey?.missingFields).toContain('callback.consent');
    expect(result?.journey?.missingFields).not.toContain('service.dateTime');
  });

  it.each([
    ['1', 'answer-resort-details', 'resort.detailsNextStep'],
    ['2', 'answer-dining', 'dining.nextStep'],
    ['3', 'answer-spa', 'spa.nextStep'],
    ['4', 'answer-day-outing', 'outing.nextStep'],
    ['5', 'answer-activities', 'activities.nextStep'],
    ['6', 'answer-location', 'location.nextStep'],
  ])('includes the published continuation after resort topic %s', async (selection, nodeId, nextField) => {
    run.currentNodeId = 'collect-resort-topic';
    run.state.fields['journey.type'] = { value: 'resort_information', status: 'collected', source: 'customer' };
    const result = await turn(selection);
    expect(result?.nodeId).toBe(nodeId);
    expect(result?.resumeQuestion).toContain('1.');
    if (['1', '4'].includes(selection)) {
      expect(result?.capability).toMatchObject({ name: 'asset.deliver', kind: 'context' });
      expect(result?.documentService).toBe(selection === '1' ? 'resort' : 'day_outing');
      expect(result?.requiredAction).toBeUndefined();
    } else {
      expect(result?.compliance?.assertions).toEqual(expect.arrayContaining([
        { type: 'grounding_is', value: 'grounded' }, { type: 'has_supported_claims' },
      ]));
      expect(playbookEngine.evaluateCompliance(result!, { replyText: 'What does 1 mean?',
        toolOutcomes: [{ name: 'answer_from_knowledge_base', args: {}, result: {}, status: 'success', success: true, confirmedSideEffect: false }],
      }).passed).toBe(false);
    }
    run.currentNodeId = result!.nodeId;
    run.state = { ...run.state, fields: result!.journey!.fields, capabilityStatus: { [result!.capability!.name]: 'success' } };
    const next = await turn('1');
    expect(next?.journey?.fields[nextField].status).toBe('collected');
  });

  it('does not reuse the hotel menu answer 4 as the unasked resort-topic answer 4', async () => {
    const result = await turn('4');
    expect(result?.nodeId).toBe('collect-resort-topic');
    expect(result?.journey?.fields['journey.type']).toMatchObject({ value: 'resort_information' });
    expect(result?.journey?.fields['resort.topic']).toMatchObject({ status: 'missing' });
    expect(result?.instruction).toContain('Which resort topic can I help with?');
    expect(update).not.toHaveBeenCalled();
    // Preview transitions are serialized, but never update a customer run.
    expect(execute).toHaveBeenCalledTimes(1);
    // Only a fresh answer to the delivered topic menu may select day outing.
    run.currentNodeId = result!.nodeId;
    run.state = { ...run.state, fields: result!.journey!.fields };
    expect((await turn('4'))?.nodeId).toBe('answer-day-outing');
  });

  it('does not trust an unlabelled downstream classifier choice on the same numbered turn', async () => {
    const result = await turn('4', { 'resort.topic': 'day_outing' });
    expect(result?.nodeId).toBe('collect-resort-topic');
    expect(result?.journey?.fields['resort.topic'].status).toBe('missing');
  });

  it('preserves explicitly named downstream choices and labelled numeric extraction', async () => {
    expect((await turn('I want resort information about the spa', { 'resort.topic': 'spa' },
      semanticIntent('information', 'spa', { topicSwitch: true })))?.nodeId).toBe('answer-spa');
    const node = graph.nodes.find((item) => item.id === 'collect-stay')!;
    const state = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: '2 adults, 1 child, 1 room', entities: { adults: 2, children: 1, rooms: 1 }, allowPromptAnswer: false,
    });
    expect(state.fields['stay.adults']).toMatchObject({ value: 2, status: 'collected' });
    expect(state.fields['stay.children']).toMatchObject({ value: 1, status: 'collected' });
    expect(state.fields['stay.rooms']).toMatchObject({ value: 1, status: 'collected' });
  });

  it('does not apply a bare number to a second numeric collect node', () => {
    const node = graph.nodes.find((item) => item.id === 'collect-stay')!;
    const state = collectJourneyFields(graph, node, initializeJourneyState(graph), { inboundText: '3', allowPromptAnswer: false });
    expect(Object.values(state.fields).every((field) => field.status === 'missing')).toBe(true);
  });

  it('treats a callback refusal as a compliant no-op capability', async () => {
    const state = initializeJourneyState(graph);
    state.fields['contact.fullName'] = { value: '[NAME_1]', status: 'collected', source: 'customer' };
    state.fields['callback.preferredPhone'] = { value: '[PHONE_1]', status: 'collected', source: 'customer', vaultRef: 90 };
    state.fields['callback.preferredTime'] = { value: 'QA test only', status: 'collected', source: 'customer' };
    state.fields['callback.consent'] = { value: false, status: 'collected', source: 'customer' };
    run.currentNodeId = 'collect-callback';
    run.state = { ...state, agentType: 'hotel_sales' };

    const directive = await turn('No');

    expect(directive?.nodeId).toBe('request-callback');
    expect(directive?.capability?.validationErrors).toBeUndefined();
    expect(directive?.compliance?.assertions).not.toContainEqual({ type: 'effect_proposed', effectType: 'callback' });
  });
});

describe('booking correction and fresh consent', () => {
  beforeEach(() => { run.currentNodeId = 'collect-booking-confirmation'; run.state = { ...confirmedSummaryState(), agentType: 'hotel_sales' }; });

  it('updates a conditional correction, clears consent, and rechecks the complete new summary', async () => {
    const result = await correctionTurn('Yes, but change the adults to 3', { adults: 3, confirmed: true });
    expect(result?.nodeId).toBe('recheck-selected-room');
    expect(result?.requiredAction).toBe('check_room_availability');
    expect(result?.actionArgs).toMatchObject({ guests: 3, rooms: 1, check_in: '2030-10-10', check_out: '2030-10-12', room_type: 'Garden Villa' });
    expect(result?.journey?.fields['stay.confirmed'].status).toBe('missing');
    expect(result?.instruction).toContain('canonical verified booking summary');
    const corrected = correctJourneyFields(graph, confirmedSummaryState(), { inboundText: 'Actually adults should be 3', entities: { adults: 3 }, semanticRequest: semanticIntent('correction', 'stay') });
    expect(corrected.state.pendingConfirmation).toBeUndefined();
    expect(corrected.state.capabilityStatus).toBeUndefined();
    // Simulate commit of the verified new summary; a later Yes can continue.
    run.currentNodeId = result!.nodeId;
    run.state = { ...run.state, fields: result!.journey!.fields, capabilityStatus: { 'availability.check': 'success' } };
    expect((await turn('Yes'))?.nodeId).toBe('continue-booking');
  });

  it('re-collects checkout when a corrected check-in invalidates the previous date range', async () => {
    const result = await correctionTurn('Actually change check-in to 2030-10-14');
    expect(result?.nodeId).toBe('collect-stay');
    expect(result?.journey?.fields['stay.checkIn']).toMatchObject({ value: '2030-10-14' });
    expect(result?.journey?.fields['stay.checkOut'].status).toBe('invalid');
    expect(result?.journey?.fields['stay.confirmed'].status).toBe('missing');
    expect(result?.instruction).toContain('What is the check-out date?');
    expect(result?.requiredAction).toBeUndefined();
  });

  it('does not accept a fresh Yes against the old summary if delivery of the corrected summary failed', async () => {
    const corrected = await correctionTurn('Adults: 3');
    // Resolution persists proposed fields before the delivery commit. The old
    // node stays at confirmation until the new verified summary is delivered.
    run.state = { ...run.state, fields: corrected!.journey!.fields, capabilityStatus: {},
      correctionPendingTransition: true, proposedNodeId: corrected!.nodeId, proposedEventKey: 'correction-message' };
    const retry = await turn('Yes');
    expect(retry?.nodeId).toBe('recheck-selected-room');
    expect(retry?.actionArgs?.guests).toBe(3);
    expect(retry?.journey?.fields['stay.confirmed'].status).toBe('missing');
    expect(retry?.requiredAction).not.toBe('continue_external_booking');
    await playbookEngine.commitProposedTransition(9, 1, {
      capabilityName: 'availability.check', capabilityStatus: 'success', deliveryStatus: 'sent',
    });
    expect(run.state.correctionPendingTransition).toBeUndefined();
    expect(run.currentNodeId).toBe('recheck-selected-room');
    expect((await turn('Yes'))?.nodeId).toBe('continue-booking');
  });

  it('completes a delivered external search when an older graph lacks the terminal edge', async () => {
    graph.nodes = graph.nodes.filter((node) => node.id !== 'external-search-complete');
    graph.edges = graph.edges.filter((edge) => edge.target !== 'external-search-complete');
    run.currentNodeId = 'check-availability';
    run.state = {
      ...initializeJourneyState(graph),
      agentType: 'hotel_sales',
      proposedNodeId: 'check-availability',
      proposedCompleted: false,
      proposedEventKey: 'redirected-search-event',
    };

    await playbookEngine.commitProposedTransition(9, 1, {
      capabilityName: 'availability.check', capabilityStatus: 'redirected', deliveryStatus: 'sent',
    });

    expect(run.status).toBe('completed');
    expect(run.state.completedTerminalNodeId).toBe('external-search-complete');
    expect(run.state.proposedNodeId).toBeUndefined();
  });

  it('repairs a previously stuck delivered external-search run before consuming a new message', async () => {
    run.currentNodeId = 'check-availability';
    run.state = {
      ...initializeJourneyState(graph),
      agentType: 'hotel_sales',
      lastEventKey: 'previous-search-event',
      capabilityStatus: { 'availability.check': 'redirected' },
      deliveryStatus: 'sent',
    };

    const result = await playbookEngine.resolve({
      userId: 9,
      conversationId: 10,
      channel: 'whatsapp',
      agentType: 'hotel_sales',
      inboundText: 'Corporate offsite',
      intent: 'booking_request',
      entities: {},
      eventKey: 'new-customer-event',
    });

    expect(result).toBeNull();
    expect(run.status).toBe('completed');
    expect(run.state.completedTerminalNodeId).toBe('external-search-complete');
  });

  it('refreshes a specifically corrected room without relying on a model entity', async () => {
    const result = await correctionTurn('Actually change selected room to Pool Villa');
    expect(result?.nodeId).toBe('recheck-selected-room');
    expect(result?.actionArgs?.room_type).toBe('Pool Villa');
    expect(result?.journey?.fields['stay.confirmed'].status).toBe('missing');
  });

  it('re-collects a corrected checkout that precedes check-in', async () => {
    const result = await correctionTurn('Change check-out to 2030-10-09');
    expect(result?.nodeId).toBe('collect-stay');
    expect(result?.journey?.fields['stay.checkOut']).toMatchObject({ value: '2030-10-09', status: 'invalid' });
    expect(result?.requiredAction).toBeUndefined();
  });

  it('does not accept an impossible corrected calendar date', async () => {
    const result = await correctionTurn('Actually change check-in to 2030-02-30');
    expect(result?.nodeId).toBe('collect-stay');
    expect(result?.journey?.fields['stay.checkIn'].status).toBe('invalid');
    expect(result?.requiredAction).toBeUndefined();
  });

  it('re-collects an invalid corrected count instead of truncating or submitting it', async () => {
    const result = await correctionTurn('Actually change adults to 2.5', { adults: 2.5 });
    expect(result?.nodeId).toBe('collect-stay');
    expect(result?.journey?.fields['stay.adults'].status).toBe('invalid');
    expect(result?.instruction).toContain('How many adults');
  });

  it.each(['Adults: 3', 'There are 3 adults', 'Yes, 3 adults'])('treats a labelled fact at confirmation as a correction, not consent: %s', async (text) => {
    const result = await correctionTurn(text);
    expect(result?.nodeId).toBe('recheck-selected-room');
    expect(result?.actionArgs?.guests).toBe(3);
    expect(result?.journey?.fields['stay.confirmed'].status).toBe('missing');
  });

  it('does not mutate the stay from a hypothetical factual question mentioning adults', async () => {
    const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'web', agentType: 'hotel_sales',
      inboundText: 'What is the price for 3 adults?', intent: 'faq', entities: { adults: 3 }, dryRun: true });
    expect(result?.nodeType).toBe('knowledge');
    expect(result?.journey?.fields['stay.adults'].value).toBe(2);
    expect(result?.journey?.fields['stay.confirmed'].status).toBe('missing');
  });

  it.each(['Yes, if the price drops', 'Yes but not yet', 'Maybe', 'I did not confirm', 'Please do not book it'])('never treats mixed/conditional text as confirmation: %s', async (text) => {
    const result = await turn(text, { confirmed: true });
    expect(result?.nodeId).not.toBe('continue-booking');
    expect(result?.journey?.fields['stay.confirmed'].value).not.toBe(true);
  });

  it('accepts a fresh plain Yes and declines a plain No', async () => {
    expect((await turn('Yes'))?.nodeId).toBe('continue-booking');
    expect((await turn('No'))?.nodeId).toBe('booking-declined');
  });

  it.each(['No, do not book it', 'Please do not book it', 'Yes, but change the adults to 3'])('denies adapter fallback consent: %s', async (text) => {
    const ctx: any = { userId: 9, conversationId: 10, channel: 'web', inboundText: text,
      slots: { checkIn: '2030-10-10', checkOut: '2030-10-12', guests: 2, rooms: 1, roomTypeId: 7 },
      lead: { name: 'Synthetic Guest', email: 'synthetic@example.test' }, history: [], nlu: { entities: {} }, memory: {} };
    const result = await bookingSubAgent.execute('create_booking', { room_type_id: 7, agreed_price_per_night: 100 }, ctx);
    expect(result.toolResults?.[0].result.booked).toBe(false);
    expect(result.effectProposals).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['Yes', 'Yes, please proceed', 'I confirm the booking', 'Go ahead', 'Please book'])('accepts unqualified affirmative text: %s', (text) => {
    expect(explicitCustomerConfirmation(text)).toBe(true);
  });
});
