import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import {
  lockManagedStorageReferences,
  syncManagedStorageOwners,
  releaseManagedStorageOwners,
  type DurableStorageOwner,
  type ManagedStorageTransaction,
  type ManagedStorageChange,
  type StorageReferenceScope,
} from '../../services/managedStorageReferences.js';
import { brandToolkitsTable, type BrandToolkitRecord } from './schema.js';
import { db } from '../db.js';
import { storageService } from '../../services/StorageService.js';
import { logger } from '../../utils/logger.js';

/** Storage owns URL/backend/key normalization and object-level deduplication. */
function brandToolkitManagedUrls(toolkit: BrandToolkitRecord): string[] {
  const assets = Array.isArray(toolkit.imageAssets) ? toolkit.imageAssets : [];
  return [...new Set([
    toolkit.logoUrl,
    ...(Array.isArray(toolkit.logoUrls) ? toolkit.logoUrls : []),
    toolkit.websiteScreenshotUrl,
    ...assets.flatMap(asset => asset && typeof asset === 'object'
      ? [asset.url, asset.originalUrl, asset.thumbnailUrl] : []),
  ].filter((url): url is string => typeof url === 'string' && url.trim().length > 0))];
}

function brandToolkitStorageOwner(toolkit: BrandToolkitRecord): DurableStorageOwner {
  const scope = requireBusinessScope();
  if (toolkit.userId !== scope.userId || toolkit.businessProfileId !== scope.businessProfileId
    || !Number.isSafeInteger(toolkit.id) || toolkit.id <= 0) {
    throw new Error('The persisted brand toolkit does not belong to the active business');
  }
  return {
    kind: 'brand_toolkit', id: String(toolkit.id),
    userId: toolkit.userId, businessProfileId: scope.businessProfileId,
  };
}

/** Billing/business prefix precedes all Brand row locks and writes. */
export async function lockBrandManagedStoragePrefix(tx: ManagedStorageTransaction): Promise<void> {
  const scope = requireBusinessScope();
  await lockManagedStorageReferences(tx, { userId: scope.userId, businessProfileId: scope.businessProfileId });
}

/** Preserve public model return values; physical cleanup runs only after commit.
 * The canonical service retains durable pending keys when physical IO fails. */
export async function withBrandManagedStorageTransaction<T>(
  work: (tx: ManagedStorageTransaction, recordChange: (change: ManagedStorageChange) => void) => Promise<T>,
): Promise<T> {
  const business = requireBusinessScope();
  const scope: StorageReferenceScope = { userId: business.userId, businessProfileId: business.businessProfileId };
  const cleanupFileIds = new Set<number>();
  const result = await db.transaction(async (tx: ManagedStorageTransaction) => {
    await lockBrandManagedStoragePrefix(tx);
    return work(tx, change => change.cleanupFileIds.forEach(id => cleanupFileIds.add(id)));
  });
  if (cleanupFileIds.size) {
    try { await storageService.flushManagedStorageCleanup(scope, [...cleanupFileIds]); }
    catch (error) { logger.warn({ err: error, businessProfileId: scope.businessProfileId }, 'Brand cleanup remains in durable storage intents'); }
  }
  return result;
}

/** The complete returned, persisted row is the authority, including receipt replay. */
export async function syncBrandToolkitManagedReferences(
  tx: ManagedStorageTransaction, toolkit: BrandToolkitRecord,
): Promise<ManagedStorageChange> {
  return syncManagedStorageOwners(tx, {
    entries: [{ owner: brandToolkitStorageOwner(toolkit), urls: brandToolkitManagedUrls(toolkit) }],
    cleanupReleased: true,
  });
}

/** Must be the final Brand operation: no new domain locks after this call. */
export async function releaseBrandToolkitManagedReferences(
  tx: ManagedStorageTransaction, toolkits: readonly BrandToolkitRecord[],
): Promise<ManagedStorageChange> {
  return releaseManagedStorageOwners(tx, { owners: toolkits.map(brandToolkitStorageOwner), cleanupReleased: true });
}

export interface BrandToolkitDeletionPlan {
  deletedCount: number;
  owners: readonly DurableStorageOwner[];
}

/**
 * Data composition boundary: delete Brand rows, but take no object lock.
 * Data acquires every required payer/business prefix before any domain row lock.
 * It finishes ALL domain writes, then includes this plan's owners in one final
 * canonical release batch. The plan is local to this actual transaction and
 * must be discarded on rollback; it is not a second ledger or cleanup engine.
 * No ambient-payer fallback is assumed; the caller prelocks every required
 * authorized payer/business before entering its domain phase.
 */
export async function stageBrandToolkitDeletionForBusinessInTransaction(
  tx: ManagedStorageTransaction, businessProfileId: number,
): Promise<BrandToolkitDeletionPlan> {
  if (typeof tx.rollback !== 'function') throw new Error('Brand deletion staging requires the caller transaction');
  const scope = requireBusinessScope();
  if (businessProfileId !== scope.businessProfileId) throw new Error('Brand cleanup business mismatch');
  const owned = and(eq(brandToolkitsTable.businessProfileId, businessProfileId), eq(brandToolkitsTable.userId, scope.userId));
  const locked: BrandToolkitRecord[] = await tx.select().from(brandToolkitsTable).where(owned)
    .orderBy(asc(brandToolkitsTable.id)).for('update');
  if (!locked.length) return { deletedCount: 0, owners: [] };
  const deleted: BrandToolkitRecord[] = await tx.delete(brandToolkitsTable)
    .where(and(owned, inArray(brandToolkitsTable.id, locked.map(row => row.id)))).returning();
  return { deletedCount: deleted.length, owners: deleted.map(brandToolkitStorageOwner) };
}
