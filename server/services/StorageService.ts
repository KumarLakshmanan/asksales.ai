/**
 * Storage Service
 * 
 * Unified storage abstraction layer that wraps the underlying storage backend
 * (local filesystem or S3) with automatic file tracking, quota enforcement,
 * and usage accounting.
 * 
 * All file uploads/deletions in the application should go through this service
 * to ensure accurate storage tracking per tenant.
 */

import { db } from '../models/db';
import { assertStorageReferenceScope, lockManagedStorageReferences, lockManagedStorageObjects, ManagedStorageReferenceError, type StorageReferenceScope, type ManagedStorageTransaction } from './storageReferenceLocks.js';
import { consumeManagedStorageCleanup } from './managedStorageCleanup.js';

import { businessAuditActor, currentBusinessScope, requireBusinessScope } from "../tenancy/businessContext.js";
import { storageFilesTable, type StorageFileRecord } from '../models/storageFiles/schema';
import { storageQuotasTable } from '../models/storageQuotas/schema';
import { storagePlansTable } from '../models/storagePlans/schema';
import { objectStorage, type StorageBackend } from './ObjectStorageService.js';
import { eq, and, sql, asc, desc, count, inArray, isNull, or, ilike } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import path from 'path';
import { fetchPublicHttpUrl, readResponseBuffer } from '../utils/safeRemoteFetch.js';
import { releaseOrganizationStorage, reserveOrganizationStorage, storageOrganizationEntitlements } from './billing/entitlements.js';

const PRIVATE_STORAGE_CATEGORIES = new Set<FileCategory>([
  'knowledge_base', 'support_media', 'lead_import', 'actor_output', 'document', 'audio', 'general',
]);

// ─── Types ──────────────────────────────────────────────────────────────────────

// Internal call-site authority only; never populated from request bodies.
// Ordinary domain cleanup preserves durable holders. These named paths retain
// the existing authenticated Storage deletion and Trash retention authority.
export type StorageDeletionIntent = 'unreferenced' | 'storage_delete' | 'trash_purge' | 'trash_expiry';

export type FileCategory =
  | 'image'
  | 'video'
  | 'document'
  | 'knowledge_base'
  | 'support_media'
  | 'brand_asset'
  | 'content_asset'
  | 'lead_import'
  | 'actor_output'
  | 'audio'
  | 'general';

export interface UploadOptions {
  userId: number;
  category: FileCategory;
  originalName?: string;
  mimeType?: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  /** Override auto-generated storage key */
  storageKey?: string;
}

export interface UploadResult {
  fileId: number;
  storageKey: string;
  url: string;
  fileName: string;
  fileSizeBytes: number;
}

export interface StorageUsageSummary {
  storageUsedBytes: number;
  maxStorageBytes: number;
  fileCount: number;
  usagePercent: number;
  planName: string | null;
  breakdown: { category: string; bytes: number; count: number }[];
}

export type StorageFileSort = 'newest' | 'oldest' | 'name' | 'size';

// ─── Service ────────────────────────────────────────────────────────────────────

export class StorageService {
  private static instance: StorageService;
  private backend: StorageBackend;

  private constructor() {
    this.backend = objectStorage;
  }

  static getInstance(): StorageService {
    if (!this.instance) this.instance = new StorageService();
    return this.instance;
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  /**
   * Upload a file buffer through the abstraction layer.
   * Checks quota, stores the file, records metadata, and updates usage.
   */
  async upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { userId, category, originalName, mimeType, referenceType, referenceId, metadata } = options;
    const fileSizeBytes = buffer.length;
    if (!Number.isSafeInteger(userId) || userId <= 0 || fileSizeBytes <= 0) {
      throw new Error('A valid user and non-empty file are required');
    }

    if (options.storageKey && !options.storageKey.startsWith(`${userId}/${category}/`)) {
      throw new Error('Custom storage keys must remain inside the user and category namespace');
    }
    const requestedStorageKey = options.storageKey || this.generateStorageKey(userId, category, originalName || 'file');
    const [existing] = await db
      .select()
      .from(storageFilesTable)
      .where(and(
        eq(storageFilesTable.userId, userId),
        eq(storageFilesTable.isDeleted, false),
        sql`(${storageFilesTable.storageKey} = ${requestedStorageKey} OR ${storageFilesTable.metadata}->>'requestedStorageKey' = ${requestedStorageKey})`,
      ))
      .limit(1);

    // Replacements are uploaded under a revision key first. The database is
    // switched only after the new object exists, so a failed write cannot
    // destroy the previous live object.
    const storageKey = options.storageKey
      ? this.generateReplacementKey(requestedStorageKey)
      : requestedStorageKey;
    const fileName = path.basename(storageKey);
    const backendName = process.env.STORAGE_BACKEND || 'local';
    const sizeDelta = fileSizeBytes - Number(existing?.fileSizeBytes || 0);
    const countDelta = existing ? 0 : 1;
    const reservedBytesDelta = Math.max(sizeDelta, 0);

    await this.getOrCreateQuota(userId);
    const organizationReservation = await reserveOrganizationStorage(userId, reservedBytesDelta);
    try {
      if (!await this.reserveUsage(userId, reservedBytesDelta, countDelta)) throw new Error('Unable to reserve storage accounting');
    } catch (error) {
      await releaseOrganizationStorage(organizationReservation);
      throw error;
    }

    let objectUploaded = false;
    try {
      const url = await this.backend.upload(storageKey, buffer, mimeType || 'application/octet-stream', {
        userId: String(userId),
        category,
        ...(referenceType ? { referenceType } : {}),
        ...(referenceId ? { referenceId } : {}),
      });
      objectUploaded = true;

      const nextMetadata = {
        ...(existing?.metadata || {}),
        ...(metadata || {}),
        ...(options.storageKey ? { requestedStorageKey } : {}),
        // Persist replacement cleanup before the new metadata can commit.
        ...(existing && existing.storageKey !== storageKey ? { pendingCleanupKeys: [...new Set([
          ...(Array.isArray(existing.metadata?.pendingCleanupKeys) ? existing.metadata.pendingCleanupKeys.filter((key: unknown): key is string => typeof key === 'string') : []),
          existing.storageKey,
        ])] } : {}),
      };
      const fileRecord = await db.transaction(async (tx: typeof db): Promise<StorageFileRecord> => {
        // Release the held bytes and claim the durable file in one transaction.
        // The storage_files trigger applies the organization limit to every path,
        // including imports or writes that do not use this service.
        await releaseOrganizationStorage(organizationReservation, tx);
        const business=requireBusinessScope();
        await lockManagedStorageReferences(tx,{userId,businessProfileId:business.businessProfileId});
        await lockManagedStorageObjects(tx,[{userId,businessProfileId:business.businessProfileId,fileId:existing?.id??0,storageBackend:backendName,storageKey},
          ...(existing?[{userId,businessProfileId:business.businessProfileId,fileId:existing.id,storageBackend:existing.storageBackend,storageKey:existing.storageKey}]:[])]);
        if(existing) {
          const refs=await tx.execute(sql`SELECT 1 FROM storage_managed_references WHERE storage_file_id=${existing.id} AND user_id=${userId} LIMIT 1`);
          if(refs.rows.length) throw new ManagedStorageReferenceError('This object revision has durable references. Upload a new object before replacing its references.');
        }
        let record: StorageFileRecord | undefined;
        if (existing) {
          [record] = await tx
            .update(storageFilesTable)
            .set({
              fileName,
              originalName: originalName || fileName,
              storageKey,
              storageBackend: backendName,
              mimeType: mimeType || null,
              fileSizeBytes,
              category,
              referenceType: referenceType || null,
              referenceId: referenceId || null,
              url,
              metadata: nextMetadata,
              updatedAt: new Date(),
            })
            .where(and(
              eq(storageFilesTable.id, existing.id),
              eq(storageFilesTable.userId, userId),
              eq(storageFilesTable.isDeleted, false),
              eq(storageFilesTable.storageKey, existing.storageKey),
            ))
            .returning();
        } else {
          [record] = await tx
            .insert(storageFilesTable)
            .values({
              userId,
              fileName,
              originalName: originalName || fileName,
              storageKey,
              storageBackend: backendName,
              mimeType: mimeType || null,
              fileSizeBytes,
              category,
              referenceType: referenceType || null,
              referenceId: referenceId || null,
              url,
              metadata: nextMetadata,
            })
            .returning();
        }
        if (!record) throw new Error('Unable to persist storage metadata');
        return record;
      });

      // Do not expose reclaimed capacity until the replacement metadata has
      // committed. If this accounting update fails, usage remains safely
      // overstated and can be repaired by the existing recalculation action.
      if (sizeDelta < 0) {
        try {
          await this.releaseUsage(userId, -sizeDelta, 0);
        } catch (usageError) {
          logger.error({ err: usageError, userId, fileId: fileRecord.id, sizeDelta }, '[StorageService] Failed to apply replacement quota reduction');
        }
      }

      let accessUrl = url;
      if (PRIVATE_STORAGE_CATEGORIES.has(category)) {
        accessUrl = `/api/settings/storage/files/${fileRecord.id}/download?inline=true`;
      }

      if (existing && existing.storageKey !== storageKey) {
        await this.deleteObjectOrRecordCleanup(fileRecord, existing.storageKey);
      }

      logger.info(
        { userId, fileId: fileRecord.id, storageKey, size: fileSizeBytes, category },
        '[StorageService] File uploaded'
      );

      return {
        fileId: fileRecord.id,
        storageKey,
        url: accessUrl,
        fileName,
        fileSizeBytes,
      };
    } catch (error) {
      try {
        await releaseOrganizationStorage(organizationReservation);
      } catch (releaseError) {
        logger.error({ err: releaseError, userId, reservationId: organizationReservation.id }, '[StorageService] Failed to release organization upload reservation');
      }
      try {
        await this.releaseUsage(userId, reservedBytesDelta, countDelta);
      } catch (releaseError) {
        logger.error({ err: releaseError, userId, reservedBytesDelta, countDelta }, '[StorageService] Failed to release upload reservation');
      }
      if (objectUploaded) {
        try {
          await this.backend.delete(storageKey);
        } catch (cleanupError) {
          logger.error({ err: cleanupError, userId, storageKey }, '[StorageService] Failed to remove unattached object');
          await this.recordOrphanCleanup(userId, storageKey, backendName);
        }
      }
      throw error;
    }
  }

  /**
   * Upload from a base64 string.
   */
  async uploadBase64(base64Data: string, mimeType: string, options: UploadOptions): Promise<UploadResult> {
    const base64Content = base64Data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Content, 'base64');
    return this.upload(buffer, { ...options, mimeType });
  }

  /**
   * Upload from a URL (download then store).
   */
  async uploadFromUrl(fileUrl: string, options: UploadOptions): Promise<UploadResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    timeout.unref?.();
    let response: Response;
    let finalUrl: string;
    try {
      ({ response, finalUrl } = await fetchPublicHttpUrl(fileUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'SalesMarketingStorage/1.0' },
      }, 3));
      if (!response.ok) throw new Error(`Failed to download file: HTTP ${response.status}`);
      const maxBytes = Math.min(
        Math.max(Number(process.env.MAX_REMOTE_STORAGE_UPLOAD_BYTES) || 100 * 1024 * 1024, 1024),
        250 * 1024 * 1024,
      );
      const buffer = await readResponseBuffer(response, maxBytes);
      if (buffer.length === 0) throw new Error('The remote file is empty');
      const mimeType = options.mimeType || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      return await this.upload(buffer, {
        ...options,
        mimeType,
        metadata: { ...(options.metadata || {}), sourceUrl: finalUrl },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  /** Called inside profile deletion's transaction; linked business records still
   * block that deletion and roll back the metadata, usage and cleanup receipts. */
  async deleteBusinessSetupAssets(tx: typeof db, userId: number, profileId: number): Promise<string[]> {
    const scope = requireBusinessScope();
    if (scope.userId !== userId || scope.businessProfileId !== profileId ||
        (scope.actorUserId ?? scope.userId) !== userId) throw new Error('Business owner scope required');
    const files = await tx.execute(sql`DELETE FROM storage_files WHERE business_profile_id=${profileId} AND user_id=${userId}
      AND category='brand_asset' AND reference_type IN('website_screenshot','brand_toolkit_logo','brand_toolkit_image') RETURNING *`);
    const receiptIds: string[] = [];
    for (const file of files.rows) {
      const keys = [file.storage_key, ...(Array.isArray(file.metadata?.pendingCleanupKeys) ? file.metadata.pendingCleanupKeys : [])];
      for (const key of new Set(keys)) {
        if (typeof key !== 'string' || !key.startsWith(`${userId}/brand_asset/`)) throw new Error('Invalid setup asset namespace');
        const receipt = await tx.execute(sql`INSERT INTO business_profile_asset_cleanup(user_id,storage_key,storage_backend)
          VALUES(${userId},${key},${file.storage_backend})
          ON CONFLICT(user_id,storage_key,storage_backend) DO UPDATE SET storage_key=EXCLUDED.storage_key RETURNING id`);
        receiptIds.push(String(receipt.rows[0].id));
      }
      if (!file.is_deleted) await tx.execute(sql`UPDATE storage_quotas SET
        storage_used_bytes=GREATEST(storage_used_bytes-${Number(file.file_size_bytes)},0),
        file_count=GREATEST(file_count-1,0),updated_at=now() WHERE user_id=${userId}`);
    }
    return receiptIds;
  }

  /** Caller-enlisted deletion claim: existing quota and committed cleanup intent,
   * no object IO and no commit of the caller's transaction. */
  async claimFileDeletion(
    tx: ManagedStorageTransaction,
    fileId: number,
    userId: number,
    trashBefore?: Date,
    intent: StorageDeletionIntent = 'unreferenced',
  ): Promise<StorageFileRecord | null> {
    if (!['unreferenced', 'storage_delete', 'trash_purge', 'trash_expiry'].includes(intent)
      || (['trash_purge', 'trash_expiry'].includes(intent) && !trashBefore)) {
      throw new ManagedStorageReferenceError('Invalid storage deletion intent');
    }
    const business = currentBusinessScope();
    const profileId = business?.businessProfileId ?? Number((await tx.execute(sql`
      SELECT business_profile_id FROM storage_files WHERE id=${fileId} AND user_id=${userId}
    `)).rows[0]?.business_profile_id);
    if (!profileId) return null;
    await lockManagedStorageReferences(tx, { userId, businessProfileId: profileId });
    const [object] = await tx.select().from(storageFilesTable).where(and(
      eq(storageFilesTable.id, fileId), eq(storageFilesTable.userId, userId),
    )).limit(1);
    if (!object) return null;
    await lockManagedStorageObjects(tx, [{ userId, businessProfileId: profileId, fileId,
      storageBackend: object.storageBackend, storageKey: object.storageKey }]);
    const eligible = and(
      eq(storageFilesTable.id, fileId),
      eq(storageFilesTable.userId, userId),
      eq(storageFilesTable.isDeleted, false),
      ...(trashBefore ? [sql`${storageFilesTable.metadata} #>> '{storageWorkspace,trashedAt}' IS NOT NULL
        AND (${storageFilesTable.metadata} #>> '{storageWorkspace,trashedAt}')::timestamptz <= ${trashBefore.toISOString()}::timestamptz`] : []),
    );
    if (intent !== 'unreferenced') {
      // Validate the existing governed path before removing protection. This is
      // the same transaction/object lock as registration and the delete claim.
      const [current] = await tx.select().from(storageFilesTable).where(eligible).for('update');
      if (!current) return null;
      await tx.execute(sql`DELETE FROM storage_managed_references WHERE storage_file_id=${fileId}
        AND user_id=${userId} AND business_profile_id=${profileId}`);
    }
    const revocation = intent === 'unreferenced' ? {} : {
      managedRevocation: { reason: intent, at: new Date().toISOString(),
        ...(business ? { actorUserId: business.actorUserId ?? business.userId } : {}) },
    };
    const [claimed] = await tx.update(storageFilesTable).set({
      isDeleted: true,
      deletedAt: new Date(),
      updatedAt: new Date(),
      metadata: sql`jsonb_set(COALESCE(${storageFilesTable.metadata}, '{}'::jsonb), '{pendingCleanupKeys}',
        COALESCE(${storageFilesTable.metadata}->'pendingCleanupKeys', '[]'::jsonb)
        || jsonb_build_array(${storageFilesTable.storageKey})) || ${JSON.stringify(revocation)}::jsonb`,
    }).where(and(eligible, ...(intent === 'unreferenced' ? [sql`NOT EXISTS (
      SELECT 1 FROM storage_managed_references r WHERE r.storage_file_id=${storageFilesTable.id} AND r.user_id=${userId}
    )`] : []))).returning();
    if (!claimed) return null;
    if (trashBefore) await tx.execute(sql`UPDATE storage_files SET metadata = jsonb_set(metadata, '{storageWorkspace,events}',
      (CASE WHEN jsonb_array_length(COALESCE(metadata #> '{storageWorkspace,events}', '[]'::jsonb)) >= 100
        THEN (metadata #> '{storageWorkspace,events}') - 0 ELSE COALESCE(metadata #> '{storageWorkspace,events}', '[]'::jsonb) END)
      || jsonb_build_array(jsonb_build_object('action','purged','at',CURRENT_TIMESTAMP,'actorUserId',${businessAuditActor(userId)}::integer)))
      WHERE id=${claimed.id} AND user_id=${userId}`);
    await tx.update(storageQuotasTable).set({
      storageUsedBytes: sql`GREATEST(${storageQuotasTable.storageUsedBytes} - ${claimed.fileSizeBytes}, 0)`,
      fileCount: sql`GREATEST(${storageQuotasTable.fileCount} - 1, 0)`,
      updatedAt: new Date(),
    }).where(eq(storageQuotasTable.userId, userId));
    return claimed;
  }

  /** Soft-delete a file: mark as deleted and reclaim quota. */
  async deleteFile(
    fileId: number,
    userId: number,
    trashBefore?: Date,
    intent: StorageDeletionIntent = 'unreferenced',
  ): Promise<boolean> {
    const file = await db.transaction((tx: ManagedStorageTransaction) => this.claimFileDeletion(tx, fileId, userId, trashBefore, intent));

    if (!file) return false;

    // Remove from backend
    await this.deleteObjectOrRecordCleanup(file, file.storageKey);

    logger.info(
      { userId, fileId, storageKey: file.storageKey },
      "[StorageService] File deleted",
    );
    return true;
  }

  /** After a failed caller transaction has rolled back, compensate only a
   * tracked upload that no committed durable holder acquired. False means no
   * deletion was claimed; true may still have a durable provider-cleanup retry. */
  async compensateFailedUpload(scope: StorageReferenceScope, fileId: number): Promise<boolean> {
    assertStorageReferenceScope(scope);
    if (!Number.isSafeInteger(fileId) || fileId <= 0)
      throw new ManagedStorageReferenceError('Invalid failed-upload file ID');
    const file = await this.getFile(fileId, scope.userId);
    if (!file || file.businessProfileId !== scope.businessProfileId) return false;
    return this.deleteFile(fileId, scope.userId);
  }

  /**
   * Bulk soft-delete multiple files for a user. Returns count of deleted files.
   */
  async deleteFiles(
    fileIds: number[],
    userId: number,
    trashBefore?: Date,
    intent: StorageDeletionIntent = 'unreferenced',
  ): Promise<number> {
    if (!fileIds.length) return 0;
    let deleted = 0;
    for (const fileId of fileIds) {
      const ok = await this.deleteFile(fileId, userId, trashBefore, intent);
      if (ok) deleted++;
    }
    return deleted;
  }

  /**
   * Delete a file by storage key.
   */
  async deleteByStorageKey(storageKey: string, userId: number): Promise<boolean> {
    const [file] = await db
      .select()
      .from(storageFilesTable)
      .where(and(eq(storageFilesTable.storageKey, storageKey), eq(storageFilesTable.userId, userId)))
      .limit(1);

    if (!file) return false;
    return this.deleteFile(file.id, userId);
  }

  /**
   * Delete a file by URL.
   */
  async deleteByUrl(url: string, userId: number): Promise<boolean> {
    if (!url) return false;
    const cleanUrl = url.split('?')[0];
    const [file] = await db
      .select()
      .from(storageFilesTable)
      .where(
        and(
          eq(storageFilesTable.userId, userId),
          eq(storageFilesTable.isDeleted, false),
          or(
            eq(storageFilesTable.url, url),
            eq(storageFilesTable.url, cleanUrl),
            sql`split_part(split_part(${storageFilesTable.url}, '?', 1), '#', 1) = ${cleanUrl}`,
          ),
        )
      )
      .limit(1);

    if (!file) return false;
    return this.deleteFile(file.id, userId);
  }

  /**
   * Download an active tenant-owned file by its durable public URL.
   * Used by post-processing flows that must transform an already stored file.
   */
  async downloadByUrl(url: string, userId: number): Promise<{ buffer: Buffer; file: StorageFileRecord } | null> {
    if (!url || !Number.isSafeInteger(userId) || userId <= 0) return null;
    const cleanUrl = url.split('?')[0].split('#')[0];
    const [file] = await db
      .select()
      .from(storageFilesTable)
      .where(and(
        eq(storageFilesTable.userId, userId),
        eq(storageFilesTable.isDeleted, false),
        or(
          eq(storageFilesTable.url, url),
          eq(storageFilesTable.url, cleanUrl),
          sql`split_part(split_part(${storageFilesTable.url}, '?', 1), '#', 1) = ${cleanUrl}`,
        ),
      ))
      .limit(1);
    if (!file) return null;
    return { buffer: await this.backend.download(file.storageKey), file };
  }

  /**
   * Attach newly generated files to their durable domain record. Only files
   * that do not already have an owner are claimed, so reusing a URL cannot
   * transfer another record's storage ownership.
   */
  async attachUnreferencedFilesByUrl(
    urls: string[],
    userId: number,
    referenceType: string,
    referenceId: string,
    transaction?: ManagedStorageTransaction,
  ): Promise<number> {
    const candidates = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
    if (candidates.length === 0) return 0;
    const update=async (tx: ManagedStorageTransaction) => {
      const business=requireBusinessScope();await lockManagedStorageReferences(tx,{userId,businessProfileId:business.businessProfileId});
      return await tx
      .update(storageFilesTable)
      .set({ referenceType, referenceId, updatedAt: new Date() })
      .where(and(
        eq(storageFilesTable.userId, userId),
        eq(storageFilesTable.isDeleted, false),
        isNull(storageFilesTable.referenceType),
        or(
          inArray(storageFilesTable.url, candidates),
          inArray(sql<string>`split_part(split_part(${storageFilesTable.url}, '?', 1), '#', 1)`, candidates),
        ),
      ))
      .returning({ id: storageFilesTable.id });
    };
    const attached=transaction?await update(transaction):await db.transaction(update);
    return attached.length;
  }

  async reassignFileReference(
    fileId: number,
    userId: number,
    referenceType: string,
    referenceId: string,
    transaction?: ManagedStorageTransaction,
  ): Promise<boolean> {
    const update=async (tx: ManagedStorageTransaction) => {
      const business=requireBusinessScope();await lockManagedStorageReferences(tx,{userId,businessProfileId:business.businessProfileId});
      return await tx
      .update(storageFilesTable)
      .set({ referenceType, referenceId, updatedAt: new Date() })
      .where(and(
        eq(storageFilesTable.id, fileId),
        eq(storageFilesTable.userId, userId),
        eq(storageFilesTable.isDeleted, false),
      ))
      .returning({ id: storageFilesTable.id });
    };
    const [updated]=transaction?await update(transaction):await db.transaction(update);
    return Boolean(updated);
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  /**
   * Get file metadata by ID.
   */
  async getFile(
    fileId: number,
    userId?: number,
  ): Promise<StorageFileRecord | null> {
    const conditions = [
      eq(storageFilesTable.id, fileId),
      eq(storageFilesTable.isDeleted, false),
      sql`${storageFilesTable.metadata} #>> '{storageWorkspace,trashedAt}' IS NULL`,
    ];
    if (userId !== undefined)
      conditions.push(eq(storageFilesTable.userId, userId));
    const [file] = await db
      .select()
      .from(storageFilesTable)
      .where(and(...conditions))
      .limit(1);
    return file || null;
  }

  /**
   * Get a signed/public URL for a file.
   */
  async getFileUrl(fileId: number, userId?: number, expiresIn = 300): Promise<string | null> {
    const file = await this.getFile(fileId, userId);
    if (!file) return null;
    return this.backend.getSignedUrl(file.storageKey, Math.min(Math.max(expiresIn, 60), 900));
  }

  /**
   * Download file contents.
   */
  async downloadFile(fileId: number, userId?: number): Promise<{ buffer: Buffer; file: StorageFileRecord } | null> {
    const file = await this.getFile(fileId, userId);
    if (!file) return null;
    const buffer = await this.backend.download(file.storageKey);
    return { buffer, file };
  }

  async renameFile(fileId: number, userId: number, originalName: string): Promise<StorageFileRecord | null> {
    const printableName = Array.from(originalName.trim())
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      })
      .join('');
    const cleanName = path.basename(printableName).slice(0, 255);
    if (!cleanName || cleanName === '.' || cleanName === '..') throw new Error('A valid file name is required');
    const [updated] = await db.transaction(async (tx: typeof db) => {
      const business=requireBusinessScope();await lockManagedStorageReferences(tx,{userId,businessProfileId:business.businessProfileId});
      return await tx
      .update(storageFilesTable)
      .set({ originalName: cleanName, updatedAt: new Date() })
      .where(and(
        eq(storageFilesTable.id, fileId),
        eq(storageFilesTable.userId, userId),
        eq(storageFilesTable.isDeleted, false),
      ))
      .returning();
    });
    return updated || null;
  }

  /** Post-commit fast path; the existing cleanup worker is the durable retry path. */
  async flushManagedStorageCleanup(scope: StorageReferenceScope, fileIds: number[]): Promise<{processed:number;remaining:number}> {
    assertStorageReferenceScope(scope);
    if(!fileIds.length) return {processed:0,remaining:0};
    if(fileIds.length>1000 || fileIds.some(id=>!Number.isSafeInteger(id)||id<=0)) throw new ManagedStorageReferenceError('Invalid cleanup IDs');
    const records=await db.select().from(storageFilesTable).where(and(eq(storageFilesTable.userId,scope.userId),
      eq(storageFilesTable.businessProfileId,scope.businessProfileId),eq(storageFilesTable.isDeleted,true),inArray(storageFilesTable.id,fileIds)));
    let processed=0,remaining=0;
    for(const record of records) {
      const keys: string[]=Array.isArray(record.metadata?.pendingCleanupKeys)?record.metadata.pendingCleanupKeys.filter((key:unknown):key is string=>typeof key==='string'):[];
      for(const key of new Set(keys)) if(await this.deleteObjectOrRecordCleanup(record,key)) processed++;else remaining++;
    }
    return {processed,remaining};
  }

  async cleanupPendingObjects(
    limit = 100,
  ): Promise<{ processed: number; remaining: number }> {
    const expiredTrash = await db
      .select()
      .from(storageFilesTable)
      .where(
        and(
          eq(storageFilesTable.isDeleted, false),
          sql`${storageFilesTable.metadata} #>> '{storageWorkspace,trashedAt}' IS NOT NULL AND (${storageFilesTable.metadata} #>> '{storageWorkspace,trashedAt}')::timestamptz < CURRENT_TIMESTAMP - interval '30 days'`,
        ),
      )
      .limit(limit);
    for (const file of expiredTrash)
      await this.deleteFile(
        file.id,
        file.userId,
        new Date(Date.now() - 30 * 86400000),
        'trash_expiry',
      );
    const records = await db
      .select()
      .from(storageFilesTable)
      .where(
        sql`jsonb_typeof(${storageFilesTable.metadata}->'pendingCleanupKeys') = 'array'`,
      )
      .orderBy(storageFilesTable.updatedAt)
      .limit(Math.min(Math.max(limit, 1), 500));

    let processed = 0;
    let remaining = 0;
    for (const record of records) {
      const keys: string[] = Array.isArray(record.metadata?.pendingCleanupKeys)
        ? record.metadata.pendingCleanupKeys.filter((key: unknown): key is string => typeof key === 'string') : [];
      for (const key of new Set(keys)) {
        if (await this.deleteObjectOrRecordCleanup(record, key)) processed++;
        else remaining++;
      }
    }
    return { processed, remaining };
  }

  /**
   * List files for a user with pagination.
   */
  async listFiles(
    userId: number,
    opts: {
      category?: string;
      search?: string;
      sort?: StorageFileSort;
      folder?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ files: StorageFileRecord[]; total: number }> {
    const {
      category,
      search,
      sort = "newest",
      folder,
      limit = 50,
      offset = 0,
    } = opts;

    const conditions = [
      eq(storageFilesTable.userId, userId),
      eq(storageFilesTable.isDeleted, false),
      sql`${storageFilesTable.metadata} #>> '{storageWorkspace,trashedAt}' IS NULL`,
    ];
    if (category) conditions.push(eq(storageFilesTable.category, category));
    if (search?.trim()) {
      // Treat the user's search as literal text, including SQL wildcard characters.
      const pattern = `%${search.trim().replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        or(
          ilike(storageFilesTable.originalName, pattern),
          ilike(storageFilesTable.fileName, pattern),
        )!,
      );
    }
    if (folder) {
      conditions.push(eq(storageFilesTable.category, "actor_output"));
      conditions.push(
        sql`regexp_replace(${storageFilesTable.storageKey}, '/[^/]*$', '') = ${`${userId}/actor_output/${folder}`}`,
      );
    }

    const sortColumn =
      sort === "name"
        ? asc(
            sql`lower(coalesce(${storageFilesTable.originalName}, ${storageFilesTable.fileName}))`,
          )
        : sort === "size"
          ? desc(storageFilesTable.fileSizeBytes)
          : sort === "oldest"
            ? asc(storageFilesTable.createdAt)
            : desc(storageFilesTable.createdAt);

    const [totalResult] = await db
      .select({ count: count() })
      .from(storageFilesTable)
      .where(and(...conditions));

    const files = await db
      .select()
      .from(storageFilesTable)
      .where(and(...conditions))
      .orderBy(
        sortColumn,
        sort === "oldest" || sort === "name"
          ? asc(storageFilesTable.id)
          : desc(storageFilesTable.id),
      )
      .limit(limit)
      .offset(offset);

    const safeFiles = files.map((file: StorageFileRecord) =>
      PRIVATE_STORAGE_CATEGORIES.has(file.category as FileCategory)
        ? {
            ...file,
            url: `/api/settings/storage/files/${file.id}/download?inline=true`,
          }
        : file,
    );
    return { files: safeFiles, total: totalResult?.count ?? 0 };
  }

  // ── Usage / Quota ───────────────────────────────────────────────────────────

  /**
   * Get full storage usage summary for a user.
   */
  async getUsageSummary(userId: number): Promise<StorageUsageSummary> {
    const quota = await this.getOrCreateQuota(userId);
    const entitlement = await storageOrganizationEntitlements(userId);
    const maxBytes = entitlement
      ? entitlement.limits.storageBytes ?? Number.MAX_SAFE_INTEGER
      : quota.maxStorageBytes ?? (await this.getPlanLimit(quota.planId));
    const storageUsedBytes = entitlement?.usage.storageBytes ?? quota.storageUsedBytes;

    // Category breakdown
    const breakdown = await db
      .select({
        category: storageFilesTable.category,
        bytes: sql<number>`COALESCE(SUM(${storageFilesTable.fileSizeBytes}), 0)::bigint`,
        count: count(),
      })
      .from(storageFilesTable)
      .where(and(eq(storageFilesTable.userId, userId), eq(storageFilesTable.isDeleted, false)))
      .groupBy(storageFilesTable.category);

    // Plan name
    let planName: string | null = null;
    if (quota.planId) {
      const [plan] = await db.select().from(storagePlansTable).where(eq(storagePlansTable.id, quota.planId)).limit(1);
      planName = plan?.name || null;
    }

    return {
      storageUsedBytes,
      maxStorageBytes: maxBytes,
      fileCount: entitlement?.fileCount ?? quota.fileCount,
      usagePercent: maxBytes > 0 ? Math.round((storageUsedBytes / maxBytes) * 100) : 0,
      planName: entitlement?.planSlug ?? planName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      breakdown: breakdown.map((b: any) => ({ category: b.category, bytes: Number(b.bytes), count: Number(b.count) })),
    };
  }

  /**
   * Recalculate storage usage from actual file records (repair drift).
   */
  async recalculateUsage(userId: number): Promise<void> {
    const [result] = await db
      .select({
        totalBytes: sql<number>`COALESCE(SUM(${storageFilesTable.fileSizeBytes}), 0)::bigint`,
        totalCount: count(),
      })
      .from(storageFilesTable)
      .where(and(eq(storageFilesTable.userId, userId), eq(storageFilesTable.isDeleted, false)));

    await db
      .update(storageQuotasTable)
      .set({
        storageUsedBytes: Number(result?.totalBytes ?? 0),
        fileCount: Number(result?.totalCount ?? 0),
        lastCalculatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(storageQuotasTable.userId, userId));

    logger.info({ userId, bytes: result?.totalBytes, files: result?.totalCount }, '[StorageService] Usage recalculated');
  }

  /**
   * Check if a user can upload a file of given size.
   */
  async canUpload(userId: number, fileSizeBytes: number): Promise<{ allowed: boolean; reason?: string }> {
    if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 0) return { allowed: false, reason: 'A valid file size is required' };
    const entitlement = await storageOrganizationEntitlements(userId);
    if (entitlement) {
      const cap = entitlement.limits.storageBytes;
      const enforced = entitlement.enforced || (entitlement.catalogVersion ?? 1) < 2;
      return enforced && cap !== null && entitlement.usage.storageBytes + fileSizeBytes > cap
        ? { allowed: false, reason: `Organization storage limit exceeded. Used: ${this.formatBytes(entitlement.usage.storageBytes)}, Limit: ${this.formatBytes(cap)}, File: ${this.formatBytes(fileSizeBytes)}` }
        : { allowed: true };
    }
    const quota = await this.getOrCreateQuota(userId);
    const maxBytes = quota.maxStorageBytes ?? (await this.getPlanLimit(quota.planId));

    if (quota.storageUsedBytes + fileSizeBytes > maxBytes) {
      return {
        allowed: false,
        reason: `Storage limit exceeded. Used: ${this.formatBytes(quota.storageUsedBytes)}, ` +
          `Limit: ${this.formatBytes(maxBytes)}, File: ${this.formatBytes(fileSizeBytes)}`,
      };
    }
    return { allowed: true };
  }

  // ── Admin Operations ────────────────────────────────────────────────────────

  /**
   * Set the storage plan for a user.
   */
  async setUserPlan(userId: number, planId: number): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const quota = await this.getOrCreateQuota(userId);
    await db
      .update(storageQuotasTable)
      .set({ planId, updatedAt: new Date() })
      .where(eq(storageQuotasTable.userId, userId));
    logger.info({ userId, planId }, '[StorageService] User plan updated');
  }

  /**
   * Override the storage limit for a specific user (independent of plan).
   */
  async setUserStorageLimit(userId: number, maxStorageBytes: number): Promise<void> {
    await this.getOrCreateQuota(userId);
    await db
      .update(storageQuotasTable)
      .set({ maxStorageBytes: maxStorageBytes, updatedAt: new Date() })
      .where(eq(storageQuotasTable.userId, userId));
    logger.info({ userId, maxStorageBytes }, '[StorageService] User storage limit overridden');
  }

  /**
   * Get all user quotas for admin view.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAllQuotas(opts: { limit?: number; offset?: number } = {}): Promise<{ quotas: any[]; total: number }> {
    const { limit = 100, offset = 0 } = opts;
    const result = await db.execute(sql`
      SELECT
        sq.id,
        sq.user_id,
        sq.plan_id,
        sq.storage_used_bytes,
        COALESCE(sq.max_storage_bytes, sp.max_storage_bytes, 1073741824) AS max_storage_bytes,
        sq.file_count,
        sq.last_calculated_at,
        sp.name AS plan_name,
        u.name AS user_name,
        u.email AS user_email
      FROM storage_quotas sq
      LEFT JOIN storage_plans sp ON sq.plan_id = sp.id
      LEFT JOIN users u ON sq.user_id = u.id
      ORDER BY sq.storage_used_bytes DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const [totalResult] = await db.select({ count: count() }).from(storageQuotasTable);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quotas = (result.rows as any[]).map((row) => ({
      id: row.id,
      userId: Number(row.user_id),
      email: row.user_email,
      userName: row.user_name,
      planId: row.plan_id ? Number(row.plan_id) : null,
      planName: row.plan_name,
      storageUsedBytes: Number(row.storage_used_bytes || 0),
      maxStorageBytes: Number(row.max_storage_bytes || 0),
      fileCount: Number(row.file_count || 0),
      lastCalculatedAt: row.last_calculated_at,
    }));
    return { quotas, total: Number(totalResult?.count || 0) };
  }

  /**
   * Get files for a user (admin view) with pagination.
   */
  async getAdminUserFiles(
    userId: number,
    opts: { category?: string; limit?: number; offset?: number } = {}
  ): Promise<{ files: StorageFileRecord[]; total: number }> {
    return this.listFiles(userId, opts);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async getOrCreateQuota(userId: number) {
    const [existing] = await db
      .select()
      .from(storageQuotasTable)
      .where(eq(storageQuotasTable.userId, userId))
      .limit(1);

    if (existing) return existing;

    // Get default plan
    const [defaultPlan] = await db
      .select()
      .from(storagePlansTable)
      .where(eq(storagePlansTable.isDefault, true))
      .limit(1);

    const [created] = await db
      .insert(storageQuotasTable)
      .values({
        userId,
        planId: defaultPlan?.id || null,
        storageUsedBytes: 0,
        fileCount: 0,
      })
      .onConflictDoNothing()
      .returning();

    if (created) return created;

    // Race-condition fallback: row was inserted by another request
    const [fallback] = await db
      .select()
      .from(storageQuotasTable)
      .where(eq(storageQuotasTable.userId, userId))
      .limit(1);
    return fallback;
  }

  private async getPlanLimit(planId: number | null): Promise<number> {
    if (!planId) {
      const [defaultPlan] = await db
        .select()
        .from(storagePlansTable)
        .where(eq(storagePlansTable.isDefault, true))
        .limit(1);
      return defaultPlan?.maxStorageBytes ?? 1073741824; // 1 GB fallback
    }
    const [plan] = await db.select().from(storagePlansTable).where(eq(storagePlansTable.id, planId)).limit(1);
    return plan?.maxStorageBytes ?? 1073741824;
  }

  private async reserveUsage(userId: number, bytesDelta: number, countDelta: number): Promise<boolean> {
    const conditions = [eq(storageQuotasTable.userId, userId)];
    const [reserved] = await db
      .update(storageQuotasTable)
      .set({
        storageUsedBytes: sql`GREATEST(${storageQuotasTable.storageUsedBytes} + ${bytesDelta}, 0)`,
        fileCount: sql`GREATEST(${storageQuotasTable.fileCount} + ${countDelta}, 0)`,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning({ id: storageQuotasTable.id });
    return !!reserved;
  }

  private async releaseUsage(userId: number, bytesDelta: number, countDelta: number): Promise<void> {
    await db
      .update(storageQuotasTable)
      .set({
        storageUsedBytes: sql`GREATEST(${storageQuotasTable.storageUsedBytes} - ${bytesDelta}, 0)`,
        fileCount: sql`GREATEST(${storageQuotasTable.fileCount} - ${countDelta}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(storageQuotasTable.userId, userId));
  }

  /** Intent must already be committed by deletion/replacement metadata. Never
   * replace the metadata snapshot: another cleanup may append work concurrently. */
  private async deleteObjectOrRecordCleanup(file: StorageFileRecord, storageKey: string): Promise<boolean> {
    const result=await consumeManagedStorageCleanup({
      identity:{ownerUserId:file.userId,storageBackend:file.storageBackend,storageKey},
      expectedNamespace:`${file.userId}/${storageKey.split('/')[1]}/`,
      loadIntent:async tx=>{
        const value=await tx.execute(sql`SELECT id FROM storage_files WHERE id=${file.id} AND user_id=${file.userId}
          AND storage_backend=${file.storageBackend} AND COALESCE(metadata->'pendingCleanupKeys','[]'::jsonb) ? ${storageKey} FOR UPDATE`);
        return value.rows.length>0;
      },
      acknowledge:async tx=>{
        const changed=await tx.execute(sql`UPDATE storage_files SET metadata=CASE
          WHEN jsonb_array_length(COALESCE(metadata->'pendingCleanupKeys','[]'::jsonb)-${storageKey}::text)=0 THEN metadata-'pendingCleanupKeys'
          ELSE jsonb_set(metadata,'{pendingCleanupKeys}',(metadata->'pendingCleanupKeys')-${storageKey}::text) END,updated_at=NOW()
          WHERE id=${file.id} AND user_id=${file.userId} AND storage_backend=${file.storageBackend}
            AND COALESCE(metadata->'pendingCleanupKeys','[]'::jsonb) ? ${storageKey} RETURNING id`);
        return changed.rows.length>0;
      },
    });
    if(result.status==='deferred') logger.warn({fileId:file.id,reason:result.reason},'[StorageService] Committed object cleanup remains pending');
    return result.status==='deleted'||result.status==='already_consumed';
  }

  private async recordOrphanCleanup(userId: number, storageKey: string, storageBackend: string): Promise<void> {
    try {
      await db.insert(storageFilesTable).values({
        userId,
        fileName: path.basename(storageKey),
        originalName: path.basename(storageKey),
        storageKey,
        storageBackend,
        fileSizeBytes: 0,
        category: 'general',
        metadata: { pendingCleanupKeys: [storageKey], orphanedBeforeMetadataCommit: true },
        isDeleted: true,
        deletedAt: new Date(),
      });
    } catch (error) {
      logger.error({ err: error, userId, storageKey }, '[StorageService] Unable to persist orphan cleanup marker');
    }
  }

  private generateStorageKey(userId: number, category: string, originalName: string): string {
    const timestamp = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const ext = path.extname(originalName) || '';
    const safeName = path.basename(originalName, ext).replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 50);
    return `${userId}/${category}/${safeName}-${timestamp}-${rand}${ext}`;
  }

  private generateReplacementKey(storageKey: string): string {
    const ext = path.posix.extname(storageKey);
    const stem = ext ? storageKey.slice(0, -ext.length) : storageKey;
    return `${stem}-replacement-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }
}

// ─── Error Types ────────────────────────────────────────────────────────────────

export class StorageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageLimitError';
  }
}

// ─── Singleton Export ───────────────────────────────────────────────────────────

export const storageService = StorageService.getInstance();
