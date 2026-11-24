import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AgentInput } from '../services/agents/BaseOutreachAgent.js';
import type { SubAgentResult } from '../services/agents/subagents/SubAgentBase.js';
const execute = jest.fn(async () => ({ rows: [] }));
const dispatch = jest.fn<(...args: unknown[]) => Promise<SubAgentResult>>();
const complete = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/agents/subagents/index.js', () => ({ subAgentRegistry: {
  getToolsForSubAgents: () => ['get_payment_methods', 'check_room_availability'].map(name => ({
    type: 'function', function: { name, parameters: { type: 'object', properties: {} } },
  })), dispatch,
} }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {
  createProviderForUser: async () => ({ defaultModel: 'synthetic' }), createChatCompletionWithFallback: complete,
} }));
jest.unstable_mockModule('../mastra/agents/supportAgent.js', () => ({ getDynamicHotelContext: async () => '' }));
jest.unstable_mockModule('../services/booking/HotelHistoryService.js', () => ({ hotelHistoryService: { socialProofLine: async () => '' } }));
jest.unstable_mockModule('../services/agents/SalesIntelligence.js', () => ({ salesIntelligence: {
  loadMemory: async () => ({}), computeIntelligence: () => ({ leadScore: 0, value: 'low', estimatedValue: 0 }), mergeMemory: () => ({}),
} }));
jest.unstable_mockModule('../services/booking/PaymentProvider.js', () => ({
  getHotelPaymentConfiguration: async () => ({ paymentMethodsEnabled: true, provider: 'razorpay', methods: {} }),
  isMockPaymentAllowed: () => false,
}));
const { HotelSalesAgent } = await import('../services/agents/HotelSalesAgent.js');
const { buildAtomicClaimEvidence, verifyKnowledgeClaims } = await import('../services/knowledge/KnowledgeClaimVerifier.js');
const input = (intent: string, entities = {}) => ({ userId: 9, conversationId: -100, channel: 'web', phoneNumberId: '',
  inboundText: 'Synthetic owner preview', executionMode: 'advisory', isSupportChat: true,
  conversationHistory: [], agentConfig: { agentType: 'hotel_sales', toolsEnabled: ['get_payment_methods', 'check_room_availability'] },
  nlu: { intent, entities, classificationConfidence: 1, secondaryIntents: [], sentiment: { label: 'neutral', score: 0 },
    riskLevel: 'low', riskFactors: [], urgency: 'low', needsHuman: false, summary: '' },
} as AgentInput);
function grounded(result: Awaited<ReturnType<InstanceType<typeof HotelSalesAgent>['handle']>>) {
  return verifyKnowledgeClaims({ claims: buildAtomicClaimEvidence({ replyText: result.replyText, toolOutcomes: result.toolCallsExecuted }),
    toolOutcomes: result.toolCallsExecuted, audience: 'customer', risk: 'transactional' });
}
beforeEach(() => { jest.clearAllMocks(); complete.mockReset(); dispatch.mockReset(); });

describe('owner preview from agent tool dispatch through factual verification', () => {
  it('uses the successful payment lookup instead of an unsupported model-added policy', async () => {
    complete.mockResolvedValueOnce({ success: true, completion: { choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'payment-read', type: 'function', function: { name: 'get_payment_methods', arguments: '{}' } }] } }] } })
      .mockResolvedValueOnce({ success: true, content: 'Payment is refundable for 48 hours.' });
    dispatch.mockResolvedValue({ toolResults: [{ name: 'get_payment_methods', result: {
      success: true, confirmedSideEffect: false, payment_methods: ['Manual Payment at Hotel: Pay at reception.'], configured: true,
    } }] });
    const result = await new HotelSalesAgent().handle(input('payment_inquiry'));
    expect(dispatch).toHaveBeenCalledWith('get_payment_methods', {}, expect.objectContaining({ isSupportChat: true, executionMode: 'advisory' }), expect.any(Array));
    expect(result.replyText).toBe('- Manual Payment at Hotel: Pay at reception.');
    expect(result.replyText).not.toContain('48');
    expect(result.effectProposals).toEqual([]);
    expect(grounded(result)).toMatchObject({ mayDeliver: true, answerGrounding: 'grounded', unsupportedClaims: [] });
  });
  it('executes the dated availability read and verifies its complete canonical reply', async () => {
    dispatch.mockResolvedValue({ toolResults: [{ name: 'check_room_availability', result: {
      success: true, confirmedSideEffect: false, count: 1, options: [{ room_type_id: 4, name: 'Synthetic Room',
        price_per_night: 100, total_price: 200, currency: 'INR' }],
    } }] });
    const result = await new HotelSalesAgent().handle(input('availability_inquiry', { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, rooms: 1 }));
    expect(complete).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('check_room_availability', expect.objectContaining({ check_in: '2026-11-10', check_out: '2026-11-12', guests: 2 }), expect.anything(), expect.any(Array));
    expect(result.replyText).toContain('Synthetic Room');
    expect(result.effectProposals).toEqual([]);
    expect(grounded(result)).toMatchObject({ mayDeliver: true, answerGrounding: 'grounded', unsupportedClaims: [] });
    const dialect = new PgDialect();
    for (const [statement] of execute.mock.calls as unknown as Array<[Parameters<typeof dialect.sqlToQuery>[0]]>) {
      expect(dialect.sqlToQuery(statement).sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    }
  });
  it('keeps fabricated payment claims blocked when the lookup failed', async () => {
    complete.mockResolvedValueOnce({ success: true, completion: { choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'payment-read', type: 'function', function: { name: 'get_payment_methods', arguments: '{}' } }] } }] } })
      .mockResolvedValueOnce({ success: true, content: 'Payment is refundable for 48 hours.' });
    dispatch.mockResolvedValue({ toolResults: [{ name: 'get_payment_methods', result: { success: false, error: 'Lookup unavailable' } }] });
    const result = await new HotelSalesAgent().handle(input('payment_inquiry'));
    expect(grounded(result).mayDeliver).toBe(false);
    expect(result.effectProposals).toEqual([]);
  });
  it('grounds a successful availability lookup with no matching inventory', async () => {
    dispatch.mockResolvedValue({ toolResults: [{ name: 'check_room_availability', result: {
      success: true, confirmedSideEffect: false, count: 0, options: [], note: 'No rooms match those dates/occupancy.',
    } }] });
    const result = await new HotelSalesAgent().handle(input('availability_inquiry', { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, rooms: 1 }));
    expect(result.replyText).toBe('No rooms are available for 2026-11-10 to 2026-11-12 for 2 guests.');
    expect(grounded(result)).toMatchObject({ mayDeliver: true, answerGrounding: 'grounded', unsupportedClaims: [] });
    expect(result.effectProposals).toEqual([]);
  });
  it.each([
    { success: false, count: 0, options: [] },
    { success: true, options: [] },
    { success: true, count: 0 },
  ])('does not claim no availability from a failed or incomplete lookup: %j', async lookup => {
    dispatch.mockResolvedValue({ toolResults: [{ name: 'check_room_availability', result: lookup }] });
    const result = await new HotelSalesAgent().handle(input('availability_inquiry', { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, rooms: 1 }));
    expect(result.replyText).not.toContain('No rooms are available');
    expect(grounded(result).mayDeliver).toBe(false);
  });
});
