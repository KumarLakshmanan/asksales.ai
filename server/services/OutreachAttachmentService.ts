import crypto from 'node:crypto';
import path from 'node:path';
import { and, eq, inArray, isNull, lt, notInArray, or } from 'drizzle-orm';
import * as XLSX from '@e965/xlsx';
import { db } from '../models/db.js';
import {
  outreachMessageAttachmentsTable,
  outreachMessagesTable,
  type OutreachMessageAttachmentRecord,
} from '../models/outreachConversations/schema.js';
import { StorageLimitError, storageService } from './StorageService.js';
import { logger } from '../utils/logger.js';
import { fetchPublicHttpUrl, readResponseBuffer } from '../utils/safeRemoteFetch.js';
import {
  MAX_OUTREACH_ATTACHMENTS,
  MAX_INBOUND_VIDEO_SIZE,
  getChannelAttachmentCapability,
  normalizeOutreachAttachmentMime,
  safeOutreachAttachmentFileName,
  validateAttachment,
} from '../utils/outreachAttachmentPolicy.js';
import { isSupportedOutreachAudioMime, transcribeOutreachAudio } from './OutreachAudioService.js';
export {
  ALLOWED_OUTREACH_ATTACHMENT_MIMES,
  MAX_OUTREACH_ATTACHMENTS,
  MAX_OUTREACH_ATTACHMENT_SIZE,
  getChannelAttachmentCapability,
  normalizeOutreachAttachmentMime,
} from '../utils/outreachAttachmentPolicy.js';

export const MAX_EXTRACTED_ATTACHMENT_CHARS = 40_000;
const STAGED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export type AttachmentApiRecord = {
  id: string;
  fileId: number | null;
  fileName: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  inlineUrl: string;
  downloadUrl: string;
  status: string;
  extractionStatus: string;
  extractionError?: string | null;
  deliveryStatus: string;
  deliveryError?: string | null;
  providerAttachmentId?: string | null;
  providerMediaId?: string | null;
  mediaKind?: string | null;
  transcriptionLanguage?: string | null;
};

export async function extractAttachmentText(buffer: Buffer, mimeType: string, fileName: string): Promise<{
  status: 'success' | 'empty' | 'unsupported' | 'failed';
  text?: string;
  error?: string;
  language?: string;
}> {
  try {
    mimeType = normalizeOutreachAttachmentMime(mimeType);
    let text = '';
    if (mimeType === 'text/plain' || mimeType === 'text/csv') {
      text = buffer.toString('utf8');
    } else if (mimeType === 'application/pdf') {
      const mod = await import('pdf-parse');
      const parsePdf = ('default' in mod ? mod.default : mod) as (input: Uint8Array) => Promise<{ text?: string }>;
      // PDF.js expects slice() to copy bytes. Node Buffer.slice() returns a
      // shared view, which can corrupt cross-reference parsing in valid PDFs.
      text = (await parsePdf(new Uint8Array(buffer))).text || '';
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mod = await import('mammoth');
      const mammoth = ('default' in mod ? mod.default : mod) as { extractRawText(input: { buffer: Buffer }): Promise<{ value?: string }> };
      text = (await mammoth.extractRawText({ buffer })).value || '';
    } else if (mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false, sheetRows: 1001 });
      text = workbook.SheetNames.map((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const range = worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']) : null;
        if (range && (range.e.r > 1000 || range.e.c > 200)) {
          throw new Error(`Spreadsheet sheet "${sheetName}" exceeds the safe extraction range (1,000 rows × 200 columns).`);
        }
        const csv = XLSX.utils.sheet_to_csv(worksheet, { blankrows: false });
        return `Sheet: ${sheetName}\n${csv}`;
      }).join('\n\n');
    } else if (isSupportedOutreachAudioMime(mimeType)) {
      return transcribeOutreachAudio(buffer, mimeType, fileName);
    } else if (mimeType.startsWith('image/')) {
      if (process.env.ATTACHMENT_VISION_EXTRACTION_ENABLED !== 'true') {
        return { status: 'unsupported', error: 'Image content extraction is disabled; no file details were inferred.' };
      }
      const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions.js');
      const [openaiCredential, geminiCredential] = await Promise.all([
        getActiveAdminCredential('openai'),
        getActiveAdminCredential('gemini'),
      ]);
      const prompt = `Extract only facts directly visible in this image, including readable text. Be concise. Do not infer names, quantities, brands, or events that are not visibly supported. If the image is unreadable, respond exactly: NO_READABLE_CONTENT.`;
      if (openaiCredential?.apiKey) {
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: openaiCredential.apiKey });
        const completion = await openai.chat.completions.create({
          model: String(openaiCredential.config?.model || 'gpt-4o-mini'),
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } },
            ],
          }],
          temperature: 0,
          max_tokens: 800,
        });
        text = completion.choices[0]?.message?.content || '';
      } else if (geminiCredential?.apiKey) {
        const { normalizeLLMModelName } = await import('../utils/llmConstants.js');
        const model = normalizeLLMModelName(
          'gemini',
          String(geminiCredential.config?.model || 'gemini-3.1-flash-lite'),
        );
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiCredential.apiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: buffer.toString('base64') } }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 800 },
          }),
        });
        if (!response.ok) throw new Error(`Vision extraction failed with HTTP ${response.status}`);
        const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
      } else {
        return { status: 'unsupported', error: 'No approved vision provider is configured; no file details were inferred.' };
      }
      if (text.trim() === 'NO_READABLE_CONTENT') text = '';
    } else {
      return { status: 'unsupported', error: `Text extraction is not supported for ${path.extname(fileName) || mimeType}.` };
    }
    const normalized = text.replace(/\0/g, '').replace(/\r\n/g, '\n').trim().slice(0, MAX_EXTRACTED_ATTACHMENT_CHARS);
    return normalized ? { status: 'success', text: normalized } : { status: 'empty', error: 'No readable text was found.' };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : 'Attachment extraction failed.' };
  }
}

function toApiRecord(record: OutreachMessageAttachmentRecord): AttachmentApiRecord {
  const metadata = record.metadata || {};
  const downloadUrl = `/api/outreach/attachments/${record.publicId}`;
  const inferredMediaKind = record.mimeType.startsWith('image/')
    ? 'image'
    : record.mimeType.startsWith('video/')
      ? 'video'
      : record.mimeType.startsWith('audio/')
        ? (metadata.isVoiceMessage === true ? 'voice' : 'audio')
        : 'file';
  return {
    id: record.publicId,
    fileId: record.storageFileId,
    fileName: record.fileName,
    originalName: record.fileName,
    mimeType: record.mimeType,
    size: Number(record.fileSizeBytes),
    url: downloadUrl,
    inlineUrl: `${downloadUrl}?inline=true`,
    downloadUrl,
    status: record.status,
    extractionStatus: record.extractionStatus,
    extractionError: record.extractionError,
    deliveryStatus: record.deliveryStatus,
    deliveryError: record.deliveryError,
    providerAttachmentId: record.providerAttachmentId,
    providerMediaId: record.providerMediaId,
    mediaKind: typeof metadata.mediaKind === 'string' ? metadata.mediaKind : inferredMediaKind,
    transcriptionLanguage: typeof metadata.transcriptionLanguage === 'string' ? metadata.transcriptionLanguage : null,
  };
}

export class OutreachAttachmentService {
  async stageUpload(userId: number, file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<AttachmentApiRecord> {
    const validation = validateAttachment(file.buffer, file.mimetype, file.originalname);
    if (!validation.ok) throw new AttachmentValidationError(validation.error);
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const publicId = crypto.randomUUID();
    let storageFileId: number | null = null;
    try {
      const stored = await storageService.upload(file.buffer, {
        userId,
        category: validation.mimeType.startsWith('audio/') ? 'audio' : 'document',
        originalName: validation.fileName,
        mimeType: validation.mimeType,
        referenceType: 'outreach_attachment_staged',
        referenceId: publicId,
        metadata: { sha256, private: true },
      });
      storageFileId = stored.fileId;
      const extraction = await extractAttachmentText(file.buffer, validation.mimeType, validation.fileName);
      const [record] = await db.insert(outreachMessageAttachmentsTable).values({
        publicId,
        userId,
        storageFileId,
        direction: 'outbound',
        source: 'upload',
        fileName: validation.fileName,
        mimeType: validation.mimeType,
        fileSizeBytes: file.buffer.length,
        sha256,
        status: 'ready',
        extractionStatus: extraction.status,
        extractedText: extraction.text,
        extractionError: extraction.error,
        deliveryStatus: 'pending',
        metadata: {
          mediaKind: validation.mimeType.startsWith('audio/') ? 'audio' : 'file',
          transcriptionLanguage: extraction.language,
        },
        expiresAt: new Date(Date.now() + STAGED_ATTACHMENT_TTL_MS),
      }).returning();
      return toApiRecord(record);
    } catch (error) {
      if (storageFileId) await storageService.deleteFile(storageFileId, userId).catch(() => {});
      throw error;
    }
  }

  async persistInboundBuffer(params: {
    direction?: 'inbound' | 'outbound';
    deliveryStatus?: 'sent' | 'pending';
    userId: number;
    messageId: number;
    buffer: Buffer;
    mimeType: string;
    fileName: string;
    providerAttachmentId?: string;
    providerMediaId?: string;
    source: string;
    metadata?: Record<string, unknown>;
  }): Promise<AttachmentApiRecord> {
    const existing = params.providerAttachmentId
      ? await db.select().from(outreachMessageAttachmentsTable).where(and(
          eq(outreachMessageAttachmentsTable.userId, params.userId),
          eq(outreachMessageAttachmentsTable.providerAttachmentId, params.providerAttachmentId),
        )).limit(1)
      : [];
    if (existing[0]?.status === 'ready' && existing[0].storageFileId) return toApiRecord(existing[0]);

    const validation = validateAttachment(params.buffer, params.mimeType, params.fileName, { inbound: true });
    const sha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');
    if (!validation.ok) {
      if (existing[0]) {
        const [updated] = await db.update(outreachMessageAttachmentsTable).set({
          fileName: safeOutreachAttachmentFileName(params.fileName),
          mimeType: normalizeOutreachAttachmentMime(params.mimeType) || 'application/octet-stream',
          fileSizeBytes: Math.max(params.buffer.length, 1),
          sha256,
          status: 'quarantined',
          extractionStatus: 'quarantined',
          extractionError: validation.error,
          metadata: { ...(params.metadata || {}), mediaKind: params.metadata?.isVoiceMessage === true ? 'voice' : 'file', objectAvailable: false },
          updatedAt: new Date(),
        }).where(eq(outreachMessageAttachmentsTable.id, existing[0].id)).returning();
        await this.refreshMessageAttachmentCache(params.messageId, params.userId);
        return toApiRecord(updated);
      }
      const [quarantined] = await db.insert(outreachMessageAttachmentsTable).values({
        userId: params.userId,
        messageId: params.messageId,
        direction: params.direction || 'inbound',
        source: params.source,
        fileName: safeOutreachAttachmentFileName(params.fileName),
        mimeType: normalizeOutreachAttachmentMime(params.mimeType) || 'application/octet-stream',
        fileSizeBytes: Math.max(params.buffer.length, 1),
        sha256,
        status: 'quarantined',
        extractionStatus: 'quarantined',
        extractionError: validation.error,
        deliveryStatus: params.direction === 'outbound' ? params.deliveryStatus || 'sent' : 'received',
        providerAttachmentId: params.providerAttachmentId,
        providerMediaId: params.providerMediaId,
        metadata: {
          ...(params.metadata || {}),
          mediaKind: params.metadata?.isVoiceMessage === true
            ? 'voice'
            : isSupportedOutreachAudioMime(params.mimeType) ? 'audio' : 'file',
          objectAvailable: false,
        },
      }).onConflictDoNothing().returning();
      const record = quarantined || existing[0];
      if (!record) throw new Error('Inbound attachment was already persisted.');
      await this.refreshMessageAttachmentCache(params.messageId, params.userId);
      return toApiRecord(record);
    }

    let storageFileId: number | null = null;
    try {
      const publicId = crypto.randomUUID();
      const stored = await storageService.upload(params.buffer, {
        userId: params.userId,
        category: validation.mimeType.startsWith('audio/') ? 'audio' : 'document',
        originalName: validation.fileName,
        mimeType: validation.mimeType,
        referenceType: 'outreach_message',
        referenceId: String(params.messageId),
        metadata: { sha256, private: true, inbound: true, providerAttachmentId: params.providerAttachmentId },
      });
      storageFileId = stored.fileId;
      const extraction = await extractAttachmentText(params.buffer, validation.mimeType, validation.fileName);
      if (existing[0]) {
        const [record] = await db.update(outreachMessageAttachmentsTable).set({
          messageId: params.messageId,
          storageFileId,
          direction: params.direction || 'inbound',
          source: params.source,
          fileName: validation.fileName,
          mimeType: validation.mimeType,
          fileSizeBytes: params.buffer.length,
          sha256,
          status: 'ready',
          extractionStatus: extraction.status,
          extractedText: extraction.text,
          extractionError: extraction.error,
          deliveryStatus: params.direction === 'outbound' ? params.deliveryStatus || 'sent' : 'received',
          providerMediaId: params.providerMediaId,
          metadata: {
            ...(params.metadata || {}),
            mediaKind: validation.mimeType.startsWith('video/')
              ? 'video'
              : validation.mimeType.startsWith('image/')
                ? 'image'
                : validation.mimeType.startsWith('audio/')
                  ? (params.metadata?.isVoiceMessage === true ? 'voice' : 'audio')
                  : 'file',
            transcriptionLanguage: extraction.language,
            objectAvailable: true,
          },
          updatedAt: new Date(),
        }).where(eq(outreachMessageAttachmentsTable.id, existing[0].id)).returning();
        await this.refreshMessageAttachmentCache(params.messageId, params.userId);
        return toApiRecord(record);
      }
      const [record] = await db.insert(outreachMessageAttachmentsTable).values({
        publicId,
        userId: params.userId,
        messageId: params.messageId,
        storageFileId,
        direction: params.direction || 'inbound',
        source: params.source,
        fileName: validation.fileName,
        mimeType: validation.mimeType,
        fileSizeBytes: params.buffer.length,
        sha256,
        status: 'ready',
        extractionStatus: extraction.status,
        extractedText: extraction.text,
        extractionError: extraction.error,
        deliveryStatus: params.direction === 'outbound' ? params.deliveryStatus || 'sent' : 'received',
        providerAttachmentId: params.providerAttachmentId,
        providerMediaId: params.providerMediaId,
        metadata: {
          ...(params.metadata || {}),
          mediaKind: validation.mimeType.startsWith('video/')
            ? 'video'
            : validation.mimeType.startsWith('image/')
              ? 'image'
              : validation.mimeType.startsWith('audio/')
                ? (params.metadata?.isVoiceMessage === true ? 'voice' : 'audio')
                : 'file',
          transcriptionLanguage: extraction.language,
          objectAvailable: true,
        },
      }).onConflictDoNothing().returning();
      if (!record) {
        await storageService.deleteFile(storageFileId, params.userId).catch(() => {});
        const [winner] = params.providerAttachmentId
          ? await db.select().from(outreachMessageAttachmentsTable).where(and(
              eq(outreachMessageAttachmentsTable.userId, params.userId),
              eq(outreachMessageAttachmentsTable.providerAttachmentId, params.providerAttachmentId),
            )).limit(1)
          : [];
        if (!winner) throw new Error('Inbound attachment could not be persisted.');
        return toApiRecord(winner);
      }
      await this.refreshMessageAttachmentCache(params.messageId, params.userId);
      return toApiRecord(record);
    } catch (error) {
      if (storageFileId) await storageService.deleteFile(storageFileId, params.userId).catch(() => {});
      throw error;
    }
  }

  async persistGeneratedOutboundBuffer(params: {
    userId: number;
    messageId: number;
    buffer: Buffer;
    mimeType: string;
    fileName: string;
    sourceKey: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AttachmentApiRecord> {
    const source = params.source || 'tts';
    const [existing] = await db.select().from(outreachMessageAttachmentsTable).where(and(
      eq(outreachMessageAttachmentsTable.userId, params.userId),
      eq(outreachMessageAttachmentsTable.messageId, params.messageId),
      eq(outreachMessageAttachmentsTable.source, source),
    )).limit(1);
    if (existing) {
      return toApiRecord(existing);
    }

    const validation = validateAttachment(params.buffer, params.mimeType, params.fileName);
    if (!validation.ok) throw new AttachmentValidationError(validation.error);
    const publicId = crypto.randomUUID();
    const sha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');
    let storageFileId: number | null = null;
    try {
      const stored = await storageService.upload(params.buffer, {
        userId: params.userId,
        category: validation.mimeType.startsWith('audio/') ? 'audio' : 'document',
        originalName: validation.fileName,
        mimeType: validation.mimeType,
        referenceType: 'outreach_message',
        referenceId: String(params.messageId),
        metadata: { sha256, private: true, generated: true, sourceKey: params.sourceKey },
      });
      storageFileId = stored.fileId;
      const [record] = await db.insert(outreachMessageAttachmentsTable).values({
        publicId,
        userId: params.userId,
        messageId: params.messageId,
        storageFileId,
        direction: 'outbound',
        source,
        fileName: validation.fileName,
        mimeType: validation.mimeType,
        fileSizeBytes: params.buffer.length,
        sha256,
        status: 'ready',
        extractionStatus: 'not_applicable',
        extractionError: null,
        deliveryStatus: 'pending',
        metadata: {
          ...(params.metadata || {}),
          mediaKind: 'voice',
          generatedFromApprovedText: true,
        },
      }).onConflictDoNothing().returning();
      if (!record) {
        await storageService.deleteFile(storageFileId, params.userId).catch(() => {});
        const [winner] = await db.select().from(outreachMessageAttachmentsTable).where(and(
          eq(outreachMessageAttachmentsTable.userId, params.userId),
          eq(outreachMessageAttachmentsTable.messageId, params.messageId),
          eq(outreachMessageAttachmentsTable.source, source),
        )).limit(1);
        if (!winner) throw new Error('Generated audio could not be persisted safely.');
        return toApiRecord(winner);
      }
      await this.refreshMessageAttachmentCache(params.messageId, params.userId);
      return toApiRecord(record);
    } catch (error) {
      if (storageFileId) await storageService.deleteFile(storageFileId, params.userId).catch(() => {});
      throw error;
    }
  }

  async recordInboundFailure(params: {
    direction?: 'inbound' | 'outbound';
    deliveryStatus?: 'sent' | 'pending';
    userId: number;
    messageId: number;
    fileName: string;
    mimeType?: string;
    providerAttachmentId?: string;
    providerMediaId?: string;
    source: string;
    error: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<AttachmentApiRecord> {
    const existing = params.providerAttachmentId
      ? await db.select().from(outreachMessageAttachmentsTable).where(and(
          eq(outreachMessageAttachmentsTable.userId, params.userId),
          eq(outreachMessageAttachmentsTable.providerAttachmentId, params.providerAttachmentId),
        )).limit(1)
      : [];
    if (existing[0]) return toApiRecord(existing[0]);
    const failureMessage = params.error instanceof Error
      ? params.error.message.slice(0, 500)
      : 'The provider attachment could not be safely retrieved.';
    const [record] = await db.insert(outreachMessageAttachmentsTable).values({
      userId: params.userId,
      messageId: params.messageId,
      direction: params.direction || 'inbound',
      source: params.source,
      fileName: safeOutreachAttachmentFileName(params.fileName),
      mimeType: params.mimeType || 'application/octet-stream',
      fileSizeBytes: 1,
      sha256: crypto.createHash('sha256').update(`unavailable:${params.providerAttachmentId || crypto.randomUUID()}`).digest('hex'),
      status: 'failed',
      extractionStatus: 'failed',
      extractionError: failureMessage,
      deliveryStatus: params.direction === 'outbound' ? params.deliveryStatus || 'sent' : 'received',
      providerAttachmentId: params.providerAttachmentId,
      providerMediaId: params.providerMediaId,
      metadata: {
        ...(params.metadata || {}),
        mediaKind: params.metadata?.isVoiceMessage === true
          ? 'voice'
          : isSupportedOutreachAudioMime(params.mimeType || '') ? 'audio' : 'file',
        objectAvailable: false,
      },
    }).onConflictDoNothing().returning();
    const [winner] = !record && params.providerAttachmentId
      ? await db.select().from(outreachMessageAttachmentsTable).where(and(
          eq(outreachMessageAttachmentsTable.userId, params.userId),
          eq(outreachMessageAttachmentsTable.providerAttachmentId, params.providerAttachmentId),
        )).limit(1)
      : [];
    const persisted = record || existing[0] || winner;
    if (!persisted) throw new Error('Inbound attachment failure could not be recorded.');
    await this.refreshMessageAttachmentCache(params.messageId, params.userId);
    return toApiRecord(persisted);
  }

  async persistInboundUrl(params: {
    direction?: 'inbound' | 'outbound';
    deliveryStatus?: 'sent' | 'pending';
    userId: number;
    messageId: number;
    url: string;
    fileName: string;
    mimeType?: string;
    providerAttachmentId?: string;
    source: string;
    metadata?: Record<string, unknown>;
    headers?: Record<string, string>;
  }): Promise<AttachmentApiRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    timer.unref?.();
    try {
      const { response } = await fetchPublicHttpUrl(params.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'SalesMarketingOutreachAttachment/1.0', ...(params.headers || {}) },
      }, 2);
      if (!response.ok) throw new Error(`Attachment download failed with HTTP ${response.status}`);
      const buffer = await readResponseBuffer(response, MAX_INBOUND_VIDEO_SIZE);
      const mimeType = params.mimeType || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      return await this.persistInboundBuffer({ ...params, buffer, mimeType });
    } catch (error) {
      return this.recordInboundFailure({ ...params, error });
    } finally {
      clearTimeout(timer);
    }
  }

  async refreshMessageAttachmentCache(messageId: number, userId: number): Promise<void> {
    const attachments = await this.listForMessage(messageId, userId);
    await db.update(outreachMessagesTable)
      .set({ attachments, updatedAt: new Date() })
      .where(and(eq(outreachMessagesTable.id, messageId), eq(outreachMessagesTable.userId, userId)));
  }

  async claimForMessage(userId: number, messageId: number, publicIds: string[]): Promise<OutreachMessageAttachmentRecord[]> {
    const ids = [...new Set(publicIds)];
    if (!ids.length) return [];
    if (ids.length > MAX_OUTREACH_ATTACHMENTS || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
      throw new AttachmentValidationError(`Select no more than ${MAX_OUTREACH_ATTACHMENTS} valid attachments.`);
    }
    const claimed = await db.transaction(async (tx: typeof db) => {
      const [message] = await tx.select({ id: outreachMessagesTable.id, userId: outreachMessagesTable.userId })
        .from(outreachMessagesTable)
        .where(and(eq(outreachMessagesTable.id, messageId), eq(outreachMessagesTable.userId, userId)))
        .limit(1);
      if (!message) throw new AttachmentValidationError('The message does not belong to this tenant.');

      const claimed = await tx.update(outreachMessageAttachmentsTable)
        .set({ messageId, expiresAt: null, updatedAt: new Date() })
        .where(and(
          eq(outreachMessageAttachmentsTable.userId, userId),
          inArray(outreachMessageAttachmentsTable.publicId, ids),
          isNull(outreachMessageAttachmentsTable.messageId),
          eq(outreachMessageAttachmentsTable.status, 'ready'),
        ))
        .returning();
      if (claimed.length !== ids.length) throw new AttachmentValidationError('One or more attachments are missing, expired, unsafe, or already attached to another message.');
      return claimed;
    });
    for (const attachment of claimed) {
      if (attachment.storageFileId) {
        await storageService.reassignFileReference(attachment.storageFileId, userId, 'outreach_message', String(messageId)).catch((error) => {
          logger.warn({ err: error, attachmentId: attachment.publicId, messageId }, '[OutreachAttachments] Stored-file reference metadata could not be refreshed');
        });
      }
    }
    return claimed;
  }

  async listForMessage(messageId: number, userId: number): Promise<AttachmentApiRecord[]> {
    const rows = await db.select().from(outreachMessageAttachmentsTable)
      .where(and(eq(outreachMessageAttachmentsTable.messageId, messageId), eq(outreachMessageAttachmentsTable.userId, userId)));
    return rows.map(toApiRecord);
  }

  /** A bulk email shares private bytes, while every message owns its attachment identity and delivery state. */
  async copyForMessage(userId: number, sourceMessageId: number, messageId: number, publicIds?: string[]): Promise<OutreachMessageAttachmentRecord[]> {
    return db.transaction(async (tx: typeof db) => {
      const messages = await tx.select({ id: outreachMessagesTable.id }).from(outreachMessagesTable).where(and(
        eq(outreachMessagesTable.userId, userId), inArray(outreachMessagesTable.id, [sourceMessageId, messageId]),
      ));
      if (messages.length !== 2) throw new AttachmentValidationError('The attachments do not belong to this business.');
      const source: OutreachMessageAttachmentRecord[] = await tx.select().from(outreachMessageAttachmentsTable).where(and(
        eq(outreachMessageAttachmentsTable.userId, userId), eq(outreachMessageAttachmentsTable.messageId, sourceMessageId), eq(outreachMessageAttachmentsTable.status, 'ready'),
        ...(publicIds ? [inArray(outreachMessageAttachmentsTable.publicId, publicIds)] : []),
      ));
      if (!source.length || (publicIds && source.length !== new Set(publicIds).size)) throw new AttachmentValidationError('The selected attachments are no longer available.');
      return tx.insert(outreachMessageAttachmentsTable).values(source.map(record => ({
        ...record, id: undefined, publicId: crypto.randomUUID(), messageId, expiresAt: null,
        deliveryStatus: 'pending', deliveryError: null, providerAttachmentId: null, providerMediaId: null,
        createdAt: new Date(), updatedAt: new Date(),
      }))).returning();
    });
  }

  async listRecordsForMessage(messageId: number, userId: number): Promise<OutreachMessageAttachmentRecord[]> {
    return db.select().from(outreachMessageAttachmentsTable)
      .where(and(eq(outreachMessageAttachmentsTable.messageId, messageId), eq(outreachMessageAttachmentsTable.userId, userId)));
  }

  async listRecordsForMessages(messageIds: number[], userId: number): Promise<OutreachMessageAttachmentRecord[]> {
    if (!messageIds.length) return [];
    return db.select().from(outreachMessageAttachmentsTable).where(and(
      eq(outreachMessageAttachmentsTable.userId, userId),
      inArray(outreachMessageAttachmentsTable.messageId, messageIds),
    ));
  }

  async listForMessages(messageIds: number[], userId: number): Promise<Map<number, AttachmentApiRecord[]>> {
    const records = await this.listRecordsForMessages(messageIds, userId);
    const grouped = new Map<number, AttachmentApiRecord[]>();
    for (const record of records) {
      if (!record.messageId) continue;
      const current = grouped.get(record.messageId) || [];
      current.push(toApiRecord(record));
      grouped.set(record.messageId, current);
    }
    return grouped;
  }

  async download(publicId: string, userId: number) {
    const [record] = await db.select().from(outreachMessageAttachmentsTable)
      .where(and(eq(outreachMessageAttachmentsTable.publicId, publicId), eq(outreachMessageAttachmentsTable.userId, userId)))
      .limit(1);
    if (!record?.storageFileId || record.status !== 'ready') return null;
    const stored = await storageService.downloadFile(record.storageFileId, userId);
    return stored ? { record, buffer: stored.buffer } : null;
  }

  async getEmailAttachments(messageId: number, userId: number): Promise<Array<{ filename: string; content: Buffer; contentType: string }>> {
    const records = await this.listRecordsForMessage(messageId, userId);
    const output: Array<{ filename: string; content: Buffer; contentType: string }> = [];
    for (const record of records) {
      const capability = getChannelAttachmentCapability('email', record.mimeType);
      if (!capability.supported || !record.storageFileId || record.status !== 'ready') continue;
      const stored = await storageService.downloadFile(record.storageFileId, userId);
      if (!stored) throw new Error(`Attachment "${record.fileName}" is no longer available.`);
      output.push({ filename: record.fileName, content: stored.buffer, contentType: record.mimeType });
    }
    return output;
  }

  async getGroundedContext(messageIds: number[], userId: number): Promise<string> {
    if (!messageIds.length) return '';
    const rows = await db.select().from(outreachMessageAttachmentsTable).where(and(
      eq(outreachMessageAttachmentsTable.userId, userId),
      inArray(outreachMessageAttachmentsTable.messageId, messageIds),
      eq(outreachMessageAttachmentsTable.status, 'ready'),
      eq(outreachMessageAttachmentsTable.extractionStatus, 'success'),
    ));
    return (rows as OutreachMessageAttachmentRecord[]).filter((row) => row.extractedText).map((row) => {
      const tag = row.mimeType.startsWith('audio/') ? 'audio_transcript' : 'attachment';
      const language = typeof row.metadata?.transcriptionLanguage === 'string'
        ? ` language="${row.metadata.transcriptionLanguage.replace(/[<>&"]/g, '_')}"`
        : '';
      return `<${tag} name="${row.fileName.replace(/[<>&"]/g, '_')}" message_id="${row.messageId}"${language}>\n${row.extractedText}\n</${tag}>`;
    }).join('\n\n').slice(0, 80_000);
  }

  async markDelivery(messageId: number, userId: number, status: 'sent' | 'failed' | 'unsupported', error?: string, providerAttachmentId?: string) {
    const ownership = and(
      eq(outreachMessageAttachmentsTable.messageId, messageId),
      eq(outreachMessageAttachmentsTable.userId, userId),
    );
    await db.update(outreachMessageAttachmentsTable).set({
      deliveryStatus: status,
      deliveryError: error || null,
      providerAttachmentId: providerAttachmentId || undefined,
      updatedAt: new Date(),
    }).where(status === 'sent'
      ? ownership
      : and(ownership, eq(outreachMessageAttachmentsTable.deliveryStatus, 'pending')));
    await this.refreshMessageAttachmentCache(messageId, userId);
  }

  async markAttachmentDelivery(params: {
    publicId: string;
    messageId: number;
    userId: number;
    status: 'sent' | 'failed' | 'unsupported';
    error?: string;
    providerAttachmentId?: string;
    providerMediaId?: string;
  }) {
    await db.update(outreachMessageAttachmentsTable).set({
      deliveryStatus: params.status,
      deliveryError: params.error || null,
      providerAttachmentId: params.providerAttachmentId,
      providerMediaId: params.providerMediaId,
      updatedAt: new Date(),
    }).where(and(
      eq(outreachMessageAttachmentsTable.publicId, params.publicId),
      eq(outreachMessageAttachmentsTable.messageId, params.messageId),
      eq(outreachMessageAttachmentsTable.userId, params.userId),
    ));
    await this.refreshMessageAttachmentCache(params.messageId, params.userId);
  }

  async markProviderMediaPrepared(params: {
    publicId: string;
    messageId: number;
    userId: number;
    providerMediaId: string;
  }): Promise<void> {
    await db.update(outreachMessageAttachmentsTable).set({
      providerMediaId: params.providerMediaId,
      updatedAt: new Date(),
    }).where(and(
      eq(outreachMessageAttachmentsTable.publicId, params.publicId),
      eq(outreachMessageAttachmentsTable.messageId, params.messageId),
      eq(outreachMessageAttachmentsTable.userId, params.userId),
      eq(outreachMessageAttachmentsTable.deliveryStatus, 'pending'),
    ));
    await this.refreshMessageAttachmentCache(params.messageId, params.userId);
  }

  async deleteFilesForMessages(messageIds: number[], userId: number): Promise<number> {
    if (!messageIds.length) return 0;
    const records = await db.select().from(outreachMessageAttachmentsTable).where(and(
      eq(outreachMessageAttachmentsTable.userId, userId),
      inArray(outreachMessageAttachmentsTable.messageId, messageIds),
    ));
    let deleted = 0;
    const seen = new Set<number>();
    for (const record of records) {
      if (!record.storageFileId || seen.has(record.storageFileId)) continue;
      seen.add(record.storageFileId);
      const shared = await db.select({ id: outreachMessageAttachmentsTable.id }).from(outreachMessageAttachmentsTable).where(and(
        eq(outreachMessageAttachmentsTable.userId, userId), eq(outreachMessageAttachmentsTable.storageFileId, record.storageFileId),
        or(isNull(outreachMessageAttachmentsTable.messageId), notInArray(outreachMessageAttachmentsTable.messageId, messageIds)),
      )).limit(1);
      if (!shared.length && await storageService.deleteFile(record.storageFileId, userId)) deleted++;
    }
    return deleted;
  }

  async deleteStaged(publicIds: string[], userId: number): Promise<number> {
    if (!publicIds.length) return 0;
    const records = await db.select().from(outreachMessageAttachmentsTable).where(and(
      eq(outreachMessageAttachmentsTable.userId, userId),
      inArray(outreachMessageAttachmentsTable.publicId, publicIds),
      isNull(outreachMessageAttachmentsTable.messageId),
    ));
    for (const record of records) {
      if (record.storageFileId) await storageService.deleteFile(record.storageFileId, userId).catch(() => false);
      await db.delete(outreachMessageAttachmentsTable).where(and(
        eq(outreachMessageAttachmentsTable.id, record.id),
        eq(outreachMessageAttachmentsTable.userId, userId),
        isNull(outreachMessageAttachmentsTable.messageId),
      ));
    }
    return records.length;
  }

  async cleanupExpired(limit = 100): Promise<number> {
    const expired = await db.select().from(outreachMessageAttachmentsTable)
      .where(and(isNull(outreachMessageAttachmentsTable.messageId), lt(outreachMessageAttachmentsTable.expiresAt, new Date())))
      .limit(Math.min(Math.max(limit, 1), 500));
    for (const record of expired) {
      if (record.storageFileId) await storageService.deleteFile(record.storageFileId, record.userId).catch((error) => {
        logger.warn({ err: error, attachmentId: record.publicId }, '[OutreachAttachments] Expired object cleanup failed');
      });
      await db.delete(outreachMessageAttachmentsTable).where(eq(outreachMessageAttachmentsTable.id, record.id));
    }
    return expired.length;
  }
}

export class AttachmentValidationError extends Error {}
export { StorageLimitError };
export const outreachAttachmentService = new OutreachAttachmentService();
