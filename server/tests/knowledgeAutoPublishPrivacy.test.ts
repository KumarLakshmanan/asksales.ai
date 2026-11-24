import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { KnowledgeBaseEntry } from '../models/knowledgeBase/schema.js';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let entryExists = true;
const execute = jest.fn(async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  queries.push(compiled);
  if (compiled.sql.includes('SELECT iv.id')) return { rows: [{ id: 7, version_key: 'test', provider: 'openai', model: 'test', dimensions: 3 }] };
  if (compiled.sql.includes('SELECT id FROM knowledge_base')) return { rows: entryExists ? [{ id: 5 }] : [] };
  if (compiled.sql.includes('SELECT * FROM knowledge_documents')) return { rows: [{ id: 2 }] };
  if (compiled.sql.includes('SELECT id, version_no, content_hash')) return { rows: [{ id: 20, version_no: 1, content_hash: 'old-approved-version' }] };
  if (compiled.sql.includes('INSERT INTO knowledge_document_versions')) return { rows: [{ id: 21 }] };
  if (compiled.sql.includes('INSERT INTO knowledge_chunks')) return { rows: [{ id: 31 }] };
  return { rows: [] };
});
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute, transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({ execute }),
} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
// Deterministic local PII detector; real privacy scanner and chunker run below.
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL_1]') }),
}));
const embed = jest.fn(async (_texts: string[]) => ({ provider: 'openai', model: 'test', dimensions: 3, vectors: [[0.1, 0.2, 0.3]] }));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: { generateEmbeddingsBatch: embed } }));
const { knowledgeIngestionService } = await import('../services/knowledge/KnowledgeIngestionService.js');
const entry = { id: 5, userId: 9, type: 'document', title: 'Update', content: '' } as KnowledgeBaseEntry;

describe('automatic knowledge publication privacy boundary', () => {
  beforeEach(() => { queries.length = 0; jest.clearAllMocks(); entryExists = true;
    embed.mockImplementation(async () => ({ provider: 'openai', model: 'test', dimensions: 3, vectors: [[0.1, 0.2, 0.3]] })); });

  it('keeps personal content in review and preserves the previously published version pointer', async () => {
    const result = await knowledgeIngestionService.indexLegacyEntry({ ...entry, content: 'Contact jane@example.test for the reset instructions.' }, { autoPublish: true });
    expect(result).toMatchObject({ versionId: 21, status: 'ready_for_review' });
    const version = queries.find(query => query.sql.includes('INSERT INTO knowledge_document_versions'))!;
    expect(version.params).toContain('personal');
    expect(version.params).toContain('ready_for_review');
    expect(version.params).not.toContain('published');
    expect(version.params).not.toContain('published_degraded');
    expect(queries.some(query => query.sql.includes('SET current_published_version_id'))).toBe(false);
    expect(queries.some(query => query.sql.includes("SET status = 'retired'"))).toBe(false);
    expect(embed.mock.calls[0][0][0]).not.toContain('jane@example.test');
  });

  it('preserves auto-publication for safe business content', async () => {
    const result = await knowledgeIngestionService.indexLegacyEntry({ ...entry, content: 'Press the blue reset button.' }, { autoPublish: true });
    expect(result).toMatchObject({ versionId: 21, status: 'published' });
    expect(queries.find(query => query.sql.includes('SET current_published_version_id'))?.params).toEqual(expect.arrayContaining([21, 2, 9]));
  });

  it('continues to quarantine secrets before embeddings or publication', async () => {
    const result = await knowledgeIngestionService.indexLegacyEntry({ ...entry, content: 'api_key = abcdefghijklmnop' }, { autoPublish: true });
    expect(result.status).toBe('quarantined');
    expect(embed).not.toHaveBeenCalled();
    expect(queries.some(query => query.sql.includes('SET current_published_version_id'))).toBe(false);
  });
  it('never silently auto-publishes keyword-only knowledge when embeddings fail', async () => {
    embed.mockRejectedValue(new Error('provider offline'));
    const result = await knowledgeIngestionService.indexLegacyEntry({ ...entry, content: 'Press the blue reset button.' }, { autoPublish: true });
    expect(result.status).toBe('ready_for_review');
    expect(queries.some(query => query.sql.includes('SET current_published_version_id'))).toBe(false);
  });
  it('does not recreate deleted knowledge when an already queued ingestion finishes', async () => {
    entryExists = false;
    await expect(knowledgeIngestionService.indexLegacyEntry({ ...entry, content: 'Press the blue reset button.' })).rejects.toThrow('KNOWLEDGE_ENTRY_NOT_FOUND');
    expect(queries.some(query => query.sql.includes('INSERT INTO knowledge_document'))).toBe(false);
  });
  it('writes draft profile metadata into the version without changing the live document', async () => {
    await knowledgeIngestionService.indexLegacyEntry({ ...entry, businessProfileId: 42, content: 'Press the blue reset button.' });
    expect(queries.some(query => query.sql.includes('UPDATE knowledge_documents'))).toBe(false);
    const metadata = JSON.parse(queries.find(query => query.sql.includes('INSERT INTO knowledge_document_versions'))!.params.at(-1) as string);
    expect(metadata.publicationMetadata).toMatchObject({ title: 'Update', businessProfileId: 42, accessScope: 'business_profile' });
  });
});
