import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const complete = jest.fn<(...args: unknown[]) => Promise<{ content: string }>>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: complete } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ sanitizeStructuredForModel: (value: unknown) => ({ value }) }));
const { selectRelevantMediaCandidates } = await import('../services/supportMedia/MediaRelevanceSelector.js');
const rows = [
  { gallery_id: 1, gallery_title: 'Premium Club Room', entity_tags: ['oro the estate', 'room photos'] },
  { gallery_id: 1, gallery_title: 'Premium Club Room', entity_tags: ['oro the estate', 'room photos'] },
  { gallery_id: 2, gallery_title: 'Sanctuary Villa', entity_tags: ['oro the estate', 'villa photos'] },
  { gallery_id: 3, gallery_title: 'Pool Villa', entity_tags: ['oro the estate', 'villa photos'] },
];
beforeEach(() => { complete.mockReset(); });
describe('AI media relevance boundary', () => {
  it('keeps only the model-selected room despite shared property tags', async () => {
    complete.mockResolvedValue({ content: JSON.stringify({ galleryIds: [1], confidence: 0.98 }) });
    expect(await selectRelevantMediaCandidates({ userId: 9, request: 'Premium Club Room photos at Oro The Estate', rows })).toEqual(rows.slice(0, 2));
    expect(complete.mock.calls[0][0]).toBe(9);
    expect(JSON.stringify(complete.mock.calls[0][1])).toContain('not by shared words');
  });
  it('allows genuine comparisons across model-selected entities', async () => {
    complete.mockResolvedValue({ content: JSON.stringify({ galleryIds: [1, 3], confidence: 0.95 }) });
    expect((await selectRelevantMediaCandidates({ userId: 9, request: 'Compare club room and pool villa', rows })).map((row) => row.gallery_id)).toEqual([1, 1, 3]);
  });
  it.each([
    { galleryIds: [999], confidence: 1 }, { galleryIds: ['1'], confidence: 1 },
    { galleryIds: [1], confidence: 0.6 }, { galleryIds: [1], confidence: 1.1 }, {},
  ])('fails closed on invalid/uncertain model output: %j', async (decision) => {
    complete.mockResolvedValue({ content: JSON.stringify(decision) });
    await expect(selectRelevantMediaCandidates({ userId: 9, request: 'room photos', rows })).rejects.toThrow();
  });
  it('returns no substitute when no gallery depicts the requested subject', async () => {
    complete.mockResolvedValue({ content: '{"galleryIds":[],"confidence":0.99}' });
    expect(await selectRelevantMediaCandidates({ userId: 9, request: 'spa photos', rows })).toEqual([]);
  });
  it('checks relevance even with one candidate and propagates provider failure', async () => {
    complete.mockRejectedValue(new Error('Provider unavailable'));
    await expect(selectRelevantMediaCandidates({ userId: 9, request: 'spa photo', rows: rows.slice(0, 1) })).rejects.toThrow('Provider unavailable');
  });
});
