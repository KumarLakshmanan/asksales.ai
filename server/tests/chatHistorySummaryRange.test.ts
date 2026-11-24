import { describe, expect, it, jest } from '@jest/globals';
const fetchMessages = jest.fn<any>().mockResolvedValue([
  { id: 3, role: 'user', content: 'New correction', userId: 1, threadId: 1 },
  { id: 2, role: 'assistant', content: 'Old proposal', userId: 1, threadId: 1 },
  { id: 1, role: 'user', content: 'Old request', userId: 1, threadId: 1 },
]);
jest.unstable_mockModule('../models/chatMessages/functions.js', () => ({ getChatMessagesByThreadId: fetchMessages }));
jest.unstable_mockModule('../models/chatSummaries/functions.js', () => ({ getLatestSummaryByThreadId: jest.fn<any>().mockResolvedValue({ summaryText: 'Earlier goal, not approval', toMessageId: 2 }) }));
const { chatHistoryManager } = await import('../services/ChatHistoryManager.js');
describe('summary range loading', () => {
  it('loads the summary and only turns after its cutoff', async () => {
    const result = await chatHistoryManager.buildLangChainMessages(1);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('system');
    expect(result[1].content).toBe('New correction');
  });
  it('uses the same cutoff for token-budget loading', async () => {
    const result = await chatHistoryManager.buildLangChainMessagesWithinBudget(1, 2000);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('New correction');
  });
  it('has a real default when model context metadata is unavailable', () => {
    expect(chatHistoryManager.calculateContextLimit('unknown-model')).toBeGreaterThan(0);
  });
});
