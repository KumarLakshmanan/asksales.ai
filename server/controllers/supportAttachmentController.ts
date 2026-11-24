import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../models/db.js';
import { supportTicketsTable } from '../models/supportTickets/schema.js';
import { teamMembersTable } from '../models/teamMembers/schema.js';
import { StorageLimitError, StorageService, type FileCategory } from '../services/StorageService.js';
import { logger } from '../utils/logger.js';
import { contentDisposition } from '../utils/contentDisposition.js';
import { parsePositiveId as positiveId } from '../utils/paramParsers.js';

const MAX_SUPPORT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const supportAttachmentParser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SUPPORT_ATTACHMENT_BYTES, files: 1 },
}).single('file');

export function supportAttachmentUpload(req: Request, res: Response, next: NextFunction) {
  supportAttachmentParser(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Support attachments cannot exceed 10 MB' });
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Upload one support attachment at a time' });
    }
    logger.warn({ err: error }, '[SupportAttachment] Multipart request rejected');
    return res.status(400).json({ error: 'Invalid support attachment upload' });
  });
}

function validSignature(buffer: Buffer, mimeType: string) {
  if (mimeType.startsWith('text/')) return !buffer.subarray(0, 512).includes(0);
  if (mimeType === 'image/png') {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/gif') return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
  if (mimeType === 'image/webp') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType.includes('officedocument')) return buffer[0] === 0x50 && buffer[1] === 0x4b;
  return false;
}

function attachmentCategory(mimeType: string): FileCategory {
  return mimeType.startsWith('image/') ? 'image' : 'document';
}

async function ownerTicket(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  const ticketId = positiveId(req.params.id);
  if (!userId || !ticketId) return null;
  const [ticket] = await db.select().from(supportTicketsTable).where(and(
    eq(supportTicketsTable.id, ticketId),
    eq(supportTicketsTable.userId, userId),
    isNull(supportTicketsTable.deletedAt),
  )).limit(1);
  return ticket || null;
}

async function memberTicket(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const member = (req as any).supportMember as typeof teamMembersTable.$inferSelect | undefined;
  const ticketId = positiveId(req.params.id);
  if (!member || !ticketId) return null;
  const [ticket] = await db.select().from(supportTicketsTable).where(and(
    eq(supportTicketsTable.id, ticketId),
    eq(supportTicketsTable.userId, member.userId),
    isNull(supportTicketsTable.deletedAt),
  )).limit(1);
  if (!ticket) return null;
  const [membership] = await db.select({ teamId: teamMembersTable.teamId })
    .from(teamMembersTable)
    .where(eq(teamMembersTable.id, member.id))
    .limit(1);
  const hasAccess = ticket.assignedMemberId === member.id
    || (Boolean(ticket.teamId) && membership?.teamId === ticket.teamId);
  return hasAccess ? ticket : null;
}

async function uploadForTicket(req: Request, res: Response, portal: 'owner' | 'member') {
  try {
    const ticket = portal === 'owner' ? await ownerTicket(req) : await memberTicket(req);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file?.buffer.length) return res.status(400).json({ error: 'A non-empty file is required' });
    if (!ALLOWED_TYPES.has(file.mimetype) || !validSignature(file.buffer, file.mimetype)) {
      return res.status(400).json({ error: 'The file type is unsupported or does not match its contents' });
    }

    const result = await StorageService.getInstance().upload(file.buffer, {
      userId: ticket.userId,
      category: attachmentCategory(file.mimetype),
      originalName: path.basename(file.originalname).slice(0, 255) || 'attachment',
      mimeType: file.mimetype,
      referenceType: 'support_ticket',
      referenceId: String(ticket.id),
      metadata: { uploadedFrom: portal },
    });
    return res.status(201).json({
      success: true,
      data: {
        fileId: result.fileId,
        name: path.basename(file.originalname).slice(0, 255) || result.fileName,
        type: file.mimetype,
        size: result.fileSizeBytes,
      },
    });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    if (error instanceof StorageLimitError) return res.status(413).json({ error: error.message });
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Support attachments cannot exceed 10 MB' });
    }
    logger.error({ err: error, ticketId: req.params.id, portal }, '[SupportAttachment] Upload failed');
    return res.status(500).json({ error: 'Failed to upload attachment' });
  }
}

async function downloadForTicket(req: Request, res: Response, portal: 'owner' | 'member') {
  try {
    const ticket = portal === 'owner' ? await ownerTicket(req) : await memberTicket(req);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const fileId = positiveId(req.params.fileId);
    if (!fileId) return res.status(400).json({ error: 'Invalid attachment ID' });
    const storage = StorageService.getInstance();
    const file = await storage.getFile(fileId, ticket.userId);
    if (
      !file
      || file.referenceType !== 'support_ticket'
      || file.referenceId !== String(ticket.id)
    ) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    const downloaded = await storage.downloadFile(file.id, ticket.userId);
    if (!downloaded) return res.status(404).json({ error: 'Attachment not found' });
    const safeName = path.basename(file.originalName || file.fileName);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(downloaded.buffer.length));
    res.setHeader('Content-Disposition', contentDisposition(safeName, 'attachment'));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(downloaded.buffer);
  } catch (error) {
    logger.error({ err: error, ticketId: req.params.id, fileId: req.params.fileId, portal }, '[SupportAttachment] Download failed');
    return res.status(500).json({ error: 'Failed to download attachment' });
  }
}

export const uploadOwnerSupportAttachment = (req: Request, res: Response) => uploadForTicket(req, res, 'owner');
export const downloadOwnerSupportAttachment = (req: Request, res: Response) => downloadForTicket(req, res, 'owner');
export const uploadMemberSupportAttachment = (req: Request, res: Response) => uploadForTicket(req, res, 'member');
export const downloadMemberSupportAttachment = (req: Request, res: Response) => downloadForTicket(req, res, 'member');
