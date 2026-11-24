import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AgentInput } from '../services/agents/BaseOutreachAgent.js';
import type { DefaultSupportPlaybook } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import type { PlaybookGraph } from '../models/supportOrchestration/schema.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';
import { SUPPORT_CAPABILITY_NAMES } from '../../shared/supportCapabilities.js';
import { SUPPORT_CAPABILITIES } from '../services/agents/orchestration/SupportCapabilityRegistry.js';

const dialect = new PgDialect();
let selectedDefinition: DefaultSupportPlaybook;
let activeRun: any;
let activeGraph: PlaybookGraph | undefined;
const savePreview = jest.fn<any>();
let proposalTools: any[] = [];
const writes = jest.fn();
const queries: Array<{ sql: string; params: unknown[] }> = [];
const chat = jest.fn<(...args: any[]) => Promise<any>>();
const dispatch = jest.fn<(...args: any[]) => Promise<any>>(async name => ({
  toolResults: [{ name, result: { success: true, confirmedSideEffect: true, proposal_id: 77, seller_review_required: true, delivered: false } }],
}));
const fixtureDb: any = {
  select: () => ({ from: (table: any) => {
    const name = getTableName(table);
    const rows = () => name === 'support_playbook_runs' ? (activeRun ? [activeRun] : [])
      : name === 'support_playbooks' ? [{ agentType: selectedDefinition.agentType }]
        : name === 'support_playbook_versions' ? [{ graph: activeGraph || selectedDefinition.graph }] : [];
    const chain: any = { where: () => chain, orderBy: () => chain, limit: () => chain,
      then: (resolve: any, reject: any) => Promise.resolve(rows()).then(resolve, reject) };
    return chain;
  } }),
  execute: async (sql: any) => {
    const query = dialect.sqlToQuery(sql); queries.push(query);
    return { rows: query.sql.includes('FROM support_playbook_assignments')
      ? [{ playbook_id: 8, agent_type: selectedDefinition.agentType, traffic_percent: 100, active_version: 1, graph: selectedDefinition.graph }] : [] };
  },
  insert: () => ({ values: (value: unknown) => {
    writes(value); return { onConflictDoNothing: () => ({ returning: async () => [{ id: 1, attemptCount: 1 }] }) };
  } }),
  update: () => ({ set: () => ({ where: async () => [] }) }),
  transaction: async (callback: any) => callback(fixtureDb),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: fixtureDb }));
jest.unstable_mockModule('../services/agents/orchestration/SupportPreviewStore.js', () => ({ supportPreviewStore: {
  load: async () => activeRun ? { run: activeRun, graph: activeGraph || selectedDefinition.graph } : null,
  save: savePreview,
} }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {
  createProviderForUser: async () => ({ defaultModel: 'fixture-only', getProviderName: () => 'fixture' }),
  createChatCompletionWithFallback: chat,
} }));
jest.unstable_mockModule('../services/agents/SalesIntelligence.js', () => ({ salesIntelligence: {
  loadMemory: async () => ({}), computeIntelligence: () => ({}),
} }));
jest.unstable_mockModule('../services/agents/subagents/index.js', () => ({ subAgentRegistry: {
  getToolsForSubAgents: (ids: string[]) => ids.includes('proposal') ? proposalTools : [], dispatch,
} }));
jest.unstable_mockModule('../services/booking/HotelHistoryService.js', () => ({ hotelHistoryService: {} }));
jest.unstable_mockModule('../mastra/agents/supportAgent.js', () => ({ getDynamicHotelContext: async () => ({}) }));
jest.unstable_mockModule('../services/booking/PaymentProvider.js', () => ({ getHotelPaymentConfiguration: async () => ({}), isMockPaymentAllowed: () => false }));

const { proposalSubAgent } = await import('../services/agents/subagents/ProposalSubAgent.js');
const { PROPOSAL_SUPPORT_TOOLS, createProposalSupportPlaybooks, currentProposalInstruction } = await import('../services/agents/orchestration/ProposalSupportConfiguration.js');
const { DEFAULT_SUPPORT_AGENT_PROFILES, SUPPORT_AGENT_TYPES } = await import('../services/agents/orchestration/DefaultSupportConfiguration.js');
const { playbookEngine, validatePlaybookGraph } = await import('../services/agents/orchestration/PlaybookEngine.js');
const { initializeJourneyState } = await import('../services/agents/orchestration/SupportJourneyRuntime.js');
const { NLUService, SUPPORT_INTENTS } = await import('../services/agents/NLUService.js');
const { GeneralServiceAgent } = await import('../services/agents/GeneralServiceAgent.js');
const { TechSupportAgent } = await import('../services/agents/TechSupportAgent.js');
const { CustomerSuccessAgent } = await import('../services/agents/CustomerSuccessAgent.js');
const { LeadQualifierAgent } = await import('../services/agents/LeadQualifierAgent.js');
const { HotelSalesAgent } = await import('../services/agents/HotelSalesAgent.js');
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
const { proposalSupportMigrationDefinitions } = await import('../migrations/255_enable_support_proposals.js');

const agents = { general_service: new GeneralServiceAgent(), tech_support: new TechSupportAgent(),
  customer_success: new CustomerSuccessAgent(), lead_qualifier: new LeadQualifierAgent(), hotel_sales: new HotelSalesAgent() };
const definitions = createProposalSupportPlaybooks(SUPPORT_AGENT_TYPES);
const previousKey = process.env.SUPPORT_PII_ENCRYPTION_KEY;
process.env.SUPPORT_PII_ENCRYPTION_KEY = 'proposal-routing-fixture-key-at-least-32-characters';
afterAll(() => {
  if (previousKey === undefined) delete process.env.SUPPORT_PII_ENCRYPTION_KEY;
  else process.env.SUPPORT_PII_ENCRYPTION_KEY = previousKey;
});
const classify = (intent: string, entities: Record<string, unknown> = {}) => ({ content: JSON.stringify({
  semanticRequest: semanticIntent(intent === 'proposal_status' ? 'proposal_status' : intent === 'proposal_revision' ? 'proposal_revision' : 'proposal_create', 'sales'),
  intent, entities, secondaryIntents: [], sentiment: { label: 'neutral', score: 0 }, needsHuman: false,
  summary: 'Customer proposal request', riskLevel: 'low', riskFactors: [], classificationConfidence: 0.99,
}) });
const boundInput = (directive: unknown, agentType: keyof typeof agents = 'general_service', channel = 'whatsapp'): AgentInput => ({
  userId: 9, conversationId: 7, leadId: 31, channel, rawMessageId: 'inbound-1', messageId: 12,
  inboundText: 'Please prepare a proposal for two landing pages in October', conversationHistory: [],
  nlu: { intent: 'proposal_request', secondaryIntents: [], entities: {}, sentiment: { label: 'neutral', score: 0 }, urgency: 'low',
    needsHuman: false, summary: '', riskLevel: 'low', riskFactors: [], classificationConfidence: 0.99 },
  agentConfig: { agentType, toolsEnabled: [...PROPOSAL_SUPPORT_TOOLS] },
  playbookDirective: directive, executionMode: 'customer', dryRun: false,
} as unknown as AgentInput);
const resolveJourney = (inboundText: string, intent: string, entities: Record<string, unknown>, channel = 'whatsapp') => playbookEngine.resolve({
  userId: 9, conversationId: 7, channel, agentType: selectedDefinition.agentType,
  inboundText, intent, entities, dryRun: true,
  semanticRequest: intent === 'proposal_request' ? semanticIntent('proposal_create', 'stay')
    : intent === 'proposal_status' ? semanticIntent('proposal_status')
      : intent === 'proposal_revision' ? semanticIntent('proposal_revision') : undefined,
});

beforeEach(() => {
  jest.clearAllMocks(); queries.length = 0; activeRun = undefined; activeGraph = undefined; proposalTools = proposalSubAgent.metadata.tools;
  selectedDefinition = definitions.find(item => item.key === 'proposal-request-general_service-v1')!;
});

describe('proposal routing and published journeys', () => {
  it.each([
    ['proposal_request', 'Please prepare a proposal for two landing pages in October', { proposalTitle: 'Landing pages', proposalContext: 'Two landing pages in October' }, 'create_conversation_proposal_draft'],
    ['proposal_status', 'What is the status of my proposal?', {}, 'get_conversation_proposals'],
    ['proposal_revision', 'Please move the deadline in proposal PROP-2030-9-001-ABCD to November', { proposalNumber: 'PROP-2030-9-001-ABCD', requestedChanges: 'Move the deadline to November' }, 'request_proposal_revision'],
  ] as const)('parses %s and resolves the governed tool through the actual journey engine', async (intent, text, entities, expectedTool) => {
    chat.mockResolvedValueOnce(classify(intent, entities));
    const nlu = await new NLUService().analyze(9, text);
    expect(nlu.intent).toBe(intent); expect(nlu.needsHuman).toBe(false); expect(SUPPORT_INTENTS).toContain(intent);
    const classificationPrompt = chat.mock.calls[0][1].messages[0].content;
    expect(classificationPrompt).toContain('"proposal_request"');
    expect(classificationPrompt).toContain('optional review policy');
    selectedDefinition = definitions.find(item => item.agentType === 'general_service' && item.assignments[0].intent === intent)!;
    const directive = await resolveJourney(text, nlu.intent, nlu.entities);
    expect(directive?.requiredAction).toBe(expectedTool);
    expect(directive?.capability?.validationErrors).toBeUndefined();
    expect((agents.general_service as any).toolsForInput(boundInput(directive)).map((tool: any) => tool.function.name)).toEqual([expectedTool]);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(SUPPORT_AGENT_TYPES)('offers proposal capabilities in the selected %s specialist on every private outreach channel', async agentType => {
    const profile = DEFAULT_SUPPORT_AGENT_PROFILES.find(item => item.type === agentType)!;
    expect(profile.toolsEnabled).toEqual(expect.arrayContaining([...PROPOSAL_SUPPORT_TOOLS]));
    expect(profile.prompt).toContain('Account Proposal Settings');
    for (const channel of ['whatsapp', 'facebook', 'instagram', 'email', 'sms', 'linkedin', 'twitter']) {
      selectedDefinition = definitions.find(item => item.agentType === agentType && item.assignments[0].intent === 'proposal_status')!;
      const directive = await resolveJourney('What is the status of my proposal?', 'proposal_status', {}, channel);
      expect(directive?.requiredAction).toBe('get_conversation_proposals');
      expect((agents[agentType] as any).toolsForInput(boundInput(directive, agentType, channel)).map((tool: any) => tool.function.name)).toEqual(['get_conversation_proposals']);
      expect(queries.at(-1)?.sql).toContain('a.agent_type =');
      expect(queries.at(-1)?.params).toEqual(expect.arrayContaining([9, agentType, channel, 'proposal_status']));
    }
  });

  it('collects missing request context and keeps customer identity out of the requested fields', async () => {
    const directive = await resolveJourney('I need a proposal', 'proposal_request', {});
    expect(directive?.nodeType).toBe('collect'); expect(directive?.requiredAction).toBeUndefined();
    expect(directive?.journey?.missingFields.length).toBeGreaterThan(0);
    expect(directive?.instruction).not.toContain('Ask only');
    expect(directive?.instruction).toBe('What service or outcome should the proposal cover?');
    expect((agents.general_service as any).toolsForInput(boundInput(directive))).toEqual([]);
    expect(selectedDefinition.graph.fields?.every(field => field.pii === 'none')).toBe(true);
    activeRun = { id: 1, userId: 9, conversationId: 7, playbookId: 8, playbookVersion: 1, currentNodeId: directive!.nodeId,
      status: 'active', state: { ...initializeJourneyState(selectedDefinition.graph), fields: directive!.journey!.fields, agentType: 'general_service' } };
    const completed = await resolveJourney('Two landing pages for the launch in October', 'proposal_request', {
      proposalTitle: 'Landing pages', proposalContext: 'Two landing pages for the launch in October',
    });
    expect(completed?.actionArgs).toEqual({ title: 'Landing pages', context: 'Two landing pages for the launch in October' });
    expect(completed?.requiredAction).toBe('create_conversation_proposal_draft');
  });

  it('does not turn a revision request with missing proposal number into a guessed target', async () => {
    selectedDefinition = definitions.find(item => item.key === 'proposal-revision-general_service-v1')!;
    const directive = await resolveJourney('Please change the deadline to November', 'proposal_revision', { requestedChanges: 'Deadline in November' });
    expect(directive?.nodeType).toBe('collect');
    expect(directive?.instruction).toContain('proposal number');
    expect(directive?.requiredAction).toBeUndefined();
  });

  it('switches unrelated intake to the published proposal journey and continues collecting only proposal requirements', async () => {
    const graph: PlaybookGraph = { schemaVersion: 2, entryNodeId: 'start', fields: [{ key: 'issue', type: 'text', required: true, pii: 'none', prompt: 'Which issue needs support?' }],
      nodes: [{ id: 'start', type: 'trigger' }, { id: 'collect', type: 'collect', data: { fieldKeys: ['issue'] } }, { id: 'done', type: 'complete' }],
      edges: [{ source: 'start', target: 'collect', condition: { operator: 'always' } }, { source: 'collect', target: 'done', condition: { operator: 'all_required_fields_present' } }], metadata: { agentType: 'general_service' } };
    activeGraph = graph;
    activeRun = { id: 1, userId: 9, conversationId: 7, playbookId: 18, playbookVersion: 1, currentNodeId: 'collect', status: 'active',
      state: { ...initializeJourneyState(graph), agentType: 'general_service' } };
    const directive = await resolveJourney('Please send me a proposal', 'proposal_request', {});
    expect(directive?.playbookId).toBe(8);
    expect(directive?.nodeId).toBe('collect-request');
    expect(directive?.instruction).toContain('proposal');
    expect(directive?.instruction).not.toContain('Which issue');
    expect((agents.general_service as any).toolsForInput(boundInput(directive))).toEqual([]);
    const saved = savePreview.mock.calls.at(-1)![2] as { run: any; graph: PlaybookGraph };
    activeRun = { ...saved.run, currentNodeId: saved.run.state.proposedNodeId };
    activeGraph = saved.graph;
    const completed = await resolveJourney('A deluxe room for two adults from October 2 to 4', 'booking_request', {
      proposalTitle: 'Deluxe room stay', proposalContext: 'Two adults, October 2–4',
    });
    expect(completed?.requiredAction).toBe('create_conversation_proposal_draft');
    expect(completed?.actionArgs).toEqual({ title: 'Deluxe room stay', context: 'Two adults, October 2–4' });
    expect((agents.general_service as any).toolsForInput(boundInput(completed))).toHaveLength(1);
  });

  it('keeps legacy migration tool mappings compatible with the new optional-review defaults', () => {
    expect(proposalSupportMigrationDefinitions().map((entry: any) => [entry.key,entry.assignments])).toEqual(definitions.map(entry=>[entry.key,entry.assignments]));
    for (const definition of definitions) expect(validatePlaybookGraph(definition.graph)).toEqual([]);
  });

  it('keeps every shared authoring capability backed by an actual server registration', () => {
    expect([...SUPPORT_CAPABILITY_NAMES].sort()).toEqual(Object.keys(SUPPORT_CAPABILITIES).sort());
  });

  it.each(['', 'unregistered.capability'])('retains server validation of missing and unknown revision capabilities (%s)', capabilityName => {
    const graph = createProposalSupportPlaybooks(['hotel_sales'])[2].graph;
    graph.nodes.find(node => node.id === 'record-changes')!.data!.capabilityName = capabilityName;
    expect(validatePlaybookGraph(graph)).toContain(`Capability node record-changes references unsupported capability ${capabilityName || '(empty)'}.`);
  });

  it('updates exact legacy review wording without changing custom playbook instructions', () => {
    const legacy=proposalSupportMigrationDefinitions().find((entry:any)=>entry.key==='proposal-request-hotel_sales-v1');
    const instruction=legacy.graph.nodes.find((node:any)=>node.id==='record-request').data.instruction;
    expect(currentProposalInstruction(instruction)).toContain('optional review');
    expect(currentProposalInstruction(instruction)).toContain('confirmedSideEffect=false');
    expect(currentProposalInstruction('Owner-specific proposal guidance')).toBe('Owner-specific proposal guidance');
  });
});

describe('actual support specialist tool loop', () => {
  it('dispatches trusted bound arguments once and rejects a second unoffered proposal call', async () => {
    const directive = await resolveJourney('Please prepare two landing pages in October', 'proposal_request', {
      proposalTitle: 'Landing pages', proposalContext: 'Two pages in October',
    });
    chat.mockResolvedValueOnce({ completion: { choices: [{ message: { content: '', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'create_conversation_proposal_draft', arguments: JSON.stringify({ title: 'Injected title', recipientEmail: 'another-customer@example.test' }) } },
      { id: 'call-2', type: 'function', function: { name: 'create_conversation_proposal_draft', arguments: JSON.stringify({ title: 'Duplicate draft' }) } },
    ] } }] } });
    chat.mockResolvedValueOnce({ content: 'Your request is saved for seller review.' });
    const result = await agents.general_service.handle(boundInput(directive));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('create_conversation_proposal_draft', { title: 'Landing pages', context: 'Two pages in October' },
      expect.objectContaining({ userId: 9, conversationId: 7, lead: expect.objectContaining({ id: 31 }), executionMode: 'customer' }), expect.arrayContaining(['proposal']));
    expect(result.toolCallsExecuted).toEqual([
      expect.objectContaining({ success: true, confirmedSideEffect: true }),
      expect.objectContaining({ success: false, code: 'tool_not_offered_current_turn', confirmedSideEffect: false }),
      expect.objectContaining({ success: false, code: 'tool_not_offered_current_turn', confirmedSideEffect: false }),
    ]);
    expect(chat.mock.calls[1][1].tools).toBeUndefined();
    // The attempted unoffered duplicate remains a safety failure, independent
    // of the successful draft's seller-review state.
    expect(result.escalated).toBe(true);
  });

  it('acknowledges a successful draft without requesting a customer handoff', async () => {
    const directive = await resolveJourney('Prepare a room proposal', 'proposal_request', {
      proposalTitle: 'Room proposal', proposalContext: 'Two adults, October 2–4',
    });
    chat.mockResolvedValueOnce({ content: 'Your request is saved for seller review. No booking or offer has been sent.' });
    const result = await agents.general_service.handle(boundInput(directive));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.toolCallsExecuted).toEqual([expect.objectContaining({ success: true, confirmedSideEffect: true })]);
    expect(result.escalated).not.toBe(true);
    expect(result.escalationType).toBeUndefined();
    expect(result.replyText).toContain('saved for seller review');
  });

  it('offers no tools to an advisory generation and blocks a forged call before the registry', async () => {
    chat.mockResolvedValueOnce({ completion: { choices: [{ message: { content: '', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'create_conversation_proposal_draft', arguments: '{"title":"Forbidden draft"}' } },
    ] } }] } });
    chat.mockResolvedValueOnce({ content: 'A seller can prepare a proposal in the workspace.' });
    const result = await agents.general_service.handle({ ...boundInput(null), executionMode: 'advisory', dryRun: false });
    expect(chat.mock.calls[0][1].tools).toBeUndefined(); expect(dispatch).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    expect(result.toolCallsExecuted?.[0].code).toBe('tool_not_offered_current_turn');
  });
});
