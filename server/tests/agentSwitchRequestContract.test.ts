import { describe, expect, it } from '@jest/globals';
import { agentSwitchAgentSchema } from '../middleware/schemas.js';

describe('direct agent switch request contract', () => {
  it('normalizes string thread IDs and rejects unsupported agents and invalid threads', () => {
    expect(agentSwitchAgentSchema.parse({ threadId: '42', targetAgent: 'outreach' }).threadId).toBe(42);
    for (const threadId of [0, -1, 1.5, '', 'abc', '0']) {
      expect(agentSwitchAgentSchema.safeParse({ threadId, targetAgent: 'outreach' }).success).toBe(false);
    }
    expect(agentSwitchAgentSchema.safeParse({ threadId: 42, targetAgent: 'analytics' }).success).toBe(false);
  });
  it('accepts the targetAgent field sent by chat and read by the handler', () => {
    expect(agentSwitchAgentSchema.parse({ threadId: 42, targetAgent: 'outreach' }))
      .toMatchObject({ threadId: 42, targetAgent: 'outreach' });
  });

  it('rejects a missing targetAgent instead of passing an unusable request to the handler', () => {
    expect(agentSwitchAgentSchema.safeParse({ threadId: 42, agentType: 'outreach' }).success).toBe(false);
  });
});
