/**
 * Storage Tracking Hooks
 * 
 * Lightweight functions that existing upload flows can call to register
 * files with the storage tracking system. These don't change how files
 * are stored — they just record metadata and update usage counters.
 * 
 * Usage:
 *   import { trackFileUpload, trackFileDelete } from '../services/StorageTrackingHooks';
 *   // After a file is successfully saved:
 *   await trackFileUpload({ userId, filePath, fileName, ... });
 */

import { storageService, type FileCategory } from './StorageService.js';
import { db } from '../models/db';
import { storageFilesTable } from '../models/storageFiles/schema';
import { storageQuotasTable } from '../models/storageQuotas/schema';
import { storagePlansTable } from '../models/storagePlans/schema';
import { eq, sql, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';

export interface TrackUploadParams {
  userId: number;
  fileName: string;
  originalName?: string;
  storageKey: string;
  mimeType?: string;
  fileSizeBytes?: number;
  category: FileCategory;
  referenceType?: string;
  referenceId?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Register an already-saved file with the storage tracking system.
 * Call this after multer or saveBase64File has written the file.
 * Non-blocking: catches all errors so it never breaks existing flows.
 */
export async function trackFileUpload(params: TrackUploadParams): Promise<number | null> {
  try {
    const {
      userId, fileName, originalName, storageKey, mimeType,
      fileSizeBytes, category, referenceType, referenceId, url, metadata,
    } = params;

    // Resolve file size if not provided (try to stat the file)
    let sizeBytes = fileSizeBytes ?? 0;
    if (!sizeBytes && storageKey) {
      try {
        const stat = await fs.stat(storageKey);
        sizeBytes = stat.size;
      } catch {
        // File may be on S3 or path may not be absolute — size stays 0
      }
    }

    const backendName = process.env.STORAGE_BACKEND || 'local';

    // Ensure quota exists
    await ensureQuotaExists(userId);

    // Insert file record
    const [fileRecord] = await db
      .insert(storageFilesTable)
      .values({
        userId,
        fileName,
        originalName: originalName || fileName,
        storageKey,
        storageBackend: backendName,
        mimeType: mimeType || null,
        fileSizeBytes: sizeBytes,
        category,
        referenceType: referenceType || null,
        referenceId: referenceId || null,
        url: url || null,
        metadata: metadata || {},
      })
      .returning();

    // Increment usage
    if (sizeBytes > 0) {
      await db
        .update(storageQuotasTable)
        .set({
          storageUsedBytes: sql`${storageQuotasTable.storageUsedBytes} + ${sizeBytes}`,
          fileCount: sql`${storageQuotasTable.fileCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(storageQuotasTable.userId, userId));
    }

    logger.info(
      { userId, fileId: fileRecord?.id, category, sizeBytes },
      '[StorageTracking] File tracked'
    );

    return fileRecord?.id ?? null;
  } catch (error) {
    logger.error({ err: error, userId: params.userId }, '[StorageTracking] Failed to track upload');
    return null; // Never break the caller
  }
}

/**
 * Unregister a file from storage tracking when it's deleted.
 * Non-blocking: catches all errors.
 */
export async function trackFileDelete(storageKey: string, userId: number): Promise<void> {
  try {
    const [file] = await db
      .select()
      .from(storageFilesTable)
      .where(and(
        eq(storageFilesTable.storageKey, storageKey),
        eq(storageFilesTable.userId, userId),
        eq(storageFilesTable.isDeleted, false)
      ))
      .limit(1);

    if (!file) return;

    await db
      .update(storageFilesTable)
      .set({ isDeleted: true, deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(storageFilesTable.id, file.id));

    if (file.fileSizeBytes > 0) {
      await db
        .update(storageQuotasTable)
        .set({
          storageUsedBytes: sql`GREATEST(${storageQuotasTable.storageUsedBytes} - ${file.fileSizeBytes}, 0)`,
          fileCount: sql`GREATEST(${storageQuotasTable.fileCount} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(storageQuotasTable.userId, userId));
    }

    logger.info({ userId, fileId: file.id, storageKey }, '[StorageTracking] File delete tracked');
  } catch (error) {
    logger.error({ err: error, userId, storageKey }, '[StorageTracking] Failed to track delete');
  }
}

/**
 * Track and store a generated output (e.g., Apify actor JSON, audio buffers).
 * Uploads the data to the storage backend and records metadata.
 * Non-blocking — catches all errors.
 */
export async function trackGeneratedOutput(params: {
  userId: number;
  buffer?: Buffer;
  content?: string;
  category: FileCategory;
  fileName: string;
  referenceType?: string;
  referenceId?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  /** Override the auto-generated storage key for structured paths */
  storageKey?: string;
}): Promise<number | null> {
  try {
    const buf = params.buffer
      ?? (params.content ? Buffer.from(params.content, 'utf-8') : null);
    if (!buf || buf.length === 0) return null;

    const result = await storageService.upload(buf, {
      userId: params.userId,
      category: params.category,
      originalName: params.fileName,
      mimeType: params.mimeType || 'application/octet-stream',
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      metadata: params.metadata,
      storageKey: params.storageKey,
    });

    logger.info(
      { userId: params.userId, fileId: result.fileId, category: params.category, size: result.fileSizeBytes },
      '[StorageTracking] Generated output stored'
    );
    return result.fileId;
  } catch (error) {
    logger.error({ err: error, userId: params.userId, category: params.category }, '[StorageTracking] Failed to store generated output');
    return null;
  }
}

// ── Helper ──────────────────────────────────────────────────────────────────────

async function ensureQuotaExists(userId: number): Promise<void> {
  const [existing] = await db
    .select({ id: storageQuotasTable.id })
    .from(storageQuotasTable)
    .where(eq(storageQuotasTable.userId, userId))
    .limit(1);

  if (existing) return;

  const [defaultPlan] = await db
    .select()
    .from(storagePlansTable)
    .where(eq(storagePlansTable.isDefault, true))
    .limit(1);

  await db
    .insert(storageQuotasTable)
    .values({
      userId,
      planId: defaultPlan?.id || null,
      storageUsedBytes: 0,
      fileCount: 0,
    })
    .onConflictDoNothing();
}
