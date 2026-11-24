import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import type { SupportDeliveryOutboxRecord } from '../models/supportOrchestration/schema.js';
import type { ApprovedSupportDocument } from '../services/supportDocuments/ApprovedSupportDocuments.js';

const bytes = Buffer.from('%PDF-1.7\nSynthetic fixture, not a customer file.\n%%EOF');
const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
const doc: ApprovedSupportDocument = { id: 20, userId: 9, storageFileId: 250,
  businessProfileId: null, title: 'Day outing packages', service: 'day_outing', checksum };
const execute = jest.fn<any>(async () => ({ rows: [{ id: 1 }] }));
const download = jest.fn<any>();
const allowed = jest.fn<any>(async () => true);
const revalidate = jest.fn<any>(async () => true);
const upload = jest.fn<any>(async () => ({ id: 'media-1' }));
const send = jest.fn<any>(async () => ({ messages: [{ id: 'wamid.document' }] }));
const hold = jest.fn<any>().mockResolvedValue(false);
const claim = jest.fn<any>();
const complete = jest.fn<any>(async () => {});
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: { downloadFile: download } }));
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({ automaticSupportReplyAllowed: allowed }));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({ deliveryOutboxService: { holdIfDisabled: hold, claim, completeClaimedAction: complete } }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { uploadMedia: upload, sendMedia: send } }));
// Preserve the real byte validator and registry type; replace only publication lookup.
const registry = await import('../services/supportDocuments/ApprovedSupportDocuments.js');
jest.spyOn(registry.approvedSupportDocuments, 'revalidate').mockImplementation(revalidate);
const { supportDocumentDelivery } = await import('../services/supportDocuments/SupportDocumentDelivery.js');
const input = () => ({ document: doc, userId: 9, conversationId: 615, recipient: 'qa-recipient',
  inboundProviderMessageId: 'inbound-1', caption: 'Please see the requested document for the published details.' });
const action = () => ({ id: 80, userId: 9, conversationId: 615, channel: 'whatsapp', attemptCount: 1,
  payload: { text: input().caption, recipient: 'qa-recipient', metadata: { dispatchKind: 'support_document', document: doc } },
} as unknown as SupportDeliveryOutboxRecord);

beforeEach(() => {
  jest.clearAllMocks();
  hold.mockReset().mockResolvedValue(false);
  execute.mockResolvedValue({ rows: [{ id: 1 }] }); allowed.mockResolvedValue(true); revalidate.mockResolvedValue(true);
  download.mockResolvedValue({ buffer: bytes, file: { userId: 9, mimeType: 'application/pdf' } });
  upload.mockResolvedValue({ id: 'media-1' }); send.mockResolvedValue({ messages: [{ id: 'wamid.document' }] });
  complete.mockResolvedValue(undefined); claim.mockResolvedValue({ state: 'claimed', action: action() });
});

describe('approved WhatsApp PDF delivery', () => {
  it('uploads the exact PDF and commits only after a document acknowledgement', async () => {
    expect(await supportDocumentDelivery.deliver(input())).toEqual({ status: 'sent', actionId: 80, providerMessageId: 'wamid.document' });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ buffer: bytes, mimeType: 'application/pdf' }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'document', mediaId: 'media-1', filename: 'support-document-20.pdf', caption: input().caption }));
    expect(complete).toHaveBeenCalledWith(action(), 'wamid.document');
    expect(revalidate).toHaveBeenCalledTimes(3);
  });
  it.each(['already_sent','uncertain'])('does not resend a %s outbox decision', async state => {
    claim.mockResolvedValue({ state, action: { ...action(), providerMessageId: 'old-receipt' } });
    expect((await supportDocumentDelivery.deliver(input())).status).toBe(state === 'already_sent' ? 'sent' : 'uncertain');
    expect(upload).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it.each(['changed_bytes','wrong_mime','foreign_owner','missing_file'])('rejects %s before provider upload', async condition => {
    if (condition === 'changed_bytes') download.mockResolvedValue({ buffer: Buffer.from('%PDF-1.7 changed'), file: { userId: 9, mimeType: 'application/pdf' } });
    if (condition === 'wrong_mime') download.mockResolvedValue({ buffer: bytes, file: { userId: 9, mimeType: 'image/jpeg' } });
    if (condition === 'foreign_owner') download.mockResolvedValue({ buffer: bytes, file: { userId: 10, mimeType: 'application/pdf' } });
    if (condition === 'missing_file') download.mockResolvedValue(null);
    expect((await supportDocumentDelivery.deliver(input())).status).toBe('unavailable');
    expect(upload).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it('does not deliver when automatic support replies were disabled', async () => {
    hold.mockResolvedValue(true);
    expect((await supportDocumentDelivery.deliver(input())).status).toBe('drafted');
    expect(upload).not.toHaveBeenCalled();
  });
  it('does not send after a late withdrawal following upload', async () => {
    revalidate.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await supportDocumentDelivery.deliver(input())).status).toBe('unavailable');
    expect(upload).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  });
  it('does not send when the conversation becomes approval-pending after upload', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [] });
    expect((await supportDocumentDelivery.deliver(input())).status).toBe('unavailable');
    expect(upload).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  });
  it.each(['timeout','missing_ack','receipt_failure'])('retains an uncertain outcome for %s without marking sent', async failure => {
    if (failure === 'timeout') send.mockRejectedValue(new Error('Timeout after dispatch'));
    if (failure === 'missing_ack') send.mockResolvedValue({});
    if (failure === 'receipt_failure') complete.mockRejectedValue(new Error('Receipt storage failed'));
    expect((await supportDocumentDelivery.deliver(input())).status).toBe('uncertain');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not treat a failed upload as customer delivery', async () => {
    upload.mockRejectedValue(new Error('Upload failed'));
    expect((await supportDocumentDelivery.deliver(input())).status).toBe('unavailable');
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects missing inbound identity, foreign documents and overlong captions', async () => {
    expect((await supportDocumentDelivery.deliver({ ...input(), inboundProviderMessageId: undefined })).status).toBe('unavailable');
    expect((await supportDocumentDelivery.deliver({ ...input(), userId: 10 })).status).toBe('unavailable');
    expect((await supportDocumentDelivery.deliver({ ...input(), caption: 'x'.repeat(1025) })).status).toBe('unavailable');
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('semantic document selection and exact binary validation', () => {
  const request = { action: 'document', service: 'day_outing', explicit: true, topicSwitch: true,
    pricingRequested: false, media: 'none', confidence: 0.99 } as const;
  it('uses the AI topic, not brochure keywords or filenames', () => {
    expect(registry.requestedDocumentService({ channel: 'whatsapp', semanticRequest: request })).toBe('day_outing');
    expect(registry.requestedDocumentService({ channel: 'whatsapp' })).toBeNull();
    expect(registry.requestedDocumentService({ channel: 'whatsapp', semanticRequest: { ...request, service: 'corporate' } })).toBe('corporate');
  });
  it.each([{ explicit: false }, { action: 'booking' }, { confidence: 0.1 }])('rejects an unconfirmed document request: %o', change => {
    expect(registry.requestedDocumentService({ channel: 'whatsapp', semanticRequest: { ...request, ...change } as any })).toBeNull();
  });
  it.each([{ channel: 'instagram' }, { channel: 'whatsapp', publicReply: true }, { channel: 'whatsapp', outboundFirstTouch: true }])('rejects unsupported/unsolicited surface %o', surface => {
    expect(registry.requestedDocumentService({ ...surface, semanticRequest: request })).toBeNull();
  });
  it('checks the signature, type and approved checksum independently', () => {
    expect(registry.approvedPdfBytesMatch(bytes, 'application/pdf', checksum)).toBe(true);
    expect(registry.approvedPdfBytesMatch(bytes, 'image/jpeg', checksum)).toBe(false);
    expect(registry.approvedPdfBytesMatch(bytes, 'application/pdf', '0'.repeat(64))).toBe(false);
    const other = Buffer.from('not a PDF');
    expect(registry.approvedPdfBytesMatch(other, 'application/pdf', crypto.createHash('sha256').update(other).digest('hex'))).toBe(false);
  });
});
