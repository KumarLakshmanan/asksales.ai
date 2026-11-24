import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { KnowledgeQuery } from '../services/knowledge/types.js';

const generateEmbedding = jest.fn<any>();
const logError = jest.fn();
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: logError, warn: jest.fn(), info: jest.fn() } }));
const dialect = new PgDialect();
let lexicalRows: unknown[] = [];
const fixtureDb: any = {
  transaction: async (callback: any) => callback(fixtureDb),
  execute: async (statement: any) => {
    const query = dialect.sqlToQuery(statement).sql;
    if (query.includes('FROM knowledge_runtime_settings rs')) return { rows: [{
      knowledge_v2_enabled: true, maintenance_mode: false, index_id: 2,
      version_key: 'openrouter:test', provider: 'openrouter',
      model: 'openai/text-embedding-3-small', dimensions: 1536,
    }] };
    if (query.includes('FROM knowledge_chunks c')) return { rows: lexicalRows };
    return { rows: [] };
  },
};
jest.unstable_mockModule('../models/db.js', () => ({ db: fixtureDb }));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: { generateEmbedding } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
jest.unstable_mockModule('../services/knowledge/KnowledgeReranker.js', () => ({
  rerankKnowledgeCandidates: async (_query: unknown, candidates: unknown[]) => ({ candidates, reranked: false }),
}));
const { knowledgeGateway } = await import('../services/knowledge/KnowledgeGateway.js');
const query: KnowledgeQuery = { tenantId: 9, purpose: 'support_answer', audience: 'customer',
  channel: 'instagram', risk: 'low', redactedText: 'When is check-in?' };

beforeEach(() => {
  lexicalRows = [];
  generateEmbedding.mockReset().mockRejectedValue(new Error('No active embedding credential for openrouter.'));
  logError.mockClear();
});

describe('knowledge search during a provider outage', () => {
  it('reports unavailable instead of a false knowledge gap when vector search fails', async () => {
    const result = await knowledgeGateway.retrieve(query);
    expect(logError).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'unavailable', evidence: [],
      diagnostics: { degraded: true, reason: 'vector_retrieval_unavailable' },
    });
  });

  it('still serves authorized lexical evidence while reporting degraded vector search', async () => {
    lexicalRows = [{ chunk_id: 30, evidence_id: 'KB-2-V1-C0', document_id: 2,
      version_id: 20, ordinal: 0, display_text: 'Check-in is at 3 PM.',
      token_count: 8, lexical_score: 1, authority: 'tenant_policy' }];
    const result = await knowledgeGateway.retrieve(query);
    expect(result.status).toBe('sufficient');
    expect(result.evidence[0].excerpt).toBe('Check-in is at 3 PM.');
    expect(result.diagnostics.reason).toBe('vector_retrieval_unavailable');
  });

  it('keeps insufficient for a successful search with no matching sources', async () => {
    generateEmbedding.mockResolvedValue({ vector: Array(1536).fill(0.1), dimensions: 1536 });
    expect(await knowledgeGateway.retrieve(query)).toMatchObject({ status: 'insufficient', evidence: [], diagnostics: { degraded: false } });
  });
});
