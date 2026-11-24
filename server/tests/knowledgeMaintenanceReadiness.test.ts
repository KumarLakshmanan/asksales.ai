import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockDbExecute = jest.fn<(query: unknown) => Promise<{ rows: unknown[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: mockDbExecute } }));
jest.unstable_mockModule('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: {} }));
jest.unstable_mockModule('../services/knowledge/KnowledgeTenantTransaction.js', () => ({
  withKnowledgeAdminTransaction: jest.fn(async (callback: any) => callback({execute:mockDbExecute})),
  withTenantKnowledgeTransaction: jest.fn(),
}));

const { knowledgeMaintenanceService } = await import('../services/knowledge/KnowledgeMaintenanceService.js');

describe('knowledge maintenance index readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbExecute.mockResolvedValue({ rows: [] });
  });

  it('reports an admin action instead of failing the daily job when no index is active', async () => {
    await expect(knowledgeMaintenanceService.run()).resolves.toMatchObject({
      indexVersion: null,
      maintenanceSkipped: true,
      skipReason: 'active_index_missing',
      failures: [],
      expiredAuditsDeleted:0,
      actionRequired: [expect.objectContaining({ required_action: 'configure_active_knowledge_index' })],
    });
    expect(mockDbExecute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockDbExecute.mock.calls[1])).toContain('DELETE FROM knowledge_retrieval_audits');
  });
});
