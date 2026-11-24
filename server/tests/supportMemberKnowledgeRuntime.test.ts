import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Request, Response } from 'express';

// Exercise the real controller, service, tenant transaction, and SQL compiler.
// Database I/O and all unrelated agent/delivery dependencies are disabled.
const queries: Array<{ sql: string; params: unknown[] }> = [];
let resultRows: unknown[] = [];
const execute = jest.fn(async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  queries.push(compiled);
  return { rows: compiled.sql.includes('set_config') || compiled.sql.includes("AS scheduled_publication") ? [] : resultRows };
});
const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ execute }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { transaction, execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.unstable_mockModule('../services/SupportService.js', () => ({
  supportService: {}, SupportValidationError: class extends Error {},
}));
jest.unstable_mockModule('../services/SupportReplyDeliveryService.js', () => ({
  supportReplyDeliveryService: {}, SupportReplyDeliveryError: class extends Error {},
}));
jest.unstable_mockModule('../services/SupportPresenceService.js', () => ({ supportPresenceService: {} }));
jest.unstable_mockModule('../services/agents/pipeline/HandoffService.js', () => ({ handoffService: {} }));
jest.unstable_mockModule('../services/SupportTicketWorkspaceService.js', () => ({ supportTicketWorkspaceService: {} }));
jest.unstable_mockModule('../utils/emailTemplates', () => ({ getBrandInfo: jest.fn(), renderSupportReplyEmail: jest.fn() }));
jest.unstable_mockModule('../utils/jwt.js', () => ({ generateToken: jest.fn(), verifyToken: jest.fn() }));

const { supportMemberKnowledgeService: service } = await import('../services/knowledge/SupportMemberKnowledgeService.js');
const controller = await import('../controllers/supportMemberController.js');
const list: typeof controller.getSupportKnowledgeBase = (req, res) => withBusinessScope({ userId: 9, businessProfileId: 42 }, () => controller.getSupportKnowledgeBase(req, res));
const detail: typeof controller.getSupportKnowledgeBaseExtractedText = (req, res) => withBusinessScope({ userId: 9, businessProfileId: 42 }, () => controller.getSupportKnowledgeBaseExtractedText(req, res));
const member = { id: 8, userId: 9, teamId: 3 };
const options = { page: 1, limit: 24, type: 'all', search: '' };
function request(overrides: Record<string, unknown> = {}) {
  return { supportMember: member, query: {}, params: { id: '5' }, ...overrides } as unknown as Request;
}
function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}
function publishedList(body = 'Q: How do I reset the device?\nA: Hold the reset button for five seconds.') {
  return { authorized: true, total: 1, entries: [{
    id: 5, source_type: 'qa', created_at: '2026-09-01T00:00:00.000Z', body,
    title: 'Unapproved title', description: 'private draft', answer: 'unapproved answer',
    source_url: 'https://private.invalid', content: 'legacy raw content',
  }] };
}
function publishedDetail(text = 'Approved display text') {
  return { id: 5, source_type: 'file', vector_index_status: 'failed', total_chunks: 1, chunks: [{
    ordinal: 0, display_text: text, char_start: 0, char_end: text.length, token_count: 4, truncated: false,
    search_text: 'unapproved search text', embedding: [0.5], has_embedding: false,
  }], content: 'legacy raw content', normalized_content: 'raw normalized text' };
}

describe('support member published knowledge runtime', () => {
  beforeEach(() => { queries.length = 0; resultRows = []; jest.clearAllMocks(); });

  it.each(['list', 'detail'])('%s sets tenant RLS and compiles every ownership/visibility boundary', async route => {
    resultRows = [route === 'list' ? publishedList() : publishedDetail()];
    if (route === 'list') await service.list(member, options);
    else await service.extractedText(member, 5);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(3);
    expect(queries[1].sql).toContain("v.diagnostics ? 'scheduledPublication'");
    expect(queries[1].params).toEqual([9]);
    expect(queries[0]).toMatchObject({ params: ['9'] });
    expect(queries[0].sql).toContain("set_config('app.current_user_id'");
    const query = queries[2];
    for (const boundary of [
      't.id = m.team_id AND t.user_id = m.user_id',
      'm.id =', 'm.user_id =', 'm.team_id =', 'm.is_active = TRUE AND t.is_active = TRUE',
      'v.id = d.current_published_version_id AND v.document_id = d.id AND v.user_id = d.user_id',
      "v.status IN ('published', 'published_degraded')",
      'v.effective_at IS NULL OR v.effective_at <= NOW()',
      'v.expires_at IS NULL OR v.expires_at > NOW()',
      "v.privacy_classification IN ('public', 'business', 'internal')",
      "d.audience IN ('customer', 'internal')", "d.access_scope IN ('tenant', 'staff_only')",
      'd.business_profile_id IS NULL', "ARRAY['support_answer', 'internal_assist']::text[]",
      "'support_portal' = ANY(d.allowed_channels)",
      'd.document_id = c.document_id AND d.version_id = c.version_id',
      "c.access_scope IN ('tenant', 'staff_only')", "c.sensitivity IN ('public', 'business', 'internal')",
      'cardinality(c.injection_flags) = 0',
    ]) expect(query.sql).toContain(boundary);
    expect(query.params.slice(0, 5)).toEqual([9, 8, 9, 3, 9]);
    expect(query.sql).not.toMatch(/knowledge_base\b|normalized_content|d\.title|d\.description|d\.source_url/);
  });

  it('lists FAQ text from the published display representation without mutable metadata', async () => {
    resultRows = [publishedList()];
    const res = response();
    await list(request(), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: {
      entries: [{ id: 5, title: 'How do I reset the device?', description: null,
        type: 'qa', processingStatus: 'completed', fileName: null, fileType: null, fileSize: null, sourceUrl: null,
        allowedChannels: [],
        question: 'How do I reset the device?', answer: 'Hold the reset button for five seconds.',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
      page: 1, total: 1, totalPages: 1,
      resolvedScope: { ticketId: null, businessProfileId: 42, source: 'workspace' },
    } });
  });

  it('allows only the resolved ticket profile in addition to organization-wide staff content', async () => {
    resultRows = [publishedList()];
    await service.list({ ...member, businessProfileId: 42 }, options);
    const query = queries.find(item => item.sql.includes('visible_documents'))!;
    expect(query.sql).toContain("d.access_scope IN ('tenant', 'staff_only', 'business_profile')");
    expect(query.sql).toContain('d.business_profile_id IS NULL OR d.business_profile_id =');
    expect(query.params).toContain(42);
    expect(query.sql).toContain("c.access_scope IN ('tenant', 'staff_only', 'business_profile')");
  });

  it('searches visible published titles and display chunks with escaped, bound search input and bounded pagination', async () => {
    resultRows = [{ authorized: true, total: 25, entries: [] }];
    await expect(service.list(member, { page: 2, limit: 24, type: 'file', search: "%'_\\" })).resolves.toMatchObject({ total: 25, totalPages: 2 });
    expect(queries[2].sql).toContain('c.display_text ILIKE');
    expect(queries[2].sql).toContain("publicationMetadata'->>'title'");
    expect(queries[2].params).toContain("%\\%'\\_\\\\%");
    expect(queries[2].params).toContain('file');
    expect(queries[2].sql).not.toContain("%'_\\");
    expect(queries[2].params.slice(-5)).toEqual([24, 24, 8, 9, 3]);
  });

  it('serves approved chunks without legacy/raw content, embeddings, or ingestion diagnostics', async () => {
    resultRows = [publishedDetail()];
    const res = response();
    await detail(request(), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, entryId: 5, fileName: null, type: 'file',
      processingStatus: 'completed', extractedText: 'Approved display text',
      chunks: [{ index: 0, text: 'Approved display text', charStart: 0, charEnd: 21, tokenEstimate: 4, hasEmbedding: false }],
      totalChunks: 1, truncated: false, embeddingsGenerated: false, embeddingModel: null,
      extractionSource: 'published_version', extractionWarnings: [],
    });
  });

  it('bounds the combined displayed content and reports truncation', async () => {
    const row = publishedDetail('a'.repeat(200_000));
    row.total_chunks = 201;
    row.chunks.push({ ...row.chunks[0], ordinal: 1, display_text: 'b'.repeat(100_000) });
    resultRows = [row];
    const result = await service.extractedText(member, 5);
    expect(result?.truncated).toBe(true);
    expect(result?.extractedText).toHaveLength(250_000);
    expect(result?.chunks.map(chunk => chunk.text.length)).toEqual([200_000, 50_000]);
    expect(queries[2].params).toContain(200);
  });

  it('reports published embedding availability without returning vector values', async () => {
    const row = publishedDetail();
    row.vector_index_status = 'completed';
    row.chunks[0].has_embedding = true;
    resultRows = [row];
    const result = await service.extractedText(member, 5);
    expect(result?.embeddingsGenerated).toBe(true);
    expect(result?.chunks[0].hasEmbedding).toBe(true);
    expect(result?.chunks[0]).not.toHaveProperty('embedding');
    expect(queries[2].sql).toContain('e.chunk_id = c.id AND e.user_id =');
  });

  it.each(['5oops', '1.5', '-1', '0', '01', ' 5', '5e0', '9007199254740992'])('returns 404 for malformed ID %s before database use', async id => {
    const res = response();
    await detail(request({ params: { id } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Entry not found' });
    expect(queries).toHaveLength(0);
  });

  it.each([
    { ...member, userId: 0 }, { ...member, teamId: 0 }, { ...member, id: '8' }, undefined,
  ])('denies invalid member identity before database use: %s', async identity => {
    const res = response();
    await detail(request({ supportMember: identity }), res);
    expect(res.status).toHaveBeenCalledWith(identity ? 404 : 401);
    expect(queries).toHaveLength(0);
  });

  it('returns 404 when tenant/team membership is denied', async () => {
    resultRows = [{ authorized: false, total: 0, entries: [] }];
    const res = response();
    await list(request(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Team not found' });
  });

  it('returns 404 for an absent or invisible published version', async () => {
    const res = response();
    await detail(request(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Entry not found' });
  });

  it.each([{ page: '0' }, { limit: '101' }, { type: 'managed' }, { search: 'a'.repeat(201) }])('rejects invalid listing queries before database use: %s', async query => {
    const res = response();
    await list(request({ query }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(queries).toHaveLength(0);
  });
});
