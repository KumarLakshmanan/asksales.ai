import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const completion = jest.fn<any>();
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: completion }));
const { selectMessagesForAgent, prepareContextForAgent, compactMessagesWithAI } = await import('../mastra/utils/contextManager.js');
const { compactToolResult, hasHistoricalReceiptEcho, HISTORICAL_RECEIPT_MARKER } = await import('../mastra/utils/toolResultContext.js');
beforeEach(() => { completion.mockReset(); });
describe('campaign memory', () => {
  it('rejects model-authored historical receipt markers, not ordinary review explanations', () => {
    expect(hasHistoricalReceiptEcho(HISTORICAL_RECEIPT_MARKER + ' {"widgetId":49} Ready.')).toBe(true);
    expect(hasHistoricalReceiptEcho('The previous review has completed.')).toBe(false);
    expect(hasHistoricalReceiptEcho(null)).toBe(false);
  });
  it('retains cross-agent context without keyword matching', () => {
    const messages = [{ role: 'assistant', content: 'The second choice was rejected. Never repeat it.', agentType: 'outreach' }, ...Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `Turn ${i}` }))];
    expect(selectMessagesForAgent(messages, 'content_studio')).toContain(messages[0]);
  });
  it('passes summary and specialist notes alongside recent messages', () => {
    const result = prepareContextForAgent({ messages: [{ role: 'user', content: 'Continue' }], contextSummary: 'Do not publish. Asset 114 revision 2 is pending.', scratchpad: { content_studio: ['Customer rejected red.'] } } as any, 'content_studio');
    expect(result.filter(m => m.role === 'system').map(m => m.content).join('\n')).toContain('Do not publish');
    expect(result.map(m => m.content).join('\n')).toContain('Customer rejected red.');
  });
  it('preserves originals when semantic compaction fails validation', async () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `Request ${i}` }));
    completion.mockResolvedValue({ success: true, content: '{"summary":""}' });
    expect(await compactMessagesWithAI(messages, 1, 1)).toBe(messages);
  });
  it('summarizes old turns while keeping the latest turn intact', async () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i}` }));
    completion.mockResolvedValue({ success: true, content: JSON.stringify({ summary: 'Only draft; never send.', keyEntities: [], timeline: [] }) });
    const result = await compactMessagesWithAI(messages, 1, 2);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('never send');
    expect(result.at(-1)).toBe(messages.at(-1));
    expect(result[1].role).toBe('user');
    expect((completion.mock.calls[0][1] as any).messages[0].content).toContain('prohibitions');
  });
  it('preserves nested receipt identity and bounded catalog samples as valid JSON', () => {
    const receipt = { success: true, requiresApproval: true, toolName: 'generate_ad', output: { assetId: 114, revision: 2, executionId: 'review-9', status: 'pending', body: 'x'.repeat(15000), workflows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `Workflow ${i}`, description: 'long description'.repeat(40) })) } };
    const encoded = compactToolResult(receipt, 4000);
    expect(encoded.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(encoded)).toMatchObject({ success: true, requiresApproval: true, output: { assetId: 114, revision: 2, executionId: 'review-9', status: 'pending' } });
    expect(encoded).toContain('_omittedItems');
    expect(receipt.output.workflows).toHaveLength(300);
  });
});
