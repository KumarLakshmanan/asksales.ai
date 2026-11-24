import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const upload = jest.fn<any>();
const deleteFile = jest.fn<any>();
const scan = jest.fn<any>();
const verify = jest.fn<any>();
const downloadFile = jest.fn<any>();
const sendImage = jest.fn<any>();
const instagram = jest.fn<any>();
const facebook = jest.fn<any>();
const statements: Array<{ sql: string; params: unknown[] }> = [];
let existing: Record<string, unknown> | undefined;
let reviewAsset: Record<string, unknown> | undefined;
let deliveryExists = true;
let retryPart: Record<string, unknown> | undefined;
let dispatchClaim: Record<string, unknown> | undefined;
let dispatchOwned = true;
let pendingParts: Record<string, unknown>[] = [];
const execute = jest.fn(async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  statements.push(compiled);
  if (compiled.sql.includes('SELECT p.id,p.conversation_id,p.channel')) return { rows: pendingParts };
  if (compiled.sql.includes('INSERT INTO support_media_delivery_parts')) return { rows: dispatchClaim ? [dispatchClaim] : [] };
  if (compiled.sql.includes("AND status='sending' AND attempts=")) return { rows: dispatchOwned ? [{ id: 7 }] : [] };
  if (compiled.sql.includes('SELECT c.business_profile_id FROM outreach_conversations')) return { rows: [{ business_profile_id: 42 }] };
  if (compiled.sql.includes('SELECT p.*,c.external_thread_id')) return { rows: retryPart ? [retryPart] : [] };
  if (compiled.sql.includes("scan_results->>'uploadFingerprint'")) return { rows: existing ? [existing] : [] };
  if (compiled.sql.includes('COUNT(*)::integer AS count')) return { rows: [{ count: 0 }] };
  if (compiled.sql.includes('INSERT INTO support_media_assets')) {
    existing = { id: 11, publication_state: 'ready_for_review', search_text: 'Room' };
    return { rows: [existing] };
  }
  if (compiled.sql.includes('SELECT a.* FROM support_media_assets')) return { rows: reviewAsset ? [reviewAsset] : [] };
  if (compiled.sql.includes('SELECT id FROM support_media_delivery_parts')) return { rows: deliveryExists ? [{ id: 7 }] : [] };
  return { rows: [] };
});
const autoReplyAllowed = jest.fn<() => Promise<boolean>>();
const draftDelivery = jest.fn<(...args: unknown[]) => Promise<{ id: number }>>();
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({
  automaticSupportReplyAllowed: autoReplyAllowed,
  socialDraftChannel: (channel: string) => ['whatsapp', 'instagram', 'facebook'].includes(channel.replace(/_comment$/, '')),
}));
jest.unstable_mockModule('../services/supportMedia/SupportMediaTenantTransaction.js', () => ({
  withTenantSupportMediaTransaction: async (_id: number, callback: (tx: unknown) => unknown) => callback({ execute }),
}));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({
  deliveryOutboxService: { draft: draftDelivery },
}));
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: { upload, deleteFile, downloadFile } }));
jest.unstable_mockModule('../services/supportMedia/SupportMediaSafetyService.js', () => ({
  scanSupportMedia: scan, validateSupportMediaMetadata: () => ({ safe: true }),
}));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: {} }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: {} }));
jest.unstable_mockModule('../services/instagramGraphApiService.js', () => ({ getInstagramApiForUser: instagram }));
jest.unstable_mockModule('../services/FacebookMessengerService.js', () => ({ getFacebookApiForUser: facebook }));
jest.unstable_mockModule('../services/supportMedia/MediaGateway.js', () => ({ mediaGateway: { verify } }));
const { SupportMediaGalleryService } = await import('../services/supportMedia/SupportMediaGalleryService.js');
const { SupportMediaDeliveryService, createMediaPartIdempotencyKey } = await import('../services/supportMedia/SupportMediaDeliveryService.js');

const file = { buffer: Buffer.from('room image'), mimetype: 'image/png', originalname: 'room.png' } as Express.Multer.File;
const safeScan = { normalized: Buffer.from('normalized'), derivative: Buffer.from('delivery'), mimeType: 'image/jpeg',
  width: 20, height: 20, checksum: 'checksum', status: 'ready_for_review', internalTags: [], scanResults: { scannerUnavailable: true } };

beforeEach(() => {
  autoReplyAllowed.mockResolvedValue(true); draftDelivery.mockResolvedValue({ id: 902 });
  jest.clearAllMocks(); statements.length = 0; existing = undefined; deliveryExists = true;
  retryPart = undefined;
  pendingParts = [];
  dispatchClaim = undefined; dispatchOwned = true;
  reviewAsset = { id: 11, gallery_version_id: 3, publication_state: 'ready_for_review', scan_results: { scannerUnavailable: true } };
  scan.mockResolvedValue(safeScan);
  upload.mockResolvedValue({ fileId: 22, fileSizeBytes: 40 });
  deleteFile.mockResolvedValue(true);
  downloadFile.mockResolvedValue({ buffer: Buffer.from('image') });
  sendImage.mockResolvedValue({ success: true, messageId: 'provider-ack' });
  instagram.mockResolvedValue({ sendMessageWithAttachment: sendImage });
  facebook.mockResolvedValue({ sendMessageWithAttachment: sendImage });
  verify.mockResolvedValue([{ assetId: 4, checksum: 'a'.repeat(64), derivativeStorageFileId: 22 }]);
  process.env.APP_URL = 'https://example.com';
  process.env.JWT_SECRET = 'test-media-signing-secret';
});

function galleryService() {
  const service = new SupportMediaGalleryService();
  jest.spyOn(service as any, 'editableVersion').mockResolvedValue({ version_id: 3, title: 'Rooms' });
  jest.spyOn(service, 'reconcileVersion').mockResolvedValue({ status: 'ready_for_review' });
  jest.spyOn(service, 'get').mockResolvedValue({ assets: [] } as any);
  return service;
}

describe('media review and upload workflows', () => {
  it('returns per-file failure and cleans the first stored object when the derivative upload fails', async () => {
    upload.mockResolvedValueOnce({ fileId: 21 }).mockRejectedValueOnce(new Error('Storage unavailable'));
    const result = await galleryService().addImages(9, 2, [file], [{ name: 'Room' }]);
    expect(result.outcomes).toEqual([{ index: 0, fileName: 'room.png', status: 'failed', error: 'Storage unavailable' }]);
    expect(deleteFile).toHaveBeenCalledWith(21, 9);
    expect(statements.some((query) => query.sql.includes('INSERT INTO support_media_assets'))).toBe(false);
  });

  it('reuses a successfully uploaded image on retry without uploading duplicate objects', async () => {
    const service = galleryService();
    expect((await service.addImages(9, 2, [file], [{ name: 'Room' }])).outcomes[0].status).toBe('uploaded');
    expect((await service.addImages(9, 2, [file], [{ name: 'Room' }])).outcomes[0].status).toBe('existing');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(statements.filter((query) => query.sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
  });

  it('records the review reason before publishing an unavailable-scanner image', async () => {
    await galleryService().reviewAsset(9, 2, 11, 'approve', 'Reviewed the room image; no personal details or people.');
    const audit = statements.find((query) => query.sql.includes('INSERT INTO support_media_review_audits'));
    expect(audit?.params).toEqual([9, 11, 'approve', 'Reviewed the room image; no personal details or people.']);
    expect(statements.find((query) => query.sql.includes('UPDATE support_media_assets'))?.params[0]).toBe('published');
  });

  it.each(['quarantined', 'published', 'failed'])('does not permit approving an image in %s state', async (state) => {
    reviewAsset!.publication_state = state;
    await expect(galleryService().reviewAsset(9, 2, 11, 'approve', 'Inspected')).rejects.toThrow('Only images waiting for review');
    expect(statements.some((query) => query.sql.includes('INSERT INTO support_media_review_audits'))).toBe(false);
  });

  it('does not allow owner review to override known sensitive scan findings', async () => {
    reviewAsset!.scan_results = { piiTypes: ['email'] };
    await expect(galleryService().reviewAsset(9, 2, 11, 'approve', 'Inspected')).rejects.toThrow('known sensitive');
  });

  it('does not mutate assets outside the current tenant and gallery version', async () => {
    reviewAsset = undefined;
    await expect(galleryService().reviewAsset(9, 2, 11, 'reject', 'Inspected')).rejects.toThrow('not found');
    const query = statements[0];
    expect(query.sql).toContain('g.user_id=');
    expect(query.sql).toContain('a.gallery_version_id=(SELECT id');
    expect(statements).toHaveLength(1);
  });
});

describe('uncertain delivery reconciliation', () => {
  const media = [{ assetId: 4, checksum: 'a'.repeat(64), evidenceId: 'evidence', galleryId: 2, galleryVersionId: 3,
    name: 'Room', altText: 'Room', derivativeStorageFileId: 22, mimeType: 'image/jpeg', intent: 'explicit' as const }];
  it('returns tenant-bound safe diagnostics without exposing raw provider URLs or recipient identifiers', async () => {
    pendingParts = [{ id: 7, channel: 'facebook', status: 'failed', provider_account_id: 'page', external_thread_id: 'private-recipient',
      failure_code: 'DELIVERY_FAILED', failure_reason: 'https://private-url should represent a valid URL', name: 'Room' }];
    const result = await new SupportMediaDeliveryService().pendingReconciliation(9);
    expect(result[0]).toMatchObject({ failure_code: 'PROVIDER_MEDIA_FETCH_FAILED', recovery_action: 'retry', retry_eligible: true });
    expect(JSON.stringify(result)).not.toContain('private-');
    const query = statements.find((item) => item.sql.includes('SELECT p.id,p.conversation_id,p.channel'))!;
    expect(query.sql).toContain('c.user_id=p.user_id');
    expect(query.params).toEqual([9]);
  });
  it('holds media in a draft when automatic replies are disabled', async () => {
    autoReplyAllowed.mockResolvedValue(false);
    const result = await new SupportMediaDeliveryService().deliverDirect({ userId: 9, conversationId: 8, channel: 'facebook',
      providerAccountId: 'originating-page', recipient: 'recipient', inboundProviderMessageId: 'inbound', media });
    expect(result).toEqual({ status: 'drafted', sent: 0, failed: 0 });
    expect(draftDelivery).toHaveBeenCalledTimes(media.length);
    expect(facebook).not.toHaveBeenCalled(); expect(sendImage).not.toHaveBeenCalled();
  });

  it('uses the conversation Page, not the currently selected Facebook default', async () => {
    dispatchClaim = { id: 7, attempts: 1 };
    const result = await new SupportMediaDeliveryService().deliverDirect({ userId: 9, conversationId: 8, channel: 'facebook',
      providerAccountId: 'originating-page', recipient: 'recipient', inboundProviderMessageId: 'inbound', media });
    expect(facebook).toHaveBeenCalledWith(9, 'originating-page');
    expect(result.sent).toBe(1);
  });
  it('does not dispatch when media authorization is withdrawn before delivery', async () => {
    dispatchClaim = { id: 7, attempts: 1 };
    verify.mockResolvedValueOnce([]);
    const result = await new SupportMediaDeliveryService().deliverDirect({ userId: 9, conversationId: 8, channel: 'facebook',
      providerAccountId: 'originating-page', recipient: 'recipient', inboundProviderMessageId: 'inbound', media });
    expect(result).toEqual({ status: 'sent_media_degraded', sent: 0, failed: 1 });
    expect(facebook).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
  });
  it('preserves Facebook authorization error codes in the delivery record', async () => {
    dispatchClaim = { id: 7, attempts: 1 };
    sendImage.mockResolvedValue({ success: false, error: 'Rejected', errorCode: 'META_GRAPH_190', deliveryAttempted: true, outcomeUncertain: false });
    await new SupportMediaDeliveryService().deliverDirect({ userId: 9, conversationId: 8, channel: 'facebook', providerAccountId: 'page', recipient: 'recipient', media });
    expect(statements.find((item) => item.sql.includes('failure_code='))?.params).toContain('PROVIDER_AUTHORIZATION_INVALID');
  });
  it('records missing acknowledgements as uncertain, never delivered', async () => {
    dispatchClaim = { id: 7, attempts: 1 };
    sendImage.mockResolvedValue({ success: true });
    const result = await new SupportMediaDeliveryService().deliverDirect({ userId: 9, conversationId: 8, channel: 'instagram', providerAccountId: 'account', recipient: 'recipient', media });
    expect(result).toEqual({ status: 'sent_media_degraded', sent: 0, failed: 1 });
    expect(statements.find((item) => item.sql.includes('failure_code='))?.params).toContain('uncertain');
    expect(statements.some((item) => item.sql.includes("SET status='provider_acknowledged'"))).toBe(false);
  });
  it('blocks legacy Meta retries with no verified account binding before any dispatch', async () => {
    retryPart = { channel: 'instagram', external_thread_id: 'recipient', provider_account_id: null };
    await expect(new SupportMediaDeliveryService().retryFailedPart(9, 7)).rejects.toThrow('no verified sending account');
    expect(sendImage).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
  it('does not fall back to a default account for an unbound direct Meta image send', async () => {
    dispatchClaim = { id: 7, attempts: 1 };
    await new SupportMediaDeliveryService().deliverDirect({ userId: 9, conversationId: 8, channel: 'facebook', recipient: 'recipient', media });
    expect(facebook).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
    expect(statements.find((item) => item.sql.includes('failure_code='))?.params).toContain('PROVIDER_ACCOUNT_UNBOUND');
  });
  it('does not dispatch a delayed original attempt after its lease was reconciled or retried', async () => {
    dispatchClaim = { id: 7, attempts: 1 };
    downloadFile.mockImplementation(async () => { dispatchOwned = false; return { buffer: Buffer.from('image') }; });
    const result = await new SupportMediaDeliveryService().deliverDirect({ userId: 9, conversationId: 8, channel: 'instagram',
      recipient: 'recipient', inboundProviderMessageId: 'inbound', media: [{ assetId: 4, checksum: 'checksum', evidenceId: 'evidence',
        galleryId: 2, galleryVersionId: 3, name: 'Room', altText: 'Room', derivativeStorageFileId: 22, mimeType: 'image/jpeg', intent: 'explicit' }] });
    expect(result.failed).toBe(1);
    expect(sendImage).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.sql.includes('UPDATE support_media_delivery_parts'))).toBe(false);
  });
  it('requires provider evidence for delivered outcomes', async () => {
    await expect(new SupportMediaDeliveryService().reconcile(9, 7, { outcome: 'delivered', reason: 'Checked' })).rejects.toThrow('provider message ID');
    expect(statements).toHaveLength(0);
  });
  it('records confirmed non-delivery and only makes the original idempotent send eligible for retry', async () => {
    const result = await new SupportMediaDeliveryService().reconcile(9, 7, { outcome: 'not_delivered', reason: 'Provider history confirms this image is absent' });
    expect(result).toEqual({ resolved: true, retryEligible: true });
    expect(statements.find((query) => query.sql.includes('UPDATE support_media_delivery_parts'))?.params).toContain('failed');
    expect(statements.find((query) => query.sql.includes('INSERT INTO support_media_review_audits'))?.params).toContain('not_delivered');
    expect(upload).not.toHaveBeenCalled();
  });
  it('cannot reconcile an already resolved or foreign-tenant part', async () => {
    deliveryExists = false;
    await expect(new SupportMediaDeliveryService().reconcile(9, 7, { outcome: 'not_delivered', reason: 'Checked' })).rejects.toThrow('not found');
    expect(statements).toHaveLength(1);
    expect(statements[0].params).toEqual([7, 9]);
  });
  it('retries the original part with the same index and inbound identity after current authorization', async () => {
    retryPart = { conversation_id: 8, channel: 'instagram', external_thread_id: 'provider-recipient', provider_account_id: 'account',
      evidence_id: 'media-evidence', asset_version: 'checksum', part_index: 2, inbound_provider_message_id: 'inbound-4',
      media_intent: 'explicit', conversation_metadata: { businessProfileId: 42 },
      idempotency_key: createMediaPartIdempotencyKey({ userId: 9, inboundId: 'inbound-4', decisionVersion: 1, assetVersion: 'checksum', partIndex: 2, channel: 'instagram' }) };
    verify.mockResolvedValue([{ checksum: 'checksum', evidenceId: 'media-evidence' }]);
    const service = new SupportMediaDeliveryService();
    const dispatch = jest.spyOn(service, 'deliverDirect').mockResolvedValue({ status: 'sent', sent: 1, failed: 0 });
    await service.retryFailedPart(9, 7);
    expect(verify).toHaveBeenCalledWith(9, 'instagram', expect.anything(), { businessProfileId: 42, audience: 'customer', purpose: 'support_answer' });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, recipient: 'provider-recipient', inboundProviderMessageId: 'inbound-4', partIndexOffset: 2 }));
    dispatch.mockRestore();
  });
  it('does not retry an unresolved or inaccessible delivery', async () => {
    const service = new SupportMediaDeliveryService();
    const dispatch = jest.spyOn(service, 'deliverDirect');
    await expect(service.retryFailedPart(9, 7)).rejects.toThrow('Verify uncertain deliveries first');
    expect(dispatch).not.toHaveBeenCalled();
    expect(statements[0].sql).toContain("p.status='failed'");
    dispatch.mockRestore();
  });
});
