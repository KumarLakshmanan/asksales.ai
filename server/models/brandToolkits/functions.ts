import { db } from "../db";
import { brandToolkitsTable, InsertBrandToolkit, BrandToolkitRecord } from "./schema";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  withBrandManagedStorageTransaction, syncBrandToolkitManagedReferences, releaseBrandToolkitManagedReferences,
} from './managedReferences.js';
export {
  stageBrandToolkitDeletionForBusinessInTransaction,
  type BrandToolkitDeletionPlan,
} from './managedReferences.js';

/**
 * Brand Toolkit Model Functions
 */

// Get all brand toolkits for a user
export async function getBrandToolkitsByUserId(userId: number): Promise<BrandToolkitRecord[]> {
  return db
    .select()
    .from(brandToolkitsTable)
    .where(eq(brandToolkitsTable.userId, userId))
    .orderBy(desc(brandToolkitsTable.isDefault), desc(brandToolkitsTable.createdAt));
}

// Get a specific brand toolkit by ID
export async function getBrandToolkitById(id: number): Promise<BrandToolkitRecord | undefined> {
  const results = await db
    .select()
    .from(brandToolkitsTable)
    .where(eq(brandToolkitsTable.id, id))
    .limit(1);
  return results[0];
}

// Get a brand toolkit by ID and user ID (for authorization)
export async function getBrandToolkitByIdAndUser(id: number, userId: number): Promise<BrandToolkitRecord | undefined> {
  const results = await db
    .select()
    .from(brandToolkitsTable)
    .where(and(
      eq(brandToolkitsTable.id, id),
      eq(brandToolkitsTable.userId, userId)
    ))
    .limit(1);
  return results[0];
}

// Get the default brand toolkit for a user
export async function getDefaultBrandToolkit(userId: number): Promise<BrandToolkitRecord | undefined> {
  const results = await db
    .select()
    .from(brandToolkitsTable)
    .where(and(
      eq(brandToolkitsTable.userId, userId),
      eq(brandToolkitsTable.isDefault, true)
    ))
    .limit(1);
  return results[0];
}

// Create a new brand toolkit
export async function createBrandToolkit(data: InsertBrandToolkit): Promise<BrandToolkitRecord> {
  return withBrandManagedStorageTransaction(async (tx, recordChange) => {
    if(data.creationRequestKey) {
      const {requireBusinessScope}=await import('../../tenancy/businessContext.js');
      await tx.execute(sql`SELECT pg_advisory_xact_lock(740321,${requireBusinessScope().businessProfileId})`);
      const [previous]=await tx.select().from(brandToolkitsTable).where(and(eq(brandToolkitsTable.userId,data.userId),eq(brandToolkitsTable.creationRequestKey,data.creationRequestKey))).limit(1);
      if(previous) {
        if(previous.creationRequestHash!==data.creationRequestHash) throw Object.assign(new Error('This request key was already used for different brand details.'),{code:'SETUP_REQUEST_CONFLICT'});
        recordChange(await syncBrandToolkitManagedReferences(tx, previous));
        return previous;
      }
    }
    const existing = await tx
      .select({ id: brandToolkitsTable.id })
      .from(brandToolkitsTable)
      .where(eq(brandToolkitsTable.userId, data.userId))
      .limit(1);
    const isDefault = data.isDefault === true || existing.length === 0;
    if (isDefault) {
      await tx
        .update(brandToolkitsTable)
        .set({ isDefault: false })
        .where(eq(brandToolkitsTable.userId, data.userId));
    }
    const [created] = await tx
      .insert(brandToolkitsTable)
      .values({
        ...data,
        isDefault,
        isApproved: data.isApproved ?? true,
        approvedBy: data.approvedBy ?? data.userId,
        approvedAt: data.approvedAt ?? new Date(),
        version: data.version ?? 1,
      })
      .returning();
    recordChange(await syncBrandToolkitManagedReferences(tx, created));
    return created;
  });
}

// Update a brand toolkit
export async function updateBrandToolkit(
  id: number, 
  data: Partial<InsertBrandToolkit>
): Promise<BrandToolkitRecord | undefined> {
  return withBrandManagedStorageTransaction(async (tx, recordChange) => {
    // Preserve the legacy default/approval/version contract in one transaction.
    if (data.isDefault && data.userId) {
      await tx.update(brandToolkitsTable).set({ isDefault: false })
        .where(eq(brandToolkitsTable.userId, data.userId));
    }
    const [updated] = await tx.update(brandToolkitsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(brandToolkitsTable.id, id)).returning();
    if (updated) recordChange(await syncBrandToolkitManagedReferences(tx, updated));
    return updated;
  });
}

export async function updateBrandToolkitForUser(
  id: number,
  userId: number,
  data: Partial<InsertBrandToolkit>,
  expectedVersion?: number,
): Promise<BrandToolkitRecord | undefined> {
  return withBrandManagedStorageTransaction(async (tx, recordChange) => {
    const [existing] = await tx
      .select()
      .from(brandToolkitsTable)
      .where(and(eq(brandToolkitsTable.id, id), eq(brandToolkitsTable.userId, userId)))
      .limit(1);
    if (!existing) return undefined;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) throw Object.assign(new Error('This brand toolkit changed. Reload it before saving.'), { code: 'TOOLKIT_VERSION_CONFLICT' });
    if (data.isDefault === true) {
      await tx
        .update(brandToolkitsTable)
        .set({ isDefault: false })
        .where(eq(brandToolkitsTable.userId, userId));
    }
    const { userId: _ignoredUserId, ...safeData } = data;
    const [updated] = await tx
      .update(brandToolkitsTable)
      .set({
        ...safeData,
        isApproved: true,
        approvedBy: userId,
        approvedAt: new Date(),
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(brandToolkitsTable.id, id), eq(brandToolkitsTable.userId, userId), eq(brandToolkitsTable.version, existing.version)))
      .returning();
    if (!updated) throw Object.assign(new Error('This brand toolkit changed while saving. Reload it and retry.'), { code: 'TOOLKIT_VERSION_CONFLICT' });
    recordChange(await syncBrandToolkitManagedReferences(tx, updated));
    return updated;
  });
}

// Delete a brand toolkit
export async function deleteBrandToolkit(id: number): Promise<void> {
  await withBrandManagedStorageTransaction(async (tx, recordChange) => {
    const deleted = await tx.delete(brandToolkitsTable).where(eq(brandToolkitsTable.id, id)).returning();
    recordChange(await releaseBrandToolkitManagedReferences(tx, deleted));
  });
}

export async function deleteBrandToolkitForUser(id: number, userId: number): Promise<boolean> {
  return withBrandManagedStorageTransaction(async (tx, recordChange) => {
    const [deleted] = await tx
      .delete(brandToolkitsTable)
      .where(and(eq(brandToolkitsTable.id, id), eq(brandToolkitsTable.userId, userId)))
      .returning();
    if (!deleted) return false;
    if (deleted.isDefault) {
      const [replacement] = await tx
        .select({ id: brandToolkitsTable.id })
        .from(brandToolkitsTable)
        .where(and(
          eq(brandToolkitsTable.userId, userId),
          eq(brandToolkitsTable.isActive, true),
        ))
        .orderBy(desc(brandToolkitsTable.updatedAt))
        .limit(1);
      if (replacement) {
        await tx
          .update(brandToolkitsTable)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(and(eq(brandToolkitsTable.id, replacement.id), eq(brandToolkitsTable.userId, userId)));
      }
    }
    recordChange(await releaseBrandToolkitManagedReferences(tx, [deleted]));
    return true;
  });
}

// Set a brand toolkit as default (and unset others)
export async function setDefaultBrandToolkit(id: number, userId: number): Promise<BrandToolkitRecord | undefined> {
  return withBrandManagedStorageTransaction(async tx => {
    const [target] = await tx
      .select({ id: brandToolkitsTable.id })
      .from(brandToolkitsTable)
      .where(and(eq(brandToolkitsTable.id, id), eq(brandToolkitsTable.userId, userId)))
      .limit(1);
    if (!target) return undefined;
    await tx
      .update(brandToolkitsTable)
      .set({ isDefault: false })
      .where(eq(brandToolkitsTable.userId, userId));
    const [updated] = await tx
      .update(brandToolkitsTable)
      .set({
        isDefault: true,
        isApproved: true,
        approvedBy: userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(brandToolkitsTable.id, id), eq(brandToolkitsTable.userId, userId)))
      .returning();
    return updated;
  });
}

// Check if user has any brand toolkits
export async function userHasBrandToolkits(userId: number): Promise<boolean> {
  const results = await db
    .select({ id: brandToolkitsTable.id })
    .from(brandToolkitsTable)
    .where(eq(brandToolkitsTable.userId, userId))
    .limit(1);
  return results.length > 0;
}

// Export model
export const BrandToolkitModel = {
  findAllByUser: getBrandToolkitsByUserId,
  findById: getBrandToolkitById,
  findByIdAndUser: getBrandToolkitByIdAndUser,
  findDefault: getDefaultBrandToolkit,
  create: createBrandToolkit,
  update: updateBrandToolkit,
  updateForUser: updateBrandToolkitForUser,
  delete: deleteBrandToolkit,
  deleteForUser: deleteBrandToolkitForUser,
  setDefault: setDefaultBrandToolkit,
  userHasToolkits: userHasBrandToolkits,
};
