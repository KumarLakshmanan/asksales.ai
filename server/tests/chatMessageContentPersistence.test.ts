import { describe, expect, it, jest } from '@jest/globals';
const values = jest.fn<any>((message: any) => ({ returning: async () => [{ id: 1, ...message }] }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { insert: () => ({ values }) } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitChatMessage: jest.fn() } }));
jest.unstable_mockModule('../utils/tokenCounter.js', () => ({ countTokens: () => 100 }));
const { createChatMessage } = await import('../models/chatMessages/functions.js');

describe('durable assistant content', () => {
  it('persists a full catalog beyond the short error limit', async () => {
    const content = Array.from({ length: 14 }, (_, i) => `Strategy ${i}: ${'Description '.repeat(40)}`).join('\n');
    const result = await createChatMessage({ userId: 1, threadId: 184, role: 'assistant', content });
    expect(result.content).toBe(content);
    expect(result.content.length).toBeGreaterThan(2000);
  });
  it('still removes provider infrastructure details', async () => {
    const result = await createChatMessage({ userId: 1, threadId: 184, role: 'assistant', content: 'Lightning dunning decision is deny for project: projects/123' });
    expect(result.content).toBe('The AI service is temporarily unavailable. Please try this action again.');
  });
});
