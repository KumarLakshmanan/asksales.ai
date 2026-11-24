import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';

const localPostgres = process.env.SUPPORT_KNOWLEDGE_LOCAL_QA === '1' ? describe : describe.skip;
jest.setTimeout(30000);
let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({
  db: { transaction: (callback: Parameters<typeof fixtureDb.transaction>[0]) => fixtureDb.transaction(callback) },
}));
const { supportMemberKnowledgeService: service } = await import('../services/knowledge/SupportMemberKnowledgeService.js');
const { knowledgeDocumentsTable, knowledgeDocumentVersionsTable, knowledgeChunksTable } = await import('../models/knowledge/schema.js');
const { supportTeamsTable } = await import('../models/supportTeams/schema.js');
const { teamMembersTable } = await import('../models/teamMembers/schema.js');

localPostgres('support member knowledge (isolated local PostgreSQL schema)', () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  const member = { id: 8, userId: 9, teamId: 3 };
  const options = { page: 1, limit: 24, type: 'all', search: '' };

  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true });
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) {
      throw new Error('Knowledge QA requires local PostgreSQL');
    }
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_knowledge_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 1, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    // Application column names and SQL types, no external FKs/defaults: every
    // test value is explicit and no absent table can resolve to public data.
    for (const table of [supportTeamsTable, teamMembersTable, knowledgeDocumentsTable,
      knowledgeDocumentVersionsTable, knowledgeChunksTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`);
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query('CREATE TABLE knowledge_chunk_embeddings(chunk_id bigint, user_id integer)');
  });

  afterAll(async () => {
    await pool?.end();
    if (admin && /^support_knowledge_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE support_teams,team_members,knowledge_documents,knowledge_document_versions,knowledge_chunks,knowledge_chunk_embeddings RESTART IDENTITY');
    await pool.query('INSERT INTO support_teams(id,user_id,is_active) VALUES(3,9,true),(4,10,true)');
    await pool.query('INSERT INTO team_members(id,user_id,team_id,is_active) VALUES(8,9,3,true),(18,10,4,true)');
    await pool.query(`INSERT INTO knowledge_documents(id,user_id,legacy_entry_id,source_type,title,description,source_url,
        audience,access_scope,usage_scopes,allowed_channels,current_published_version_id)
      VALUES(2,9,5,'qa','Unreviewed edit','Private draft','https://private.invalid',
        'internal','staff_only',ARRAY['internal_assist'],ARRAY[]::text[],20)`);
    await pool.query(`INSERT INTO knowledge_document_versions(id,document_id,user_id,version_no,status,
        normalized_content,privacy_classification,created_at,vector_index_status)
      VALUES(20,2,9,1,'published_degraded','RAW SHOULD NOT RETURN','business',NOW(),'failed'),
        (21,2,9,2,'ready_for_review','UNAPPROVED VERSION','business',NOW(),'completed')`);
    await pool.query(`INSERT INTO knowledge_chunks(id,user_id,document_id,version_id,ordinal,display_text,search_text,
        char_start,char_end,token_count,access_scope,sensitivity,injection_flags)
      VALUES(30,9,2,20,0,E'Q: How to reset?\nA: Press reset.','PRIVATE SEARCH',0,34,8,'staff_only','business',ARRAY[]::text[]),
        (31,9,2,21,0,'UNAPPROVED CHUNK','UNAPPROVED SEARCH',0,16,3,'staff_only','business',ARRAY[]::text[])`);
  });

  it('executes list/search/detail CTEs against real columns and returns only current published display content', async () => {
    const listing = await service.list(member, options);
    expect(listing?.total).toBe(1);
    expect(listing?.entries[0]).toMatchObject({ id: 5, title: 'How to reset?', question: 'How to reset?', answer: 'Press reset.', sourceUrl: null });
    expect(JSON.stringify(listing)).not.toMatch(/Unreviewed|Private draft|RAW SHOULD|UNAPPROVED/);
    expect((await service.list(member, { ...options, search: 'reset', type: 'qa' }))?.total).toBe(1);
    expect((await service.list(member, { ...options, search: 'UNAPPROVED' }))?.total).toBe(0);
    expect((await service.list(member, { ...options, search: '%' }))?.total).toBe(0);
    expect((await service.list(member, { ...options, page: 2 }))?.total).toBe(1);
    const detail = await service.extractedText(member, 5);
    expect(detail?.extractedText).toBe('Q: How to reset?\nA: Press reset.');
    expect(detail?.totalChunks).toBe(1);
    expect(detail?.embeddingsGenerated).toBe(false);
    await pool.query('INSERT INTO knowledge_chunk_embeddings(chunk_id,user_id) VALUES(30,9)');
    expect((await service.extractedText(member, 5))?.chunks[0].hasEmbedding).toBe(true);
    // SET LOCAL is cleared when the real service transaction returns.
    expect((await pool.query("SELECT current_setting('app.current_user_id',true) AS tenant")).rows[0].tenant).toBe('');
  });

  it('removes a revoked version immediately from both routes', async () => {
    await pool.query("UPDATE knowledge_document_versions SET status='revoked' WHERE id=20");
    expect((await service.list(member, options))?.entries).toEqual([]);
    expect(await service.extractedText(member, 5)).toBeNull();
  });

  it('never follows an unpublished or foreign version pointer', async () => {
    await pool.query('UPDATE knowledge_documents SET current_published_version_id=21 WHERE id=2');
    expect(await service.extractedText(member, 5)).toBeNull();
    await pool.query("UPDATE knowledge_document_versions SET status='published',user_id=10 WHERE id=21");
    expect(await service.extractedText(member, 5)).toBeNull();
  });

  it('rejects stale/foreign team identity and a cross-tenant team relationship', async () => {
    expect(await service.list({ ...member, teamId: 4 }, options)).toBeNull();
    expect(await service.extractedText({ ...member, userId: 10 }, 5)).toBeNull();
    expect(await service.extractedText({ id: 18, userId: 10, teamId: 4 }, 5)).toBeNull();
    await pool.query('UPDATE support_teams SET user_id=10 WHERE id=3');
    expect(await service.list(member, options)).toBeNull();
  });

  it.each([
    "UPDATE knowledge_document_versions SET status='quarantined' WHERE id=20",
    "UPDATE knowledge_document_versions SET privacy_classification='personal' WHERE id=20",
    "UPDATE knowledge_document_versions SET privacy_classification='secret' WHERE id=20",
    "UPDATE knowledge_document_versions SET privacy_classification='restricted' WHERE id=20",
    "UPDATE knowledge_document_versions SET effective_at=NOW()+INTERVAL '1 day' WHERE id=20",
    "UPDATE knowledge_document_versions SET expires_at=NOW()-INTERVAL '1 day' WHERE id=20",
    "UPDATE knowledge_documents SET access_scope='restricted' WHERE id=2",
    "UPDATE knowledge_documents SET audience='restricted' WHERE id=2",
    "UPDATE knowledge_documents SET business_profile_id=42 WHERE id=2",
    "UPDATE knowledge_documents SET usage_scopes=ARRAY['content_draft'] WHERE id=2",
    "UPDATE knowledge_documents SET allowed_channels=ARRAY['email'] WHERE id=2",
    "UPDATE knowledge_chunks SET sensitivity='personal' WHERE id=30",
    "UPDATE knowledge_chunks SET access_scope='restricted' WHERE id=30",
    "UPDATE knowledge_chunks SET injection_flags=ARRAY['prompt_override'] WHERE id=30",
  ])('excludes unsafe or out-of-scope records: %s', async mutation => {
    await pool.query(mutation);
    expect((await service.list(member, options))?.total).toBe(0);
    expect(await service.extractedText(member, 5)).toBeNull();
  });
});
