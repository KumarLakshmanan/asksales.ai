import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<(...args: unknown[]) => Promise<any>>();
const analyze = jest.fn<(...args: unknown[]) => Promise<any>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/agents/NLUService.js', () => ({ nluService: { analyze } }));
jest.unstable_mockModule('../services/agents/orchestration/SupportCRMPipeline.js', () => ({
  supportCrmPipelineContext: jest.fn(async () => undefined),
}));
const { IntentRiskClassifierStage } = await import('../services/agents/pipeline/stages/IntentRiskClassifierStage.js');
const { CanAIHandleGate } = await import('../services/agents/pipeline/stages/CanAIHandleGate.js');
const { PostClassificationPolicyStage } = await import('../services/agents/pipeline/stages/PostClassificationPolicyStage.js');
const context = (): PipelineContext => ({ message: {
  userId: 9, conversationId: 734, messageId: 7518, channel: 'whatsapp',
  senderIdentifier: 'test', inboundText: 'Reply here', metadata: { executionMode: 'customer' },
}, metadata: {}, confidence: 0, policyViolations: [] });
beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rows: [{ selection: { kind: 'template_button', title: 'Reply here' } }] });
  analyze.mockResolvedValue({ intent: 'clarify', needsHuman: true, riskLevel: 'low', riskFactors: [], classificationConfidence: 0 });
});
describe('native generic template reply opening', () => {
  it('opens the normal playbook pipeline without inventing booking or handoff consent', async () => {
    const ctx = context();
    await new IntentRiskClassifierStage().execute(ctx);
    expect(analyze).not.toHaveBeenCalled();
    expect(ctx.message.inboundText).toBe('Reply here');
    expect(ctx.nlu).toMatchObject({ intent: 'greeting', needsHuman: false, entities: {},
      semanticRequest: { action: 'other', service: 'general', explicit: false } });
    expect(ctx.metadata?.verifiedHandoffConsent).toBeUndefined();
    expect(ctx.metadata?.skipAgentGeneration).toBeUndefined();
    await expect(new CanAIHandleGate().execute(ctx)).resolves.toBe(ctx);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.params).toEqual(expect.arrayContaining([9, 734, 7518]));
    expect(query.sql).toContain('c.business_profile_id=m.business_profile_id');
  });
  it.each([undefined, { kind: 'button_reply', title: 'Reply here' },
    { kind: 'template_button', title: 'Book now' }])('classifies unverified selection %j normally', async selection => {
    execute.mockResolvedValue({ rows: [{ selection }] });
    await new IntentRiskClassifierStage().execute(context());
    expect(analyze).toHaveBeenCalled();
  });
  it.each(['Yes', 'Book now', 'Reply here and reserve it'])('does not reinterpret %s as an opening', async text => {
    const ctx = context(); ctx.message.inboundText = text;
    await new IntentRiskClassifierStage().execute(ctx);
    expect(execute).not.toHaveBeenCalled(); expect(analyze).toHaveBeenCalled();
  });
  it('keeps configured greeting escalation authoritative', async () => {
    const ctx = context();
    ctx.metadata!.agentConfig = { escalationRules: [{ id: 'review', type: 'auto_escalate_intent', enabled: true, config: { intents: ['greeting'] } }] };
    await new IntentRiskClassifierStage().execute(ctx);
    await expect(new PostClassificationPolicyStage().execute(ctx)).rejects.toMatchObject({ outcome: 'human_handoff' });
  });
  it('leaves human-owned turns and simulations on their existing paths', async () => {
    for (const mode of ['human', 'preview', 'facebook']) {
      const ctx = context();
      if (mode === 'human') ctx.metadata!.suspendPlaybookForHandoff = true;
      if (mode === 'preview') ctx.message.metadata!.dryRun = true;
      if (mode === 'facebook') ctx.message.channel = 'facebook';
      await new IntentRiskClassifierStage().execute(ctx);
    }
    expect(execute).not.toHaveBeenCalled(); expect(analyze).toHaveBeenCalledTimes(3);
  });
});
