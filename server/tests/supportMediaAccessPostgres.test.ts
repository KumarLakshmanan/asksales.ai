import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { Request, Response } from 'express';
import type { MediaQuery, SupportMediaDecision } from '../services/supportMedia/types.js';
import { withBusinessScope, withAccountScope } from '../tenancy/businessContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

const inProfile = <T>(profile: number, work: () => T) => withBusinessScope({ userId: 9, businessProfileId: profile }, work);
const inBusiness = <T>(work: () => T) => inProfile(42, work);

const localPostgres = process.env.SUPPORT_MEDIA_LOCAL_QA === '1' ? describe : describe.skip;
jest.unstable_mockModule('../services/supportMedia/MediaRelevanceSelector.js', () => ({
  selectRelevantMediaCandidates: async ({ rows }: { rows: unknown[] }) => rows,
}));
jest.setTimeout(30000);
let fixtureDb: ReturnType<typeof drizzle>;
const proxy = new Proxy({} as typeof fixtureDb, { get: (_target, key) => {
  const value = Reflect.get(fixtureDb, key);
  return typeof value === 'function' ? value.bind(fixtureDb) : value;
} });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
const download = jest.fn(async (_fileId: number, _userId: number) => ({ buffer: Buffer.from('isolated fixture image bytes') }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: { downloadFile: download } }));
jest.unstable_mockModule('../services/supportMedia/SupportMediaGalleryService.js', () => ({ supportMediaGalleryService: {} }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: {} }));
const privacyVault = await import('../services/agents/orchestration/PrivacyVaultService.js');
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  ...privacyVault,
  encryptRestrictedPayload: (...args: [number, string, unknown]) => args[2],
  decryptRestrictedPayload: (...args: [number, string, unknown]) => args[2],
  privacyVaultService: {}, redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
const disabledEmbedding = jest.fn(async () => { throw new Error('External embeddings disabled in isolated QA'); });
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: { generateEmbedding: disabledEmbedding } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
const mediaTables = await import('../models/supportMedia/schema.js');
const knowledgeTables = await import('../models/knowledge/schema.js');
const { supportTeamsTable } = await import('../models/supportTeams/schema.js');
const { teamMembersTable } = await import('../models/teamMembers/schema.js');
const { supportChatSessionsTable } = await import('../models/supportChatSessions/schema.js');
const { supportChatMessagesTable } = await import('../models/supportChatMessages/schema.js');
const { supportTicketsTable } = await import('../models/supportTickets/schema.js');
const { companySettings } = await import('../models/companySettings/schema.js');
const { outreachConversationsTable } = await import('../models/outreachConversations/schema.js');
const { listMemberMediaGalleries, getMemberMediaGallery, downloadMemberMediaAsset } = await import('../controllers/supportMemberResourcesController.js');
const { getWidgetSessionMedia } = await import('../controllers/supportWidgetController.js');
const { downloadSupportMediaAsset } = await import('../controllers/supportMediaGalleryController.js');
const { mediaGateway } = await import('../services/supportMedia/MediaGateway.js');

function response() {
  const headers: Record<string, string> = {};
  const res = { status: jest.fn(), json: jest.fn(), send: jest.fn(), setHeader: (key: string, value: string) => { headers[key] = value; } };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res); res.send.mockReturnValue(res);
  return { res: res as unknown as Response, headers };
}
const request = (overrides: Record<string, unknown> = {}) => ({ supportMember: { id: 8, userId: 9, teamId: 3 },
  params: { id: '2', assetId: '30', sessionId: '40' }, query: { token: 'a'.repeat(64), sessionToken: 'fixture-session-token' },
  ...overrides } as unknown as Request);

localPostgres('media current access (isolated local PostgreSQL schema)', () => {
  let pool: Pool;
  let admin: Pool;
  let runtime: Pool;
  let schema: string;
  const originalFlag = process.env.SUPPORT_MEDIA_V1_ENABLED;
  const query: MediaQuery = { tenantId: 9, businessProfileId: 42, purpose: 'support_answer',
    audience: 'customer', channel: 'web', mediaIntent: 'explicit', redactedText: 'Opal Room', limit: 5 };
  const decision: SupportMediaDecision = { intent: 'explicit', reason: 'Fixture', selections: [{ evidenceId: 'MEDIA-2-V1-A30', order: 0 }] };

  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true });
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Media QA requires local PostgreSQL');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_media_access_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog -c app.business_profile_id=42` });
    await localBusinessFunctions(pool);
    runtime = createBusinessScopedPool(new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog` }));
    fixtureDb = drizzle(runtime);
    // Schema-derived names/types without external foreign keys or defaults;
    // absent tables cannot resolve to the application's public schema.
    for (const table of [mediaTables.supportMediaGalleriesTable, mediaTables.supportMediaGalleryVersionsTable,
      mediaTables.supportMediaAssetsTable, mediaTables.supportMediaDeliveryPartsTable, mediaTables.supportMediaRetrievalAuditsTable,
      knowledgeTables.knowledgeIndexVersionsTable, knowledgeTables.knowledgeRuntimeSettingsTable,
      supportTeamsTable, teamMembersTable, supportChatSessionsTable, supportChatMessagesTable, supportTicketsTable, companySettings, outreachConversationsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`);
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query("ALTER TABLE support_media_assets ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple',search_text)) STORED");
    await localBusinessIsolation(pool, schema, ['support_media_galleries', 'support_media_gallery_versions', 'support_media_assets',
      'support_media_delivery_parts', 'support_media_retrieval_audits', 'knowledge_index_versions', 'knowledge_runtime_settings',
      'support_teams', 'team_members', 'support_chat_sessions', 'support_chat_messages', 'support_tickets', 'outreach_conversations']);
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.SUPPORT_MEDIA_V1_ENABLED;
    else process.env.SUPPORT_MEDIA_V1_ENABLED = originalFlag;
    await runtime?.end(); await pool?.end();
    if (admin && /^support_media_access_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    delete process.env.SUPPORT_MEDIA_V1_ENABLED;
    jest.clearAllMocks();
    await pool.query('TRUNCATE support_media_galleries,support_media_gallery_versions,support_media_assets,support_media_delivery_parts,support_media_retrieval_audits,knowledge_runtime_settings,knowledge_index_versions,support_teams,team_members,support_chat_sessions,support_chat_messages,support_tickets,company_settings,outreach_conversations RESTART IDENTITY');
    await pool.query(`INSERT INTO support_media_galleries(id,user_id,title,audience,usage_scopes,allowed_channels,
        entity_tags,helpful_auto_attach,current_published_version_id,status,updated_at)
      VALUES(2,9,'Opal Room','customer',ARRAY['support_answer'],ARRAY[]::text[],ARRAY['opal room'],true,20,'active',NOW());
      INSERT INTO support_media_gallery_versions(id,gallery_id,user_id,version_no,status) VALUES(20,2,9,1,'published'),(21,2,9,2,'draft');
      INSERT INTO support_media_assets(id,user_id,gallery_id,gallery_version_id,evidence_id,name,owner_description,
        alt_text,sort_order,width,height,mime_type,checksum,sensitivity,owner_tags,search_text,publication_state,derivative_storage_file_id)
      VALUES(30,9,2,20,'MEDIA-2-V1-A30','Opal Room','Owner room description','Opal Room image',0,10,10,'image/jpeg','checksum',
        'business',ARRAY['opal room'],'Opal Room owner image','published',99),
        (31,9,2,21,'MEDIA-2-V2-A31','Draft room','Draft description','Draft image',0,10,10,'image/jpeg','draft-checksum',
        'business',ARRAY[]::text[],'Draft image','ready_for_review',100)`);
    await pool.query('INSERT INTO support_teams(id,user_id,business_profile_id,name,is_active,widget_token) VALUES(3,9,42,$1,true,$2),(4,10,52,$3,true,$4)',
      ['Support', 'a'.repeat(64), 'Foreign support', 'b'.repeat(64)]);
    await pool.query(`INSERT INTO team_members(id,user_id,business_profile_id,team_id,is_active) VALUES(8,9,42,3,true),(18,10,52,4,true);
      INSERT INTO support_chat_sessions(id,member_id,public_token,session_expires_at) VALUES(40,8,'fixture-session-token',NOW()+INTERVAL '1 day');
      INSERT INTO support_chat_messages(id,session_id,role,metadata,processing_status) VALUES(50,40,'assistant','{"media":[{"assetId":30}]}','completed');
      INSERT INTO company_settings(id,user_id,name,is_default,updated_at) VALUES(42,9,'Current profile',true,NOW()),
        (43,9,'Other owned business',false,NOW()),(52,10,'Foreign business',true,NOW())`);
  });

  it('serves a valid member gallery/asset and attached widget asset with private no-store responses', async () => inBusiness(async () => {
    const listing = response(); await listMemberMediaGalleries(request(), listing.res);
    expect(listing.res.json).toHaveBeenCalledWith(expect.objectContaining({ galleries: [expect.objectContaining({ id: '2', asset_count: 1 })],
      resolvedScope: expect.objectContaining({ businessProfileId: 42, source: 'workspace' }) }));
    const gallery = response(); await getMemberMediaGallery(request(), gallery.res);
    expect(gallery.res.json).toHaveBeenCalledWith(expect.objectContaining({ assets: [expect.objectContaining({ id: 30 })] }));
    for (const route of [downloadMemberMediaAsset, getWidgetSessionMedia]) {
      const output = response(); await route(request(), output.res);
      expect(output.res.send).toHaveBeenCalledWith(Buffer.from('isolated fixture image bytes'));
      expect(output.headers['Cache-Control']).toBe('private, no-store');
    }
    expect(download).toHaveBeenCalledWith(99, 9);
    expect((await mediaGateway.retrieve(query)).status).toBe('selected');
    expect(await mediaGateway.verify(9, 'web', decision, query)).toHaveLength(1);
    expect(disabledEmbedding).not.toHaveBeenCalled();
  }));

  it('preserves owner preview of draft images while excluding members and customers', async () => inBusiness(async () => {
    const owner = response();
    await downloadSupportMediaAsset(request({ user: { id: 9 }, params: { assetId: '31' } }), owner.res);
    expect(owner.res.send).toHaveBeenCalled();
    const member = response(); await downloadMemberMediaAsset(request({ params: { assetId: '31' } }), member.res);
    expect(member.res.status).toHaveBeenCalledWith(404);
    const widget = response(); await getWidgetSessionMedia(request({ params: { assetId: '31', sessionId: '40' } }), widget.res);
    expect(widget.res.status).toHaveBeenCalledWith(404);
  }));

  it('does not reuse previously selected media after retirement', async () => inBusiness(async () => {
    const result = await mediaGateway.retrieve(query);
    expect(result.status).toBe('selected');
    await pool.query("UPDATE support_media_galleries SET status='retired' WHERE id=2");
    expect(await mediaGateway.verify(9, 'web', mediaGateway.buildDecision(result), query)).toEqual([]);
    for (const route of [getMemberMediaGallery, downloadMemberMediaAsset, getWidgetSessionMedia]) {
      const output = response(); await route(request(), output.res);
      expect(output.res.status).toHaveBeenCalledWith(404);
    }
    expect(download).not.toHaveBeenCalled();
  }));

  it('uses selected-profile verification, rejects missing/foreign scope and never trusts widget query scope', async () => inBusiness(async () => {
    await pool.query('UPDATE support_media_galleries SET business_profile_id=42');
    // Retrieval also persists a scoped audit; supply its required business unit explicitly.
    expect((await mediaGateway.retrieve(query)).status).toBe('selected');
    expect(await mediaGateway.verify(9, 'web', decision, { ...query, businessProfileId: null })).toHaveLength(1);
    expect((await withAccountScope(()=>mediaGateway.retrieve({ ...query, businessProfileId: null }))).evidence).toEqual([]);
    expect(await withAccountScope(()=>mediaGateway.verify(9,'web',decision,{ ...query, businessProfileId: null }))).toEqual([]);
    expect((await mediaGateway.retrieve({ ...query, businessProfileId: 43 })).evidence).toEqual([]);
    expect((await mediaGateway.retrieve({ ...query, businessProfileId: 42 })).status).toBe('selected');
    expect(await mediaGateway.verify(9, 'web', decision, { ...query, businessProfileId: 42 })).toHaveLength(1);
    const member = response(); await inProfile(43,()=>downloadMemberMediaAsset(request(), member.res));
    expect(member.res.status).toHaveBeenCalledWith(404);
    const widget = response(); await getWidgetSessionMedia(request(), widget.res);
    expect(widget.res.send).toHaveBeenCalled();
    await pool.query('UPDATE support_media_galleries SET business_profile_id=43');
    const foreign = response(); await getWidgetSessionMedia(request({ query: { token: 'a'.repeat(64), sessionToken: 'fixture-session-token', businessProfileId: '43' } }), foreign.res);
    expect(foreign.res.status).toHaveBeenCalledWith(404);
  }));

  it('uses customer/web context for widget bytes and internal/support_portal context for the member library', async () => inBusiness(async () => {
    await pool.query("UPDATE support_media_galleries SET audience='internal',usage_scopes=ARRAY['internal_assist'],allowed_channels=ARRAY['support_portal']");
    const member = response(); await downloadMemberMediaAsset(request(), member.res);
    expect(member.res.send).toHaveBeenCalled();
    const widget = response(); await getWidgetSessionMedia(request(), widget.res);
    expect(widget.res.status).toHaveBeenCalledWith(404);
    expect(await mediaGateway.verify(9, 'web', decision, query)).toEqual([]);
    expect(await mediaGateway.verify(9, 'support_portal', decision, { audience: 'internal', purpose: 'internal_assist' })).toHaveLength(1);
  }));

  it.each([
    "UPDATE support_media_gallery_versions SET effective_at=NOW()+INTERVAL '1 day' WHERE id=20",
    "UPDATE support_media_gallery_versions SET expires_at=NOW()-INTERVAL '1 day' WHERE id=20",
    "UPDATE support_media_gallery_versions SET status='draft' WHERE id=20",
    "UPDATE support_media_gallery_versions SET user_id=10 WHERE id=20",
    "UPDATE support_media_gallery_versions SET gallery_id=99 WHERE id=20",
    "UPDATE support_media_galleries SET current_published_version_id=21",
    "UPDATE support_media_galleries SET user_id=10",
    "UPDATE support_media_galleries SET audience='restricted'",
    "UPDATE support_media_galleries SET usage_scopes=ARRAY['content_draft']",
  ])('blocks gallery access consistently after %s', async mutation => inBusiness(async () => {
    await pool.query(mutation);
    const listing = response(); await listMemberMediaGalleries(request(), listing.res);
    expect(listing.res.json).toHaveBeenCalledWith(expect.objectContaining({ galleries: [] }));
    for (const route of [getMemberMediaGallery, downloadMemberMediaAsset, getWidgetSessionMedia]) {
      const output = response(); await route(request(), output.res);
      expect(output.res.status).toHaveBeenCalledWith(404);
    }
    expect((await mediaGateway.retrieve(query)).evidence).toEqual([]);
    expect(await mediaGateway.verify(9, 'web', decision, query)).toEqual([]);
    expect(download).not.toHaveBeenCalled();
  }));

  it.each([
    "UPDATE support_media_assets SET retired_at=NOW() WHERE id=30",
    "UPDATE support_media_assets SET publication_state='quarantined' WHERE id=30",
    "UPDATE support_media_assets SET sensitivity='personal' WHERE id=30",
    "UPDATE support_media_assets SET user_id=10 WHERE id=30",
    "UPDATE support_media_assets SET gallery_id=99 WHERE id=30",
    "UPDATE support_media_assets SET gallery_version_id=21 WHERE id=30",
  ])('excludes individual unsafe assets from galleries and byte access after %s', async mutation => inBusiness(async () => {
    await pool.query(mutation);
    const gallery = response(); await getMemberMediaGallery(request(), gallery.res);
    expect(gallery.res.json).toHaveBeenCalledWith(expect.objectContaining({ assets: [] }));
    for (const route of [downloadMemberMediaAsset, getWidgetSessionMedia]) {
      const output = response(); await route(request(), output.res);
      expect(output.res.status).toHaveBeenCalledWith(404);
    }
    expect((await mediaGateway.retrieve(query)).evidence).toEqual([]);
    expect(await mediaGateway.verify(9, 'web', decision, query)).toEqual([]);
    expect(download).not.toHaveBeenCalled();
  }));

  it('allows authenticated internal media browsing while enforcing delivery-channel restrictions for customers', async () => inBusiness(async () => {
    await pool.query("UPDATE support_media_galleries SET allowed_channels=ARRAY['email']");
    const listing = response(); await listMemberMediaGalleries(request(), listing.res);
    expect(listing.res.json).toHaveBeenCalledWith(expect.objectContaining({ galleries: [expect.objectContaining({ id: '2' })] }));
    const member = response(); await downloadMemberMediaAsset(request(), member.res);
    expect(member.res.send).toHaveBeenCalled();
    const widget = response(); await getWidgetSessionMedia(request(), widget.res);
    expect(widget.res.status).toHaveBeenCalledWith(404);
    expect(await mediaGateway.verify(9, 'web', decision, query)).toEqual([]);
  }));

  it('resolves media from the selected workspace or a currently authorized ticket', async () => inBusiness(async () => {
    await pool.query(`UPDATE support_media_galleries SET business_profile_id=42;
      INSERT INTO outreach_conversations(id,user_id,channel,metadata) VALUES(70,9,'instagram','{"businessProfileId":42}');
      INSERT INTO support_tickets(id,user_id,team_id,assigned_member_id,outreach_conversation_id,business_profile_id) VALUES(60,9,3,8,70,42)`);
    const workspace = response(); await listMemberMediaGalleries(request(), workspace.res);
    expect(workspace.res.json).toHaveBeenCalledWith(expect.objectContaining({ galleries: [expect.objectContaining({ id: '2' })],
      resolvedScope: expect.objectContaining({ businessProfileId: 42, source: 'workspace' }) }));
    const scoped = response(); await listMemberMediaGalleries(request({ query: { ticketId: '60' } }), scoped.res);
    expect(scoped.res.json).toHaveBeenCalledWith(expect.objectContaining({ galleries: [expect.objectContaining({ id: '2' })],
      resolvedScope: expect.objectContaining({ ticketId: 60, businessProfileId: 42, source: 'ticket' }) }));
    const bytes = response(); await downloadMemberMediaAsset(request({ query: { ticketId: '60' } }), bytes.res);
    expect(bytes.res.send).toHaveBeenCalled();
    await pool.query('UPDATE support_tickets SET team_id=4,assigned_member_id=18 WHERE id=60');
    const denied = response(); await downloadMemberMediaAsset(request({ query: { ticketId: '60' } }), denied.res);
    expect(denied.res.status).toHaveBeenCalledWith(403);
  }));

  it.each([
    "UPDATE support_chat_messages SET metadata='{}'",
    "UPDATE support_chat_messages SET metadata='{\"media\":{\"assetId\":30}}'",
    "UPDATE support_chat_messages SET metadata='{\"media\":[{\"assetId\":\"not-an-id\"}]}'",
    "UPDATE support_chat_messages SET role='user'",
    "UPDATE support_chat_sessions SET session_expires_at=NOW()-INTERVAL '1 day'",
    "UPDATE support_chat_sessions SET public_token='different-token'",
    "UPDATE support_chat_sessions SET member_id=18",
    "UPDATE team_members SET user_id=10 WHERE id=8",
    "UPDATE team_members SET is_active=false WHERE id=8",
  ])('requires an attached assistant asset and exact current widget session ownership after %s', async mutation => inBusiness(async () => {
    await pool.query(mutation);
    const output = response(); await getWidgetSessionMedia(request(), output.res);
    expect(output.res.status).toHaveBeenCalledWith(404);
    expect(download).not.toHaveBeenCalled();
  }));

  it('requires current member/team ownership on member routes', async () => inBusiness(async () => {
    await pool.query('UPDATE support_teams SET user_id=10 WHERE id=3');
    const listing = response(); await listMemberMediaGalleries(request(), listing.res);
    expect(listing.res.json).toHaveBeenCalledWith(expect.objectContaining({ galleries: [] }));
    const output = response(); await downloadMemberMediaAsset(request(), output.res);
    expect(output.res.status).toHaveBeenCalledWith(404);
    expect(download).not.toHaveBeenCalled();
  }));

  it('enforces business RLS without query filters and blocks another owned business or tenant', async () => inBusiness(async () => {
    const role = await runtime.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(role.rows).toEqual([{ role: 'salesmarketing_business_runtime', rolsuper: false, rolbypassrls: false }]);
    expect((await runtime.query('SELECT id FROM support_media_galleries')).rows).toEqual([{ id: '2' }]);
    for (const scope of [{ userId: 9, businessProfileId: 43 }, { userId: 10, businessProfileId: 52 }]) {
      await withBusinessScope(scope, async () => {
        expect((await runtime.query('SELECT * FROM support_media_galleries')).rows).toEqual([]);
        expect((await runtime.query("UPDATE support_media_galleries SET title='Unauthorized' WHERE id=2")).rowCount).toBe(0);
        await expect(runtime.query("INSERT INTO support_media_galleries(id,user_id,business_profile_id,title) VALUES(999,9,42,'Unauthorized')"))
          .rejects.toThrow('row-level security');
      });
    }
    expect((await withAccountScope(()=>runtime.query('SELECT * FROM support_media_galleries'))).rows).toEqual([]);
    expect((await pool.query('SELECT title FROM support_media_galleries WHERE id=2')).rows).toEqual([{ title: 'Opal Room' }]);
    expect(download).not.toHaveBeenCalled(); expect(disabledEmbedding).not.toHaveBeenCalled();
  }));
});
