import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { PlaybookGraph, PlaybookFieldDefinition } from '../models/supportOrchestration/schema.js';
import { collectJourneyFields, initializeJourneyState, matchActiveOccupancyCount, missingFieldsForNode } from '../services/agents/orchestration/SupportJourneyRuntime.js';
import { withAssistantContext, type ResolvedAssistant } from '../services/assistants/AssistantContext.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const analyze = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/agents/NLUService.js', () => ({ nluService: { analyze } }));
const { ActivePlaybookSelectionStage } = await import('../services/agents/pipeline/stages/ActivePlaybookSelectionStage.js');
const { IntentRiskClassifierStage } = await import('../services/agents/pipeline/stages/IntentRiskClassifierStage.js');
const { CanAIHandleGate } = await import('../services/agents/pipeline/stages/CanAIHandleGate.js');
const { PostClassificationPolicyStage } = await import('../services/agents/pipeline/stages/PostClassificationPolicyStage.js');

const children: PlaybookFieldDefinition = {
  key: 'stay.children', type: 'integer', pii: 'none', required: true,
  prompt: 'How many children? Reply 0 if none.', validation: { min: 0, max: 20 },
};
const graph: PlaybookGraph = {
  schemaVersion: 2, entryNodeId: 'collect-stay',
  fields: [children, { ...children, key: 'stay.rooms', prompt: 'How many rooms?', validation: { min: 1, max: 10 } }],
  nodes: [{ id: 'collect-stay', type: 'collect', data: { fieldKeys: ['stay.children', 'stay.rooms'] } }], edges: [],
};
const context = (text: string): PipelineContext => ({
  message: { userId: 9, conversationId: 461, channel: 'whatsapp', senderIdentifier: 'test', inboundText: text },
  confidence: 1, policyViolations: [], metadata: {},
});
beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rows: [{ id: 146, graph, current_node_id: 'collect-stay', state: initializeJourneyState(graph) }] });
  analyze.mockResolvedValue({ intent: 'clarify', entities: {}, needsHuman: true, riskLevel: 'medium', riskFactors: ['classification_unavailable'], classificationConfidence: 0 });
});

describe('active occupancy answers during classifier outages', () => {
  it('skips playbook lookup when the published assistant has no assigned playbooks', async () => {
    const assistant = { provenance: { assistantId: 'assistant', revision: 2 },
      configuration: { playbooks: { mode: 'none', assignments: [] } } } as unknown as ResolvedAssistant;
    const ctx = context('What services do you offer?');
    await withAssistantContext(assistant, () => new ActivePlaybookSelectionStage().execute(ctx));
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses parameterized IDs when the assistant has assigned playbooks', async () => {
    const assistant = { provenance: { assistantId: 'assistant', revision: 2 },
      configuration: { playbooks: { mode: 'selected', assignments: [{ playbookId: 4 }, { playbookId: 9 }] } } } as unknown as ResolvedAssistant;
    execute.mockResolvedValueOnce({ rows: [] });
    await withAssistantContext(assistant, () => new ActivePlaybookSelectionStage().execute(context('Hello')));
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/playbook_id IN \(\$\d+, \$\d+\)/);
    expect(query.params).toEqual(expect.arrayContaining([4, 9]));
  });
  it('accepts 0 children and advances only to rooms without calling the unavailable classifier', async () => {
    const ctx = await new ActivePlaybookSelectionStage().execute(context('0'));
    expect(ctx.metadata?.activePlaybookCount).toEqual({ runId: 146, nodeId: 'collect-stay', fieldKey: 'stay.children', value: 0 });
    expect(ctx.metadata?.activePlaybookSelection).toBeUndefined();
    await new IntentRiskClassifierStage().execute(ctx);
    await expect(new PostClassificationPolicyStage().execute(ctx)).resolves.toBe(ctx);
    await expect(new CanAIHandleGate().execute(ctx)).resolves.toBe(ctx);
    expect(analyze).not.toHaveBeenCalled();
    const state = collectJourneyFields(graph, graph.nodes[0], initializeJourneyState(graph), { inboundText: '0', entities: ctx.nlu?.entities });
    expect(state.fields['stay.children']).toMatchObject({ value: 0, status: 'collected' });
    expect(state.fields['stay.rooms'].status).toBe('missing');
    expect(missingFieldsForNode(graph, graph.nodes[0], state)[0].key).toBe('stay.rooms');
  });

  it.each(['0 refund me', '0 and call a human', '-1', '1.5', '21', '100000', ''])('does not bypass classification for %j', async (text) => {
    const ctx = await new ActivePlaybookSelectionStage().execute(context(text));
    expect(ctx.metadata?.activePlaybookCount).toBeUndefined();
    await new IntentRiskClassifierStage().execute(ctx);
    await expect(new CanAIHandleGate().execute(ctx)).rejects.toMatchObject({ outcome: 'human_handoff' });
  });

  it('does not classify a context-free number as a safe playbook answer', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    const ctx = await new ActivePlaybookSelectionStage().execute(context('0'));
    await new IntentRiskClassifierStage().execute(ctx);
    expect(analyze).toHaveBeenCalled();
    await expect(new CanAIHandleGate().execute(ctx)).rejects.toMatchObject({ outcome: 'human_handoff' });
  });

  it('does not override existing human ownership', async () => {
    const ctx = context('0');
    ctx.metadata = { suspendPlaybookForHandoff: true };
    await new ActivePlaybookSelectionStage().execute(ctx);
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.metadata?.activePlaybookCount).toBeUndefined();
  });

  it('preserves configured intent escalation rather than using the choice-policy override', async () => {
    const ctx = await new ActivePlaybookSelectionStage().execute(context('0'));
    ctx.metadata!.agentConfig = { escalationRules: [{ id: 'review', type: 'auto_escalate_intent', enabled: true, config: { intents: ['clarify'] } }] };
    await new IntentRiskClassifierStage().execute(ctx);
    await expect(new PostClassificationPolicyStage().execute(ctx)).rejects.toMatchObject({ outcome: 'human_handoff' });
  });

  it.each(['stay.adults', 'stay.children', 'stay.rooms', 'service.adults', 'service.children', 'corporate.attendees', 'corporate.nights', 'celebration.guestCount'])('recognizes only a validated count for %s', (key) => {
    expect(matchActiveOccupancyCount({ ...children, key }, '2')).toBe(2);
  });

  it('rejects money, identifiers, personal fields, free text, and consent', () => {
    expect(matchActiveOccupancyCount({ ...children, type: 'money' }, '0')).toBeUndefined();
    expect(matchActiveOccupancyCount({ ...children, key: 'payment.code' }, '123')).toBeUndefined();
    expect(matchActiveOccupancyCount({ ...children, pii: 'sensitive' }, '0')).toBeUndefined();
    expect(matchActiveOccupancyCount({ ...children, pii: 'contact' }, '0')).toBeUndefined();
    expect(matchActiveOccupancyCount({ ...children, type: 'text' }, '0')).toBeUndefined();
    expect(matchActiveOccupancyCount({ ...children, key: 'stay.confirmed', type: 'boolean' }, '1')).toBeUndefined();
  });
});
