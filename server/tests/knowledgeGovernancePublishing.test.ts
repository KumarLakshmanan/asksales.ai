import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let version: Record<string, unknown> | undefined;
let target: Record<string, unknown> | undefined;
const execute = jest.fn(async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  queries.push(compiled);
  if (compiled.sql.includes('SELECT v.*')) return { rows: version ? [version] : [] };
  if (compiled.sql.includes('SELECT v.document_id')) return { rows: target ? [target] : [] };
  return { rows: [] };
});
jest.unstable_mockModule('../services/knowledge/KnowledgeTenantTransaction.js', () => ({
  withTenantKnowledgeTransaction: async (_userId: number, callback: (tx: unknown) => Promise<unknown>) => callback({ execute }),
}));
const { knowledgeGovernanceService } = await import('../services/knowledge/KnowledgeGovernanceService.js');
const input = { userId: 9, actorUserId: 9, legacyEntryId: 5, versionId: 20, authority: 'owner_authored' };
const writes = () => queries.filter(q => /^\s*(UPDATE|INSERT INTO)\b/.test(q.sql));

describe('governed knowledge publication', () => {
  beforeEach(() => {
    queries.length = 0;
    version = { status: 'ready_for_review', usage_scopes: ['support_answer'], lexical_index_status: 'completed',
      vector_index_status: 'completed', privacy_classification: 'public', owned_document_id: 2, diagnostics: {} };
    target = { document_id: 2 };
  });

  it('publishes indexed, reviewed knowledge under a tenant governance lock', async () => {
    await expect(knowledgeGovernanceService.publish(input)).resolves.toMatchObject({ versionId: 20, status: 'published' });
    expect(queries[0].sql).toContain('pg_advisory_xact_lock');
    expect(queries[0].params).toEqual([9]);
    expect(queries[1].params).toEqual([20, 9, 5]);
    expect(writes()).toHaveLength(4);
  });

  it.each([0, -2, 20, 2.5, '19', false])('rejects invalid supersession %s before database use', async id => {
    await expect(knowledgeGovernanceService.publish({ ...input, supersedesVersionId: id as number })).rejects.toThrow('INVALID_KNOWLEDGE_SUPERSESSION');
    expect(queries).toHaveLength(0);
  });

  it.each([undefined, 18])('does not let a missing or unrelated version bypass a conflict', async id => {
    version!.diagnostics = { conflictVersionIds: [19] };
    await expect(knowledgeGovernanceService.publish({ ...input, supersedesVersionId: id })).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it('does not silently resolve multiple conflicts with one replacement', async () => {
    version!.diagnostics = { conflictVersionIds: [18, 19] };
    await expect(knowledgeGovernanceService.publish({ ...input, supersedesVersionId: 19 })).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it('rejects foreign, missing, or no-longer-published targets', async () => {
    target = undefined;
    await expect(knowledgeGovernanceService.publish({ ...input, supersedesVersionId: 19 })).rejects.toThrow('INVALID_KNOWLEDGE_SUPERSESSION');
    const lookup = queries.find(q => q.sql.includes('SELECT v.document_id'))!;
    expect(lookup.sql).toContain('v.user_id =');
    expect(lookup.sql).toContain('d.current_published_version_id = v.id');
    expect(lookup.sql).toContain("v.status IN ('published', 'published_degraded')");
    expect(lookup.params).toEqual([19, 9]);
    expect(writes()).toHaveLength(0);
  });

  it('does not retire an unrelated document without a recorded conflict', async () => {
    target = { document_id: 3 };
    await expect(knowledgeGovernanceService.publish({ ...input, supersedesVersionId: 19 })).rejects.toThrow('INVALID_KNOWLEDGE_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it('retires the exact conflicting version, clears its pointer and resolves retrieval diagnostics', async () => {
    target = { document_id: 3 };
    version!.diagnostics = { conflictVersionIds: [19], extractionNote: 'preserved' };
    await knowledgeGovernanceService.publish({ ...input, supersedesVersionId: 19 });
    expect(writes()[0].params).toEqual([19, 9]);
    expect(writes()[1].params).toEqual([3, 9, 19]);
    const publish = writes().find(q => q.sql.includes('supersedes_version_id ='))!;
    expect(publish.sql).toContain("COALESCE(diagnostics, '{}'::jsonb)");
    expect(publish.sql).toContain("-'scheduledPublication'-'scheduleReviewRequired'");
    expect(publish.params).toContain(JSON.stringify({ conflictVersionIds: [] }));
    const audit = writes().find(q => q.sql.includes('INSERT INTO knowledge_governance_audits'))!;
    expect(JSON.parse(audit.params.at(-1) as string)).toMatchObject({ supersedesVersionId: 19, supersededDocumentId: 3, resolvedConflictVersionIds: [19] });
  });

  it.each(['secret', 'restricted', 'personal'])('blocks %s data before any publication writes', async classification => {
    version!.privacy_classification = classification;
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_PRIVACY_REVIEW_REQUIRED');
    expect(writes()).toHaveLength(0);
  });

  it('preserves prompt-injection blocking even with supersession', async () => {
    version!.diagnostics = { injectionFlags: ['instruction_override'], conflictVersionIds: [19] };
    await expect(knowledgeGovernanceService.publish({ ...input, supersedesVersionId: 19 })).rejects.toThrow('KNOWLEDGE_INJECTION_FLAGS_PRESENT');
    expect(writes()).toHaveLength(0);
  });

  it('requires explicit degraded publication when vectors are unavailable', async () => {
    version!.vector_index_status = 'failed';
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('VECTOR_INDEX_NOT_READY');
    expect(writes()).toHaveLength(0);
    await expect(knowledgeGovernanceService.publish({ ...input, allowLexicalOnly: true })).resolves.toMatchObject({ status: 'published_degraded' });
  });
});
