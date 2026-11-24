import { describe, expect, it } from '@jest/globals';
import { recoverEmptyAssistantTurn } from '../mastra/turnResponseRecovery.js';

describe('empty HTTP reply recovery', () => {
  it('returns the exact persisted assistant reply from this turn', () => {
    const saved = {
      id: 13,
      role: 'assistant',
      content: 'The ICP review is ready.',
      agentType: 'icp_generation',
      metadata: { responseId: 'response-13' },
    };
    expect(recoverEmptyAssistantTurn(11, [
      { id: 9, role: 'assistant', content: 'Old reply' }, saved,
    ], [])).toEqual({ content: saved.content, agentType: 'icp_generation', persistedMessage: saved });
  });

  it('never recycles a prior-turn assistant reply', () => {
    expect(recoverEmptyAssistantTurn(11, [
      { id: 9, role: 'assistant', content: 'Old reply' },
    ], [])).toMatchObject({ content: expect.stringContaining('could not complete a reply') });
  });
});
