import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { conflictingKnowledgeEvidence, knowledgeConflictTextFullyCompared } from '../services/knowledge/KnowledgeConflictDetection.js';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let version: Record<string, unknown>;
let sources: Record<string, unknown>[];
let target: Record<string, unknown> | undefined;
const execute = jest.fn(async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  queries.push(compiled);
  if (compiled.sql.includes('SELECT v.*')) return { rows: [version] };
  if (compiled.sql.includes('SELECT c.evidence_id')) return { rows: sources };
  if (compiled.sql.includes('SELECT v.document_id')) return { rows: target ? [target] : [] };
  return { rows: [] };
});
jest.unstable_mockModule('../services/knowledge/KnowledgeTenantTransaction.js', () => ({
  withTenantKnowledgeTransaction: async (_userId: number, callback: (tx: unknown) => Promise<unknown>) => callback({ execute }),
}));
const { knowledgeGovernanceService } = await import('../services/knowledge/KnowledgeGovernanceService.js');
const input = { userId: 9, actorUserId: 9, legacyEntryId: 48, versionId: 47, authority: 'owner_authored' };
const source = (id: number, text: string, count: unknown = 1) => ({ evidence_id: `source-${id}`, document_id: id,
  version_id: id, authority: 'owner_authored', display_text: text, version_chunk_count: count });
const writes = () => queries.filter(query => /^\s*(UPDATE|INSERT INTO)\b/.test(query.sql));
const diagnosticsWrite = () => writes().find(query => query.sql.includes('SET diagnostics=COALESCE'));
const auditDetails = () => JSON.parse(writes().find(query => query.sql.includes('INSERT INTO knowledge_governance_audits'))!.params.at(-1) as string);
const longText = `${'General information about our business. '.repeat(201)}Our standard warranty lasts 3 years.`;

describe('candidate-scoped knowledge publication conflicts', () => {
  beforeEach(() => {
    queries.length = 0;
    version = { status: 'ready_for_review', usage_scopes: ['support_answer'], lexical_index_status: 'completed',
      vector_index_status: 'completed', privacy_classification: 'business', owned_document_id: 27,
      normalized_content: 'We build software for businesses.', diagnostics: {} };
    sources = [source(21, 'Our standard warranty lasts 2 years.'), source(32, 'Our standard warranty lasts 9 years.')];
    target = undefined;
  });

  it('keeps all-pairs retrieval detection while anchoring publication to the candidate', () => {
    const evidence = sources.map(row => ({ evidenceId: String(row.evidence_id), documentId: Number(row.document_id),
      authority: String(row.authority), excerpt: String(row.display_text) }));
    evidence.unshift({ evidenceId: 'candidate', documentId: 27, authority: 'owner_authored', excerpt: String(version.normalized_content) });
    expect([...conflictingKnowledgeEvidence(evidence)]).toEqual(['source-21', 'source-32']);
    expect([...conflictingKnowledgeEvidence(evidence, 27)]).toEqual([]);
    evidence[0].excerpt = 'Our standard warranty lasts 3 years.';
    expect([...conflictingKnowledgeEvidence(evidence, 27)].sort()).toEqual(['candidate', 'source-21', 'source-32']);
  });

  it('does not block an unrelated candidate because two existing sources disagree', async () => {
    await expect(knowledgeGovernanceService.publish(input)).resolves.toMatchObject({ status: 'published' });
    expect(auditDetails()).toMatchObject({ supersedesVersionId: null, supersededDocumentId: null, resolvedConflictVersionIds: [] });
    expect(writes()).toHaveLength(4);
  });

  it('revalidates fully compared historical false flags without superseding either source', async () => {
    version.diagnostics = { conflictVersionIds: [21, 32], privacyReasons: [] };
    await expect(knowledgeGovernanceService.publish(input)).resolves.toMatchObject({ status: 'published' });
    expect(auditDetails()).toMatchObject({ clearedUnrelatedConflictVersionIds: [21, 32], resolvedConflictVersionIds: [], supersedesVersionId: null });
    expect(writes()).toHaveLength(4);
    expect(writes().filter(query => query.sql.includes("status = 'retired'"))).toHaveLength(1);
    expect(writes()[0].params).toEqual([27, 9, 47]);
  });

  it('records actual candidate conflicts and leaves publication and other documents untouched', async () => {
    version.normalized_content = 'Our standard warranty lasts 3 years.';
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(1);
    expect(diagnosticsWrite()!.params).toEqual([JSON.stringify({ conflictVersionIds: [21, 32] }), 47, 9]);
  });

  it('does not attribute an unrelated peer disagreement to a candidate with one genuine conflict', async () => {
    sources.push(source(40, 'Our onboarding process takes 5 days.'));
    version.normalized_content = 'Our onboarding process takes 7 days.';
    version.diagnostics = { conflictVersionIds: [21, 32] };
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(diagnosticsWrite()!.params[0]).toBe(JSON.stringify({ conflictVersionIds: [40] }));
  });

  it('does not clear a source with a conflict in a later chunk', async () => {
    version.normalized_content = 'Our standard warranty lasts 3 years.';
    version.diagnostics = { conflictVersionIds: [21] };
    sources = [source(21, 'We build software for businesses.', 2),
      { ...source(21, 'Our standard warranty lasts 2 years.', 2), evidence_id: 'source-21-second' }];
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it('clears an unrelated recorded source only after all its chunks were compared', async () => {
    version.diagnostics = { conflictVersionIds: [21] };
    sources = [source(21, 'Business information.', '2'),
      { ...source(21, 'Additional business information.', '2'), evidence_id: 'source-21-second' }];
    await expect(knowledgeGovernanceService.publish(input)).resolves.toMatchObject({ status: 'published' });
    expect(auditDetails().clearedUnrelatedConflictVersionIds).toEqual([21]);
  });

  it.each([undefined, null, 0, -1, 1.5, 'invalid', 2])('retains recorded flags with incomplete or invalid source chunk coverage %s', async count => {
    version.diagnostics = { conflictVersionIds: [21] };
    sources = [source(21, 'We build software for businesses.', count)];
    // Explicit undefined must model a missing field rather than the fixture default.
    if (count === undefined) delete sources[0].version_chunk_count;
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it('retains a recorded source omitted by the scoped or bounded query', async () => {
    version.diagnostics = { conflictVersionIds: [99] };
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it.each([undefined, null, 42, ''])('retains recorded flags when comparison text is unavailable: %s', async text => {
    version.diagnostics = { conflictVersionIds: [21] };
    sources = [{ ...source(21, 'Business information.'), display_text: text }];
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
    sources = [source(21, 'Business information.')];
    version.normalized_content = text;
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it.each(['candidate', 'source'])('does not clear recorded flags when the %s text exceeds the comparison bound', async side => {
    expect(knowledgeConflictTextFullyCompared(longText)).toBe(false);
    version.diagnostics = { conflictVersionIds: [21] };
    sources = [source(21, side === 'source' ? longText : 'We build software for businesses.')];
    if (side === 'candidate') version.normalized_content = longText;
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it('requires all chunk totals to agree before clearing a recorded flag', async () => {
    version.diagnostics = { conflictVersionIds: [21] };
    sources = [source(21, 'Business information.', 2), { ...source(21, 'More business information.', 3), evidence_id: 'second' }];
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it('allows only explicit supersession of the actual owned current conflict', async () => {
    version.normalized_content = 'Our standard warranty lasts 3 years.';
    sources = [source(21, 'Our standard warranty lasts 2 years.')];
    target = { document_id: 21 };
    await expect(knowledgeGovernanceService.publish({ ...input, supersedesVersionId: 21 })).resolves.toMatchObject({ status: 'published' });
    expect(auditDetails()).toMatchObject({ supersedesVersionId: 21, supersededDocumentId: 21, resolvedConflictVersionIds: [21] });
    expect(writes()[0].params).toEqual([21, 9]);
  });

  it('does not permit superseding a source after its unrelated flag was cleared', async () => {
    version.diagnostics = { conflictVersionIds: [21] };
    target = { document_id: 21 };
    await expect(knowledgeGovernanceService.publish({ ...input, supersedesVersionId: 21 })).rejects.toThrow('INVALID_KNOWLEDGE_SUPERSESSION');
    expect(writes()).toHaveLength(0);
  });

  it.each(['personal', 'restricted', 'secret'])('preserves %s privacy blocking before conflict revalidation', async classification => {
    version.privacy_classification = classification;
    version.diagnostics = { conflictVersionIds: [21, 32] };
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_PRIVACY_REVIEW_REQUIRED');
    expect(queries.some(query => query.sql.includes('SELECT c.evidence_id'))).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it('preserves injection blocking and invalid diagnostics rejection', async () => {
    version.diagnostics = { injectionFlags: ['override'], conflictVersionIds: [21, 32] };
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('KNOWLEDGE_INJECTION_FLAGS_PRESENT');
    version.diagnostics = { conflictVersionIds: ['21'] };
    await expect(knowledgeGovernanceService.publish(input)).rejects.toThrow('INVALID_KNOWLEDGE_CONFLICTS');
    expect(writes()).toHaveLength(0);
  });
});
