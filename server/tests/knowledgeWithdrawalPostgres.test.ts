import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { KnowledgeQuery } from '../services/knowledge/types.js';

const localPostgres = process.env.SUPPORT_KNOWLEDGE_LOCAL_QA === '1' ? describe : describe.skip;
jest.setTimeout(30000);
let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  transaction: (callback: Parameters<typeof fixtureDb.transaction>[0]) => fixtureDb.transaction(callback),
  execute: (query: Parameters<typeof fixtureDb.execute>[0]) => fixtureDb.execute(query),
} }));
const legacySearch = jest.fn(async () => [{ sourceId: 5, content: 'HARBOUR-QA-B846-V1 WITHDRAWN VECTOR', similarity: 1 }]);
const disabledEmbedding = jest.fn(async () => { throw new Error('External embedding provider disabled in local QA'); });
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({
  embeddingService: { searchSimilar: legacySearch, generateEmbedding: disabledEmbedding },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
let duringRerank: (() => Promise<void>) | undefined;
jest.unstable_mockModule('../services/knowledge/KnowledgeReranker.js', () => ({
  rerankKnowledgeCandidates: async (_query: unknown, candidates: unknown[]) => {
    await duringRerank?.();
    return { candidates, reranked: Boolean(duringRerank) };
  },
}));
const { knowledgeGateway } = await import('../services/knowledge/KnowledgeGateway.js');
const { knowledgeBaseService } = await import('../services/KnowledgeBaseService.js');
const { knowledgeGovernanceService } = await import('../services/knowledge/KnowledgeGovernanceService.js');
const tables = await import('../models/knowledge/schema.js');

localPostgres('withdrawn knowledge retrieval (isolated local PostgreSQL schema)', () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  const originalFlag = process.env.KNOWLEDGE_V2_ENABLED;
  const query: KnowledgeQuery = { tenantId: 9, redactedText: 'HARBOUR-QA-B846-V1',
    purpose: 'support_answer', channel: 'internal', audience: 'internal', risk: 'low' };
  const publication = { userId: 9, actorUserId: 9, legacyEntryId: 5, versionId: 20,
    authority: 'owner_authored', allowLexicalOnly: true };

  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true });
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Knowledge QA requires local PostgreSQL');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `knowledge_withdrawal_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    // Real application column names and types, omitting external FKs/defaults.
    // No query can fall through to a public application table.
    for (const table of [tables.knowledgeDocumentsTable, tables.knowledgeDocumentVersionsTable,
      tables.knowledgeChunksTable, tables.knowledgeIndexVersionsTable, tables.knowledgeRuntimeSettingsTable,
      tables.knowledgeRetrievalAuditsTable, tables.knowledgeGovernanceAuditsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`);
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query("ALTER TABLE knowledge_chunks ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple',search_text)) STORED");
    await pool.query(`CREATE TABLE knowledge_base(id int, user_id int, business_profile_id int, title text,
      content text, question text, answer text, processing_status text, updated_at timestamp);
      CREATE TABLE embeddings(user_id int,source_id int,source_type text DEFAULT 'knowledge_base',content text);
      CREATE TABLE knowledge_chunk_embeddings(user_id int,chunk_id int,index_version_id int,provider text,model text,
        dimensions int,content_hash text,embedding text,metadata jsonb);
      CREATE TABLE company_settings(id int,user_id int)`);
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.KNOWLEDGE_V2_ENABLED;
    else process.env.KNOWLEDGE_V2_ENABLED = originalFlag;
    await pool?.end();
    if (admin && /^knowledge_withdrawal_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    delete process.env.KNOWLEDGE_V2_ENABLED;
    duringRerank = undefined;
    jest.clearAllMocks();
    await pool.query('TRUNCATE knowledge_documents,knowledge_document_versions,knowledge_chunks,knowledge_index_versions,knowledge_runtime_settings,knowledge_retrieval_audits,knowledge_governance_audits,knowledge_base,embeddings,knowledge_chunk_embeddings,company_settings RESTART IDENTITY');
    await pool.query('INSERT INTO knowledge_runtime_settings(id,knowledge_v2_enabled,maintenance_mode) VALUES(1,false,false)');
    await pool.query(`INSERT INTO knowledge_documents(id,user_id,legacy_entry_id,source_type,title,source_url,
        audience,access_scope,usage_scopes,allowed_channels)
      VALUES(2,9,5,'qa','Unapproved confidential title','https://unapproved.invalid',
        'customer','tenant',ARRAY['support_answer'],ARRAY[]::text[])`);
    await pool.query(`INSERT INTO knowledge_document_versions(id,document_id,user_id,version_no,status,
        normalized_content,privacy_classification,created_at,authority,vector_index_status,lexical_index_status,diagnostics)
      VALUES(20,2,9,1,'ready_for_review','RAW SECRET OLD SOURCE','business',NOW(),'owner_authored','failed','completed','{}'),
        (21,2,9,2,'ready_for_review','UNAPPROVED VERSION','business',NOW(),'owner_authored','failed','completed','{}')`);
    await pool.query(`INSERT INTO knowledge_chunks(id,user_id,document_id,version_id,ordinal,evidence_id,display_text,search_text,
        token_count,access_scope,sensitivity,injection_flags,exact_identifiers)
      VALUES(30,9,2,20,0,'KB-2-V1-C0','HARBOUR-QA-B846-V1: Press the blue reset button.',
        'HARBOUR-QA-B846-V1 blue reset button',12,'tenant','business',ARRAY[]::text[],ARRAY['HARBOUR-QA-B846-V1']),
        (31,9,2,21,0,'KB-2-V2-C0','UNAPPROVED HARBOUR-QA-B846-V1 CHANGE',
        'HARBOUR-QA-B846-V1 UNAPPROVED',12,'tenant','business',ARRAY[]::text[],ARRAY['HARBOUR-QA-B846-V1'])`);
    await pool.query(`INSERT INTO knowledge_base(id,user_id,title,content,processing_status,updated_at)
      VALUES(5,9,'Legacy raw title','HARBOUR-QA-B846-V1 raw old content','completed',NOW()),
      (23,9,'Unreviewed legacy','UNREVIEWEDLEGACYX992ONLY','completed',NOW());
      INSERT INTO embeddings(user_id,source_id,content) VALUES(9,5,'HARBOUR-QA-B846-V1 old vector')`);
    await knowledgeGovernanceService.publish(publication);
  });

  it('supports published lexical answers while the V2 flag is off, then respects actual quarantine without stale authorization', async () => {
    const before = await knowledgeGateway.retrieve(query);
    expect(before.status).toBe('sufficient');
    expect(before.evidence).toHaveLength(1);
    expect(before.evidence[0]).toMatchObject({ evidenceId: 'KB-2-V1-C0', documentId: 2, versionId: 20,
      excerpt: 'HARBOUR-QA-B846-V1: Press the blue reset button.' });
    expect(await knowledgeGateway.revalidateEvidence(query, before.evidence)).toEqual(before.evidence);
    expect(JSON.stringify(before.evidence)).not.toMatch(/Unapproved|UNAPPROVED|RAW SECRET|unapproved.invalid/);
    expect((await knowledgeBaseService.getLegacyGroundedContext(9, query.redactedText)).status).toBe('grounded');
    await knowledgeGovernanceService.quarantine({ ...publication, reason: 'QA withdrawal' });
    expect(await knowledgeGateway.revalidateEvidence(query, before.evidence)).toEqual([]);
    const after = await knowledgeGateway.retrieve(query);
    expect(after.status).not.toBe('sufficient');
    expect(after.evidence).toEqual([]);
    expect((await knowledgeBaseService.getLegacyGroundedContext(9, query.redactedText)).sources).toEqual([]);
    expect((await pool.query('SELECT count(*)::int n FROM embeddings')).rows[0].n).toBe(1);
    expect(legacySearch).not.toHaveBeenCalled();
    expect(disabledEmbedding).not.toHaveBeenCalled();
  });

  it('deletes legacy and governed embeddings atomically and immediately removes the approved answer', async () => {
    await pool.query('INSERT INTO knowledge_chunk_embeddings(user_id,chunk_id) VALUES(9,30),(99,30)');
    expect((await knowledgeGateway.retrieve(query)).status).toBe('sufficient');
    expect(await knowledgeGovernanceService.deleteEntry(99, 5)).toBe(false);
    expect((await knowledgeGateway.retrieve(query)).status).toBe('sufficient');
    expect(await knowledgeGovernanceService.deleteEntry(9, 5)).toBe(true);
    expect((await knowledgeGateway.retrieve(query)).evidence).toEqual([]);
    expect((await pool.query('SELECT current_published_version_id FROM knowledge_documents WHERE id=2')).rows[0].current_published_version_id).toBeNull();
    expect((await pool.query("SELECT status FROM knowledge_document_versions WHERE document_id=2")).rows.every(row => row.status === 'retired')).toBe(true);
    expect((await pool.query('SELECT count(*)::int n FROM embeddings WHERE user_id=9')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT user_id FROM knowledge_chunk_embeddings')).rows).toEqual([{ user_id: 99 }]);
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_base WHERE id=5')).rows[0].n).toBe(0);
  });

  it('keeps draft scope and citations separate until publication, then applies them to retrieval', async () => {
    const metadata = { title: 'Reviewed staff guide', sourceUrl: 'https://example.test/guide', businessProfileId: null,
      audience: 'internal' as const, accessScope: 'staff_only' as const, usageScopes: ['internal_assist'],
      allowedChannels: ['support_portal'], locale: 'en-IN' };
    await knowledgeGovernanceService.updateDraftScope({ userId: 9, legacyEntryId: 5, versionId: 21, metadata });
    const customer = { ...query, audience: 'customer' as const, channel: 'web' };
    expect((await knowledgeGateway.retrieve(customer)).status).toBe('sufficient');
    expect(JSON.stringify(await knowledgeGateway.retrieve(customer))).not.toContain('Reviewed staff guide');
    await knowledgeGovernanceService.publish({ ...publication, versionId: 21 });
    expect((await knowledgeGateway.retrieve(customer)).evidence).toEqual([]);
    const staff = await knowledgeGateway.retrieve({ ...query, channel: 'support_portal', purpose: 'internal_assist', entities: { locale: 'en-IN' } });
    expect(staff.status).toBe('sufficient');
    expect(staff.evidence[0]).toMatchObject({ title: 'Reviewed staff guide', sourceUrl: 'https://example.test/guide' });
    expect((await knowledgeGateway.retrieve({ ...query, channel: 'support_portal', purpose: 'internal_assist', entities: { locale: 'fr' } })).evidence).toEqual([]);
    await expect(knowledgeGovernanceService.updateDraftScope({ userId: 9, legacyEntryId: 5, versionId: 21, metadata })).rejects.toThrow('KNOWLEDGE_DRAFT_NOT_EDITABLE');
  });

  it('does not call unrelated stale or restricted documents a matching knowledge gap', async () => {
    await pool.query("UPDATE knowledge_document_versions SET expires_at=NOW()-INTERVAL '1 hour' WHERE id=20");
    expect((await knowledgeGateway.retrieve({ ...query, redactedText: 'unrelatedpoolopeninghours' })).status).toBe('insufficient');
    expect((await knowledgeGateway.retrieve(query)).status).toBe('stale_only');
    await pool.query("UPDATE knowledge_document_versions SET expires_at=NULL WHERE id=20; UPDATE knowledge_documents SET audience='internal' WHERE id=2");
    expect((await knowledgeGateway.retrieve({ ...query, audience: 'customer', redactedText: 'unrelatedpoolopeninghours' })).status).toBe('insufficient');
    expect((await knowledgeGateway.retrieve({ ...query, audience: 'customer' })).status).toBe('access_denied');
  });

  it('withdraws immediately while preserving history for review', async () => {
    await knowledgeGovernanceService.withdraw({ userId: 9, actorUserId: 9, legacyEntryId: 5, reason: 'Policy under review' });
    expect((await knowledgeGateway.retrieve(query)).evidence).toEqual([]);
    expect((await knowledgeGovernanceService.listVersions(9, 5))).toHaveLength(2);
    expect((await pool.query("SELECT action FROM knowledge_governance_audits WHERE action='withdraw'")).rows).toHaveLength(1);
  });

  it('creates an explicit reviewed draft after withdrawal without reviving the retired source', async () => {
    await expect(knowledgeGovernanceService.createDraft({ userId: 9, legacyEntryId: 5, versionId: 20 })).rejects.toThrow('REVIEW_EXISTING_DRAFT_FIRST');
    await pool.query("UPDATE knowledge_document_versions SET status='retired' WHERE id=21");
    await knowledgeGovernanceService.withdraw({ userId: 9, actorUserId: 9, legacyEntryId: 5, reason: 'Review scope' });
    const draft = await knowledgeGovernanceService.createDraft({ userId: 9, legacyEntryId: 5, versionId: 20 });
    expect(draft.status).toBe('ready_for_review');
    expect(draft.versionNo).toBe(3);
    expect((await knowledgeGateway.retrieve(query)).evidence).toEqual([]);
    const chunks = await pool.query('SELECT evidence_id,display_text FROM knowledge_chunks WHERE version_id=$1', [draft.versionId]);
    expect(chunks.rows).toEqual([{ evidence_id: 'KB-2-V3-C0', display_text: 'HARBOUR-QA-B846-V1: Press the blue reset button.' }]);
    await knowledgeGovernanceService.publish({ ...publication, versionId: draft.versionId });
    expect((await knowledgeGateway.retrieve(query)).evidence[0].evidenceId).toBe('KB-2-V3-C0');
    expect((await pool.query('SELECT status FROM knowledge_document_versions WHERE id=20')).rows[0].status).toBe('retired');
  });

  it.each(['web', 'support_portal'])('retrieves an exact published Q&A on %s without embeddings and never returns its draft', async channel => {
    await pool.query("UPDATE knowledge_chunks SET display_text=E'Q: How are you?\\nA: We are ready to help.', search_text='How are you We are ready to help' WHERE id=30");
    await pool.query("UPDATE knowledge_chunks SET display_text=E'Q: How are you?\\nA: UNAPPROVED ANSWER', search_text='How are you UNAPPROVED ANSWER' WHERE id=31");
    const result = await knowledgeGateway.retrieve({ ...query, channel,
      purpose: channel === 'support_portal' ? 'internal_assist' : 'support_answer', redactedText: ' HOW ARE YOU? ' });
    expect(result.status).toBe('sufficient');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].excerpt).toContain('We are ready to help.');
    expect(JSON.stringify(result)).not.toContain('UNAPPROVED ANSWER');
    expect(disabledEmbedding).not.toHaveBeenCalled();
    await knowledgeGovernanceService.quarantine({ ...publication, reason: 'UG-02 withdrawal check' });
    expect((await knowledgeGateway.retrieve({ ...query, channel, redactedText: 'How are you?' })).evidence).toEqual([]);
  });

  it('keeps the approved exact question ahead of more than 40 broad keyword matches', async () => {
    await pool.query("UPDATE knowledge_chunks SET display_text=E'Q: When do you open?\\nA: We open at 9 AM.', search_text='When do you open We open at 9 AM' WHERE id=30");
    await pool.query(`INSERT INTO knowledge_documents(id,user_id,source_type,audience,access_scope,usage_scopes,allowed_channels,current_published_version_id)
      SELECT n,9,'document','customer','tenant',ARRAY['support_answer'],ARRAY[]::text[],n FROM generate_series(100,150) n;
      INSERT INTO knowledge_document_versions(id,document_id,user_id,status,privacy_classification,authority,diagnostics)
      SELECT n,n,9,'published_degraded','business','owner_authored','{}' FROM generate_series(100,150) n;
      INSERT INTO knowledge_chunks(id,user_id,document_id,version_id,ordinal,evidence_id,display_text,search_text,token_count,access_scope,sensitivity,injection_flags,exact_identifiers)
      SELECT n,9,n,n,0,'KB-distractor-'||n,'Open settings when you open the application.','open when you open',10,'tenant','business',ARRAY[]::text[],ARRAY[]::text[] FROM generate_series(100,150) n`);
    const result = await knowledgeGateway.retrieve({ ...query, redactedText: 'When do you open?' });
    expect(result.evidence[0]).toMatchObject({ evidenceId: 'KB-2-V1-C0', excerpt: 'Q: When do you open?\nA: We open at 9 AM.' });
  });

  it('excludes genuinely ungoverned legacy entries even when they have exact matches', async () => {
    const result = await knowledgeGateway.retrieve({ ...query, redactedText: 'UNREVIEWEDLEGACYX992ONLY' });
    expect(result.evidence).toEqual([]);
    expect(result.status).not.toBe('sufficient');
    expect(legacySearch).not.toHaveBeenCalled();
  });

  it('honors maintenance before an explicit environment rollback flag', async () => {
    process.env.KNOWLEDGE_V2_ENABLED = 'false';
    await pool.query('UPDATE knowledge_runtime_settings SET maintenance_mode=true');
    expect(await knowledgeGateway.retrieve(query)).toMatchObject({ status: 'unavailable', evidence: [],
      diagnostics: { reason: 'maintenance_mode' } });
  });

  it('rechecks current authorization after an in-flight reranker withdraws a previously valid hit', async () => {
    await pool.query('UPDATE knowledge_runtime_settings SET knowledge_v2_enabled=true');
    duringRerank = async () => { await knowledgeGovernanceService.quarantine({ ...publication, reason: 'Concurrent withdrawal' }); };
    expect(await knowledgeGateway.retrieve(query)).toMatchObject({ status: 'insufficient', evidence: [] });
  });

  it('filters neighboring chunks with the same privacy boundary as the primary hit', async () => {
    await pool.query('UPDATE knowledge_chunks SET next_chunk_id=32 WHERE id=30');
    await pool.query(`INSERT INTO knowledge_chunks(id,user_id,document_id,version_id,ordinal,evidence_id,display_text,
      search_text,token_count,access_scope,sensitivity,injection_flags,exact_identifiers)
      VALUES(32,9,2,20,1,'KB-2-V1-C1','PRIVATE NEIGHBOR','PRIVATE NEIGHBOR',4,'tenant','personal',ARRAY[]::text[],ARRAY[]::text[])`);
    const result = await knowledgeGateway.retrieve(query);
    expect(result.status).toBe('sufficient');
    expect(result.evidence.map(e => e.evidenceId)).toEqual(['KB-2-V1-C0']);
  });

  it('admits exactly the authorized business profile and audience', async () => {
    await pool.query("UPDATE knowledge_documents SET business_profile_id=42,access_scope='business_profile'");
    await pool.query("UPDATE knowledge_chunks SET access_scope='business_profile'");
    expect((await knowledgeGateway.retrieve(query)).evidence).toEqual([]);
    expect((await knowledgeGateway.retrieve({ ...query, businessProfileId: 43 })).evidence).toEqual([]);
    expect((await knowledgeGateway.retrieve({ ...query, businessProfileId: 42 })).status).toBe('sufficient');
    await pool.query("UPDATE knowledge_documents SET audience='internal',access_scope='staff_only'");
    expect((await knowledgeGateway.retrieve({ ...query, businessProfileId: 42, audience: 'customer' })).evidence).toEqual([]);
    expect((await knowledgeGateway.retrieve({ ...query, businessProfileId: 42 })).status).toBe('sufficient');
  });

  it('does not consider a surviving low-relevance neighbor sufficient after the primary is withdrawn', async () => {
    await pool.query('UPDATE knowledge_runtime_settings SET knowledge_v2_enabled=true');
    await pool.query('UPDATE knowledge_chunks SET next_chunk_id=32 WHERE id=30');
    await pool.query(`INSERT INTO knowledge_chunks(id,user_id,document_id,version_id,ordinal,evidence_id,display_text,
      search_text,token_count,access_scope,sensitivity,injection_flags,exact_identifiers)
      VALUES(32,9,2,20,1,'KB-2-V1-C1','Unrelated approved neighbor','Unrelated approved neighbor',4,
        'tenant','business',ARRAY[]::text[],ARRAY[]::text[])`);
    duringRerank = async () => { await pool.query("UPDATE knowledge_chunks SET sensitivity='personal' WHERE id=30"); };
    expect(await knowledgeGateway.retrieve(query)).toMatchObject({ status: 'insufficient', evidence: [] });
  });

  it.each([
    "UPDATE knowledge_document_versions SET status='quarantined' WHERE id=20",
    "UPDATE knowledge_document_versions SET status='retired' WHERE id=20",
    "UPDATE knowledge_documents SET current_published_version_id=21",
    "UPDATE knowledge_document_versions SET user_id=10 WHERE id=20",
    "UPDATE knowledge_document_versions SET document_id=99 WHERE id=20",
    "UPDATE knowledge_chunks SET user_id=10 WHERE id=30",
    "UPDATE knowledge_document_versions SET privacy_classification='personal' WHERE id=20",
    "UPDATE knowledge_document_versions SET privacy_classification='secret' WHERE id=20",
    "UPDATE knowledge_document_versions SET privacy_classification='restricted' WHERE id=20",
    "UPDATE knowledge_document_versions SET effective_at=NOW()+INTERVAL '1 day' WHERE id=20",
    "UPDATE knowledge_document_versions SET expires_at=NOW()-INTERVAL '1 day' WHERE id=20",
    "UPDATE knowledge_documents SET access_scope='restricted'",
    "UPDATE knowledge_documents SET audience='restricted'",
    "UPDATE knowledge_documents SET usage_scopes=ARRAY['content_draft']",
    "UPDATE knowledge_documents SET allowed_channels=ARRAY['email']",
    "UPDATE knowledge_chunks SET sensitivity='personal' WHERE id=30",
    "UPDATE knowledge_chunks SET access_scope='restricted' WHERE id=30",
    "UPDATE knowledge_chunks SET injection_flags=ARRAY['prompt_override'] WHERE id=30",
  ])('excludes withdrawn, unsafe, or foreign sources: %s', async mutation => {
    await pool.query(mutation);
    const result = await knowledgeGateway.retrieve(query);
    expect(result.evidence).toEqual([]);
    expect(result.status).not.toBe('sufficient');
  });
});
