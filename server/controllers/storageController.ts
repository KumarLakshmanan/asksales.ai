import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
/**
 * Storage Controller
 * 
 * User-facing endpoints for viewing storage usage and managing files.
 */

import { Request, Response } from 'express';
import { storageService, StorageLimitError, type FileCategory, type StorageFileSort } from '../services/StorageService.js';
import { logger } from '../utils/logger.js';

function parseBoundedPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function parseNonNegativeInt(value: unknown, fallback = 0, max = 1_000_000): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

const STORAGE_UPLOAD_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv', 'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/mpeg', 'audio/wav', 'video/mp4', 'video/webm',
]);

function hasValidSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return !buffer.subarray(0, 512).includes(0);
  if (mimeType === 'application/json') {
    try { JSON.parse(buffer.toString('utf8')); return true; } catch { return false; }
  }
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/gif') return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType.includes('officedocument')) return buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (mimeType === 'audio/wav') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  if (mimeType === 'audio/mpeg') return buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  if (mimeType === 'video/mp4') return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'video/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

function categoryForMime(mimeType: string): FileCategory {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'document';
  return 'document';
}

export async function getMyStorageUsage(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const summary = await storageService.getUsageSummary(userId);
    return res.json({ success: true, data: summary });
  } catch (error) {
    logger.error({ err: error }, '[Storage] Failed to get usage');
    return res.status(500).json({ error: 'Failed to fetch storage usage' });
  }
}

export async function uploadMyFile(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file || file.buffer.length === 0)
      return res.status(400).json({ error: "A non-empty file is required" });
    if (
      !STORAGE_UPLOAD_MIME_TYPES.has(file.mimetype) ||
      !hasValidSignature(file.buffer, file.mimetype)
    ) {
      return res
        .status(400)
        .json({
          error: "The file type is unsupported or does not match its contents",
        });
    }
    const uploadReceipt = req.headers["x-storage-upload-id"];
    if (uploadReceipt !== undefined) {
      if (
        typeof uploadReceipt !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          uploadReceipt,
        )
      )
        return res.status(400).json({ error: "Invalid upload receipt" });
      const { uploadWorkspaceFile } =
        await import("../services/storageWorkspace.js");
      const result = await uploadWorkspaceFile(
        userId,
        file,
        categoryForMime(file.mimetype),
        uploadReceipt,
      );
      return res.status(201).json({ success: true, data: result });
    }
    const result = await storageService.upload(file.buffer, {
      userId,
      category: categoryForMime(file.mimetype),
      originalName: file.originalname,
      mimeType: file.mimetype,
      referenceType: "user_upload",
    });
    const stored = await storageService.getFile(result.fileId, userId);
    return res
      .status(201)
      .json({
        success: true,
        data: stored ? { ...stored, url: result.url } : null,
      });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError)
      return res.status(capacityError.status).json(capacityError.toJSON());
    if (error instanceof StorageLimitError)
      return res.status(413).json({ error: error.message });
    if (error instanceof Error && error.name === "StorageWorkspaceError")
      return res
        .status((error as Error & { status: number }).status)
        .json({ error: error.message });
    logger.error({ err: error }, "[Storage] Failed to upload file");
    return res.status(500).json({ error: "Failed to upload file" });
  }
}

export async function getMyFiles(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (category && !/^[a-z][a-z0-9_]{0,99}$/.test(category)) {
      return res.status(400).json({ error: 'Invalid storage category' });
    }
    const search = req.query.search;
    if (search !== undefined && (typeof search !== 'string' || search.length > 255)) {
      return res.status(400).json({ error: 'Search must be text of at most 255 characters' });
    }
    const sort = req.query.sort ?? 'newest';
    if (typeof sort !== 'string' || !['newest', 'oldest', 'name', 'size'].includes(sort)) {
      return res.status(400).json({ error: 'Invalid storage sort order' });
    }
    const folder = req.query.folder;
    if (folder !== undefined && (typeof folder !== 'string' || !folder || folder.length > 950 || category !== 'actor_output')) {
      return res.status(400).json({ error: 'Invalid actor run folder' });
    }
    const limit = parseBoundedPositiveInt(req.query.limit, 50, 200);
    const offset = parseNonNegativeInt(req.query.offset);

    const { files, total } = await storageService.listFiles(userId, {
      category, search: typeof search === 'string' ? search.trim() : undefined,
      sort: sort as StorageFileSort, folder: typeof folder === 'string' ? folder : undefined,
      limit, offset,
    });
    return res.json({
      success: true,
      data: {
        files,
        total,
        pagination: { limit, offset, hasMore: offset + files.length < total },
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[Storage] Failed to get files');
    return res.status(500).json({ error: 'Failed to fetch files' });
  }
}

export async function deleteMyFile(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const fileId = parseInt(req.params.fileId, 10);
    if (!Number.isInteger(fileId) || fileId <= 0) return res.status(400).json({ error: 'Invalid file ID' });
    const deleted = await storageService.deleteFile(fileId, userId, undefined, 'storage_delete');
    if (!deleted) return res.status(404).json({ error: 'File not found' });
    return res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    logger.error({ err: error }, '[Storage] Failed to delete file');
    return res.status(500).json({ error: 'Failed to delete file' });
  }
}

export async function deleteMyFiles(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { fileIds } = req.body;
    if (!Array.isArray(fileIds) || fileIds.length === 0 || fileIds.length > 200) {
      return res.status(400).json({ error: 'fileIds must contain between 1 and 200 IDs' });
    }
    const ids = [...new Set(fileIds)];
    if (!ids.every((id) => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: 'fileIds must contain positive integer IDs' });
    }
    const deletedCount = await storageService.deleteFiles(ids, userId, undefined, 'storage_delete');
    return res.json({ success: true, deletedCount });
  } catch (error) {
    logger.error({ err: error }, '[Storage] Failed to bulk delete files');
    return res.status(500).json({ error: 'Failed to delete files' });
  }
}

export async function checkUploadAllowed(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const fileSizeBytes = parseNonNegativeInt(req.query.size, -1, 5 * 1024 * 1024 * 1024);
    if (fileSizeBytes < 0) return res.status(400).json({ error: 'A valid file size is required' });
    const result = await storageService.canUpload(userId, fileSizeBytes);
    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ err: error }, '[Storage] Failed to check upload');
    return res.status(500).json({ error: 'Failed to check upload allowance' });
  }
}

export async function downloadMyFile(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const fileId = Number(req.params.fileId);
    if (!Number.isSafeInteger(fileId) || fileId <= 0) return res.status(400).json({ error: 'Invalid file ID' });

    // Generated private URLs use this legacy endpoint too. Share the scoped
    // streaming path so large outputs remain bounded and ranges/cancellation
    // propagate to the object stream instead of buffering the entire file.
    const { streamStorageFile } = await import('./storageWorkspaceController.js');
    return await streamStorageFile(req, res);
  } catch (error) {
    logger.error({ err: error }, '[Storage] Failed to download file');
    return res.status(500).json({ error: 'Failed to download file' });
  }
}

export async function renameMyFile(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const fileId = Number(req.params.fileId);
    if (!Number.isSafeInteger(fileId) || fileId <= 0) return res.status(400).json({ error: 'Invalid file ID' });
    const originalName: string = typeof req.body?.originalName === 'string' ? req.body.originalName.trim() : '';
    const hasControlCharacter = Array.from(originalName).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    if (!originalName || originalName.length > 255 || hasControlCharacter) {
      return res.status(400).json({ error: 'File name must contain 1 to 255 printable characters' });
    }
    const file = await storageService.renameFile(fileId, userId, originalName);
    if (!file) return res.status(404).json({ error: 'File not found' });
    return res.json({ success: true, data: file });
  } catch (error) {
    logger.error({ err: error }, '[Storage] Failed to rename file');
    return res.status(500).json({ error: 'Failed to rename file' });
  }
}
