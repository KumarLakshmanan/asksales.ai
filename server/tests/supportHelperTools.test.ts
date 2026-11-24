import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SubAgentContext } from '../services/agents/subagents/SubAgentBase.js';
const buildDeal = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>();
const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>();
const formatEvidence = jest.fn<(...args: unknown[]) => string>();
const retrieve = jest.fn();
jest.unstable_mockModule('../services/booking/NegotiationEngine.js', () => ({ negotiationEngine: { buildDeal } }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: { formatEvidence, retrieve } }));
jest.unstable_mockModule('../services/SupportService.js', () => ({ supportService: {} }));
jest.unstable_mockModule('../services/agents/SalesIntelligence.js', () => ({ salesIntelligence: {} }));
const { NegotiationSubAgent } = await import('../services/agents/subagents/NegotiationSubAgent.js');
const { ComplaintSubAgent } = await import('../services/agents/subagents/ComplaintSubAgent.js');
const { QualificationSubAgent } = await import('../services/agents/subagents/QualificationSubAgent.js');
const { TicketSubAgent } = await import('../services/agents/subagents/TicketSubAgent.js');
const { KnowledgeBaseSubAgent } = await import('../services/agents/subagents/KnowledgeBaseSubAgent.js');
const context = (changes: Record<string, unknown> = {}) => ({ userId: 9, conversationId: 20, channel: 'web',
  lead: { id: 30 }, slots: { negotiationRound: 1, checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, rooms: 1 },
  memory: {}, nlu: { intent: 'complaint', riskLevel: 'low', riskFactors: [] }, ...changes } as unknown as SubAgentContext);
const approvedDeal = { approved: true, mustEscalate: false, offerPrice: 100, basePrice: 120, floorPrice: 90,
  discountPct: 16.67, atFloor: false, currency: 'INR', roomTypeName: 'Synthetic room', perks: [], strategy: 'Verified offer only.' };
beforeEach(() => { jest.clearAllMocks(); buildDeal.mockReset().mockResolvedValue(approvedDeal);
  execute.mockReset().mockResolvedValue({ rows: [] }); formatEvidence.mockReturnValue('Approved synthetic policy'); });

describe('direct support helper tool behavior', () => {
  it('presents only the already-authorized knowledge lane instead of starting a second search', async () => {
    const evidence = [{ evidenceId: 'KB-1', title: 'Approved synthetic policy', excerpt: 'Checkout is at 11 AM.' }];
    const knowledgeResult = { status: 'sufficient', evidence };
    const result = await new KnowledgeBaseSubAgent().execute('answer_from_knowledge_base', { query: 'Another query' }, context({ knowledgeResult }));
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, grounding_status: 'sufficient', sources: evidence, confirmedSideEffect: false });
    expect(formatEvidence).toHaveBeenCalledWith(knowledgeResult);
    expect(retrieve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it.each(['insufficient', 'unavailable', 'access_denied', 'conflict_detected', undefined])('does not invent a successful knowledge answer when evidence is %s', async status => {
    const result = await new KnowledgeBaseSubAgent().execute('answer_from_knowledge_base', { query: 'Cancellation terms?' },
      context(status ? { knowledgeResult: { status, evidence: [] } } : {}));
    expect(result.toolResults?.[0].result).toMatchObject({ success: false, sources: [], confirmedSideEffect: false });
    expect(retrieve).not.toHaveBeenCalled();
  });
  it('returns the verified hotel profile and normalized check-in times', async () => {
    execute.mockResolvedValue({ rows: [{ name: 'Synthetic Hotel', city: 'Synthetic City', amenities: ['WiFi'], check_in_time: '14:00:00', check_out_time: '11:00:00' }] });
    const result = await new KnowledgeBaseSubAgent().execute('get_hotel_info', {}, context());
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, name: 'Synthetic Hotel', checkInTime: '14:00', checkOutTime: '11:00', amenities: ['WiFi'], confirmedSideEffect: false });
  });
  it('does not fabricate hotel details when no property is configured', async () => {
    const result = await new KnowledgeBaseSubAgent().execute('get_hotel_info', {}, context());
    expect(result.toolResults?.[0].result.success).not.toBe(true);
    expect(result.toolResults?.[0].result.error).toContain('No hotel property');
  });
  it.each(['price', 'thinking_about_it', 'comparing_hotels', 'trust', 'availability', 'other'])('handles %s objections without inventing property or cancellation facts', async objectionType => {
    const result = await new NegotiationSubAgent().execute('handle_objection', { objection_type: objectionType }, context());
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, confirmedSideEffect: false, objection_type: objectionType, deal: null });
    expect(JSON.stringify(result)).not.toMatch(/48h|free cancellation|complimentary breakfast|beachfront|sea view/);
    expect(buildDeal).not.toHaveBeenCalled();
  });
  it.each(['quote_or_negotiate_price', 'handle_objection'])('%s preserves the approved deal and current stay context', async name => {
    const result = await new NegotiationSubAgent().execute(name, { objection_type: 'price', room_type_id: 4 }, context());
    expect(buildDeal).toHaveBeenCalledWith(9, 4, expect.objectContaining({ round: 1, checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, rooms: 1 }));
    expect(result.slotsUpdate).toMatchObject({ agreedPricePerNight: 100, priceQuoteRoomTypeId: 4 });
    expect(result.toolResults?.[0].result.confirmedSideEffect).toBe(false);
  });
  it.each(['quote_or_negotiate_price', 'handle_objection'])('%s escalates a rejected deal without committing an agreed price', async name => {
    buildDeal.mockResolvedValue({ ...approvedDeal, approved: false, mustEscalate: true });
    const result = await new NegotiationSubAgent().execute(name, { objection_type: 'price', room_type_id: 4 }, context());
    expect(result).toMatchObject({ escalated: true, escalationType: 'sales', crmPipelineStatus: 'negotiation' });
    expect(result.slotsUpdate?.agreedPricePerNight).toBeUndefined();
    const payload = result.toolResults?.[0].result;
    expect(name === 'handle_objection' ? payload.deal : payload).toMatchObject({ approved: false, must_escalate: true });
  });
  it('does not fabricate a quote for an unknown room', async () => {
    buildDeal.mockResolvedValue(null);
    const result = await new NegotiationSubAgent().execute('quote_or_negotiate_price', { room_type_id: 999 }, context());
    expect(result.toolResults?.[0].result.error).toContain('Unknown room');
    expect(result.slotsUpdate).toBeUndefined();
  });
  it('routes a serious complaint to support without claiming resolution', async () => {
    const result = await new ComplaintSubAgent().execute('resolve_complaint', { complaint_details: 'Synthetic refund complaint', resolution_action: 'Review' },
      context({ nlu: { intent: 'refund_request', riskLevel: 'high', riskFactors: [] } }));
    expect(result).toMatchObject({ escalated: true, escalationType: 'support' });
    expect(result.toolResults?.[0].result).toMatchObject({ success: false, resolved: false, confirmedSideEffect: false });
  });
  it('returns minor complaint guidance without claiming a committed effect', async () => {
    const result = await new ComplaintSubAgent().execute('resolve_complaint', { complaint_details: 'Synthetic concern', resolution_action: 'Explain approved instructions' }, context());
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, confirmedSideEffect: false });
  });
  it.each(['support', 'sales'])('requests a %s handoff without claiming a person has taken ownership', async type => {
    const result = await new ComplaintSubAgent().execute('escalate_to_human', { reason: 'Synthetic request', type }, context());
    expect(result).toMatchObject({ escalated: true, escalationType: type, escalationReason: 'Synthetic request' });
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, confirmedSideEffect: false });
  });
  it('proposes a support ticket bound to the current conversation and lead', async () => {
    const result = await new TicketSubAgent().execute('create_support_ticket', { subject: 'Synthetic issue', description: 'Test only', priority: 'high' }, context());
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, status: 'proposed', confirmedSideEffect: false });
    expect(result.effectProposals).toEqual([expect.objectContaining({ type: 'support_ticket',
      payload: expect.objectContaining({ leadId: 30, outreachConversationId: 20, subject: 'Synthetic issue', priority: 'high' }) })]);
  });
  it('qualifies a lead through effect proposals without updating its source object', async () => {
    const ctx = context();
    const result = await new QualificationSubAgent().execute('qualify_lead', { intent: 'urgent', urgency: 'high', rooms_requested: 3 }, ctx);
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, confirmedSideEffect: false, qualification_score: 75, high_value: true });
    expect(result.effectProposals).toContainEqual({ type: 'lead_score', payload: { leadId: 30, score: 75 } });
    expect(ctx.lead).toEqual({ id: 30 });
  });
  it('proposes a score update only for a verified current lead', async () => {
    const result = await new QualificationSubAgent().execute('update_lead_score', { score: 80 }, context());
    expect(result.effectProposals).toEqual([{ type: 'lead_score', payload: { leadId: 30, score: 80 } }]);
    expect((await new QualificationSubAgent().execute('update_lead_score', { score: 80 }, context({ lead: {} }))).effectProposals).toEqual([]);
  });
});
