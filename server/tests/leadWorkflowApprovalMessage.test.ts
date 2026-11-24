import {
  persistAndBroadcastChatMessage,
  persistAndBroadcastLeadWorkflowApproval,
} from '../services/leadWorkflowApprovalMessage.js';

describe('lead workflow approval message delivery', () => {
  it('broadcasts the single durable user message instead of a second streaming bubble', async () => {
    const persistedAt = new Date('2026-08-30T14:49:33.425Z');
    const persistedMessages: unknown[] = [];
    const emittedMessages: unknown[][] = [];

    await persistAndBroadcastLeadWorkflowApproval(
      1,
      165,
      'Approved. Starting lead generation on: google maps, justdial',
      {
        persist: async (message) => {
          persistedMessages.push(message);
          return { id: 2765, createdAt: persistedAt };
        },
        emit: (...args) => emittedMessages.push(args),
      },
    );

    expect(persistedMessages).toHaveLength(1);
    expect(emittedMessages).toEqual([[1, 165, {
      id: 2765,
      role: 'user',
      content: 'Approved. Starting lead generation on: google maps, justdial',
      agentType: 'user',
      timestamp: persistedAt.getTime(),
    }]]);
  });

  it('refuses to emit an approval bubble without a durable message ID', async () => {
    const emittedMessages: unknown[][] = [];

    await expect(persistAndBroadcastLeadWorkflowApproval(
      1,
      165,
      'Approved. Starting lead generation on: google maps',
      { persist: async () => ({ id: 0 }), emit: (...args) => emittedMessages.push(args) },
    )).rejects.toThrow(/durable message id/i);
    expect(emittedMessages).toEqual([]);
  });

  it('broadcasts a truthful assistant result from its durable row', async () => {
    const emittedMessages: unknown[][] = [];

    await persistAndBroadcastChatMessage(1, 165, {
      role: 'assistant',
      content: 'Lead generation failed across all 2 workflow(s).',
      agentType: 'lead_generation',
    }, {
      persist: async () => ({ id: 2768, createdAt: '2026-08-30T14:51:00.000Z' }),
      emit: (...args) => emittedMessages.push(args),
    });

    expect(emittedMessages).toEqual([[1, 165, expect.objectContaining({
      id: 2768,
      role: 'assistant',
      content: 'Lead generation failed across all 2 workflow(s).',
      agentType: 'lead_generation',
    })]]);
  });
});
