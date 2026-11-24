import { beforeAll, beforeEach, afterAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { withBusinessScope, withAccountScope } from '../tenancy/businessContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';

const inProfile = <T>(userId: number, profile: number, work: () => T) => withBusinessScope({ userId, businessProfileId: profile }, work);
const inBusiness = <T>(work: () => T) => inProfile(9, 7, work);

const local = process.env.SUPPORT_DOCUMENT_LOCAL_QA === '1' ? describe : describe.skip;
const assistantId = '11111111-1111-4111-8111-111111111111';
const assistantConfiguration = { ...emptyAssistantDraft(), name: 'Synthetic document assistant', agentType: 'general_service',
  replyModel: { provider: 'test', model: 'approved' }, bindings: [{ channel: 'whatsapp', surface: 'private', accountId: 'fixture-phone' }],
  knowledge: { mode: 'none', ids: [] }, documents: { mode: 'none', ids: [] }, galleries: { mode: 'none', ids: [] },
  playbooks: { mode: 'none', assignments: [] }, followUps: { mode: 'none', sequences: [] }, tools: { mode: 'none', names: [], approvalRequired: [] } };
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({
  availableAssistantModels: async () => [{ provider: 'test', model: 'approved', controls: [] }],
  assistantCatalog: async () => ({ presets: [{ agentType: 'general_service' }],
    accounts: [{ channel: 'whatsapp', surface: 'private', accountId: 'fixture-phone', connected: true }],
    models: [{ provider: 'test', model: 'approved', controls: [] }], knowledge: [], documents: [], galleries: [], playbooks: [], templates: [], tools: [] }),
  assistantPlatformReadiness: async () => ({ classifier: true, privacyVault: true }),
}));
let fixtureDb: ReturnType<typeof drizzle>;
const proxy = new Proxy({} as typeof fixtureDb, { get: (_target, key) => {
  const value = Reflect.get(fixtureDb, key);
  return typeof value === 'function' ? value.bind(fixtureDb) : value;
} });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
const upload = jest.fn<any>(async () => ({ id: 'synthetic-upload' }));
const send = jest.fn<any>(async () => ({ messages: [{ id: 'synthetic-wamid' }] }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { uploadMedia: upload, sendMedia: send } }));
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({
  socialDraftChannel: () => undefined,
  automaticSupportReplyAllowed: async () => true, isAutomaticSupportDelivery: () => true, AUTOMATIC_REPLY_DISABLED: 'disabled',
}));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ activateSocialFollowUpForAnchor: async () => {} }));
const buffer = Buffer.from('%PDF-1.7\nSynthetic approved fixture.\n%%EOF');
const checksum = createHash('sha256').update(buffer).digest('hex');
let downloadBuffer = buffer;
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageLimitError: class extends Error {
  constructor(message: string) { super(message); this.name = 'StorageLimitError'; }
}, storageService: {
  downloadFile: async (_fileId: number, userId: number) => ({ buffer: downloadBuffer, file: { userId, mimeType: 'application/pdf' } }),
} }));
const { downloadWidgetDocument, loadApprovedWidgetDocument, verifyWidgetDocumentReceipt, publicWidgetMessage } =
  await import('../services/supportDocuments/SupportWidgetDocuments.js');
const { approvedSupportDocuments } = await import('../services/supportDocuments/ApprovedSupportDocuments.js');
const { supportDocumentDelivery } = await import('../services/supportDocuments/SupportDocumentDelivery.js');
const { supportDeliveryOutboxTable, supportAdminAuditLogsTable } = await import('../models/supportOrchestration/schema.js');
const { supportDocumentLibrary } = await import('../services/supportDocuments/SupportDocumentLibrary.js');
const { outreachConversationsTable, outreachMessagesTable } = await import('../models/outreachConversations/schema.js');
// @ts-expect-error Production migrations are plain JavaScript without declarations.
const { up } = await import('../migrations/289_support_document_delivery.js');
// @ts-expect-error Production migrations are plain JavaScript without declarations.
const { up: libraryUp } = await import('../migrations/290_support_document_library.js');

local('approved document registry (isolated local PostgreSQL and non-superuser RLS)', () => {
  let admin: Pool; let fixture: Pool; let reader: Pool; let schema: string; let role: string;
  const priorRuntime = process.env.SUPPORT_ASSISTANTS_ENABLED;
  const priorProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true });
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'true';
    delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
    if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('QA requires local PostgreSQL.');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    const suffix = randomBytes(8).toString('hex'); schema = `support_docs_${suffix}`; role = `support_docs_reader_${suffix}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    fixture = new Pool({ ...config, max: 1, options: `-c search_path=${schema},pg_catalog -c app.business_profile_id=7` });
    await localBusinessFunctions(fixture);
    await fixture.query(`CREATE TABLE users(id integer PRIMARY KEY);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer NOT NULL);
      CREATE TABLE storage_files(id integer PRIMARY KEY,user_id integer NOT NULL,business_profile_id integer NOT NULL,is_deleted boolean NOT NULL DEFAULT false,mime_type text NOT NULL);
      INSERT INTO users VALUES(9),(10);
      INSERT INTO company_settings VALUES(7,9),(17,9),(8,10);
      INSERT INTO storage_files VALUES(250,9,7,false,'application/pdf'),(251,10,8,false,'application/pdf'),
        (252,9,7,false,'application/pdf'),(253,9,17,false,'application/pdf');`);
    await up(fixture);
    await libraryUp(fixture);
    // Migration 299 adds the business prefix to these original uniqueness contracts.
    for (const table of ['support_approved_documents', 'support_document_library']) {
      const unique = await fixture.query(`SELECT conname FROM pg_constraint
        WHERE conrelid=$1::regclass AND contype='u'`, [table]);
      expect(unique.rows).toHaveLength(1);
      await fixture.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${String(unique.rows[0].conname).replaceAll('"','""')}"`);
    }
    await fixture.query(`ALTER TABLE support_approved_documents ADD UNIQUE(business_profile_id,user_id,storage_file_id,service,checksum);
      ALTER TABLE support_document_library ADD UNIQUE(business_profile_id,user_id,storage_file_id)`);
    for (const table of [supportDeliveryOutboxTable, outreachConversationsTable, outreachMessagesTable, supportAdminAuditLogsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`);
      await fixture.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await fixture.query(`ALTER TABLE support_delivery_outbox ADD UNIQUE(decision_key);
      ALTER TABLE support_delivery_outbox ALTER COLUMN attempt_count SET DEFAULT 0;
      ALTER TABLE support_delivery_outbox ALTER COLUMN max_attempts SET DEFAULT 5;
      CREATE UNIQUE INDEX fixture_message_delivery_unique ON outreach_messages(delivery_action_id) WHERE delivery_action_id IS NOT NULL;
      CREATE TABLE handoff_queue(user_id integer,business_profile_id integer DEFAULT app_business_profile_id(),conversation_id integer,status text);
      CREATE TABLE support_teams(id integer PRIMARY KEY,user_id integer,business_profile_id integer DEFAULT app_business_profile_id(),is_active boolean DEFAULT true);
      CREATE TABLE team_members(id integer PRIMARY KEY,user_id integer,business_profile_id integer DEFAULT app_business_profile_id(),team_id integer,is_active boolean DEFAULT true);
      CREATE TABLE support_chat_sessions(id integer PRIMARY KEY,business_profile_id integer DEFAULT app_business_profile_id(),member_id integer,public_token text,session_expires_at timestamptz);
      CREATE TABLE support_chat_messages(id integer PRIMARY KEY,business_profile_id integer DEFAULT app_business_profile_id(),session_id integer,role text,metadata jsonb,
        processing_status text NOT NULL DEFAULT 'completed');
      CREATE TABLE agent_audit_logs(user_id integer,business_profile_id integer DEFAULT app_business_profile_id(),delivery_action_id bigint,delivery_status text,delivery_deferred boolean,provider_message_id text);`);
    await fixture.query(`CREATE TABLE outreach_assistants(id uuid PRIMARY KEY,user_id integer,business_profile_id integer,state text,published_revision integer);
      CREATE TABLE outreach_assistant_revisions(assistant_id uuid,revision integer,configuration jsonb,business_profile_id integer);
      CREATE TABLE outreach_assistant_bindings(id integer PRIMARY KEY,user_id integer,business_profile_id integer,assistant_id uuid,
        revision integer,version integer,channel text,surface text,account_id text,enabled boolean);
      INSERT INTO outreach_assistants VALUES('${assistantId}',9,7,'live',1);
      INSERT INTO outreach_assistant_bindings VALUES(1,9,7,'${assistantId}',1,1,'whatsapp','private','fixture-phone',true);`);
    await fixture.query('INSERT INTO outreach_assistant_revisions VALUES($1,1,$2::jsonb,7)', [assistantId, JSON.stringify(assistantConfiguration)]);
    await localBusinessIsolation(fixture, schema, ['storage_files', 'support_approved_documents', 'support_document_library',
      'support_delivery_outbox', 'outreach_conversations', 'outreach_messages', 'support_admin_audit_logs',
      'handoff_queue', 'support_teams', 'team_members', 'support_chat_sessions', 'support_chat_messages', 'agent_audit_logs']);
    await fixture.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}";
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}";
      GRANT salesmarketing_business_runtime TO "${role}"`);
    reader = createBusinessScopedPool(new Pool({ ...config, max: 1, options: `-c search_path=${schema},pg_catalog -c role=${role}` }));
    fixtureDb = drizzle(reader);
  });
  afterAll(async () => {
    await reader?.end(); await fixture?.end();
    if (admin && /^support_docs_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (admin && /^support_docs_reader_[a-f0-9]{16}$/.test(role)) await admin.query(`DROP ROLE "${role}"`);
    await admin?.end();
    if (priorRuntime === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED; else process.env.SUPPORT_ASSISTANTS_ENABLED = priorRuntime;
    if (priorProfiles === undefined) delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES; else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = priorProfiles;
  });
  beforeEach(async () => {
    await fixture.query('TRUNCATE support_document_library,support_approved_documents,support_admin_audit_logs RESTART IDENTITY');
    await fixture.query('TRUNCATE support_delivery_outbox,outreach_conversations,outreach_messages,handoff_queue,agent_audit_logs RESTART IDENTITY');
    await fixture.query(`UPDATE outreach_assistant_bindings SET enabled=true;
      INSERT INTO outreach_conversations(id,user_id,channel,provider_account_id,external_thread_id,automation_mode,status,metadata,total_messages)
      VALUES(615,9,'whatsapp','fixture-phone','synthetic-recipient','ai_active','active','{}',0)`);
    await fixture.query('UPDATE storage_files SET is_deleted=false');
    await fixture.query(`TRUNCATE support_teams,team_members,support_chat_sessions,support_chat_messages;
      INSERT INTO support_teams(id,user_id,business_profile_id) VALUES(1,9,7),(2,10,8);
      INSERT INTO team_members(id,user_id,business_profile_id,team_id) VALUES(1,9,7,1),(2,10,8,2);
      INSERT INTO support_chat_sessions(id,business_profile_id,member_id,public_token,session_expires_at) VALUES(1,7,1,'session-one',NOW()+INTERVAL '1 hour'),
        (2,7,1,'session-two',NOW()+INTERVAL '1 hour'),(3,8,2,'session-other-tenant',NOW()+INTERVAL '1 hour');`);
    downloadBuffer = buffer;
    jest.clearAllMocks(); upload.mockResolvedValue({ id: 'synthetic-upload' }); send.mockResolvedValue({ messages: [{ id: 'synthetic-wamid' }] });
  });
  const approval = () => ({ userId: 9, businessProfileId: 7, storageFileId: 250, title: 'Day outing brochure', service: 'day_outing' as const,
    checksum, approvalReason: 'Synthetic binary inspected and approved by owner for this test.' });
  const draft = () => ({ title: 'Day outing brochure', description: 'For families visiting without an overnight stay.',
    service: 'day_outing' as const, storageFileId: 250 });
  const certification = (document: { revision: number; checksum: string }) => ({ ...document, certified: true, reason: 'Reviewed synthetic PDF for testing.' });

  it('serves exact PDF bytes only for the owning session and persisted assistant attachment', async () => inBusiness(async () => {
    const document = await approvedSupportDocuments.approve(approval());
    await fixture.query(`INSERT INTO support_chat_messages(id,session_id,role,metadata) VALUES(1,1,'assistant',$1)`, [JSON.stringify({ documents: [document] })]);
    const input = { userId: 9, teamId: 1, sessionId: 1, sessionToken: 'session-one', messageId: 1, documentId: document!.id };
    expect((await downloadWidgetDocument(input))?.buffer).toEqual(buffer);
    expect(await verifyWidgetDocumentReceipt(9,-1,{ sessionId:1,messageId:1,documentId:document!.id })).toBe(true);
    for (const override of [{ sessionToken: '' }, { sessionToken: 'session-two' }, { sessionId: 2, sessionToken: 'session-two' },
      { userId:10,teamId:2,sessionId:3,sessionToken:'session-other-tenant' }, { teamId:2 }, { messageId:99 }, { documentId:99 }]) {
      const target = { ...input, ...override };
      expect(await inProfile(target.userId,target.userId===9 ? 7 : 8,()=>downloadWidgetDocument(target))).toBeNull();
    }
    expect(await inProfile(10,8,()=>verifyWidgetDocumentReceipt(10,-1,{ sessionId:1,messageId:1,documentId:document!.id }))).toBe(false);
    expect(await verifyWidgetDocumentReceipt(9,-2,{ sessionId:2,messageId:1,documentId:document!.id })).toBe(false);
    const publicMessage = publicWidgetMessage({ sources: [{ excerpt: 'Internal revenue target' }], metadata: { documents: [document] } });
    expect(publicMessage.metadata.documents).toEqual([{ id:document!.id,title:document!.title }]);
    expect(publicMessage.sources).toEqual([]);
    expect(publicWidgetMessage({ sources: [{ excerpt: 'Legacy internal source' }], metadata: null }).sources).toEqual([]);
    await fixture.query("UPDATE support_chat_messages SET role='user'");
    expect(await downloadWidgetDocument(input)).toBeNull();
  }));
  it('rejects expired sessions, inactive teams, modified bytes, deleted files and withdrawn approvals', async () => inBusiness(async () => {
    const document = await approvedSupportDocuments.approve(approval());
    await fixture.query(`INSERT INTO support_chat_messages(id,session_id,role,metadata) VALUES(1,1,'assistant',$1)`, [JSON.stringify({ documents: [document] })]);
    const input = { userId:9,teamId:1,sessionId:1,sessionToken:'session-one',messageId:1,documentId:document!.id };
    downloadBuffer = Buffer.from('%PDF-1.7\nUnapproved replacement\n%%EOF');
    expect(await loadApprovedWidgetDocument(document!)).toBeNull();
    expect(await downloadWidgetDocument(input)).toBeNull();
    downloadBuffer = buffer;
    await fixture.query('UPDATE support_teams SET is_active=false WHERE id=1');
    expect(await downloadWidgetDocument(input)).toBeNull();
    await fixture.query('UPDATE support_teams SET is_active=true WHERE id=1');
    await fixture.query("UPDATE support_chat_sessions SET session_expires_at=NOW()-INTERVAL '1 second' WHERE id=1");
    expect(await downloadWidgetDocument(input)).toBeNull();
    await fixture.query("UPDATE support_chat_sessions SET session_expires_at=NOW()+INTERVAL '1 hour' WHERE id=1");
    await fixture.query('UPDATE storage_files SET is_deleted=true WHERE id=250');
    expect(await downloadWidgetDocument(input)).toBeNull();
    await fixture.query('UPDATE storage_files SET is_deleted=false WHERE id=250');
    await fixture.query("UPDATE support_approved_documents SET status='withdrawn',withdrawn_at=NOW()");
    expect(await downloadWidgetDocument(input)).toBeNull();
  }));

  it('keeps drafts private, publishes exact files, records history and permits explicit reapproval', async () => inBusiness(async () => {
    const saved = await supportDocumentLibrary.save(9, draft());
    expect(saved.status).toBe('draft');
    expect(await approvedSupportDocuments.find(9,null,'day_outing')).toBeNull();
    expect(await inProfile(10,8,()=>supportDocumentLibrary.list(10))).toEqual([]);
    expect((await withAccountScope(()=>reader.query('SELECT * FROM support_document_library'))).rows).toEqual([]);
    const published = await supportDocumentLibrary.publish(9, saved.id, certification(saved));
    expect(published.status).toBe('published');
    expect(published.revision).toBe(2);
    expect((await approvedSupportDocuments.candidates(9,null,'day_outing',saved.id))[0]?.description).toBe(draft().description);
    const withdrawn = await supportDocumentLibrary.withdraw(9,saved.id,{ revision: published.revision, reason: 'Outdated terms' });
    expect(await approvedSupportDocuments.candidates(9,null,'day_outing',saved.id)).toEqual([]);
    const republished = await supportDocumentLibrary.publish(9,saved.id,certification(withdrawn));
    expect(republished.status).toBe('published');
    expect((await fixture.query('SELECT action FROM support_admin_audit_logs ORDER BY id')).rows.map(row => row.action))
      .toEqual(['document.draft_saved','document.published','document.withdrawn','document.published']);
  }));
  it('withdraws old approval atomically when replacing or editing a published document', async () => inBusiness(async () => {
    const saved = await supportDocumentLibrary.save(9, draft());
    const published = await supportDocumentLibrary.publish(9,saved.id,certification(saved));
    const edited = await supportDocumentLibrary.save(9,{ ...draft(), storageFileId: 252 },{ id: saved.id, revision: published.revision });
    expect(edited.status).toBe('draft'); expect(edited.approvalId).toBeNull();
    expect(await approvedSupportDocuments.find(9,null,'day_outing')).toBeNull();
    expect((await fixture.query('SELECT status FROM support_approved_documents')).rows[0].status).toBe('withdrawn');
    expect((await fixture.query('SELECT is_deleted FROM storage_files WHERE id=250')).rows[0].is_deleted).toBe(false);
    await expect(supportDocumentLibrary.publish(9,saved.id,certification(published))).rejects.toThrow('changed');
  }));
  it('rejects foreign files, profiles, library IDs and stale review details', async () => inBusiness(async () => {
    await expect(supportDocumentLibrary.save(9,{ ...draft(), storageFileId: 251 })).rejects.toThrow('not found');
    await expect(supportDocumentLibrary.save(9,{ ...draft(), businessProfileId: 8 })).rejects.toThrow('not found');
    const saved = await supportDocumentLibrary.save(9,draft());
    await expect(inProfile(10,8,()=>supportDocumentLibrary.publish(10,saved.id,certification(saved)))).rejects.toThrow('not found');
    await expect(inProfile(10,8,()=>supportDocumentLibrary.download(10,saved.id))).rejects.toThrow('not found');
    await expect(inProfile(10,8,()=>supportDocumentLibrary.withdraw(10,saved.id,{ revision: 1,reason: 'Foreign' }))).rejects.toThrow('not found');
    await expect(supportDocumentLibrary.publish(9,saved.id,{ ...certification(saved), checksum: '0'.repeat(64) })).rejects.toThrow('changed');
    await expect(supportDocumentLibrary.publish(9,saved.id,{ ...certification(saved), certified: false })).rejects.toThrow('Confirm');
    await expect(supportDocumentLibrary.publish(9,saved.id,{ ...certification(saved), expiresAt: '2020-01-01' })).rejects.toThrow('future');
    expect((await supportDocumentLibrary.download(9,saved.id)).buffer).toEqual(buffer);
  }));
  it('selects a pinned approved document without substituting another topic or business scope', async () => inBusiness(async () => {
    const saved = await supportDocumentLibrary.save(9,{ ...draft(), businessProfileId: 7 });
    await supportDocumentLibrary.publish(9,saved.id,certification(saved));
    await approvedSupportDocuments.approve({ ...approval(), storageFileId: 252 });
    expect(await approvedSupportDocuments.find(9,7,'day_outing')).toBeNull();
    const [candidate] = await approvedSupportDocuments.candidates(9,7,'day_outing',saved.id);
    expect(candidate.document.storageFileId).toBe(250);
    expect(await approvedSupportDocuments.revalidate(candidate.document)).toBe(true);
    expect(await inProfile(9,17,()=>approvedSupportDocuments.candidates(9,17,'day_outing',saved.id))).toEqual([]);
    expect(await approvedSupportDocuments.candidates(9,7,'corporate',saved.id)).toEqual([]);
    expect(await inProfile(10,8,()=>approvedSupportDocuments.candidates(10,7,'day_outing',saved.id))).toEqual([]);
  }));
  it('rolls back withdrawal if an edit collides with another library file', async () => inBusiness(async () => {
    const saved = await supportDocumentLibrary.save(9,draft());
    const published = await supportDocumentLibrary.publish(9,saved.id,certification(saved));
    await supportDocumentLibrary.save(9,{ ...draft(), storageFileId: 252 });
    await expect(supportDocumentLibrary.save(9,{ ...draft(), storageFileId: 252 },{ id: saved.id, revision: published.revision })).rejects.toThrow();
    expect((await approvedSupportDocuments.find(9,null,'day_outing'))?.storageFileId).toBe(250);
    expect((await supportDocumentLibrary.list(9)).find(item => item.id === saved.id)?.revision).toBe(published.revision);
  }));
  it('allows one concurrent approval and reflects withdrawal through the registry', async () => inBusiness(async () => {
    const saved = await supportDocumentLibrary.save(9,draft());
    const attempts = await Promise.allSettled([
      supportDocumentLibrary.publish(9,saved.id,certification(saved)),
      supportDocumentLibrary.publish(9,saved.id,certification(saved)),
    ]);
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const published = (await supportDocumentLibrary.list(9))[0];
    await approvedSupportDocuments.withdraw(9,published.approvalId!,'Withdrawn by owner command');
    expect((await supportDocumentLibrary.list(9))[0].status).toBe('withdrawn');
  }));

  it('records explicit approval and serves only the approved topic/tenant', async () => inBusiness(async () => {
    const approved = await approvedSupportDocuments.approve(approval());
    expect(approved?.storageFileId).toBe(250);
    expect(await approvedSupportDocuments.find(9,null,'day_outing')).toEqual(approved);
    expect(await approvedSupportDocuments.find(9,null,'corporate')).toBeNull();
    expect(await inProfile(10,8,()=>approvedSupportDocuments.find(10,null,'day_outing'))).toBeNull();
    expect(await approvedSupportDocuments.revalidate(approved!)).toBe(true);
  }));
  it('does not select a foreign file even if a downloader erroneously labels it owned', async () => inBusiness(async () => {
    expect(await approvedSupportDocuments.approve({ ...approval(), storageFileId: 251 })).toBeNull();
    expect(await approvedSupportDocuments.find(9,null,'day_outing')).toBeNull();
  }));
  it('enforces business-profile ownership and scope', async () => inBusiness(async () => {
    await expect(approvedSupportDocuments.approve({ ...approval(), businessProfileId: 8 })).rejects.toThrow('not owned');
    await approvedSupportDocuments.approve({ ...approval(), businessProfileId: 7 });
    expect((await approvedSupportDocuments.find(9,null,'day_outing'))?.businessProfileId).toBe(7);
    expect(await inProfile(9,17,()=>approvedSupportDocuments.find(9,null,'day_outing'))).toBeNull();
    expect(await approvedSupportDocuments.find(9,8,'day_outing')).toBeNull();
    expect((await approvedSupportDocuments.find(9,7,'day_outing'))?.storageFileId).toBe(250);
  }));
  it.each(['withdrawn','expired','file_deleted'])('blocks %s approvals', async state => inBusiness(async () => {
    const approved = await approvedSupportDocuments.approve(approval());
    if (state === 'withdrawn') await fixture.query("UPDATE support_approved_documents SET status='withdrawn',withdrawn_at=NOW()");
    if (state === 'expired') await fixture.query("UPDATE support_approved_documents SET expires_at=NOW()-INTERVAL '1 minute'");
    if (state === 'file_deleted') await fixture.query('UPDATE storage_files SET is_deleted=true WHERE id=250');
    expect(await approvedSupportDocuments.find(9,null,'day_outing')).toBeNull();
    expect(await approvedSupportDocuments.revalidate(approved!)).toBe(false);
  }));
  it('does not silently republish withdrawn files on a repeated approval command', async () => inBusiness(async () => {
    await approvedSupportDocuments.approve(approval());
    await fixture.query("UPDATE support_approved_documents SET status='withdrawn'");
    expect(await approvedSupportDocuments.approve(approval())).toBeNull();
    expect(await approvedSupportDocuments.find(9,null,'day_outing')).toBeNull();
  }));
  it('allows only the owning tenant to withdraw a published binary and preserves its approval record', async () => inBusiness(async () => {
    const approved = await approvedSupportDocuments.approve(approval());
    expect(await inProfile(10,8,()=>approvedSupportDocuments.withdraw(10,approved!.id,'Foreign request'))).toBe(false);
    expect(await approvedSupportDocuments.withdraw(9,approved!.id,'Owner replaced the brochure')).toBe(true);
    expect(await approvedSupportDocuments.revalidate(approved!)).toBe(false);
    expect((await fixture.query('SELECT checksum,approval_reason,withdrawal_reason FROM support_approved_documents')).rows[0])
      .toEqual({ checksum, approval_reason: approval().approvalReason, withdrawal_reason: 'Owner replaced the brochure' });
  }));
  it('rejects ambiguous approved documents for the same topic', async () => inBusiness(async () => {
    await approvedSupportDocuments.approve(approval());
    await approvedSupportDocuments.approve({ ...approval(), storageFileId: 252 });
    expect(await approvedSupportDocuments.find(9,null,'day_outing')).toBeNull();
  }));
  it('enforces RLS when a caller omits its tenant filter/context', async () => inBusiness(async () => {
    await approvedSupportDocuments.approve(approval());
    expect((await withAccountScope(()=>reader.query('SELECT * FROM support_approved_documents'))).rows).toEqual([]);
    const client = await reader.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user_id','10',true)");
      expect((await client.query('SELECT * FROM support_approved_documents')).rows).toEqual([]);
      await expect(client.query(`INSERT INTO support_approved_documents(user_id,storage_file_id,title,service,checksum,approval_reason,approved_by)
        VALUES(9,250,'Foreign','resort',$1,'Invalid tenant',9)`, [checksum])).rejects.toThrow('row-level security');
    } finally { await client.query('ROLLBACK'); client.release(); }
  }));

  async function deliveryInput() {
    return { document: (await approvedSupportDocuments.approve(approval()))!, userId: 9, conversationId: 615,
      recipient: 'synthetic-recipient', inboundProviderMessageId: 'synthetic-inbound', caption: 'The requested approved document.' };
  }
  it('blocks document delivery when its published receiving assignment is disabled', async () => inBusiness(async () => {
    const input = await deliveryInput();
    await fixture.query('UPDATE outreach_assistant_bindings SET enabled=false');
    await expect(supportDocumentDelivery.deliver(input)).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED' });
    expect(upload).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  }));
  it('commits a document message and a durable receipt once under a repeated inbound event', async () => inBusiness(async () => {
    const input = await deliveryInput();
    const first = await supportDocumentDelivery.deliver(input);
    if (first.status !== 'sent') throw new Error(JSON.stringify((await fixture.query('SELECT status,last_error FROM support_delivery_outbox')).rows));
    expect(first.status).toBe('sent');
    expect((await supportDocumentDelivery.deliver(input)).status).toBe('sent');
    expect(upload).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    expect((await fixture.query('SELECT message_type,status,provider_message_id FROM outreach_messages')).rows)
      .toEqual([{ message_type: 'document', status: 'sent', provider_message_id: 'synthetic-wamid' }]);
    expect((await fixture.query('SELECT status,attempt_count FROM support_delivery_outbox')).rows)
      .toEqual([{ status: 'sent', attempt_count: 1 }]);
    expect((await fixture.query('SELECT total_messages FROM outreach_conversations WHERE id=615')).rows[0].total_messages).toBe(1);
  }));
  it.each(['approval_pending','human_owned','opted_out'])('does not upload or commit a PDF in %s conversation mode', async mode => inBusiness(async () => {
    const input = await deliveryInput(); await fixture.query('UPDATE outreach_conversations SET automation_mode=$1',[mode]);
    expect((await supportDocumentDelivery.deliver(input)).status).toBe('unavailable');
    expect(upload).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect((await fixture.query('SELECT * FROM outreach_messages')).rows).toEqual([]);
  }));
  it('blocks an active handoff despite a stale ai_active conversation flag', async () => inBusiness(async () => {
    const input = await deliveryInput(); await fixture.query("INSERT INTO handoff_queue(user_id,conversation_id,status) VALUES(9,615,'assigned')");
    expect((await supportDocumentDelivery.deliver(input)).status).toBe('unavailable'); expect(upload).not.toHaveBeenCalled();
  }));
  it('records uncertainty without a sent message or automatic retry schedule', async () => inBusiness(async () => {
    const input = await deliveryInput(); send.mockRejectedValue(new Error('Provider timeout'));
    expect((await supportDocumentDelivery.deliver(input)).status).toBe('uncertain');
    expect((await supportDocumentDelivery.deliver(input)).status).toBe('uncertain');
    expect(send).toHaveBeenCalledTimes(1);
    expect((await fixture.query('SELECT * FROM outreach_messages')).rows).toEqual([]);
    expect((await fixture.query('SELECT status,next_attempt_at FROM support_delivery_outbox')).rows)
      .toEqual([{ status: 'uncertain', next_attempt_at: null }]);
  }));

  it('blocks another owned business, foreign tenant and absent scope at the database and service boundaries', async () => inBusiness(async () => {
    const saved = await supportDocumentLibrary.save(9,draft());
    const published = await supportDocumentLibrary.publish(9,saved.id,certification(saved));
    const role = await reader.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(role.rows).toEqual([{ role: 'salesmarketing_business_runtime', rolsuper: false, rolbypassrls: false }]);
    for (const scope of [{ userId: 9, businessProfileId: 17 }, { userId: 10, businessProfileId: 8 }]) {
      await withBusinessScope(scope, async () => {
        expect((await reader.query('SELECT * FROM support_document_library')).rows).toEqual([]);
        expect((await reader.query('SELECT * FROM support_approved_documents')).rows).toEqual([]);
        expect((await reader.query("UPDATE support_document_library SET title='Unauthorized' WHERE id=$1",[saved.id])).rowCount).toBe(0);
        expect(await supportDocumentLibrary.list(scope.userId)).toEqual([]);
        await expect(supportDocumentLibrary.download(scope.userId,saved.id)).rejects.toThrow('not found');
        await expect(reader.query(`INSERT INTO support_document_library
          (user_id,business_profile_id,storage_file_id,title,description,service,checksum)
          VALUES(9,7,252,'Unauthorized','','day_outing',$1)`,[checksum])).rejects.toThrow('row-level security');
      });
    }
    expect((await withAccountScope(()=>reader.query('SELECT * FROM support_document_library'))).rows).toEqual([]);
    await expect(supportDocumentLibrary.save(9,{ ...draft(), storageFileId: 253 })).rejects.toThrow('not found');
    await expect(inProfile(9,17,()=>supportDocumentLibrary.save(9,draft()))).rejects.toThrow('not found');
    expect((await supportDocumentLibrary.list(9)).find(document=>document.id===saved.id)?.revision).toBe(published.revision);
    expect(upload).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  }));
});
