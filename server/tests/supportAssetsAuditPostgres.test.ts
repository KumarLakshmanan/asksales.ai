import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import request from 'supertest';

// Explicit opt-in; never reads repository dotenv files or the retained application DB.
const local = process.env.SUPPORT_ASSETS_AUDIT_QA === '1' ? describe : describe.skip;
let fixtureDb: ReturnType<typeof drizzle>;
let objectPool: Pool;
let nextObject = 100;
const proxy = new Proxy({} as typeof fixtureDb, { get: (_target, key) => {
  const value = Reflect.get(fixtureDb, key);
  return typeof value === 'function' ? value.bind(fixtureDb) : value;
} });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
const objects = new Map<number, Buffer>();
let onDownload: (() => Promise<void>) | undefined;
const download = jest.fn<any>(async (id: number, userId: number) => {
  await onDownload?.();
  const buffer = objects.get(id);
  return buffer ? { buffer, file: { userId, businessProfileId: 7, mimeType: id === 250 ? 'application/pdf' : 'image/jpeg' } } : null;
});
const store = jest.fn<any>(async (buffer: Buffer, options: { userId: number; referenceType?: string; referenceId?: string }) => {
  const fileId = ++nextObject; objects.set(fileId, buffer);
  await objectPool.query('INSERT INTO storage_files(id,user_id) VALUES($1,$2)', [fileId, options.userId]);
  return { fileId, fileSizeBytes: buffer.length };
});
const remove = jest.fn<any>(async (id: number) => { objects.delete(id); await objectPool.query('DELETE FROM storage_files WHERE id=$1',[id]); return true; });
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: { downloadFile: download, upload: store, deleteFile: remove } }));
const upload = jest.fn<any>(async () => ({ id: 'synthetic-upload' }));
const send = jest.fn<any>(async () => ({ messages: [{ id: 'synthetic-receipt' }] }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { uploadMedia: upload, sendMedia: send } }));
jest.unstable_mockModule('../services/instagramGraphApiService.js', () => ({ getInstagramApiForUser: async () => null }));
jest.unstable_mockModule('../services/FacebookMessengerService.js', () => ({ getFacebookApiForUser: async () => null }));
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({ automaticSupportReplyAllowed: async () => true }));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({ deliveryOutboxService: { draft: jest.fn<any>() } }));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: { generateEmbedding: jest.fn<any>() } }));
// Lifecycle races use controlled scan outcomes; the real scanner has separate runtime coverage.
const scan = jest.fn<any>();
jest.unstable_mockModule('../services/supportMedia/SupportMediaSafetyService.js', () => ({
  scanSupportMedia: scan,
  validateSupportMediaMetadata: () => ({ safe: true, reasons: [] }),
}));
const { supportMediaDeliveryService } = await import('../services/supportMedia/SupportMediaDeliveryService.js');
const { getSupportMediaDeliveryAsset } = await import('../controllers/supportMediaDeliveryController.js');
const { createSupportMediaDeliveryUrl } = await import('../services/supportMedia/SupportMediaDeliveryUrl.js');
const { mediaGateway } = await import('../services/supportMedia/MediaGateway.js');
const { supportMediaGalleryService } = await import('../services/supportMedia/SupportMediaGalleryService.js');
const { withBusinessScope } = await import('../tenancy/businessContext.js');
// @ts-expect-error Production migrations are JavaScript.
const { up: mediaUp } = await import('../migrations/215_create_support_media_gallery.js');
// @ts-expect-error Production migrations are JavaScript.
const { up: reviewUp } = await import('../migrations/281_support_media_review_workflows.js');

local('support assets audit: real PostgreSQL and HTTP, fixture objects and providers', () => {
  let admin: Pool; let fixture: Pool; let schema: string;
  const checksum = 'a'.repeat(64);
  const input = () => ({ userId: 9, conversationId: 60, channel: 'whatsapp' as const, recipient: 'synthetic-recipient',
    inboundProviderMessageId: 'synthetic-inbound', media: [{ evidenceId: 'media-fixture-30', assetId: 30, galleryId: 2,
      galleryVersionId: 20, name: 'Opal room', altText: 'Synthetic room', checksum, derivativeStorageFileId: 100,
      mimeType: 'image/jpeg', intent: 'explicit' as const }] });
  const scoped = <T>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 7 }, work);
  const file = { buffer: Buffer.from('synthetic original'), mimetype: 'image/jpeg', originalname: 'fixture.jpg' } as Express.Multer.File;
  const scanResult = (status: string, hash = 'b'.repeat(64)) => ({ status, normalized: file.buffer,
    derivative: Buffer.from('synthetic derivative'), width: 10, height: 10, mimeType: 'image/jpeg', checksum: hash,
    internalTags: [], scanResults: { scannerUnavailable: status === 'ready_for_review' } });
  const draftGallery = () => scoped(() => supportMediaGalleryService.create(9, { title: 'Synthetic gallery',
    businessProfileId: 7, rightsCertified: true, certification: { lawfulAuthority: true, customerUsePermitted: true, accuracyConfirmed: true } }));
  const app = express(); app.get('/support-media-delivery/:assetId/image.jpg', getSupportMediaDeliveryAsset);
  const signedPath = () => { const url = new URL(createSupportMediaDeliveryUrl({ assetId: 30, checksum })); return url.pathname + url.search; };
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || '') || process.env.DB_NAME !== 'support_gallery_audit') {
      throw new Error('Use a disposable loopback PostgreSQL database named support_gallery_audit.');
    }
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_assets_audit_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1 });
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    fixture = new Pool({ ...config, max: 6, options: `-c search_path=${schema},public,pg_catalog -c timezone=UTC` });
    fixtureDb = drizzle(fixture);
    objectPool = fixture;
    await fixture.query(`CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,archived_at timestamptz);
      CREATE TABLE storage_files(id integer PRIMARY KEY,user_id integer);
      CREATE TABLE knowledge_index_versions(id bigint PRIMARY KEY,provider text,model text,dimensions integer,state text);
      CREATE TABLE knowledge_runtime_settings(id integer,active_index_version_id bigint);
      CREATE TABLE outreach_conversations(id integer PRIMARY KEY,user_id integer,business_profile_id integer,channel text,
        external_thread_id text,provider_account_id text,status text,automation_mode text,metadata jsonb);
      CREATE TABLE handoff_queue(user_id integer,conversation_id integer,status text,ai_reply_enabled boolean NOT NULL DEFAULT false);
      INSERT INTO users(id) VALUES(9),(10); INSERT INTO company_settings(id,user_id) VALUES(7,9),(8,10);
      INSERT INTO storage_files VALUES(99,9),(100,9);`);
    await mediaUp(fixture); await reviewUp(fixture);
    // These persisted scope columns are mandatory after migration299.
    await fixture.query(`ALTER TABLE support_media_assets ADD COLUMN business_profile_id integer DEFAULT 7;
      ALTER TABLE support_media_gallery_versions ADD COLUMN business_profile_id integer DEFAULT 7`);
  });
  afterAll(async () => {
    await fixture?.end();
    if (admin && /^support_assets_audit_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    jest.clearAllMocks(); onDownload = undefined;
    scan.mockResolvedValue(scanResult('ready_for_review'));
    upload.mockImplementation(async () => ({ id: 'synthetic-upload' }));
    send.mockResolvedValue({ messages: [{ id: 'synthetic-receipt' }] });
    objects.clear(); objects.set(100, Buffer.from('synthetic derivative object'));
    await fixture.query(`DROP TRIGGER IF EXISTS reject_ack ON support_media_delivery_parts;
      TRUNCATE support_media_review_audits,support_media_delivery_parts,support_media_retrieval_audits,
        support_media_asset_embeddings,support_media_assets,support_media_gallery_versions,support_media_galleries,
        outreach_conversations,handoff_queue RESTART IDENTITY CASCADE;
      INSERT INTO support_media_galleries(id,user_id,business_profile_id,title,audience,usage_scopes,allowed_channels)
        VALUES(2,9,7,'Opal room','customer',ARRAY['support_answer'],ARRAY['whatsapp','instagram']);
      INSERT INTO support_media_gallery_versions(id,gallery_id,user_id,version_no,status,content_checksum,rights_certified)
        VALUES(20,2,9,1,'published','${checksum}',true);
      UPDATE support_media_galleries SET current_published_version_id=20;
      INSERT INTO support_media_assets(id,user_id,gallery_id,gallery_version_id,storage_file_id,derivative_storage_file_id,
        evidence_id,name,alt_text,width,height,mime_type,size_bytes,checksum,search_text,publication_state)
        VALUES(30,9,2,20,99,100,'media-fixture-30','Opal room','Synthetic room',10,10,'image/jpeg',27,'${checksum}','Opal room','published');
      INSERT INTO outreach_conversations VALUES(60,9,7,'whatsapp','synthetic-recipient',NULL,'active','ai_active','{"businessProfileId":7}');`);
  });
  it('serves a valid signed derivative over HTTP and denies malformed, expired and retired links', async () => {
    expect((await request(app).get(signedPath())).status).toBe(200);
    expect((await request(app).get('/support-media-delivery/30/image.jpg?expires=1&token=bad')).status).toBe(404);
    await fixture.query("UPDATE support_media_galleries SET status='retired'");
    expect((await request(app).get(signedPath())).status).toBe(404);
  });
  it.each([
    "UPDATE support_media_galleries SET audience='internal'",
    "UPDATE support_media_assets SET sensitivity='internal'",
    "UPDATE support_media_assets SET sensitivity='personal'",
  ])('revokes previously issued customer links after %s', async mutation => {
    const path = signedPath(); await fixture.query(mutation);
    expect((await request(app).get(path)).status).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });
  it('rechecks a signed link after slow object retrieval', async () => {
    onDownload = async () => { await fixture.query("UPDATE support_media_galleries SET status='retired'"); };
    expect((await request(app).get(signedPath())).status).toBe(404);
  });
  it('sends one provider message for concurrent duplicate requests', async () => {
    const results = await scoped(() => Promise.all([supportMediaDeliveryService.deliverDirect(input()), supportMediaDeliveryService.deliverDirect(input())]));
    expect(send).toHaveBeenCalledTimes(1);
    expect(results.some(result => result.sent === 1)).toBe(true);
    expect((await fixture.query('SELECT status,attempts FROM support_media_delivery_parts')).rows).toEqual([{ status: 'provider_acknowledged', attempts: 1 }]);
  });
  it('rechecks publication after slow object retrieval before sending', async () => {
    onDownload = async () => { await fixture.query("UPDATE support_media_galleries SET status='retired'"); };
    expect((await scoped(() => supportMediaDeliveryService.deliverDirect(input()))).sent).toBe(0);
    expect(send).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  });
  it('rechecks publication after provider upload before customer delivery', async () => {
    upload.mockImplementation(async () => { await fixture.query("UPDATE support_media_assets SET publication_state='quarantined'"); return { id: 'synthetic-upload' }; });
    expect((await scoped(() => supportMediaDeliveryService.deliverDirect(input()))).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps an acknowledged send uncertain when the receipt write fails and prevents replay', async () => {
    await fixture.query(`CREATE OR REPLACE FUNCTION reject_fixture_ack() RETURNS trigger AS $$
      BEGIN IF NEW.status='provider_acknowledged' THEN RAISE EXCEPTION 'synthetic receipt persistence failure'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_ack BEFORE UPDATE ON support_media_delivery_parts FOR EACH ROW EXECUTE FUNCTION reject_fixture_ack();`);
    await scoped(() => supportMediaDeliveryService.deliverDirect(input()));
    expect((await fixture.query('SELECT status FROM support_media_delivery_parts')).rows).toEqual([{ status: 'uncertain' }]);
    await scoped(() => supportMediaDeliveryService.deliverDirect(input()));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('uses the real gateway to reject a stale selection after withdrawal', async () => {
    const decision = { intent: 'explicit' as const, reason: 'fixture', selections: [{ evidenceId: 'media-fixture-30', order: 0 }] };
    expect(await scoped(() => mediaGateway.verify(9,'whatsapp',decision,{ businessProfileId: 7, audience: 'customer', purpose: 'support_answer' }))).toHaveLength(1);
    await fixture.query("UPDATE support_media_assets SET publication_state='quarantined'");
    expect(await scoped(() => mediaGateway.verify(9,'whatsapp',decision,{ businessProfileId: 7, audience: 'customer', purpose: 'support_answer' }))).toEqual([]);
  });
  it.each([
    "UPDATE support_media_galleries SET allowed_channels=ARRAY['email']",
    "UPDATE support_media_galleries SET audience='internal'",
    "UPDATE support_media_galleries SET business_profile_id=8",
    "UPDATE outreach_conversations SET status='closed'",
    "UPDATE outreach_conversations SET automation_mode='human_owned'",
    "UPDATE outreach_conversations SET external_thread_id='different-recipient'",
    "INSERT INTO handoff_queue(user_id,conversation_id,status) VALUES(9,60,'assigned')",
  ])('cancels stale delivery after %s', async mutation => {
    onDownload = async () => { await fixture.query(mutation); };
    expect((await scoped(() => supportMediaDeliveryService.deliverDirect(input()))).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps an unannotated provider timeout uncertain across reload/retry', async () => {
    send.mockRejectedValue(new Error('Synthetic provider timeout'));
    await scoped(() => supportMediaDeliveryService.deliverDirect(input()));
    await scoped(() => supportMediaDeliveryService.deliverDirect(input()));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await fixture.query('SELECT status,reconciliation_state FROM support_media_delivery_parts')).rows)
      .toEqual([{ status: 'uncertain', reconciliation_state: 'pending' }]);
  });
  it('preserves delivery when an active handoff explicitly leaves AI replies enabled', async () => {
    await fixture.query("INSERT INTO handoff_queue(user_id,conversation_id,status,ai_reply_enabled) VALUES(9,60,'assigned',true)");
    expect((await scoped(() => supportMediaDeliveryService.deliverDirect(input()))).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('permits retry after an explicit confirmed rejection', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('Synthetic confirmed rejection'), { deliveryAttempted: true, outcomeUncertain: false }));
    await scoped(() => supportMediaDeliveryService.deliverDirect(input()));
    expect((await fixture.query('SELECT status FROM support_media_delivery_parts')).rows).toEqual([{ status: 'failed' }]);
    expect((await scoped(() => supportMediaDeliveryService.deliverDirect(input()))).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('uploads with reference handoffs, reuses a retry, requires review, and versions edits', async () => scoped(async () => {
    const gallery = await draftGallery(); const id = Number(gallery.version.gallery_id);
    const upload = await supportMediaGalleryService.addImages(9,id,[file],[{ name: 'Synthetic tile' }]);
    const retry = await supportMediaGalleryService.addImages(9,id,[file],[{ name: 'Synthetic tile' }]);
    expect(retry.outcomes[0].status).toBe('existing'); expect(store).toHaveBeenCalledTimes(2);
    expect(store.mock.calls[0][1]).toMatchObject({ referenceType: 'support_media_gallery_version', referenceId: String(upload.versionId) });
    expect((await supportMediaGalleryService.get(9,id))?.version_status).toBe('ready_for_review');
    await supportMediaGalleryService.reviewAsset(9,id,Number(upload.assets[0].id),'approve','Synthetic owner review');
    expect((await supportMediaGalleryService.get(9,id))?.version_status).toBe('published');
    await supportMediaGalleryService.updateAsset(9,id,Number(upload.assets[0].id),{ name: 'Updated synthetic tile' });
    const current = await supportMediaGalleryService.get(9,id);
    expect(Number(current?.version_no)).toBe(2);
    expect((await fixture.query('SELECT name FROM support_media_assets WHERE gallery_version_id=$1',[upload.versionId])).rows)
      .toEqual([{ name: 'Synthetic tile' }]);
  }));
  it('does not apply an old safe scan to a quarantined replacement', async () => scoped(async () => {
    const gallery = await draftGallery(); const id = Number(gallery.version.gallery_id);
    const added = await supportMediaGalleryService.addImages(9,id,[file],[{ name: 'Original synthetic tile' }]);
    let started!: () => void; const scanning = new Promise<void>(resolve => { started = resolve; });
    let release!: (result: unknown) => void;
    scan.mockImplementationOnce(async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = supportMediaGalleryService.retryScans(9,id); await scanning;
    scan.mockResolvedValue(scanResult('quarantined','c'.repeat(64)));
    await supportMediaGalleryService.replaceAsset(9,id,Number(added.assets[0].id),file,{ name: 'Quarantined replacement' });
    release(scanResult('published')); await pending;
    const latest = await supportMediaGalleryService.get(9,id);
    expect(latest?.assets[0].publication_state).toBe('quarantined');
    expect(latest?.version_status).toBe('quarantined');
  }));
  (process.env.SUPPORT_ASSETS_BROWSER_HARNESS === '1' ? it : it.skip)('serves the browser fixture with real document/gallery controllers and PostgreSQL', async () => {
    const { getTableConfig } = await import('drizzle-orm/pg-core');
    const { supportAdminAuditLogsTable } = await import('../models/supportOrchestration/schema.js');
    // @ts-expect-error Production migrations are JavaScript.
    const { up: documentUp } = await import('../migrations/289_support_document_delivery.js');
    // @ts-expect-error Production migrations are JavaScript.
    const { up: libraryUp } = await import('../migrations/290_support_document_library.js');
    await documentUp(fixture); await libraryUp(fixture);
    await fixture.query(`ALTER TABLE storage_files ADD COLUMN is_deleted boolean DEFAULT false;
      ALTER TABLE storage_files ADD COLUMN mime_type text DEFAULT 'image/jpeg';
      INSERT INTO storage_files VALUES(250,9,false,'application/pdf');`);
    const unique = await fixture.query("SELECT conname FROM pg_constraint WHERE conrelid='support_approved_documents'::regclass AND contype='u'");
    await fixture.query(`ALTER TABLE support_approved_documents DROP CONSTRAINT "${String(unique.rows[0].conname).replaceAll('"','""')}"`);
    await fixture.query('ALTER TABLE support_approved_documents ADD UNIQUE(business_profile_id,user_id,storage_file_id,service,checksum)');
    const definition = getTableConfig(supportAdminAuditLogsTable);
    const columns = definition.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`);
    await fixture.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    objects.set(250, Buffer.from('%PDF-1.7\nSynthetic audit document\n%%EOF'));
    const { supportDocumentLibrary } = await import('../services/supportDocuments/SupportDocumentLibrary.js');
    await scoped(() => supportDocumentLibrary.save(9, { title: 'Synthetic corporate brochure', description: 'Only synthetic test content', service: 'corporate', storageFileId: 250 }));
    const documents = await import('../controllers/supportDocumentLibraryController.js');
    const galleries = await import('../controllers/supportMediaGalleryController.js');
    app.use(express.json());
    app.use('/api/settings', (req, res, next) => {
      if (req.headers.authorization !== 'Bearer fixture-owner') { res.status(401).json({ error: 'Fixture authentication required' }); return; }
      Object.assign(req, { user: { id: 9 } }); scoped(next);
    });
    app.get('/api/settings/support-documents', documents.listSupportDocuments);
    app.put('/api/settings/support-documents/:id', documents.updateSupportDocument);
    app.post('/api/settings/support-documents/:id/publish', documents.publishSupportDocument);
    app.post('/api/settings/support-documents/:id/withdraw', documents.withdrawSupportDocument);
    app.get('/api/settings/support-documents/:id/content', documents.downloadSupportDocument);
    app.get('/api/settings/media-galleries', galleries.listSupportMediaGalleries);
    app.get('/api/settings/media-galleries/assets/:assetId/content', galleries.downloadSupportMediaAsset);
    app.get('/api/settings/media-galleries/:id', galleries.getSupportMediaGallery);
    app.post('/api/settings/media-galleries', galleries.createSupportMediaGallery);
    app.get('/api/settings/media-deliveries', galleries.listUncertainMediaDeliveries);
    const server = app.listen(8159, '127.0.0.1');
    const { writeFile, access } = await import('node:fs/promises');
    const ready = '/workspace/support-gallery-audit/browser-api-ready';
    await writeFile(ready, 'ready');
    try {
      await new Promise<void>((resolve, reject) => {
        const end = Date.now() + 240_000;
        const poll = async () => {
          if (Date.now() > end) { reject(new Error('Browser harness timed out')); return; }
          try { await access('/workspace/support-gallery-audit/browser-api-stop'); resolve(); }
          catch { setTimeout(() => { void poll(); }, 250); }
        }; void poll();
      });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 260_000);
});
