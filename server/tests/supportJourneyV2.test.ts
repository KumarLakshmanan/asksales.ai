import { describe, expect, it } from '@jest/globals';
import type { PlaybookGraph } from '../models/supportOrchestration/schema.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';
import {
  DEFAULT_SUPPORT_PLAYBOOKS,
  INDUSTRY_SUPPORT_PLAYBOOKS,
} from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import {
  asJourneyState,
  collectNodeConsumesInbound,
  committedTerminalNode,
  isDeliveredExternalSearchRedirect,
  isCompletedPublicSearchRefinement,
  validatePlaybookGraph,
  shouldUseKnowledgeInterruption,
  shouldUseMediaInterruption,
} from '../services/agents/orchestration/PlaybookEngine.js';
import {
  collectInstruction,
  collectJourneyFields,
  initializeJourneyState,
  missingFieldsForNode,
} from '../services/agents/orchestration/SupportJourneyRuntime.js';
import {
  resolveCapabilityBindings,
  validateCapabilityBindings,
  validateResolvedCapability,
} from '../services/agents/orchestration/SupportCapabilityRegistry.js';
import { capabilityOutcomeStatus } from '../services/agents/pipeline/stages/PostProcessingStage.js';
import {
  availabilityQuoteRequiresRefresh,
  normalizeOptionalRoomPreference,
  hasGovernedExternalBookingConfirmation,
  resolveExternalCheckoutPrice,
  selectAvailableRoomTypeId,
} from '../services/agents/subagents/BookingSubAgent.js';
import { BaseOutreachAgent, type AgentInput, type AgentResult } from '../services/agents/BaseOutreachAgent.js';
import { readFileSync } from 'node:fs';
import { isStrongContactName } from '../services/InboundContactResolver.js';
import { meaningPreserved } from '../services/agents/orchestration/SupportPlaybookPresentationService.js';
import { parseExternalSearchCountCorrection } from '../services/booking/ExternalBookingSearchUrl.js';
import {
  appendPlaybookResumeQuestion,
  factualAnswerBeforeResumeQuestion,
  isClarificationOnlyKnowledgeReply,
  removeModelQuestionsFromKnowledgeAnswer,
} from '../services/agents/pipeline/stages/AgentDispatchStage.js';

class RequiredToolTestAgent extends BaseOutreachAgent {
  readonly agentName = 'required-tool-test';
  protected override getComposedTools(): any[] {
    return [
      { type: 'function', function: { name: 'check_room_availability' } },
      { type: 'function', function: { name: 'continue_external_booking' } },
    ];
  }
  tools(input: AgentInput): any[] { return this.toolsForInput(input); }
  turnTools(input: AgentInput, tools: any[], executedCount: number): any[] {
    return this.toolsForGenerationTurn(input, tools, executedCount);
  }
  async handle(): Promise<AgentResult> { return { replyText: '', escalated: false }; }
}

const fixtureGraph = (agentType: string, fieldKey: string): PlaybookGraph => ({
  schemaVersion: 2,
  entryNodeId: 'start',
  fields: [{
    key: fieldKey,
    type: 'single_select',
    required: true,
    pii: 'none',
    prompt: 'Choose an option.',
    options: [
      { value: 'first', label: 'First option', aliases: ['one'] },
      { value: 'second', label: 'Second option', aliases: ['two'] },
    ],
  }],
  nodes: [
    { id: 'start', type: 'trigger', data: {} },
    { id: 'collect', type: 'collect', data: { fieldKeys: [fieldKey] } },
    { id: 'done', type: 'complete', data: {} },
  ],
  edges: [
    { source: 'start', target: 'collect', condition: { operator: 'always' } },
    { source: 'collect', target: 'done', condition: { operator: 'all_required_fields_present' } },
  ],
  metadata: { agentType },
});

describe('configurable support journey v2', () => {
  it.each([
    ['Actually, make that 3 adults instead.',{adults:3}],
    ['0 children',{children:0}],
    ['Change it to 2 rooms.',{rooms:2}],
  ])('parses only a bounded public-search count refinement: %s',(text,expected)=>{
    expect(parseExternalSearchCountCorrection(String(text))).toEqual(expected);
  });
  it.each(['Cancel my booking','Book 3 adults','Change my reservation to 3 adults','Actually, make that 0 adults instead.','99 rooms','3 adults and refund me','No, not 3 adults'])('does not treat transactional or ambiguous text as a public-search refinement: %s',text=>{
    expect(parseExternalSearchCountCorrection(text)).toBeUndefined();
  });
  it('retains a delivered external search even when the classifier labels its count correction as a new booking',()=>{
    const run={status:'completed',currentNodeId:'external-search-complete',state:{deliveryStatus:'sent'}};
    const input={inboundText:'Actually, make that 3 adults instead.',semanticRequest:semanticIntent('booking','stay')};
    expect(isCompletedPublicSearchRefinement(run,input)).toBe(true);
    expect(isCompletedPublicSearchRefinement({...run,currentNodeId:'booking-complete'},input)).toBe(false);
    expect(isCompletedPublicSearchRefinement({...run,status:'active'},input)).toBe(false);
    expect(isCompletedPublicSearchRefinement({...run,state:{deliveryStatus:'unknown'}},input)).toBe(false);
    expect(isCompletedPublicSearchRefinement(run,{...input,inboundText:'I want a new booking for 3 adults'})).toBe(false);
    expect(isCompletedPublicSearchRefinement(run,{inboundText:'No, not 3 adults',semanticRequest:semanticIntent('correction','stay')})).toBe(false);
    expect(isCompletedPublicSearchRefinement(run,{inboundText:'Actually, make that 0 adults instead.',semanticRequest:semanticIntent('correction','stay')})).toBe(false);
  });
  it('accepts a confident date correction only for the same public stay search',()=>{
    const run={status:'completed',currentNodeId:'external-search-complete',state:{deliveryStatus:'sent'}};
    expect(isCompletedPublicSearchRefinement(run,{inboundText:'Change the dates to 21–23 November',semanticRequest:semanticIntent('correction','stay')})).toBe(true);
    expect(isCompletedPublicSearchRefinement(run,{inboundText:'I am changing topics',semanticRequest:semanticIntent('correction','stay',{topicSwitch:true})})).toBe(false);
  });
  it('accepts an exact document pin and rejects customer-controlled or malformed pins', () => {
    const graph = structuredClone(INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph);
    const node = graph.nodes.find(item => item.id === 'answer-resort-details')!;
    node.data!.args = { service: { source: 'constant', value: 'resort' }, documentId: { source: 'constant', value: 41 } };
    expect(validatePlaybookGraph(graph)).toEqual([]);
    for (const documentId of [{ source: 'constant', value: -1 }, { source: 'constant', value: '41' }, { source: 'context', key: 'conversationId' }]) {
      node.data!.args = { service: { source: 'constant', value: 'resort' }, documentId };
      expect(validatePlaybookGraph(graph).some(error => error.includes('document ID'))).toBe(true);
    }
  });
  it('rejects a menu attachment without an explicit published service', () => {
    const graph = structuredClone(INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph);
    const node = graph.nodes.find(item => item.id === 'answer-resort-details')!;
    node.data!.args = { service: { source: 'constant', value: 'arbitrary_file_name.pdf' } };
    expect(validatePlaybookGraph(graph)).toContain('Asset node answer-resort-details requires a constant approved document service.');
  });
  it('keeps explicit media requests out of the KB interruption compliance path', () => {
    expect(shouldUseKnowledgeInterruption({ intent: 'faq', mediaIntent: 'explicit' })).toBe(false);
    expect(shouldUseKnowledgeInterruption({ intent: 'faq', mediaIntent: 'none' })).toBe(true);
    expect(shouldUseKnowledgeInterruption({ intent: 'faq' })).toBe(true);
    expect(shouldUseMediaInterruption({ mediaIntent: 'explicit' })).toBe(true);
    expect(shouldUseMediaInterruption({ mediaIntent: 'helpful' })).toBe(false);
    expect(shouldUseMediaInterruption({ mediaIntent: 'none' })).toBe(false);
  });

  it('consumes a published menu choice before a broad FAQ classification can interrupt collection', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const node = template.graph.nodes.find((item) => item.id === 'collect-purpose')!;
    const state = initializeJourneyState(template.graph);
    expect(collectNodeConsumesInbound(template.graph, node, state, {
      inboundText: '4',
      intent: 'faq',
      entities: { inquiryType: 'Resort details, dining, spa, day visit, or another enquiry' },
    })).toBe(true);
    expect(collectNodeConsumesInbound(template.graph, node, state, {
      inboundText: 'What time is check-in?',
      intent: 'faq',
    })).toBe(false);
  });

  it.each(['I do not want dining', 'He said book a table', 'If I choose spa, what happens?', '1 room versus 2 rooms'])('does not classify menu intent by substring: %s', inboundText => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const node = graph.nodes.find(item => item.id === 'collect-resort-topic')!;
    const state = initializeJourneyState(graph);
    expect(collectJourneyFields(graph, node, state, { inboundText }).fields['resort.topic'].status).toBe('missing');
    expect(collectJourneyFields(graph, node, state, { inboundText, entities: { 'resort.topic': 'dining' },
      semanticRequest: semanticIntent('booking', 'dining', { explicit: false }),
    }).fields['resort.topic'].status).toBe('missing');
  });

  it.each(['Leisure stay', '1'])('consumes the exact prompted choice despite uncertain or conflicting NLU: %s', inboundText => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const node = graph.nodes.find(item => item.id === 'collect-purpose')!;
    const input = { inboundText, intent: 'booking_request', entities: { 'journey.type': 'corporate' },
      semanticRequest: semanticIntent('booking','stay',{explicit:false}) };
    const state = initializeJourneyState(graph);
    expect(collectNodeConsumesInbound(graph,node,state,input)).toBe(true);
    expect(collectJourneyFields(graph,node,state,input).fields['journey.type']).toMatchObject({value:'leisure',status:'collected'});
  });

  it.each(['I do not want a Leisure stay', 'Does Leisure stay include breakfast?'])('does not turn prose about an option into a selection: %s', inboundText => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const node = graph.nodes.find(item => item.id === 'collect-purpose')!;
    const state = collectJourneyFields(graph,node,initializeJourneyState(graph),{
      inboundText, entities:{'journey.type':'leisure'}, semanticRequest:semanticIntent('booking','stay',{explicit:false}),
    });
    expect(state.fields['journey.type'].status).toBe('missing');
  });

  it.each(['Leisure stay','1'])('does not consume a choice before its question is delivered: %s', inboundText => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const node = graph.nodes.find(item => item.id === 'collect-purpose')!;
    const state = collectJourneyFields(graph,node,initializeJourneyState(graph),{
      inboundText, allowPromptAnswer:false, entities:{'journey.type':'leisure'},
      semanticRequest:semanticIntent('booking','stay',{explicit:false}),
    });
    expect(state.fields['journey.type'].status).toBe('missing');
  });

  it('routes a free-form dining/table request into the hospitality topic branch', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const node = template.graph.nodes.find((item) => item.id === 'collect-resort-topic')!;
    const state = initializeJourneyState(template.graph);
    const text = 'I would like to request a table for 4 adults tomorrow evening.';
    const semanticRequest = semanticIntent('booking', 'dining');
    expect(collectNodeConsumesInbound(template.graph, node, state, {
      inboundText: text,
      intent: 'faq',
      semanticRequest,
    })).toBe(true);
    const next = collectJourneyFields(template.graph, node, state, { inboundText: text, semanticRequest });
    expect(next.fields['resort.topic']).toMatchObject({ value: 'dining', status: 'collected' });
  });

  it('does not consume factual questions as journey fields merely because NLU extracted entities', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const state = initializeJourneyState(template.graph);
    const stay = template.graph.nodes.find((item) => item.id === 'collect-stay')!;
    expect(collectNodeConsumesInbound(template.graph, stay, state, {
      inboundText: 'Can nine adults stay in one Premium Club Room?', intent: 'faq',
      entities: { 'stay.adults': 9, 'stay.rooms': 1, 'stay.roomPreference': 'Premium Club Room' },
    })).toBe(false);
    const purpose = template.graph.nodes.find((item) => item.id === 'collect-purpose')!;
    expect(collectNodeConsumesInbound(template.graph, purpose, state, {
      inboundText: 'Does the villa have a private garden?', intent: 'faq',
      entities: { 'journey.type': 'leisure' },
    })).toBe(false);
    const textGraph = fixtureGraph('technical_support', 'product');
    textGraph.fields![0] = { key: 'product', type: 'text', required: true, pii: 'none', prompt: 'Which product?' };
    expect(collectNodeConsumesInbound(textGraph, textGraph.nodes[1], initializeJourneyState(textGraph), {
      inboundText: 'What does error E42 mean?', intent: 'faq',
    })).toBe(false);
  });

  it('allows only exact published FAQ-labelled selections to override a factual interruption', () => {
    const graph = fixtureGraph('technical_support', 'product');
    const node = graph.nodes[1];
    const state = initializeJourneyState(graph);
    const option = graph.fields![0].options![0];
    expect(collectNodeConsumesInbound(graph, node, state, { inboundText: option.label, intent: 'faq' })).toBe(true);
    expect(collectNodeConsumesInbound(graph, node, state, {
      inboundText: `What is ${option.label}?`, intent: 'faq', entities: { product: option.value },
    })).toBe(false);
  });

  it('appends the exact suspended playbook question once after a knowledge answer', () => {
    const question = 'How can I assist you today?\n\n1. Leisure stay\n2. Resort details';
    expect(appendPlaybookResumeQuestion('The published room guide supports up to two guests.', question))
      .toBe(`The published room guide supports up to two guests.\n\n${question}`);
    expect(appendPlaybookResumeQuestion(`Answer.\n\n${question}`, question))
      .toBe(`Answer.\n\n${question}`);
    expect(factualAnswerBeforeResumeQuestion(`The room supports two guests.\n\n${question}`, question))
      .toBe('The room supports two guests.');
    expect(removeModelQuestionsFromKnowledgeAnswer('The room supports two guests.\n\nMay I have your name?\nWould you like to book?'))
      .toBe('The room supports two guests.');
    expect(isClarificationOnlyKnowledgeReply({
      replyText: `Check-in is at 14:00.\n\n${question}`,
      resumeQuestion: question,
      hasProvidedClaims: false,
      hasSuccessfulTool: false,
    })).toBe(false);
    expect(isClarificationOnlyKnowledgeReply({
      replyText: question,
      resumeQuestion: question,
      hasProvidedClaims: false,
      hasSuccessfulTool: false,
    })).toBe(true);
    expect(isClarificationOnlyKnowledgeReply({
      replyText: 'Which product version are you using?',
      hasProvidedClaims: false,
      hasSuccessfulTool: false,
    })).toBe(true);
  });

  it('keeps contact correction confirmation separate from booking confirmation', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const node = template.graph.nodes.find((item) => item.id === 'collect-booking-confirmation')!;
    const state = initializeJourneyState(template.graph);
    const prompt = collectInstruction(template.graph, node, state);
    expect(prompt).toBe('Please confirm that the room, dates, guest count, and room count are correct. Reply Yes to continue or No to stop.');
    expect(prompt).not.toMatch(/updated the name|contact profile/i);
  });

  it('rejects provider placeholders, handles, emails, and phone numbers as CRM names', () => {
    expect(isStrongContactName('Lakshmanan R')).toBe(true);
    expect(isStrongContactName('+91 733 787 7475')).toBe(false);
    expect(isStrongContactName('guest@example.com')).toBe(false);
    expect(isStrongContactName('IG User 123456')).toBe(false);
    expect(isStrongContactName('@orocircle')).toBe(false);
  });

  it('rejects AI presentation that changes the question, asks for secrets, or invents numbers', () => {
    expect(meaningPreserved('stay.adults', 'How many adults will stay?', 'How many adult guests will be staying?')).toBe(true);
    expect(meaningPreserved('stay.adults', 'How many adults will stay?', 'Please send your password.')).toBe(false);
    expect(meaningPreserved('stay.adults', 'How many adults will stay?', 'Would you like room 99?')).toBe(false);
    expect(meaningPreserved('journey.type', 'How can I assist you today?', 'How can I help with your visit?')).toBe(true);
  });
  it('publishes a valid optional hospitality template without tenant-specific literals', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2');
    expect(template).toBeDefined();
    expect(validatePlaybookGraph(template!.graph)).toEqual([]);
    const serialized = JSON.stringify(template);
    expect(serialized).not.toMatch(/ORO|10955|733\s*787\s*7475|bookings\.orocircle/i);
    expect(template!.graph.schemaVersion).toBe(2);
    expect(DEFAULT_SUPPORT_PLAYBOOKS.some((item) => item.key === template!.key)).toBe(false);
    expect(template!.assignments.some((assignment) => assignment.intent === 'lead_qualification')).toBe(true);
  });

  it('runs hospitality, SaaS, and clinic field schemas through the same validator', () => {
    const hospitality = fixtureGraph('hotel_sales', 'stay.kind');
    const saas = fixtureGraph('lead_qualifier', 'demo.product');
    const clinic = fixtureGraph('general_service', 'appointment.service');
    expect(validatePlaybookGraph(hospitality)).toEqual([]);
    expect(validatePlaybookGraph(saas)).toEqual([]);
    expect(validatePlaybookGraph(clinic)).toEqual([]);
  });

  it('collects numbered and natural-language selections from the declared field only', () => {
    const graph = fixtureGraph('general_service', 'journey.type');
    const node = graph.nodes.find((item) => item.id === 'collect')!;
    const first = collectJourneyFields(graph, node, initializeJourneyState(graph), { inboundText: '2' });
    expect(first.fields['journey.type']).toMatchObject({ value: 'second', status: 'collected' });
    const alias = collectJourneyFields(graph, node, initializeJourneyState(graph), { inboundText: 'I would like option one',
      entities: { 'journey.type': 'first' }, semanticRequest: semanticIntent('continue') });
    expect(alias.fields['journey.type']).toMatchObject({ value: 'first', status: 'collected' });
    expect(missingFieldsForNode(graph, node, alias)).toEqual([]);
  });

  it('does not collect stale classifier dates from a turn that contains no date expression', () => {
    const graph: PlaybookGraph = {
      schemaVersion: 2,
      entryNodeId: 'collect',
      fields: [{
        key: 'alternative.checkIn', type: 'date', required: true, pii: 'none',
        prompt: 'What alternative check-in date should I check?', validation: { entityKeys: ['checkIn'] },
      }],
      nodes: [{ id: 'collect', type: 'collect', data: { fieldKeys: ['alternative.checkIn'] } }],
      edges: [],
      metadata: { agentType: 'hotel_sales' },
    };
    const node = graph.nodes[0];
    const stale = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: 'Alternative dates', entities: { checkIn: '2026-10-15' },
    });
    expect(stale.fields['alternative.checkIn']).toMatchObject({ status: 'missing' });
    const explicit = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: 'Try next Friday', entities: { checkIn: '2026-10-23' },
    });
    expect(explicit.fields['alternative.checkIn']).toMatchObject({ value: '2026-10-23', status: 'collected' });
  });

  it('normalizes provider/NLU option labels instead of repeating the same question', () => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const node = graph.nodes.find((item) => item.id === 'collect-celebration')!;
    const state = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: 'Birthday',
      entities: { eventType: 'Birthday' },
    });
    expect(state.fields['celebration.eventType']).toMatchObject({ value: 'birthday', status: 'collected' });
    expect(missingFieldsForNode(graph, node, state).map((field) => field.key)).not.toContain('celebration.eventType');
  });

  it('hydrates a trusted name but requires booking-specific consent rather than collecting it again', () => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const state = initializeJourneyState(graph, {
      contactId: 44,
      leadId: 142,
      fields: {
        fullName: { value: '[NAME_1]', vaultRef: 501, trust: 'provider' },
      },
    });
    expect(state.fields['contact.fullName']).toEqual(expect.objectContaining({
      value: '[NAME_1]', status: 'verified', source: 'crm', vaultRef: 501,
    }));
    const collectContact = graph.nodes.find((node) => node.id === 'collect-booking-contact')!;
    expect(missingFieldsForNode(graph, collectContact, state).map((field) => field.key)).toContain('contact.fullName');
    expect(collectInstruction(graph, collectContact, state)).toContain('saved contact name');
  });

  it('repairs an existing active run whose CRM-bound name was initialized as missing', () => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const state = asJourneyState(graph, {
      graphVersion: 2,
      fields: { 'contact.fullName': { status: 'missing', source: 'customer' } },
    }, {
      contactId: 44,
      leadId: 142,
      fields: { fullName: { value: '[NAME_1]', vaultRef: 501, trust: 'provider' } },
    });
    expect(state.fields['contact.fullName']).toEqual(expect.objectContaining({ status: 'verified', source: 'crm' }));
  });

  it('compiles one deterministic cross-channel numbered menu from field options', () => {
    const graph = fixtureGraph('general_service', 'journey.type');
    const node = graph.nodes.find((item) => item.id === 'collect')!;
    expect(collectInstruction(graph, node, initializeJourneyState(graph))).toBe([
      'Choose an option.',
      '',
      '1. First option',
      '2. Second option',
      '',
      'Reply with a number or describe your choice in your own words.',
    ].join('\n'));
  });

  it('keeps a collect-node preface and still renders the complete numbered menu', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const node = template.graph.nodes.find((item) => item.id === 'collect-purpose')!;
    expect(collectInstruction(template.graph, node, initializeJourneyState(template.graph))).toBe([
      'Namaskar! Welcome. I can help with the following:',
      'How can I assist you today?',
      '',
      '1. Leisure stay',
      '2. Corporate offsite',
      '3. Wedding or celebration',
      '4. Resort details, dining, spa, day visit, or another enquiry',
      '',
      'Reply with a number or describe your choice in your own words.',
    ].join('\n'));
  });

  it('recognizes every document navigation branch from natural language', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const graph = template.graph;
    const purpose = graph.nodes.find((item) => item.id === 'collect-purpose')!;
    for (const [message, expected, service] of [
      ['I need a leisure stay', 'leisure', 'stay'],
      ['We are planning a corporate offsite', 'corporate', 'corporate'],
      ['I need help with a wedding', 'celebration', 'celebration'],
      ['Can you share the restaurant menu?', 'resort_information', 'dining'],
    ] as const) {
      expect(collectJourneyFields(graph, purpose, initializeJourneyState(graph), {
        inboundText: message,
        semanticRequest: semanticIntent('information', service),
      }).fields['journey.type']).toMatchObject({ value: expected, status: 'collected' });
    }

    const resortTopic = graph.nodes.find((item) => item.id === 'collect-resort-topic')!;
    for (const [message, expected] of [
      ['Resort details', 'resort'],
      ['Restaurant menu', 'dining'],
      ['Spa', 'spa'],
      ['Day outing', 'day_outing'],
      ['Things to do', 'activities'],
      ['Directions', 'location'],
      ['Something else', 'other'],
    ] as const) {
      expect(collectJourneyFields(graph, resortTopic, initializeJourneyState(graph), {
        inboundText: message,
        entities: { 'resort.topic': expected }, semanticRequest: semanticIntent('information', expected),
      }).fields['resort.topic']).toMatchObject({ value: expected, status: 'collected' });
    }
  });

  it('routes direct stay intents into the leisure fields without forcing the generic menu', () => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const startEdges = graph.edges.filter((edge) => edge.source === 'start');

    for (const intent of ['availability_inquiry', 'booking_request', 'pricing_question', 'purchase_intent']) {
      expect(startEdges).toContainEqual(expect.objectContaining({
        target: 'collect-stay',
        condition: { operator: 'matches_intent', value: intent },
      }));
    }
    expect(startEdges).toContainEqual(expect.objectContaining({
      target: 'collect-purpose',
      condition: { operator: 'always' },
    }));
  });

  it('renders every document selection field as a numbered cross-channel menu', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const graph = template.graph;
    for (const nodeId of [
      'collect-purpose', 'collect-stay-next', 'collect-unavailable-next', 'collect-resort-topic',
      'collect-resort-next', 'collect-dining-next', 'collect-spa-next', 'collect-outing-next',
      'collect-activities-next', 'collect-location-next',
    ]) {
      const node = graph.nodes.find((item) => item.id === nodeId)!;
      const rendered = collectInstruction(graph, node, initializeJourneyState(graph));
      expect(rendered).toMatch(/(?:^|\n)1\. /);
      expect(rendered).toContain('Reply with a number or describe your choice in your own words.');
    }
  });

  it('collects a compound stay answer and then explicitly asks for the room preference', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const graph = template.graph;
    const node = graph.nodes.find((item) => item.id === 'collect-stay')!;
    const state = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: '15 to 17 September for 2 adults, 1 child, and 1 room',
      entities: { checkIn: '2026-09-15', checkOut: '2026-09-17', adults: 2, children: 1, rooms: 1 },
    });
    expect(state.fields['stay.checkIn']).toMatchObject({ value: '2026-09-15', status: 'collected' });
    expect(state.fields['stay.checkOut']).toMatchObject({ value: '2026-09-17', status: 'collected' });
    expect(state.fields['stay.adults']).toMatchObject({ value: 2, status: 'collected' });
    expect(state.fields['stay.children']).toMatchObject({ value: 1, status: 'collected' });
    expect(state.fields['stay.rooms']).toMatchObject({ value: 1, status: 'collected' });
    expect(state.fields['stay.roomPreference']).toMatchObject({ status: 'missing' });
    expect(missingFieldsForNode(graph, node, state).map((field) => field.key)).toEqual(['stay.roomPreference']);
    expect(collectInstruction(graph, node, state)).toContain('Reply No preference if you would like to see every available option.');
  });

  it('collects labelled quantities and model-extracted preferences', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const graph = template.graph;
    const node = graph.nodes.find((item) => item.id === 'collect-stay')!;
    const state = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: "I'd like a leisure stay from 10 September 2026 to 12 September 2026 for 2 adults, no children, 1 room, with no room preference.",
      entities: { checkIn: '2026-09-10', checkOut: '2026-09-12', guests: 2, rooms: 1, roomPreference: 'No preference' },
    });
    expect(state.fields['stay.adults']).toMatchObject({ value: 2, status: 'collected' });
    expect(state.fields['stay.children']).toMatchObject({ value: 0, status: 'collected' });
    expect(state.fields['stay.rooms']).toMatchObject({ value: 1, status: 'collected' });
    expect(state.fields['stay.roomPreference']).toMatchObject({ value: 'No preference', status: 'collected' });
    expect(missingFieldsForNode(graph, node, state)).toEqual([]);
  });

  it('uses configured entity labels to collect multiple industry-neutral quantities', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const graph = template.graph;
    const node = graph.nodes.find((item) => item.id === 'collect-corporate')!;
    const state = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: 'Example Industries needs space for 40 attendees for 2 nights',
      entities: {},
    });
    expect(state.fields['corporate.attendees']).toMatchObject({ value: 40, status: 'collected' });
    expect(state.fields['corporate.nights']).toMatchObject({ value: 2, status: 'collected' });
  });

  it('keeps sequential free-form fields separate while accepting keyed entities', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const graph = template.graph;
    const node = graph.nodes.find((item) => item.id === 'collect-corporate')!;
    const first = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: 'Example Industries',
    });
    expect(first.fields['corporate.companyName']).toMatchObject({ value: 'Example Industries', status: 'collected' });
    expect(first.fields['corporate.preferredDates']).toMatchObject({ status: 'missing' });
    expect(first.fields['corporate.meetingRequirements']).toMatchObject({ status: 'missing' });

    const enriched = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: '40 people for 2 nights',
      entities: { attendees: 40, nights: 2 },
    });
    expect(enriched.fields['corporate.attendees']).toMatchObject({ value: 40, status: 'collected' });
    expect(enriched.fields['corporate.nights']).toMatchObject({ value: 2, status: 'collected' });
  });

  it('stores contact PII as stable tokens with a vault reference rather than raw data', () => {
    const graph: PlaybookGraph = {
      ...fixtureGraph('general_service', 'placeholder'),
      fields: [{ key: 'contact.email', type: 'email', required: true, pii: 'contact', prompt: 'What email may we use?' }],
      nodes: [
        { id: 'start', type: 'trigger', data: {} },
        { id: 'collect', type: 'collect', data: { fieldKeys: ['contact.email'] } },
        { id: 'done', type: 'complete', data: {} },
      ],
    };
    const state = collectJourneyFields(graph, graph.nodes[1], initializeJourneyState(graph), {
      inboundText: 'Email me at [EMAIL_1]', vaultId: 77,
    });
    expect(state.fields['contact.email']).toEqual({
      value: '[EMAIL_1]', status: 'collected', source: 'customer', vaultRef: 77,
    });
    expect(JSON.stringify(state)).not.toContain('customer@example.com');

    const rawEntity = collectJourneyFields(graph, graph.nodes[1], initializeJourneyState(graph), {
      inboundText: 'Email me at customer@example.com',
      entities: { email: 'customer@example.com' },
      vaultId: 77,
    });
    expect(rawEntity.fields['contact.email']).toMatchObject({ status: 'missing' });

    const tokenWithoutVault = collectJourneyFields(graph, graph.nodes[1], initializeJourneyState(graph), {
      inboundText: 'Email me at [EMAIL_1]',
    });
    expect(tokenWithoutVault.fields['contact.email']).toMatchObject({ status: 'missing' });
  });

  it('stores a contact name only as a stable privacy token', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const graph = template.graph;
    const node = graph.nodes.find((item) => item.id === 'collect-callback')!;
    const state = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: 'My name is [NAME_1]',
      entities: { fullName: '[NAME_1]' },
      vaultId: 88,
    });
    expect(state.fields['contact.fullName']).toEqual({
      value: '[NAME_1]', status: 'collected', source: 'customer', vaultRef: 88,
    });
  });

  it('resolves callback bindings and permits inquiry recording after callback refusal', () => {
    const fields = {
      'callback.time': { value: 'Tomorrow at 10:00', status: 'collected' as const, source: 'customer' as const },
      'callback.consent': { value: true, status: 'collected' as const, source: 'customer' as const },
    };
    const bindings = {
      preferredTime: { source: 'field', key: 'callback.time' },
      consent: { source: 'field', key: 'callback.consent' },
      contactAvailable: { source: 'context', key: 'contactAvailable' },
    };
    expect(validateCapabilityBindings(bindings, new Set(Object.keys(fields)))).toEqual([]);
    const args = resolveCapabilityBindings(bindings, fields, {
      channel: 'whatsapp', conversationId: 10, contactAvailable: true,
    }) as Record<string, unknown>;
    expect(args).toEqual({ preferredTime: 'Tomorrow at 10:00', consent: true, contactAvailable: true });
    expect(validateResolvedCapability('callback.request', args, { agentType: 'general_service', contactAvailable: true })).toEqual([]);
    expect(validateResolvedCapability('callback.request', { ...args, consent: false }, {
      agentType: 'general_service', contactAvailable: true,
    })).toEqual([]);
    expect(validateResolvedCapability('callback.request', { ...args, consent: undefined, preferredTime: '' }, {
      agentType: 'general_service', contactAvailable: true,
    })).toEqual(expect.arrayContaining([
      'callback.request requires explicit consent=true.',
      'callback.request requires a preferred time.',
    ]));
    expect(validateResolvedCapability('inquiry.create', {
      category: 'corporate_offsite',
      callback: { preferredTime: 'Tomorrow at 10:00', consent: true, contactAvailable: true },
    }, { agentType: 'hotel_sales', contactAvailable: true })).toEqual([]);
    expect(validateResolvedCapability('inquiry.create', {
      category: 'corporate_offsite',
      callback: { preferredTime: '', consent: false, contactAvailable: true },
    }, { agentType: 'hotel_sales', contactAvailable: true })).toEqual([]);
    expect(validateResolvedCapability('inquiry.create', {
      category: 'corporate_offsite',
      callback: { preferredTime: '', consent: true, contactAvailable: false },
    }, { agentType: 'hotel_sales', contactAvailable: false })).toEqual(expect.arrayContaining([
      'inquiry.create callback bundle requires an available contact method.',
      'inquiry.create callback bundle requires a preferred time.',
    ]));
  });

  it('resolves a typed sum binding for total stay guests', () => {
    const fields = {
      'stay.adults': { value: 2, status: 'collected' as const, source: 'customer' as const },
      'stay.children': { value: 1, status: 'collected' as const, source: 'customer' as const },
    };
    const binding = { source: 'sum' as const, keys: ['stay.adults', 'stay.children'] };
    expect(validateCapabilityBindings(binding, new Set(Object.keys(fields)))).toEqual([]);
    expect(resolveCapabilityBindings(binding, fields, {
      channel: 'whatsapp', conversationId: 10, contactAvailable: true,
    })).toBe(3);
  });

  it('prefers a collected alternative through a typed coalesce binding', () => {
    const fields = {
      'stay.checkIn': { value: '2026-10-15', status: 'collected' as const, source: 'customer' as const },
      'alternative.checkIn': { value: '2026-09-10', status: 'collected' as const, source: 'customer' as const },
    };
    const binding = { source: 'coalesce' as const, keys: ['alternative.checkIn', 'stay.checkIn'] };
    expect(validateCapabilityBindings(binding, new Set(Object.keys(fields)))).toEqual([]);
    expect(resolveCapabilityBindings(binding, fields, {
      channel: 'whatsapp', conversationId: 10, contactAvailable: true,
    })).toBe('2026-09-10');

    const withoutAlternative = {
      ...fields,
      'alternative.checkIn': { status: 'missing' as const, source: 'customer' as const },
    };
    expect(resolveCapabilityBindings(binding, withoutAlternative, {
      channel: 'whatsapp', conversationId: 10, contactAvailable: true,
    })).toBe('2026-10-15');
  });

  it('distinguishes an unavailable result from a failed availability check', () => {
    const base = {
      name: 'check_room_availability', status: 'success' as const, success: true,
      code: 'ok', confirmedSideEffect: false, reconciliationState: 'not_required' as const,
      args: {},
    };
    expect(capabilityOutcomeStatus('availability.check', { ...base, result: { available: false } })).toBe('unavailable');
    expect(capabilityOutcomeStatus('availability.check', { ...base, result: { options: [] } })).toBe('unavailable');
    expect(capabilityOutcomeStatus('availability.check', { ...base, result: { available: true, options: [{ id: 1 }] } })).toBe('success');
    expect(capabilityOutcomeStatus('availability.check', {
      ...base, status: 'failed', success: false, code: 'provider_error', result: null,
    })).toBe('failed');
    expect(capabilityOutcomeStatus('availability.check', undefined, 'tool')).toBe('failed');
    expect(capabilityOutcomeStatus('inquiry.create', undefined, 'effect')).toBe('success');
  });

  it('does not turn an explicit no-preference answer into a room-name filter', () => {
    expect(normalizeOptionalRoomPreference('No preference')).toBeUndefined();
    expect(normalizeOptionalRoomPreference('any room')).toBeUndefined();
    expect(normalizeOptionalRoomPreference('all villas')).toBeUndefined();
    expect(normalizeOptionalRoomPreference('Sanctuary Villa')).toBe('Sanctuary Villa');
  });

  it('resolves a customer room selection only within the current availability set', () => {
    const roomTypes = [
      { id: 5, name: 'Premium Club Rooms' },
      { id: 7, name: 'Sanctuary Villa Rooms' },
      { id: 8, name: 'Garden Villa Rooms' },
    ];
    expect(selectAvailableRoomTypeId('1', [5, 7], roomTypes)).toBe(5);
    expect(selectAvailableRoomTypeId('Sanctuary Villa', [5, 7], roomTypes)).toBe(7);
    expect(selectAvailableRoomTypeId('Garden Villa', [5, 7], roomTypes)).toBeUndefined();
  });

  it('uses the selected room live price instead of a stale negotiation for another room', () => {
    expect(resolveExternalCheckoutPrice({
      availabilityPrice: 16992,
      negotiatedPrice: 113870,
      negotiatedForSelectedRoom: false,
    })).toBe(16992);
    expect(resolveExternalCheckoutPrice({
      availabilityPrice: 16992,
      negotiatedPrice: 15000,
      negotiatedForSelectedRoom: true,
    })).toBe(15000);
  });

  it('refreshes checkout availability only when the selected quote is stale or missing', () => {
    const now = Date.parse('2026-08-28T09:00:00.000Z');
    expect(availabilityQuoteRequiresRefresh({
      expiresAt: '2026-08-28T09:15:00.000Z',
      availableRoomTypeIds: [5, 7],
      roomTypeId: 5,
      now,
    })).toBe(false);
    expect(availabilityQuoteRequiresRefresh({
      expiresAt: '2026-08-28T08:59:59.000Z',
      availableRoomTypeIds: [5, 7],
      roomTypeId: 5,
      now,
    })).toBe(true);
    expect(availabilityQuoteRequiresRefresh({
      expiresAt: '2026-08-28T09:15:00.000Z',
      availableRoomTypeIds: [7],
      roomTypeId: 5,
      now,
    })).toBe(true);
  });

  it('exposes only the playbook-required tool during a governed capability step', () => {
    const agent = new RequiredToolTestAgent();
    const input = {
      executionMode: 'customer',
      agentConfig: { agentType: 'hotel_sales', toolsEnabled: ['continue_external_booking'] },
      playbookDirective: {
        playbookId: 1, version: 1, runId: 1, nodeId: 'checkout', nodeType: 'capability',
        requiredAction: 'continue_external_booking', actionArgs: { room_type_name: 'Premium Club Rooms' },
        capability: { name: 'checkout.continue', kind: 'tool', args: { room_type_name: 'Premium Club Rooms' } },
      },
    } as unknown as AgentInput;
    expect(agent.tools(input).map((tool) => tool.function.name)).toEqual(['continue_external_booking']);
    expect(agent.turnTools(input, agent.tools(input), 0)).toHaveLength(1);
    expect(agent.turnTools(input, agent.tools(input), 1)).toEqual([]);
  });

  it('resolves external checkout rooms using columns present in the hotel schema', () => {
    const source = readFileSync(new URL('../services/agents/subagents/BookingSubAgent.ts', import.meta.url), 'utf8');
    expect(source).toContain('SELECT rt.id, rt.name');
    expect(source).not.toContain('rt.is_active');
  });

  it('uses committed playbook confirmation instead of fragile transcript position', () => {
    const ctx = {
      playbookDirective: {
        playbookId: 21, version: 5, runId: 8,
        nodeId: 'continue-booking', nodeType: 'capability',
        requiredAction: 'continue_external_booking',
        journey: {
          schemaVersion: 2,
          missingFields: [],
          fields: {
            'stay.confirmed': { value: true, status: 'collected', source: 'customer' },
          },
        },
      },
      history: [{ role: 'assistant', content: 'A recovery acknowledgement displaced the summary.' }],
    } as unknown as Parameters<typeof hasGovernedExternalBookingConfirmation>[0];
    expect(hasGovernedExternalBookingConfirmation(ctx)).toBe(true);
    expect(hasGovernedExternalBookingConfirmation({
      ...ctx,
      playbookDirective: {
        ...ctx.playbookDirective!,
        nodeId: 'recheck-selected-room',
      },
    })).toBe(false);
  });

  it('closes a delivered capability at its immediate terminal without consuming another customer turn', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const terminal = committedTerminalNode(template.graph, 'continue-booking', {
      graphVersion: 2,
      fields: {},
      capabilityStatus: { 'checkout.continue': 'success' },
      deliveryStatus: 'sent',
    }, {
      userId: 9,
      conversationId: 68,
      channel: 'whatsapp',
      inboundText: '',
      agentType: 'hotel_sales',
      deliveryStatus: 'sent',
    });
    expect(terminal?.id).toBe('booking-complete');
  });

  it('recognizes a delivered external search as terminal for an older availability run', () => {
    expect(isDeliveredExternalSearchRedirect({
      currentNodeId: 'check-availability',
      state: { capabilityStatus: { 'availability.check': 'redirected' }, deliveryStatus: 'sent' },
    })).toBe(true);
    expect(isDeliveredExternalSearchRedirect({
      currentNodeId: 'check-availability',
      state: { capabilityStatus: { 'availability.check': 'redirected' }, deliveryStatus: 'pending' },
    })).toBe(false);
    expect(isDeliveredExternalSearchRedirect({
      currentNodeId: 'check-availability',
      state: { capabilityStatus: { 'availability.check': 'success' }, deliveryStatus: 'sent' },
    })).toBe(false);
  });

  it('closes every delivered document enquiry at its configured terminal', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    for (const [source, target] of [
      ['request-callback', 'callback-complete'],
      ['create-corporate-inquiry', 'corporate-complete'],
      ['create-celebration-inquiry', 'celebration-complete'],
      ['create-service-inquiry', 'service-complete'],
      ['answer-information-question', 'information-complete'],
      ['request-information-callback', 'information-callback-complete'],
      ['create-other-inquiry', 'other-complete'],
    ] as const) {
      expect(committedTerminalNode(template.graph, source, {
        graphVersion: 2,
        fields: {},
        deliveryStatus: 'sent',
      }, {
        userId: 9,
        conversationId: 68,
        channel: 'whatsapp',
        inboundText: '',
        agentType: 'hotel_sales',
        deliveryStatus: 'sent',
      })?.id).toBe(target);
    }
  });

  it('models every document branch as typed configuration and requires booking confirmation', () => {
    const template = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!;
    const fieldKeys = new Set(template.graph.fields?.map((field) => field.key));
    for (const key of [
      'corporate.companyName', 'corporate.attendees', 'corporate.preferredDates',
      'celebration.eventType', 'celebration.eventDate', 'celebration.guestCount',
      'resort.topic', 'dining.nextStep', 'spa.nextStep', 'outing.nextStep',
      'activities.nextStep', 'location.nextStep', 'stay.confirmed',
    ]) expect(fieldKeys.has(key)).toBe(true);
    const nodeIds = new Set(template.graph.nodes.map((node) => node.id));
    for (const nodeId of [
      'answer-resort-details', 'answer-dining', 'answer-spa', 'answer-day-outing',
      'answer-activities', 'answer-location', 'create-service-inquiry',
      'collect-booking-confirmation',
    ]) expect(nodeIds.has(nodeId)).toBe(true);
    expect(template.graph.edges).toContainEqual(expect.objectContaining({
      source: 'collect-booking-confirmation', target: 'continue-booking',
      condition: expect.objectContaining({ field: 'stay.confirmed', value: 'true' }),
    }));
    expect(template.graph.nodes).toContainEqual(expect.objectContaining({
      id: 'continue-booking', type: 'capability',
      data: expect.objectContaining({ capabilityName: 'checkout.continue' }),
    }));
    expect(template.graph.nodes).toContainEqual(expect.objectContaining({
      id: 'recheck-selected-room', type: 'capability',
      data: expect.objectContaining({ capabilityName: 'availability.check' }),
    }));
    expect(nodeIds.has('request-corporate-callback')).toBe(false);
    expect(nodeIds.has('request-celebration-callback')).toBe(false);
    expect(template.graph.edges).toContainEqual(expect.objectContaining({
      source: 'create-corporate-inquiry', target: 'corporate-complete',
    }));
  });

  it('keeps legacy v1 instruction graphs valid and free of v2 field requirements', () => {
    const graph: PlaybookGraph = {
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'trigger', data: {} },
        { id: 'reply', type: 'message', data: { instruction: 'Provide the approved response.' } },
        { id: 'done', type: 'complete', data: {} },
      ],
      edges: [
        { source: 'start', target: 'reply', condition: { operator: 'always' } },
        { source: 'reply', target: 'done', condition: { operator: 'always' } },
      ],
    };
    expect(validatePlaybookGraph(graph)).toEqual([]);
  });

  it('rejects overlapping branch conditions at publication', () => {
    const graph: PlaybookGraph = {
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'trigger', data: {} },
        { id: 'left', type: 'complete', data: {} },
        { id: 'right', type: 'complete', data: {} },
      ],
      edges: [
        { source: 'start', target: 'left', priority: 10, condition: { operator: 'contains', value: 'book' } },
        { source: 'start', target: 'right', priority: 20, condition: { operator: 'contains', value: 'booking' } },
      ],
    };
    expect(validatePlaybookGraph(graph)).toContain('Node start has overlapping branch conditions at priorities 10 and 20.');
  });
});
