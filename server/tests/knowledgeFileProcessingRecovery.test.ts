import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let entry: Record<string, unknown>;
const update = jest.fn(
  async (_id: number, _userId: number, changes: Record<string, unknown>) => {
    entry = { ...entry, ...changes };
    return entry;
  },
);
const ingest = jest.fn(async (_input: unknown) => ({
  extractedText: 'Synthetic searchable text',
  chunks: [{ index: 0, text: 'Synthetic searchable text' }],
  embeddingsGenerated: false,
  extractionSource: 'text-loader',
  extractionWarnings: [],
}));
const index =
  jest.fn<(...args: unknown[]) => Promise<{ vectorIndexed: boolean }>>();
jest.unstable_mockModule('../models/knowledgeBase/functions.js', () => ({
  KnowledgeBaseModel: {
    findById: async () => entry,
    update,
  },
}));
jest.unstable_mockModule('../services/StorageService.js', () => ({
  StorageService: {
    getInstance: () => ({
      downloadFile: async () => ({
        file: { userId: 9, fileName: 'synthetic.txt', mimeType: 'text/plain' },
        buffer: Buffer.from('Synthetic searchable text'),
      }),
    }),
  },
}));
jest.unstable_mockModule(
  '../services/KnowledgeBaseIngestionService.js',
  () => ({ ingestKnowledgeBaseFile: ingest }),
);
jest.unstable_mockModule(
  '../services/knowledge/KnowledgeIngestionService.js',
  () => ({ knowledgeIngestionService: { indexLegacyEntry: index } }),
);
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));
const { processKnowledgeBaseEntryIngestion: processFile } =
  await import('../services/KnowledgeBaseProcessingService.js');

describe('canonical file indexing recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    entry = { id: 5, userId: 9, type: 'file', processingStatus: 'queued' };
    index.mockResolvedValue({ vectorIndexed: false });
  });
  it('keeps successful extraction but reports failed canonical indexing and permits retry', async () => {
    index.mockRejectedValueOnce(new Error('Synthetic canonical index outage'));
    await expect(
      processFile({ userId: 9, entryId: 5, storageFileId: 12 }),
    ).rejects.toThrow('KNOWLEDGE_VERSION_INDEX_FAILED');
    expect(entry).toMatchObject({
      processingStatus: 'failed',
      extractionStatus: 'completed',
      indexingStatus: 'failed',
    });
    expect(JSON.parse(String(entry.content)).extractedText).toBe(
      'Synthetic searchable text',
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ generateEmbeddings: false }),
    );
    await expect(
      processFile({ userId: 9, entryId: 5, storageFileId: 12 }),
    ).resolves.toMatchObject({ success: true, embeddingsGenerated: false });
    expect(index).toHaveBeenCalledTimes(2);
    expect(entry).toMatchObject({
      processingStatus: 'completed',
      extractionStatus: 'completed',
      indexingStatus: 'failed',
    });
  });
  it('reports vector completion only when the canonical index completed', async () => {
    index.mockResolvedValue({ vectorIndexed: true });
    await expect(
      processFile({ userId: 9, entryId: 5, storageFileId: 12 }),
    ).resolves.toMatchObject({ success: true, embeddingsGenerated: true });
    expect(entry).toMatchObject({
      processingStatus: 'completed',
      indexingStatus: 'completed',
    });
  });
});
