import { beforeEach, afterAll, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { KnowledgeQuery } from '../services/knowledge/types.js';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let settings: Record<string, unknown> | undefined;
let withdrawn = false;
let vectorOnly = false;
let failKnowledgeRead = false;
const hit = {
  chunk_id: 30, evidence_id: 'KB-2-V1-C0', document_id: 2, version_id: 20,
  ordinal: 0, display_text: 'HARBOUR-QA-B846-V1 resets with the blue button.',
  title: 'Published display heading', token_count: 12, authority: 'owner_authored',
  exact_identifiers: ['HARBOUR-QA-B846-V1'], lexical_score: 1, vector_score: 0.95,
};
const execute = jest.fn(async (input: SQL) => {
  const query = new PgDialect().sqlToQuery(input);
  queries.push(query);
  if (query.sql.includes('FROM knowledge_runtime_settings rs')) return { rows: settings ? [settings] : [] };
  if (query.sql.includes('FROM knowledge_chunks c') || query.sql.includes('FROM knowledge_chunk_embeddings e')) {
    if (failKnowledgeRead) throw new Error('governed index unavailable');
    if (query.sql.includes('c.id = ANY')) return { rows: withdrawn ? [] : [hit] };
    if (query.sql.includes('ts_rank_cd')) return { rows: vectorOnly ? [] : [hit] };
    return { rows: [hit] };
  }
  return { rows: [] };
});
jest.unstable_mockModule('../models/db.js', () => ({
  db: { execute, transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({ execute }) },
}));
const legacySearch = jest.fn(async () => [{ content: 'WITHDRAWN LEGACY CONTENT', sourceId: 23, similarity: 1 }]);
const generateEmbedding = jest.fn(async () => ({ dimensions: 3, vector: [0.2, 0.3, 0.4] }));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({
  embeddingService: { searchSimilar: legacySearch, generateEmbedding },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
const rerank = jest.fn(async (_query: unknown, candidates: unknown[]) => ({ candidates, reranked: false }));
jest.unstable_mockModule('../services/knowledge/KnowledgeReranker.js', () => ({ rerankKnowledgeCandidates: rerank }));
const { knowledgeGateway } = await import('../services/knowledge/KnowledgeGateway.js');
const { knowledgeBaseService } = await import('../services/KnowledgeBaseService.js');
const query: KnowledgeQuery = { tenantId: 9, redactedText: 'HARBOUR-QA-B846-V1 blue button',
  purpose: 'support_answer', audience: 'internal', channel: 'internal', risk: 'low' };
const previousFlag = process.env.KNOWLEDGE_V2_ENABLED;

describe('knowledge withdrawal and rollback runtime', () => {
  beforeEach(() => {
    delete process.env.KNOWLEDGE_V2_ENABLED;
    queries.length = 0; withdrawn = false; vectorOnly = false; failKnowledgeRead = false;
    settings = { knowledge_v2_enabled: false, maintenance_mode: false, index_id: 1,
      version_key: 'index:test', provider: 'openai', model: 'test', dimensions: 3 };
    jest.clearAllMocks();
    rerank.mockImplementation(async (_query, candidates) => ({ candidates, reranked: false }));
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.KNOWLEDGE_V2_ENABLED;
    else process.env.KNOWLEDGE_V2_ENABLED = previousFlag;
  });

  it('returns current published evidence when V2 is off without using legacy vectors, text, or a model', async () => {
    const result = await knowledgeGateway.retrieve(query);
    expect(result.status).toBe('sufficient');
    expect(result.indexVersion).toBe('published-lexical-only');
    expect(result.evidence[0]).toMatchObject({ evidenceId: 'KB-2-V1-C0', versionId: 20, documentId: 2 });
    expect(legacySearch).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(rerank).not.toHaveBeenCalled();
    expect(queries.some(item => /FROM knowledge_base\b|FROM embeddings\b/.test(item.sql))).toBe(false);
    expect(queries.filter(item => item.sql.includes('set_config')).every(item => item.params[0] === '9')).toBe(true);
  });

  it('keeps the old method as a governed lexical wrapper without recursive fallback', async () => {
    settings!.knowledge_v2_enabled = true;
    const result = await knowledgeBaseService.getLegacyGroundedContext(9, query.redactedText);
    expect(result.status).toBe('grounded');
    expect(result.sources[0].citation).toBe('KB-2-V1-C0');
    expect(result.context).toContain('HARBOUR-QA-B846-V1');
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(legacySearch).not.toHaveBeenCalled();
  });

  it.each(['false', 'true', undefined])('honors maintenance even with environment flag %s', async flag => {
    if (flag === undefined) delete process.env.KNOWLEDGE_V2_ENABLED;
    else process.env.KNOWLEDGE_V2_ENABLED = flag;
    settings!.maintenance_mode = true;
    const result = await knowledgeGateway.retrieve(query);
    expect(result).toMatchObject({ status: 'unavailable', evidence: [], diagnostics: { reason: 'maintenance_mode' } });
    expect(queries).toHaveLength(1);
    expect(legacySearch).not.toHaveBeenCalled();
  });

  it('fails closed when runtime settings cannot be established', async () => {
    settings = undefined;
    expect(await knowledgeGateway.retrieve(query)).toMatchObject({ status: 'unavailable', evidence: [],
      diagnostics: { reason: 'runtime_settings_unavailable' } });
    expect(queries).toHaveLength(1);
  });

  it('never falls back to raw legacy content when the governed tables are unavailable', async () => {
    failKnowledgeRead = true;
    expect(await knowledgeGateway.retrieve(query)).toMatchObject({ status: 'unavailable', evidence: [] });
    expect(legacySearch).not.toHaveBeenCalled();
  });

  it.each([false, true])('revalidates %s vector-only candidates after reranking and drops withdrawals', async vector => {
    settings!.knowledge_v2_enabled = true;
    vectorOnly = vector;
    rerank.mockImplementation(async (_query, candidates) => { withdrawn = true; return { candidates, reranked: true }; });
    expect(await knowledgeGateway.retrieve(query)).toMatchObject({ status: 'insufficient', evidence: [] });
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
    expect(queries.some(item => item.sql.includes('c.id = ANY'))).toBe(true);
    expect(legacySearch).not.toHaveBeenCalled();
  });

  it('applies publication, privacy, profile and scope filters to actual compiled lexical/vector/final SQL', async () => {
    settings!.knowledge_v2_enabled = true;
    await knowledgeGateway.retrieve({ ...query, businessProfileId: 42, audience: 'customer' });
    const reads = queries.filter(item => item.sql.includes('AS chunk_id'));
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      for (const boundary of [
        'v.document_id = d.id AND c.document_id = d.id', 'd.current_published_version_id = v.id',
        "v.status IN ('published', 'published_degraded')", 'v.effective_at <= NOW()', 'v.expires_at > NOW()',
        "v.privacy_classification IN ('public', 'business', 'internal')",
        "c.sensitivity IN ('public', 'business', 'internal')", 'cardinality(c.injection_flags) = 0',
        "d.access_scope IN ('tenant', 'business_profile', 'staff_only')", "c.access_scope <> 'staff_only'",
        'd.usage_scopes &&', 'ANY(d.allowed_channels)', "d.audience = 'customer'",
        'd.business_profile_id IS NULL OR d.business_profile_id =', 'maintenance_mode = TRUE',
      ]) expect(read.sql).toContain(boundary);
      expect(read.params).toContain(9);
      expect(read.params).toContain(42);
      expect(read.sql).not.toMatch(/d\.title|d\.source_url/);
    }
  });
});
