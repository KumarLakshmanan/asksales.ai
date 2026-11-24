import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const summary = { id: 5, userId: 1, threadId: 171, fromMessageId: 1, toMessageId: 5, messageCount: 5, summaryText: 'Saved summary', version: 2 };
const getMessages = jest.fn<() => Promise<unknown[]>>();
const getLatestSummaryByThreadId = jest.fn(async () => summary);
const createProviderForUser = jest.fn<any>();
const complete = jest.fn<any>();
const updateMetadata = jest.fn<any>();
const createChatSummary = jest.fn<any>();
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.unstable_mockModule('../services/ChatHistoryManager.js', () => ({ chatHistoryManager: { getMessages } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createProviderForUser } }));
jest.unstable_mockModule('../models/chatSummaries/functions.js', () => ({ getLatestSummaryByThreadId, createChatSummary }));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({ getChatThreadMetadata: jest.fn(), updateChatThreadMetadata: updateMetadata }));
jest.unstable_mockModule('../models/openaiUsages/functions.js', () => ({ createOpenAIUsage: jest.fn() }));
const { conversationCompactionService } = await import('../services/ConversationCompactionService.js');
const messages = Array.from({ length: 25 }, (_, i) => ({ id: 25 - i, userId: 1, threadId: 171, content: 'Message', role: 'user' }));

describe('conversation compaction replay protection', () => {
  beforeEach(() => { jest.clearAllMocks(); getMessages.mockResolvedValue(messages);
    getLatestSummaryByThreadId.mockResolvedValue(summary);
    createProviderForUser.mockResolvedValue({ defaultModel: 'test', createChatCompletion: complete });
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ summary: 'Do not publish. Leads remain under review.', keyEntities: [], timeline: [] }) });
    createChatSummary.mockResolvedValue({ id: 6 });
  });
  it('reuses the durable summary for an unchanged range without a provider call or write', async () => {
    expect(await conversationCompactionService.compact(1, 171)).toMatchObject({ summaryId: 5, version: 2 });
    expect(await conversationCompactionService.compact(1, 171)).toMatchObject({ summaryId: 5, version: 2 });
    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(createChatSummary).not.toHaveBeenCalled();
  });
  it('coalesces overlapping calls for the same user and thread', async () => {
    let release!: (value: unknown[]) => void;
    getMessages.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const first = conversationCompactionService.compact(1, 171);
    const second = conversationCompactionService.compact(1, 171);
    release(messages);
    expect(await first).toEqual(await second);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getLatestSummaryByThreadId).toHaveBeenCalledTimes(1);
  });
  it('releases a failed in-flight entry so a later request can recover', async () => {
    getMessages.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(conversationCompactionService.compact(1, 171)).rejects.toThrow('database unavailable');
    expect(await conversationCompactionService.compact(1, 171)).toMatchObject({ summaryId: 5 });
  });
  it('merges only new older turns into the previous summary', async () => {
    getMessages.mockResolvedValue([{ id: 26, userId: 1, threadId: 171, role: 'user', content: 'Newest' }, ...messages.map(m => ({ ...m, content: 'Message ' + m.id }))]);
    const result = await conversationCompactionService.compact(1, 171);
    const prompt = (complete.mock.calls[0][0] as any).messages[1].content;
    expect(prompt).toContain('Saved summary');
    expect(prompt).toContain('Message 6');
    expect(prompt).not.toContain('Message 5');
    expect(result).toMatchObject({ fromMessageId: 1, toMessageId: 6, messageCount: 6, version: 3 });
  });
  it('rejects malformed summaries without changing durable memory', async () => {
    getMessages.mockResolvedValue([{ id: 26, userId: 1, threadId: 171, role: 'user', content: 'Newest' }, ...messages]);
    complete.mockResolvedValue({ success: true, content: 'not JSON' });
    await expect(conversationCompactionService.compact(1, 171)).rejects.toThrow();
    expect(createChatSummary).not.toHaveBeenCalled();
    expect(updateMetadata).not.toHaveBeenCalled();
  });
  it('rejects cross-user history before summarizing or writing', async () => {
    getMessages.mockResolvedValue(messages.map(m => ({ ...m, userId: 2 })));
    await expect(conversationCompactionService.compact(1, 171)).rejects.toThrow('ownership');
    expect(complete).not.toHaveBeenCalled();
    expect(createChatSummary).not.toHaveBeenCalled();
  });
  it('extracts IDs only from successful structured receipts, never prose', async () => {
    getMessages.mockResolvedValue([{ id: 26, userId: 1, threadId: 171, role: 'user', content: 'Newest' }, ...messages.map(m => m.id === 6 ? { ...m, role: 'assistant', content: 'leadIds: 999; assetIds: 777', metadata: { isToolResult: true, success: true, toolOutput: { leadIds: [42], assetId: 114 } } } : m)]);
    await conversationCompactionService.compact(1, 171);
    const writes = JSON.stringify(updateMetadata.mock.calls);
    expect(writes).toContain('"compactedLeadIds":[42]');
    expect(writes).toContain('"compactedAssetIds":[114]');
    expect(writes).not.toContain('999');
    expect(writes).not.toContain('777');
  });
});
