import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn(async (_query: SQL) => ({ rows: [] }));
const entry = { id: 23, userId: 1, type: 'document', title: 'Synthetic QA', content: 'Check-in is at 3 PM.' };
const find = jest.fn<(...args: unknown[]) => Promise<typeof entry | null>>(async () => entry);
const index = jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ status: 'ready_for_review', vectorIndexed: false }));
const embed = jest.fn<(...args: unknown[]) => Promise<any>>(async () => ({ vectors: [[1, 2, 3]], provider: 'openai', model: 'test' }));
const replace = jest.fn(async () => 1);
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/knowledgeBase/functions.js', () => ({ KnowledgeBaseModel: { findById: find } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeIngestionService.js', () => ({ knowledgeIngestionService: { indexLegacyEntry: index } }));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: { generateEmbeddingsBatch: embed, replaceKnowledgeBaseEmbeddings: replace } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ redactPiiWithStableTokens: (text: string) => ({ redactedText: text }) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
const { knowledgeBaseService } = await import('../services/KnowledgeBaseService.js');

describe('document and Q&A governed ingestion under vector degradation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    find.mockResolvedValue(entry);
    index.mockResolvedValue({ status: 'ready_for_review', vectorIndexed: false });
    embed.mockResolvedValue({ vectors: [[1, 2, 3]], provider: 'openai', model: 'test' });
  });
  it.each(['invalid provider key', 'embedding timeout'])('still creates a reviewable canonical lexical version after %s', async error => {
    embed.mockRejectedValue(new Error(error));
    await expect(knowledgeBaseService.indexEntry(1, 23, entry.content)).resolves.toBeUndefined();
    expect(index).toHaveBeenCalledWith(entry, { autoPublish: false });
    expect(replace).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not report success if canonical indexing fails even when legacy indexing succeeds', async () => {
    index.mockRejectedValue(new Error('canonical index unavailable'));
    await expect(knowledgeBaseService.indexEntry(1, 23, entry.content)).rejects.toThrow('canonical index unavailable');
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain("processing_status = 'failed'");
    expect(query.params).toEqual([23, 1]);
  });
  it('fails for a missing owned entry instead of silently reporting completion', async () => {
    find.mockResolvedValue(null);
    await expect(knowledgeBaseService.indexEntry(1, 23, entry.content)).rejects.toThrow('unavailable during indexing');
    expect(index).not.toHaveBeenCalled();
  });
  it('quarantines secret source before any legacy embedding request', async () => {
    const secretEntry = { ...entry, content: 'api_key = syntheticabcdefghijklmnop' };
    find.mockResolvedValue(secretEntry);
    index.mockResolvedValue({ status: 'quarantined', vectorIndexed: false });
    await expect(knowledgeBaseService.indexEntry(1, 23, secretEntry.content)).rejects.toThrow('privacy review');
    expect(index).toHaveBeenCalledWith(secretEntry, { autoPublish: false });
    expect(embed).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
