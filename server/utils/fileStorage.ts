/**
 * File Storage Utility
 * Routes all file operations through ObjectStorageService (S3/MinIO/local backend).
 * Maintains the same interface for backward compatibility with workers.
 */

import { logger } from './logger.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { MediaProbe } from '../services/media/MediaTranscodingService.js';

// Lazy-loaded storage service to avoid circular imports at module-load time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _storageService: any = null;
async function getStorageService() {
  if (!_storageService) {
    try {
      const mod = await import('../services/StorageService.js');
      _storageService = mod.StorageService.getInstance();
    } catch (err) {
      logger.warn({ err }, '[FileStorage] StorageService unavailable, falling back to direct disk writes');
    }
  }
  return _storageService;
}

// Get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base upload directory (fallback for when StorageService is unavailable)
const isDistBuild = __dirname.includes('/dist/') || __dirname.includes('\\dist\\');
const serverRoot = isDistBuild 
  ? path.join(__dirname, '..', '..', '..') // dist/utils -> server
  : path.join(__dirname, '..');            // utils -> server (dev)
const UPLOADS_DIR = path.join(serverRoot, 'uploads');

// Subdirectories for different file types
export const UPLOAD_PATHS = {
  images: path.join(UPLOADS_DIR, 'images'),
  videos: path.join(UPLOADS_DIR, 'videos'),
  documents: path.join(UPLOADS_DIR, 'documents'),
  temp: path.join(UPLOADS_DIR, 'temp'),
};

/**
 * Ensure all upload directories exist (fallback for direct disk writes)
 */
export async function ensureUploadDirectories(): Promise<void> {
  logger.info({ data: UPLOADS_DIR }, '[FileStorage] UPLOADS_DIR:');
  for (const dir of Object.values(UPLOAD_PATHS)) {
    await fs.mkdir(dir, { recursive: true });
  }
  logger.info({ paths: Object.values(UPLOAD_PATHS) }, '[FileStorage] Upload directories initialized');
}

/**
 * Generate a unique filename
 */
export function generateUniqueFilename(originalName: string, prefix: string = ''): string {
  const timestamp = Date.now();
  const randomStr = crypto.randomBytes(4).toString('hex');
  const ext = path.extname(originalName) || '.png';
  const baseName = prefix || path.basename(originalName, ext);
  return `${baseName}-${timestamp}-${randomStr}${ext}`;
}

/**
 * Get the extension from a mime type
 */
export function getExtensionFromMimeType(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
  };
  return mimeToExt[mimeType] || '.bin';
}

// Category mapping from file type to storage category
const categoryMap: Record<string, string> = {
  images: 'image',
  videos: 'video',
  documents: 'document',
  temp: 'general',
};

/**
 * Save a base64 encoded file via storage backend.
 */
export async function saveBase64File(
  base64Data: string,
  mimeType: string,
  type: 'images' | 'videos' | 'documents' | 'temp' = 'images',
  prefix: string = 'generated',
  userId?: number
): Promise<{ filePath: string; fileName: string; url: string }> {
  const ext = getExtensionFromMimeType(mimeType);
  const fileName = generateUniqueFilename(`${prefix}${ext}`, prefix);
  const base64Content = base64Data.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64Content, 'base64');

  // User-owned output must retain quota, ownership and durable tracking on every backend.
  if (userId) {
    const svc = await getStorageService();
    if (!svc) throw new Error('Tracked file storage is unavailable. Please retry.');
    if (svc) {
      try {
        const result = await svc.uploadBase64(base64Data, mimeType, {
          userId,
          category: categoryMap[type] || 'general',
          originalName: fileName,
          mimeType,
        });
        logger.info({ url: result.url }, `[FileStorage] Saved ${type.slice(0, -1)} via StorageService`);
        return { filePath: result.storageKey, fileName: result.fileName, url: result.url };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.warn({ err: err.message }, '[FileStorage] Tracked upload failed');
        throw err;
      }
    }
  }

  // Temporary/system output without an owner retains the existing disk path.
  await fs.mkdir(UPLOAD_PATHS[type], { recursive: true });
  const filePath = path.join(UPLOAD_PATHS[type], fileName);
  await fs.writeFile(filePath, buffer);
  const url = `/api/uploads/${type}/${fileName}`;
  logger.info({ data: filePath }, `[FileStorage] Saved ${type.slice(0, -1)} to disk (fallback)`);
  return { filePath, fileName, url };
}

/**
 * Save a buffer via storage backend.
 */
export async function saveBufferFile(
  buffer: Buffer,
  originalName: string,
  type: 'images' | 'videos' | 'documents' | 'temp' = 'images',
  prefix: string = 'uploaded',
  userId?: number
): Promise<{ filePath: string; fileName: string; url: string; mediaProbe?: MediaProbe }> {
  let mediaProbe: MediaProbe | undefined;
  if (type === 'videos') {
    const { transcodeMedia } = await import('../services/media/MediaTranscodingService.js');
    const normalized = await transcodeMedia(buffer, 'youtube');
    buffer = normalized.output;
    mediaProbe = normalized.probe;
    originalName = `${path.parse(originalName).name}.mp4`;
  }
  const fileName = generateUniqueFilename(originalName, prefix);

  // User-owned output must never bypass tracked storage on failure.
  if (userId) {
    const svc = await getStorageService();
    if (!svc) throw new Error('Tracked file storage is unavailable. Please retry.');
    if (svc) {
      try {
        const ext = path.extname(originalName).toLowerCase();
        const mimeGuess = guessMimeType(ext);
        const result = await svc.upload(buffer, {
          userId,
          category: categoryMap[type] || 'general',
          originalName: fileName,
          mimeType: mimeGuess,
          ...(mediaProbe ? { metadata: { mediaProbe } } : {}),
        });
        logger.info({ url: result.url }, `[FileStorage] Saved ${type.slice(0, -1)} via StorageService`);
        return { filePath: result.storageKey, fileName: result.fileName, url: result.url, ...(mediaProbe ? { mediaProbe } : {}) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.warn({ err: err.message }, '[FileStorage] Tracked upload failed');
        throw err;
      }
    }
  }

  // Fallback: direct disk write
  await fs.mkdir(UPLOAD_PATHS[type], { recursive: true });
  const filePath = path.join(UPLOAD_PATHS[type], fileName);
  await fs.writeFile(filePath, buffer);
  const url = `/uploads/${type}/${fileName}`;
  logger.info({ data: filePath }, `[FileStorage] Saved ${type.slice(0, -1)} to disk (fallback)`);
  return { filePath, fileName, url, ...(mediaProbe ? { mediaProbe } : {}) };
}

function guessMimeType(ext: string): string | undefined {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf', '.json': 'application/json',
  };
  return map[ext];
}

/**
 * Delete a file from uploads
 */
export async function deleteFile(
  fileName: string,
  type: 'images' | 'videos' | 'documents' | 'temp' = 'images'
): Promise<boolean> {
  try {
    const filePath = path.join(UPLOAD_PATHS[type], fileName);
    await fs.unlink(filePath);
    logger.info({ data: filePath }, `[FileStorage] Deleted file:`);
    return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      logger.error({ err: error.message }, `[FileStorage] Error deleting file:`);
    }
    return false;
  }
}

