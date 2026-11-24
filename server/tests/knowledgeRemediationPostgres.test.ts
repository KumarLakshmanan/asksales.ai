import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  jest,
} from '@jest/globals';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
let db: any;
let pool: Pool;
let admin: Pool;
const schema = `knowledge_remediation_${randomBytes(8).toString('hex')}`;
jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    execute: (q: any) => db.execute(q),
    transaction: (f: any) => db.transaction(f),
    select: (...args: any[]) => db.select(...args),
    insert: (...args: any[]) => db.insert(...args),
    update: (...args: any[]) => db.update(...args),
  },
}));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({
  embeddingService: {
    generateEmbedding: async () => {
      throw new Error('audit provider disabled');
    },
  },
}));
jest.unstable_mockModule('../services/knowledge/KnowledgeReranker.js', () => ({
  rerankKnowledgeCandidates: async (_q: any, candidates: any) => ({
    candidates,
    reranked: false,
  }),
}));
const { knowledgeGovernanceService: governance } =
  await import('../services/knowledge/KnowledgeGovernanceService.js');
const { knowledgeGateway: gateway } =
  await import('../services/knowledge/KnowledgeGateway.js');
const { supportMemberKnowledgeService: library } =
  await import('../services/knowledge/SupportMemberKnowledgeService.js');
const { knowledgeReadinessService: readiness } =
  await import('../services/knowledge/KnowledgeReadinessService.js');
const tables = await import('../models/knowledge/schema.js');
const { knowledgeBaseTable } =
  await import('../models/knowledgeBase/schema.js');
const { KnowledgeBaseModel } =
  await import('../models/knowledgeBase/functions.js');
// @ts-expect-error Migration modules are plain JavaScript without declarations.
const { up: recoveryUp, down: recoveryDown } = await import('../migrations/400_knowledge_authoring_recovery.js');
const { verifyKnowledgeClaims } =
  await import('../services/knowledge/KnowledgeClaimVerifier.js');
const local =
  process.env.AUDIT_LOCAL_POSTGRES === '1' ? describe : describe.skip;
local(
  'knowledge remediation acceptance (isolated PostgreSQL; providers disabled)',
  () => {
    beforeAll(async () => {
      const cfg = {
        host: '127.0.0.1',
        port: 55499,
        database: 'postgres',
        user: 'postgres',
      };
      admin = new Pool({
        ...cfg,
        max: 1,
        options: '-c search_path=pg_catalog',
      });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        ...cfg,
        max: 1,
        options: `-c search_path=${schema},pg_catalog`,
      });
      db = drizzle(pool);
      for (const table of [
        knowledgeBaseTable,
        tables.knowledgeDocumentsTable,
        tables.knowledgeDocumentVersionsTable,
        tables.knowledgeChunksTable,
        tables.knowledgeIndexVersionsTable,
        tables.knowledgeRuntimeSettingsTable,
        tables.knowledgeRetrievalAuditsTable,
        tables.knowledgeGovernanceAuditsTable,
      ]) {
        const def = getTableConfig(table);
        await pool.query(
          `CREATE TABLE "${def.name}" (${def.columns.map((c) => `"${c.name}" ${c.getSQLType()}${c.primary ? ' PRIMARY KEY' : ''}`).join(',')})`,
        );
      }
      for (const table of [
        'knowledge_base',
        'knowledge_document_versions',
        'knowledge_chunks',
        'knowledge_governance_audits',
      ]) {
        await pool.query(
          `SELECT setval(pg_get_serial_sequence('${table}','id'),1000)`,
        );
      }
      await recoveryUp(pool);
      await recoveryDown(pool);
      await recoveryUp(pool);
      await pool.query(`ALTER TABLE knowledge_chunks ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS(to_tsvector('simple',search_text)) STORED;
   CREATE TABLE company_settings(id integer,user_id integer);
   CREATE TABLE support_teams(id integer,user_id integer,is_active boolean);
   CREATE TABLE team_members(id integer,user_id integer,team_id integer,is_active boolean);
   CREATE TABLE knowledge_chunk_embeddings(chunk_id bigint,user_id integer,index_version_id integer,provider text,model text,dimensions integer,content_hash text,embedding text,metadata jsonb);
   INSERT INTO support_teams VALUES(3,9,true);INSERT INTO team_members VALUES(8,9,3,true);`);
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
    beforeEach(async () => {
      await pool.query(`TRUNCATE knowledge_base,knowledge_documents,knowledge_document_versions,knowledge_chunks,knowledge_runtime_settings,knowledge_index_versions,knowledge_chunk_embeddings;
   INSERT INTO knowledge_base(id,user_id,type,title,content,business_profile_id,updated_at,processing_status) VALUES(5,9,'document','Legacy title','Reset with the blue button.',NULL,NOW(),'completed');
   INSERT INTO knowledge_runtime_settings(id,knowledge_v2_enabled,maintenance_mode)VALUES(1,false,false);
   INSERT INTO knowledge_documents(id,user_id,legacy_entry_id,source_type,title,audience,access_scope,usage_scopes,allowed_channels,current_published_version_id)
    VALUES(2,9,5,'document','Legacy title','customer','tenant',ARRAY['support_answer'],ARRAY[]::text[],20);
   INSERT INTO knowledge_document_versions(id,document_id,user_id,version_no,status,normalized_content,privacy_classification,created_at,authority,vector_index_status,lexical_index_status,diagnostics)
    VALUES(20,2,9,1,'published_degraded','Reset with the blue button.','business',NOW(),'owner_authored','failed','completed',
     '{"publicationMetadata":{"title":"OrchidManual4821","sourceUrl":null,"businessProfileId":null,"audience":"customer","accessScope":"tenant","usageScopes":["support_answer"],"allowedChannels":[],"locale":null}}'),
    (21,2,9,2,'ready_for_review','Reset with the green button.','business',NOW(),'owner_authored','failed','completed','{}');
   INSERT INTO knowledge_chunks(id,user_id,document_id,version_id,ordinal,evidence_id,display_text,search_text,token_count,access_scope,sensitivity,injection_flags,exact_identifiers)
    VALUES(30,9,2,20,0,'KB-2-V1-C0','Reset with the blue button.','Reset with the blue button.',6,'tenant','business',ARRAY[]::text[],ARRAY[]::text[]),
     (31,9,2,21,0,'KB-2-V2-C0','Reset with the green button.','Reset with the green button.',6,'tenant','business',ARRAY[]::text[],ARRAY[]::text[]);`);
    });
    const query = {
      tenantId: 9,
      redactedText: 'reset button',
      purpose: 'support_answer',
      audience: 'customer',
      channel: 'web',
      risk: 'low',
    } as any;
    it('reports a historical personal publication as blocked even with complete active-index embeddings', async () => {
      await pool.query(`INSERT INTO knowledge_index_versions(id,version_key,provider,model,dimensions,state) VALUES(2,'readiness-active','openai','test-model',1536,'active');
        UPDATE knowledge_runtime_settings SET active_index_version_id=2;
        UPDATE knowledge_document_versions SET privacy_classification='personal',vector_index_status='completed' WHERE id=20;
        UPDATE knowledge_chunks SET sensitivity='personal' WHERE version_id=20;
        INSERT INTO knowledge_chunk_embeddings(chunk_id,user_id,index_version_id,provider,model,dimensions,embedding) VALUES(30,9,2,'openai','test-model',1536,'synthetic');`);
      const state = (await readiness.entries(9,[5])).get(5);
      expect(state).toMatchObject({ status:'privacy_blocked',versionId:20,versionNo:1,isLive:true,
        chunkCount:1,embeddedChunkCount:1,semanticIndexStatus:'completed' });
      const preview = await readiness.extractedText(9,5);
      expect(preview?.extractionSource).toBe('published_version');
      expect(preview?.chunks[0]).toMatchObject({text:'Reset with the blue button.',hasEmbedding:true});
      expect(preview?.extractedText).not.toContain('green');
      expect((await gateway.retrieve(query)).evidence).toEqual([]);
      expect(await library.extractedText({id:8,userId:9,teamId:3},5)).toBeNull();
      expect(await readiness.retrievalDiagnostics(query)).toEqual({scopeOnly:true,privacyBlockedSources:1,safetyBlockedSources:0,indexingBlockedSources:0});
      expect((await readiness.entries(10,[5])).size).toBe(0);
      expect(await readiness.extractedText(10,5)).toBeNull();
      expect((await pool.query('SELECT privacy_classification,status FROM knowledge_document_versions WHERE id=20')).rows[0])
        .toEqual({privacy_classification:'personal',status:'published_degraded'});
    });
    it('uses active-index embeddings and ignores legacy flags, old indexes, and wrong dimensions', async () => {
      await pool.query(`INSERT INTO knowledge_index_versions(id,version_key,provider,model,dimensions,state) VALUES(3,'readiness-rotated','openai','test-model',1536,'active');
        UPDATE knowledge_runtime_settings SET active_index_version_id=3;
        UPDATE knowledge_document_versions SET vector_index_status='completed' WHERE id=20;
        INSERT INTO knowledge_chunk_embeddings(chunk_id,user_id,index_version_id,provider,model,dimensions,embedding)
          VALUES(30,9,2,'openai','test-model',1536,'old'),(30,9,3,'openai','test-model',768,'wrong-dimensions');`);
      expect((await readiness.entries(9,[5])).get(5)).toMatchObject({status:'available',embeddedChunkCount:0,semanticIndexStatus:'incomplete'});
      expect((await readiness.extractedText(9,5))?.chunks[0].hasEmbedding).toBe(false);
      await pool.query('UPDATE knowledge_chunk_embeddings SET dimensions=1536 WHERE index_version_id=3');
      expect((await readiness.extractedText(9,5))?.chunks[0].hasEmbedding).toBe(true);
    });
    it('reports chunk privacy independently of the version and scopes owner diagnostic counts', async () => {
      await pool.query(`UPDATE knowledge_chunks SET sensitivity='personal' WHERE version_id=20`);
      expect((await readiness.entries(9,[5])).get(5)?.status).toBe('privacy_blocked');
      expect((await readiness.retrievalDiagnostics({...query,purpose:'proposal'})).privacyBlockedSources).toBe(1);
      await pool.query(`UPDATE knowledge_documents SET allowed_channels=ARRAY['email'],business_profile_id=42,access_scope='business_profile'`);
      expect((await readiness.retrievalDiagnostics(query)).privacyBlockedSources).toBe(0);
      expect((await readiness.retrievalDiagnostics({...query,channel:'email',businessProfileId:43})).privacyBlockedSources).toBe(0);
      expect((await readiness.retrievalDiagnostics({...query,channel:'email',businessProfileId:42})).privacyBlockedSources).toBe(1);
    });
    it('KB-03 preserves current facts until the approved schedule becomes due, then switches atomically', async () => {
      expect((await gateway.retrieve(query)).evidence[0].versionId).toBe(20);
      const result = await governance.publish({
        userId: 9,
        actorUserId: 9,
        legacyEntryId: 5,
        versionId: 21,
        authority: 'owner_authored',
        allowLexicalOnly: true,
        effectiveAt: new Date(Date.now() + 86400000).toISOString(),
      });
      expect(result.status).toBe('scheduled');
      expect((await gateway.retrieve(query)).evidence[0].versionId).toBe(20);
      expect(
        (
          await pool.query(
            'SELECT status FROM knowledge_document_versions WHERE id=20',
          )
        ).rows[0].status,
      ).toBe('published_degraded');
      await pool.query(
        "UPDATE knowledge_document_versions SET effective_at=NOW()-INTERVAL '1 second' WHERE id=21",
      );
      expect((await gateway.retrieve(query)).evidence[0].versionId).toBe(21);
      expect(
        (
          await pool.query(
            'SELECT status FROM knowledge_document_versions WHERE id=20',
          )
        ).rows[0].status,
      ).toBe('retired');
    });
    it('KB-03 withdrawal cancels a pending publication without later resurrection', async () => {
      await governance.publish({
        userId: 9,
        actorUserId: 9,
        legacyEntryId: 5,
        versionId: 21,
        authority: 'owner_authored',
        allowLexicalOnly: true,
        effectiveAt: new Date(Date.now() + 86400000).toISOString(),
      });
      await governance.withdraw({
        userId: 9,
        actorUserId: 9,
        legacyEntryId: 5,
        reason: 'Synthetic review required',
      });
      await pool.query(
        "UPDATE knowledge_document_versions SET effective_at=NOW()-INTERVAL '1 second' WHERE id=21",
      );
      expect((await gateway.retrieve(query)).evidence).toEqual([]);
      expect(
        (
          await pool.query(
            'SELECT current_published_version_id FROM knowledge_documents WHERE id=2',
          )
        ).rows[0].current_published_version_id,
      ).toBeNull();
    });
    it('KB-03 refuses scheduling a live degraded version without a separate draft', async () => {
      await expect(
        governance.publish({
          userId: 9,
          actorUserId: 9,
          legacyEntryId: 5,
          versionId: 20,
          authority: 'owner_authored',
          allowLexicalOnly: true,
          effectiveAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      ).rejects.toThrow('KNOWLEDGE_SCHEDULE_REQUIRES_DRAFT');
      expect((await gateway.retrieve(query)).evidence[0].versionId).toBe(20);
    });
    it('KB-03 keeps prior content live when a scheduled version expires before activation', async () => {
      await governance.publish({
        userId: 9,
        actorUserId: 9,
        legacyEntryId: 5,
        versionId: 21,
        authority: 'owner_authored',
        allowLexicalOnly: true,
        effectiveAt: new Date(Date.now() + 86400000).toISOString(),
        expiresAt: new Date(Date.now() + 172800000).toISOString(),
      });
      await pool.query(
        "UPDATE knowledge_document_versions SET effective_at=NOW()-INTERVAL '2 seconds',expires_at=NOW()-INTERVAL '1 second' WHERE id=21",
      );
      // Use persisted expiry as well as effective time, matching the approved schedule.
      await pool.query(
        "UPDATE knowledge_document_versions SET diagnostics=jsonb_set(diagnostics,'{scheduledPublication,expiresAt}',to_jsonb((NOW()-INTERVAL '1 second')::text)) WHERE id=21",
      );
      expect((await gateway.retrieve(query)).evidence[0].versionId).toBe(20);
      expect(
        (
          await pool.query(
            'SELECT diagnostics FROM knowledge_document_versions WHERE id=21',
          )
        ).rows[0].diagnostics.scheduleReviewRequired,
      ).toBe('CANNOT_PUBLISH_EXPIRED_KNOWLEDGE');
    });
    it('KB-06 published title and body are searchable without exposing draft metadata', async () => {
      const member = { id: 8, userId: 9, teamId: 3 };
      const opts = { page: 1, limit: 24, type: 'all', search: '' };
      expect((await library.list(member, opts))?.entries[0].title).toBe(
        'OrchidManual4821',
      );
      expect(
        (await library.list(member, { ...opts, search: 'OrchidManual4821' }))
          ?.total,
      ).toBe(1);
      expect(
        (await library.list(member, { ...opts, search: 'blue button' }))?.total,
      ).toBe(1);
    });
    it('KB-08 rejects legacy oversize evidence even when its stored token count is forged', async () => {
      const text = 'Reset button ' + '界'.repeat(100000);
      await pool.query(
        'UPDATE knowledge_chunks SET display_text=$1,search_text=$2,token_count=3 WHERE id=30',
        [text, 'Reset button'],
      );
      const result = await gateway.retrieve(query);
      expect(result.evidence).toEqual([]);
    });
    it('KB-08 bounds oversized legacy navigation metadata within the actual evidence payload', async () => {
      await pool.query(
        'UPDATE knowledge_chunks SET section_path=$1 WHERE id=30',
        [['界'.repeat(100000)]],
      );
      const result = await gateway.retrieve(query);
      expect(result.status).toBe('sufficient');
      expect(
        Buffer.byteLength(JSON.stringify(result.evidence), 'utf8'),
      ).toBeLessThanOrEqual(24000);
      expect(
        Buffer.byteLength(result.evidence[0].sectionPath![0], 'utf8'),
      ).toBeLessThanOrEqual(512);
    });
    it('KB-01 blocks unsafe publication metadata even when the indexed body is safe', async () => {
      const title = 'synthetic.person@example.test api_key = abcdefghijklmnop';
      const metadata = {
        title,
        sourceUrl: null,
        businessProfileId: null,
        audience: 'customer',
        accessScope: 'tenant',
        usageScopes: ['support_answer'],
        allowedChannels: [],
        locale: null,
      };
      await pool.query(
        'UPDATE knowledge_document_versions SET diagnostics=$1 WHERE id=21',
        [JSON.stringify({ publicationMetadata: metadata })],
      );
      await expect(
        governance.publish({
          userId: 9,
          actorUserId: 9,
          legacyEntryId: 5,
          versionId: 21,
          authority: 'owner_authored',
          allowLexicalOnly: true,
        }),
      ).rejects.toThrow('KNOWLEDGE_METADATA_PRIVACY_REVIEW_REQUIRED');
      expect((await gateway.retrieve(query)).evidence[0].versionId).toBe(20);
    });
    it('KB-09 contradictory equal-authority publication stays in review and verifier rejects conflicting retained evidence', async () => {
      await pool.query(
        "UPDATE knowledge_chunks SET display_text='Premium Club Room accommodates 2 guests.',search_text='Premium Club Room accommodates 2 guests.' WHERE id=30",
      );
      await pool.query(`INSERT INTO knowledge_documents(id,user_id,legacy_entry_id,source_type,title,audience,access_scope,usage_scopes,allowed_channels)
   VALUES(3,9,6,'document','Room capacity revision','customer','tenant',ARRAY['support_answer'],ARRAY[]::text[]);
   INSERT INTO knowledge_document_versions(id,document_id,user_id,version_no,status,normalized_content,privacy_classification,created_at,authority,vector_index_status,lexical_index_status,diagnostics)
   VALUES(22,3,9,1,'ready_for_review','Premium Club Room accommodates 9 guests.','business',NOW(),'owner_authored','failed','completed','{}');
   INSERT INTO knowledge_chunks(id,user_id,document_id,version_id,ordinal,evidence_id,display_text,search_text,token_count,access_scope,sensitivity,injection_flags,exact_identifiers)
   VALUES(32,9,3,22,0,'KB-3-V1-C0','Premium Club Room accommodates 9 guests.','Premium Club Room accommodates 9 guests.',7,'tenant','business',ARRAY[]::text[],ARRAY[]::text[]);`);
      await expect(
        governance.publish({
          userId: 9,
          actorUserId: 9,
          legacyEntryId: 6,
          versionId: 22,
          authority: 'owner_authored',
          allowLexicalOnly: true,
        }),
      ).rejects.toThrow('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
      expect(
        (
          await pool.query(
            'SELECT diagnostics FROM knowledge_document_versions WHERE id=22',
          )
        ).rows[0].diagnostics.conflictVersionIds,
      ).toEqual([20]);
      // Simulate a legacy conflicting live source to exercise the read-time safety net.
      await pool.query(
        "UPDATE knowledge_document_versions SET status='published_degraded' WHERE id=22;UPDATE knowledge_documents SET current_published_version_id=22 WHERE id=3",
      );
      const result = await gateway.retrieve({
        ...query,
        redactedText: 'Premium Club Room accommodates guests',
      });
      expect(result.status).toBe('conflict_detected');
      expect(result.evidence).toEqual([]);
      const verdict = verifyKnowledgeClaims({
        retrieval: result,
        audience: 'customer',
        risk: 'low',
        claims: [
          {
            claimId: 'capacity',
            claim: 'Premium Club Room accommodates 9 guests.',
            origin: 'knowledge',
            evidenceIds: ['KB-3-V1-C0'],
            verdict: 'unsupported',
          },
        ],
      });
      expect(verdict).toMatchObject({
        mayDeliver: false,
        answerGrounding: 'blocked',
      });
    });

    it('KB-05 metadata-only edits clone a reviewable version without changing live metadata or calling providers', async () => {
      const entry = await KnowledgeBaseModel.findById(5, 9);
      const result = await governance.updateSourceMetadata(
        entry!,
        { title: 'Reviewed replacement title' },
        entry!.updatedAt!,
      );
      expect(result.draft.status).toBe('ready_for_review');
      const old = await gateway.retrieve(query);
      expect(old.evidence[0].title).toBe('OrchidManual4821');
      const draft = (
        await pool.query(
          'SELECT diagnostics FROM knowledge_document_versions WHERE id=$1',
          [result.draft.versionId],
        )
      ).rows[0];
      expect(draft.diagnostics.publicationMetadata.title).toBe(
        'Reviewed replacement title',
      );
    });
    it('KB-05 metadata-only edits create a new immutable version when no draft exists', async () => {
      await pool.query(
        'DELETE FROM knowledge_chunks WHERE version_id=21;DELETE FROM knowledge_document_versions WHERE id=21',
      );
      const entry = await KnowledgeBaseModel.findById(5, 9);
      const result = await governance.updateSourceMetadata(
        entry!,
        { title: 'Replacement file title' },
        entry!.updatedAt!,
      );
      expect(result.draft.versionId).not.toBe(20);
      expect(
        (
          await pool.query(
            'SELECT display_text FROM knowledge_chunks WHERE version_id=$1',
            [result.draft.versionId],
          )
        ).rows.map((r) => r.display_text),
      ).toEqual(['Reset with the blue button.']);
      expect((await gateway.retrieve(query)).evidence[0].title).toBe(
        'OrchidManual4821',
      );
    });
    it('KB-07 concurrent unchanged batch retries persist one source per item and reject payload reuse', async () => {
      const candidates = [
        {
          userId: 9,
          title: 'Batch reset',
          type: 'qa',
          question: 'Reset?',
          answer: 'Blue button',
          content: 'Q: Reset?\nA: Blue button',
          processingStatus: 'queued',
          businessProfileId: null,
        },
      ];
      const [first, second] = await Promise.all([
        KnowledgeBaseModel.createBatch(9, 'synthetic-request-123', candidates),
        KnowledgeBaseModel.createBatch(9, 'synthetic-request-123', candidates),
      ]);
      expect(first[0].id).toBe(second[0].id);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM knowledge_base WHERE creation_request_key IS NOT NULL',
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        KnowledgeBaseModel.createBatch(9, 'synthetic-request-123', [
          { ...candidates[0], answer: 'Changed answer' },
        ]),
      ).rejects.toThrow('KNOWLEDGE_BATCH_REQUEST_CHANGED');
      await expect(KnowledgeBaseModel.createBatch(9,'synthetic-request-123',[...candidates,...candidates])).rejects.toThrow('KNOWLEDGE_BATCH_REQUEST_CHANGED');
    const [claimed, other] = await Promise.all([
        KnowledgeBaseModel.claimBatchItem(first[0].id, 9),
        KnowledgeBaseModel.claimBatchItem(first[0].id, 9),
      ]);
      expect([claimed, other].filter(Boolean)).toHaveLength(1);
      await expect(recoveryDown(pool)).rejects.toThrow(
        'Knowledge recovery identities must be preserved',
      );
    });
    it('S-03 permits the initial edit of a legacy null timestamp and rejects its stale retry',async()=>{
    await pool.query('UPDATE knowledge_base SET updated_at=NULL WHERE id=5');
    expect(await KnowledgeBaseModel.updateIfUnchanged(5,9,{title:'Legacy repaired'},new Date(0))).not.toBeNull();
    expect(await KnowledgeBaseModel.updateIfUnchanged(5,9,{title:'Stale legacy'},new Date(0))).toBeNull();
  });
  it('S-03 stale source edits conflict instead of overwriting a newer save', async () => {
      const entry = await KnowledgeBaseModel.findById(5, 9);
      expect(
        await KnowledgeBaseModel.updateIfUnchanged(
          5,
          9,
          { title: 'New title' },
          entry!.updatedAt!,
        ),
      ).not.toBeNull();
      expect(
        await KnowledgeBaseModel.updateIfUnchanged(
          5,
          9,
          { title: 'Stale title' },
          entry!.updatedAt!,
        ),
      ).toBeNull();
      expect((await KnowledgeBaseModel.findById(5, 9))!.title).toBe(
        'New title',
      );
    });
  },
);
