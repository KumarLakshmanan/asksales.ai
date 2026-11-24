import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { KnowledgeBaseEntry } from '../models/knowledgeBase/schema.js';

const content = 'Q: When do you open?\nA: We open at 9 AM.';
let status: string;
let vectorStatus: string;
let storedText: string;
let contentHash: string;
const queries: Array<{ sql: string; params: unknown[] }> = [];
const execute = jest.fn(async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  queries.push(compiled);
  if (compiled.sql.includes('SELECT iv.id')) return { rows: [{ id: 7, version_key: 'test', provider: 'openai', model: 'test', dimensions: 3 }] };
  if (compiled.sql.includes('SELECT id FROM knowledge_base')) return { rows: [{ id: 5 }] };
  if (compiled.sql.includes('SELECT * FROM knowledge_documents')) return { rows: [{ id: 2 }] };
  if (compiled.sql.includes('SELECT id, version_no, content_hash')) return { rows: [{ id: 20, version_no: 1, content_hash: contentHash, status, vector_index_status: vectorStatus }] };
  if (compiled.sql.includes('SELECT id, ordinal, search_text')) return { rows: [{ id: 30, ordinal: 0, search_text: storedText }] };
  return { rows: [] };
});
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, transaction: (callback: any) => callback({ execute }) } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
const embed = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: { generateEmbeddingsBatch: embed } }));
const { scanKnowledgeContent } = await import('../services/knowledge/KnowledgePrivacyService.js');
const { knowledgeIngestionService } = await import('../services/knowledge/KnowledgeIngestionService.js');
const entry = { id: 5, userId: 9, type: 'qa', title: 'Hours', question: 'When do you open?', answer: 'We open at 9 AM.' } as KnowledgeBaseEntry;

beforeEach(() => {
  queries.length = 0; status = 'published_degraded'; vectorStatus = 'failed'; storedText = content;
  contentHash = scanKnowledgeContent(content).contentHash;
  embed.mockReset().mockResolvedValue({ provider: 'openai', model: 'test', dimensions: 3, vectors: [[0.1, 0.2, 0.3]] });
});
describe('embedding retries for unchanged published Q&A', () => {
  it.each(['published_degraded', 'ready_for_review'])('persists recovered vectors without replacing or publishing the %s version', async currentStatus => {
    status = currentStatus;
    expect(await knowledgeIngestionService.indexLegacyEntry(entry)).toMatchObject({ versionId: 20, vectorIndexed: true, skipped: true });
    const saved = queries.find(query => query.sql.includes('INSERT INTO knowledge_chunk_embeddings'));
    expect(saved?.params.slice(0, 6)).toEqual([9, 30, 7, 'openai', 'test', 3]);
    expect(saved?.sql).toContain('ON CONFLICT (chunk_id, index_version_id) DO UPDATE');
    expect(queries.find(query => query.sql.includes("SET vector_index_status = 'completed'"))?.sql)
      .toContain("CASE WHEN status = 'published_degraded' THEN 'published' ELSE status END");
    expect(queries.some(query => query.sql.includes('SET current_published_version_id') || query.sql.includes('INSERT INTO knowledge_document_versions'))).toBe(false);
  });
  it.each(['revoked', 'quarantined', 'retired'])('does not restore %s knowledge', async currentStatus => {
    status = currentStatus;
    expect((await knowledgeIngestionService.indexLegacyEntry(entry)).vectorIndexed).toBe(false);
    expect(queries.some(query => query.sql.includes('INSERT INTO knowledge_chunk_embeddings'))).toBe(false);
  });
  it('does not attach newly chunked vectors to incompatible stored chunks', async () => {
    storedText = 'An older chunking layout';
    expect((await knowledgeIngestionService.indexLegacyEntry(entry)).vectorIndexed).toBe(false);
    expect(queries.some(query => query.sql.includes('INSERT INTO knowledge_chunk_embeddings'))).toBe(false);
  });
  it.each([{ vectors: [[NaN, 0, 1]] }, { vectors: [[0.1, 0.2]] }])('rejects invalid provider vectors without damaging the lexical version', async ({ vectors }) => {
    embed.mockResolvedValue({ provider: 'openai', model: 'test', dimensions: 3, vectors });
    expect((await knowledgeIngestionService.indexLegacyEntry(entry)).vectorIndexed).toBe(false);
    expect(queries.some(query => query.sql.includes('INSERT INTO knowledge_chunk_embeddings'))).toBe(false);
  });
  it('reports existing vector coverage truthfully when the provider is unavailable', async () => {
    vectorStatus = 'completed';
    embed.mockRejectedValue(new Error('provider unavailable'));
    expect((await knowledgeIngestionService.indexLegacyEntry(entry)).vectorIndexed).toBe(true);
  });
});
