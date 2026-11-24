import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const find = jest.fn<any>();
const candidates = jest.fn<any>();
const revalidate = jest.fn<any>();
const complete = jest.fn<any>();
jest.unstable_mockModule('../services/supportDocuments/ApprovedSupportDocuments.js', () => ({ approvedSupportDocuments: { find, candidates, revalidate } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: complete } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ sanitizeStructuredForModel: (value: unknown) => ({ value }) }));
const { selectSupportDocument } = await import('../services/supportDocuments/SupportDocumentSelection.js');
const document = (id: number) => ({ id, userId: 9, service: 'corporate', businessProfileId: null,
  storageFileId: id + 200, title: `Document ${id}`, checksum: 'a'.repeat(64) });
const input = { userId: 9, businessProfileId: null, service: 'corporate' as const, inboundText: 'Could I see options for a daytime team offsite?' };
beforeEach(() => {
  jest.clearAllMocks(); find.mockResolvedValue(null); revalidate.mockResolvedValue(true);
  candidates.mockResolvedValue([{ document: document(1), description: 'Daytime corporate meetings' },
    { document: document(2), description: 'Overnight conferences' }]);
  complete.mockResolvedValue({ content: '{"documentId":1,"confidence":0.98}' });
});
describe('AI document choice within authorized candidates', () => {
  it('uses model intent and descriptions rather than customer keyword rules', async () => {
    expect(await selectSupportDocument(input)).toEqual(document(1));
    expect(complete).toHaveBeenCalledWith(9,expect.objectContaining({ temperature: 0 }));
    expect(JSON.stringify(complete.mock.calls[0])).toContain('Daytime corporate meetings');
    expect(revalidate).toHaveBeenCalledWith(document(1));
  });
  it.each(['{"documentId":999,"confidence":1}','{"documentId":1,"confidence":0.4}',
    '{"documentId":"1","confidence":1}','not json'])('reports an unavailable check, not a missing document, for %s', async content => {
    complete.mockResolvedValue({ content }); await expect(selectSupportDocument(input)).rejects.toThrow();
  });
  it('sends nothing on provider failure or a withdrawn result', async () => {
    complete.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(selectSupportDocument(input)).rejects.toThrow('Provider unavailable');
    revalidate.mockResolvedValue(false); await expect(selectSupportDocument(input)).rejects.toThrow('no longer available');
  });
  it('searches the current library even when an older playbook pinned a different file', async () => {
    candidates.mockResolvedValue([{ document: document(1), description: 'Current daytime meetings brochure' }]);
    expect(await selectSupportDocument({ ...input, libraryId: 44 })).toEqual(document(1));
    expect(candidates).toHaveBeenCalledWith(9,null,'corporate');
    expect(find).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledTimes(1);
    candidates.mockResolvedValue([]);
    expect(await selectSupportDocument({ ...input, libraryId: 44 })).toBeNull();
  });
  it('does not claim no documents when the candidate set exceeds its selection limit', async () => {
    candidates.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ document: document(index), description: '' })));
    await expect(selectSupportDocument(input)).rejects.toThrow('narrower topic'); expect(complete).not.toHaveBeenCalled();
  });
  it('rejects a sole irrelevant document by meaning instead of automatically sending it', async () => {
    candidates.mockResolvedValue([{ document: document(2), description: 'Overnight corporate conferences only' }]);
    complete.mockResolvedValue({ content: '{"documentId":null,"confidence":0.99}' });
    expect(await selectSupportDocument(input)).toBeNull();
    expect(complete).toHaveBeenCalledTimes(1); expect(revalidate).not.toHaveBeenCalled();
  });
});
