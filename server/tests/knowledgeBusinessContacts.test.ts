import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';

const phone = '+91 98765 43210';
const email = 'reservations@example.test';
const address = '21 Estate Road, Chennai 600001';
const customerPhone = '+91 91234 56789';
const customerEmail = 'guest@example.test';
const contacts = [phone, email, address];
const excerpt = `Reservations: ${phone}\nEmail: ${email}\nAddress: ${address}`;
let withdrawn = false;
const queries: Array<{ sql: string; params: unknown[] }> = [];
const execute = jest.fn(async (input: SQL) => {
  const query = new PgDialect().sqlToQuery(input);
  queries.push(query);
  if (query.sql.includes('FROM company_settings')) return { rows: [{ phone, email, address }] };
  if (query.sql.includes('SELECT iv.id')) return { rows: [{ id: 1, version_key: 'test', provider: 'openai', model: 'test', dimensions: 3 }] };
  if (query.sql.includes('SELECT id FROM knowledge_base')) return { rows: [{ id: 5 }] };
  if (query.sql.includes('SELECT * FROM knowledge_documents')) return { rows: [{ id: 2 }] };
  if (query.sql.includes('INSERT INTO knowledge_document_versions')) return { rows: [{ id: 20 }] };
  if (query.sql.includes('INSERT INTO knowledge_chunks')) return { rows: [{ id: 30 }] };
  if (query.sql.includes('FROM knowledge_chunks c')) return { rows: withdrawn ? [] : [{
    chunk_id: 30, evidence_id: 'KB-2-V1-C0', document_id: 2, version_id: 20, ordinal: 0, display_text: excerpt,
    title: 'Reservations', authority: 'owner_authored', token_count: 20, verified_business_contacts: contacts,
  }] };
  return { rows: [] };
});
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, transaction: (fn: (tx: unknown) => unknown) => fn({ execute }) } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.unstable_mockModule('../services/agents/pipeline/PolicyEngine.js', () => ({ policyEngine: { evaluatePostGeneration: () => ({ passed: true, violations: [], enforcements: [] }) } }));
jest.unstable_mockModule('../services/agents/orchestration/ContentModerationService.js', () => ({ contentModerationService: { moderate: async () => ({ status: 'available', flagged: false, categories: [] }) } }));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: { generateEmbeddingsBatch: async () => ({ provider: 'openai', model: 'test', dimensions: 3, vectors: [[0, 0, 1]] }) } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeReranker.js', () => ({ rerankKnowledgeCandidates: async () => ({ candidates: [], reranked: false }) }));
const { loadVerifiedBusinessContacts, redactWithVerifiedBusinessContacts } = await import('../services/knowledge/KnowledgeBusinessContacts.js');
const { scanKnowledgeContent } = await import('../services/knowledge/KnowledgePrivacyService.js');
const { chunkStructuredKnowledge } = await import('../services/knowledge/KnowledgeChunker.js');
const { knowledgeGateway } = await import('../services/knowledge/KnowledgeGateway.js');
const { knowledgeIngestionService } = await import('../services/knowledge/KnowledgeIngestionService.js');
const { GuardrailComplianceStage } = await import('../services/agents/pipeline/stages/GuardrailComplianceStage.js');

function context(): PipelineContext {
  return { message: { userId: 9, conversationId: 100, channel: 'instagram', senderIdentifier: 'test', inboundText: 'How can I contact reservations?' },
    confidence: 1, policyViolations: [], agentResult: { replyText: `${excerpt}\nGuest email: ${customerEmail}\nGuest phone: ${customerPhone}`, escalated: false },
    metadata: { agentConfig: { escalationRules: [] }, knowledgeQuery: { tenantId: 9, audience: 'customer', channel: 'instagram', purpose: 'support_answer', risk: 'low', redactedText: 'reservations' } },
    contextLanes: { knowledge: { status: 'sufficient', indexVersion: 'test', diagnostics: { queryFingerprint: 'test', candidateCount: 1, reranked: false, latencyMs: 1 }, evidence: [
      { evidenceId: 'KB-2-V1-C0', documentId: 2, versionId: 20, chunkId: '30', title: 'Reservations', excerpt, authority: 'owner_authored', scores: { fused: 1 }, verifiedBusinessContacts: contacts },
    ] } } } as PipelineContext;
}

describe('verified business contacts across knowledge and outbound boundaries', () => {
  beforeEach(() => { withdrawn = false; queries.length = 0; });
  it('loads only owned catalog values with an explicit profile or unambiguous global catalog', async () => {
    expect(await loadVerifiedBusinessContacts(9, 42)).toEqual(contacts);
    expect(queries[0].params).toEqual([9, 42]);
    expect(queries).toHaveLength(1);
    queries.length = 0;
    await loadVerifiedBusinessContacts(9, null);
    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toContain('id=app_business_profile_id()');
    expect(queries[0].params).toEqual([9]);
    expect(queries[1].sql).toContain('FROM hotel_properties');
    expect(queries[1].sql).toContain('count(*)');
    expect(queries[1].sql).toContain('=1');
    expect(queries[1].params).toEqual([9, 9]);
  });
  it('preserves verified phone/email/labeled address through scan, chunks, and model evidence while masking customer data', () => {
    expect(scanKnowledgeContent(excerpt).classification).toBe('personal');
    const scan = scanKnowledgeContent(excerpt, { trustedBusinessContacts: contacts });
    expect(scan.classification).toBe('business');
    expect(scan.searchText).toBe(excerpt);
    expect(chunkStructuredKnowledge(excerpt, { trustedBusinessContacts: contacts })[0].displayText).toBe(excerpt);
    const mixed = scanKnowledgeContent(`${excerpt}\nCustomer email: ${customerEmail}\nHome address: 99 Customer Street`, { trustedBusinessContacts: contacts });
    expect(mixed.classification).toBe('personal');
    expect(mixed.searchText).toContain(email);
    expect(mixed.searchText).not.toContain(customerEmail);
    expect(mixed.searchText).not.toContain('99 Customer Street');
    expect(knowledgeGateway.formatEvidence(context().contextLanes!.knowledge!)).toContain(excerpt);
  });
  it('snapshots only catalog-verified values into a reviewable canonical version', async () => {
    const entry = { id: 5, userId: 9, businessProfileId: 42, title: 'Reservations', type: 'document', content: excerpt } as Parameters<typeof knowledgeIngestionService.indexLegacyEntry>[0];
    expect(await knowledgeIngestionService.indexLegacyEntry(entry)).toMatchObject({ status: 'ready_for_review', vectorIndexed: true });
    const inserted = queries.find(query => query.sql.includes('INSERT INTO knowledge_document_versions'))!;
    expect(inserted.params).toContain('business');
    expect(JSON.parse(inserted.params.at(-1) as string).verifiedBusinessContacts).toEqual(contacts);
    const chunk = queries.find(query => query.sql.includes('INSERT INTO knowledge_chunks'))!;
    expect(chunk.params).toContain(excerpt);
  });
  it('preserves authorized published contacts in outbound replies but still masks customer email and phone', async () => {
    const ctx = await new GuardrailComplianceStage().execute(context());
    expect(ctx.agentResult!.replyText).toContain(excerpt);
    expect(ctx.agentResult!.replyText).not.toContain(customerPhone);
    expect(ctx.agentResult!.replyText).not.toContain(customerEmail);
    expect(queries.some(query => query.sql.includes('d.current_published_version_id = v.id'))).toBe(true);
  });
  it('does not allow withdrawn evidence or arbitrary uploads to exempt contact details', async () => {
    withdrawn = true;
    const ctx = await new GuardrailComplianceStage().execute(context());
    expect(ctx.agentResult!.replyText).not.toContain(phone);
    expect(ctx.agentResult!.replyText).not.toContain(email);
    const uploaded = context();
    uploaded.contextLanes!.knowledge = { ...uploaded.contextLanes!.knowledge!, status: 'insufficient', evidence: [] };
    uploaded.contextLanes!.referenceEvidence = [{ source: 'user_upload:fake', excerpt }];
    uploaded.metadata!.businessPiiAllowlist = contacts;
    expect((await new GuardrailComplianceStage().execute(uploaded)).agentResult!.replyText).not.toContain(email);
  });
  it('cannot expose credentials by listing their value as a public contact', () => {
    expect(scanKnowledgeContent(`Password: ${email}`, { trustedBusinessContacts: contacts }).mustQuarantine).toBe(true);
    expect(redactWithVerifiedBusinessContacts(`Address: ${address}\nGuest: ${customerEmail}`, contacts)).toContain(`Address: ${address}`);
    expect(redactWithVerifiedBusinessContacts(`Address: ${address}\nGuest: ${customerEmail}`, contacts)).not.toContain(customerEmail);
    expect(redactWithVerifiedBusinessContacts('Card: 4242 4242 4242 4242', ['4242 4242'])).not.toContain('4242');
    expect(redactWithVerifiedBusinessContacts(`Guest: private+${email}`, contacts)).not.toContain(`private+${email}`);
  });
});
