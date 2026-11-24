/**
 * Admin Storage Controller
 * 
 * Endpoints for managing storage plans, pricing, user quotas, and files
 * from the admin panel.
 */

import { Request, Response } from 'express';
import { db } from '../models/db';
import { storagePlansTable, type InsertStoragePlan } from '../models/storagePlans/schema';
import { storageQuotasTable } from '../models/storageQuotas/schema';
import { storageFilesTable } from '../models/storageFiles/schema';
import { storagePricingTable } from '../models/storagePricing/schema';

import { storageService } from '../services/StorageService.js';
import { eq, sql, count } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { parseStoragePricingInput } from '../utils/pricingValidation.js';
import { pricingAuditTable } from '../models/pricingAudit/schema.js';
import { pricingAuditValues } from '../models/pricingAudit/functions.js';
import { parsePositiveId } from '../utils/paramParsers.js';
import { adminActorId as getAdminActorId } from '../utils/requestUserIds.js';

function parsePagination(req: Request): { limit: number; offset: number } | null {
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return null;
  return { limit, offset };
}

function parsePlanInput(body: unknown, partial = false): { value?: Partial<InsertStoragePlan>; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'A plan object is required' };
  const input = body as Record<string, unknown>;
  const allowed = new Set(['name', 'description', 'maxStorageBytes', 'pricePerGbCents', 'currency', 'isDefault', 'isActive']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: 'The request contains unsupported plan fields' };

  const value: Partial<InsertStoragePlan> = {};
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) return { error: 'Name must contain 1 to 100 characters' };
    value.name = input.name.trim();
  }
  if (input.description !== undefined) {
    if (input.description !== null && (typeof input.description !== 'string' || input.description.length > 2000)) return { error: 'Description must contain at most 2,000 characters' };
    value.description = typeof input.description === 'string' ? input.description.trim() || null : null;
  }
  if (!partial || input.maxStorageBytes !== undefined) {
    const maxStorageBytes = Number(input.maxStorageBytes);
    if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < 1 || maxStorageBytes > 10 * 1024 ** 4) return { error: 'Storage must be between 1 byte and 10 TB' };
    value.maxStorageBytes = maxStorageBytes;
  }
  if (input.pricePerGbCents !== undefined) {
    const price = Number(input.pricePerGbCents);
    if (!Number.isSafeInteger(price) || price < 0 || price > 100_000_000) return { error: 'Price must be a non-negative integer in minor currency units' };
    value.pricePerGbCents = price;
  }
  if (input.currency !== undefined) {
    if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency)) return { error: 'Currency must be a three-letter ISO code' };
    value.currency = input.currency.toUpperCase();
  }
  for (const field of ['isDefault', 'isActive'] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'boolean') return { error: `${field} must be a boolean` };
      value[field] = input[field];
    }
  }
  return { value };
}

// ─── Dashboard Stats ────────────────────────────────────────────────────────────

export async function getStorageDashboardStats(_req: Request, res: Response) {
  try {
    const [totals] = await db
      .select({
        totalUsers: count(),
        totalUsedBytes: sql<number>`COALESCE(SUM(storage_used_bytes), 0)::bigint`,
        totalAllocatedBytes: sql<number>`COALESCE(SUM(COALESCE(${storageQuotasTable.maxStorageBytes}, ${storagePlansTable.maxStorageBytes}, 1073741824)), 0)::bigint`,
        totalFiles: sql<number>`COALESCE(SUM(file_count), 0)::int`,
      })
      .from(storageQuotasTable)
      .leftJoin(storagePlansTable, eq(storageQuotasTable.planId, storagePlansTable.id));

    const [planCount] = await db.select({ count: count() }).from(storagePlansTable);

    const topUsers = await db.execute(sql`
      SELECT
        sq.user_id,
        sq.storage_used_bytes,
        sq.file_count,
        COALESCE(sq.max_storage_bytes, sp.max_storage_bytes, 1073741824) AS max_storage_bytes,
        sp.name AS plan_name,
        u.name AS user_name,
        u.email AS user_email
      FROM storage_quotas sq
      LEFT JOIN storage_plans sp ON sq.plan_id = sp.id
      LEFT JOIN users u ON sq.user_id = u.id
      ORDER BY sq.storage_used_bytes DESC
      LIMIT 10
    `);

    // Category breakdown across all users
    const categoryBreakdown = await db
      .select({
        category: storageFilesTable.category,
        bytes: sql<number>`COALESCE(SUM(${storageFilesTable.fileSizeBytes}), 0)::bigint`,
        count: count(),
      })
      .from(storageFilesTable)
      .where(eq(storageFilesTable.isDeleted, false))
      .groupBy(storageFilesTable.category);

    return res.json({
      success: true,
      data: {
        totalUsedBytes: Number(totals?.totalUsedBytes ?? 0),
        totalAllocatedBytes: Number(totals?.totalAllocatedBytes ?? 0),
        totalUsers: Number(totals?.totalUsers ?? 0),
        totalFiles: Number(totals?.totalFiles ?? 0),
        totalPlans: Number(planCount?.count ?? 0),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        topUsers: (topUsers.rows as any[]).map((u: any) => ({
          userId: u.user_id,
          email: u.user_email,
          userName: u.user_name,
          storageUsedBytes: Number(u.storage_used_bytes),
          fileCount: Number(u.file_count),
          maxStorageBytes: Number(u.max_storage_bytes),
          planName: u.plan_name,
        })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        categoryBreakdown: categoryBreakdown.map((c: any) => ({
          category: c.category,
          totalBytes: Number(c.bytes),
          fileCount: Number(c.count),
        })),
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to get dashboard stats');
    return res.status(500).json({ error: 'Failed to fetch storage stats' });
  }
}

// ─── Storage Plans ──────────────────────────────────────────────────────────────

export async function getStoragePlans(_req: Request, res: Response) {
  try {
    const plans = await db.select().from(storagePlansTable).orderBy(storagePlansTable.id);
    return res.json({ success: true, data: plans });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to get plans');
    return res.status(500).json({ error: 'Failed to fetch storage plans' });
  }
}

export async function createStoragePlan(req: Request, res: Response) {
  try {
    const parsed = parsePlanInput(req.body);
    if (parsed.error || !parsed.value) return res.status(400).json({ error: parsed.error });
    const values = parsed.value as InsertStoragePlan;
    const plan = await db.transaction(async (tx: typeof db) => {
      if (values.isDefault) {
        await tx.update(storagePlansTable).set({ isDefault: false, updatedAt: new Date() }).where(eq(storagePlansTable.isDefault, true));
      }
      const [created] = await tx.insert(storagePlansTable).values(values).returning();
      await tx.insert(pricingAuditTable).values(pricingAuditValues({
        domain: 'storage_plan', recordId: created.id, pricingKey: created.name, action: 'create',
        adminId: getAdminActorId(req), afterValue: created,
      }));
      return created;
    });
    return res.status(201).json({ success: true, data: plan });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code === '23505') {
      const message = String(error.constraint || '').includes('single_default')
        ? 'Another default plan was selected concurrently; reload and try again'
        : 'Plan name already exists';
      return res.status(409).json({ error: message });
    }
    logger.error({ err: error }, '[AdminStorage] Failed to create plan');
    return res.status(500).json({ error: 'Failed to create plan' });
  }
}

export async function updateStoragePlan(req: Request, res: Response) {
  try {
    const planId = parsePositiveId(req.params.id);
    if (!planId) return res.status(400).json({ error: 'Invalid plan ID' });
    const parsed = parsePlanInput(req.body, true);
    if (parsed.error || !parsed.value || Object.keys(parsed.value).length === 0) return res.status(400).json({ error: parsed.error || 'At least one plan field is required' });

    const [current] = await db.select().from(storagePlansTable).where(eq(storagePlansTable.id, planId)).limit(1);
    if (!current) return res.status(404).json({ error: 'Plan not found' });
    if (current.isDefault && parsed.value.isDefault === false) return res.status(400).json({ error: 'Choose another default plan before removing this default' });
    if (current.isDefault && parsed.value.isActive === false) return res.status(400).json({ error: 'The default plan must remain active' });

    const plan = await db.transaction(async (tx: typeof db) => {
      if (parsed.value?.isDefault) {
        await tx.update(storagePlansTable).set({ isDefault: false, updatedAt: new Date() }).where(eq(storagePlansTable.isDefault, true));
      }
      const [updated] = await tx.update(storagePlansTable)
        .set({ ...parsed.value, updatedAt: new Date() })
        .where(eq(storagePlansTable.id, planId))
        .returning();
      if (updated) {
        await tx.insert(pricingAuditTable).values(pricingAuditValues({
          domain: 'storage_plan', recordId: planId, pricingKey: current.name, action: 'update',
          adminId: getAdminActorId(req), beforeValue: current, afterValue: updated,
        }));
      }
      return updated;
    });

    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    return res.json({ success: true, data: plan });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ error: 'Another default plan was selected concurrently; reload and try again' });
    logger.error({ err: error }, '[AdminStorage] Failed to update plan');
    return res.status(500).json({ error: 'Failed to update plan' });
  }
}

export async function deleteStoragePlan(req: Request, res: Response) {
  try {
    const planId = parsePositiveId(req.params.id);
    if (!planId) return res.status(400).json({ error: 'Invalid plan ID' });

    const [plan] = await db.select().from(storagePlansTable).where(eq(storagePlansTable.id, planId)).limit(1);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.isDefault) return res.status(400).json({ error: 'The default storage plan cannot be deleted' });

    // Don't allow deleting a plan that has users
    const [userCount] = await db
      .select({ count: count() })
      .from(storageQuotasTable)
      .where(eq(storageQuotasTable.planId, planId));

    if (Number(userCount?.count) > 0) {
      return res.status(400).json({ error: `Cannot delete plan: ${userCount.count} users are assigned to it` });
    }

    await db.transaction(async (tx: typeof db) => {
      await tx.delete(storagePlansTable).where(eq(storagePlansTable.id, planId));
      await tx.insert(pricingAuditTable).values(pricingAuditValues({
        domain: 'storage_plan', recordId: planId, pricingKey: plan.name, action: 'delete',
        adminId: getAdminActorId(req), beforeValue: plan,
      }));
    });
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to delete plan');
    return res.status(500).json({ error: 'Failed to delete plan' });
  }
}

// ─── Storage Pricing ────────────────────────────────────────────────────────────

export async function getStoragePricing(_req: Request, res: Response) {
  try {
    const pricing = await db.select().from(storagePricingTable).orderBy(storagePricingTable.id);
    return res.json({ success: true, data: pricing });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to get pricing');
    return res.status(500).json({ error: 'Failed to fetch storage pricing' });
  }
}

export async function updateStoragePricing(req: Request, res: Response) {
  try {
    const pricingId = parsePositiveId(req.params.id);
    if (!pricingId) return res.status(400).json({ error: 'Invalid pricing ID' });
    const parsed = parseStoragePricingInput(req.body, true);
    if (parsed.error || !parsed.value || Object.keys(parsed.value).length === 0) {
      return res.status(400).json({ error: parsed.error || 'At least one pricing field is required' });
    }

    const pricing = await db.transaction(async (tx: typeof db) => {
      const [before] = await tx.select().from(storagePricingTable).where(eq(storagePricingTable.id, pricingId)).limit(1);
      if (!before) return undefined;
      const [updated] = await tx
        .update(storagePricingTable)
        .set({ ...parsed.value, updatedAt: new Date() })
        .where(eq(storagePricingTable.id, pricingId))
        .returning();
      await tx.insert(pricingAuditTable).values(pricingAuditValues({
        domain: 'storage_pricing', recordId: pricingId, pricingKey: before.pricingKey, action: 'update',
        adminId: getAdminActorId(req), beforeValue: before, afterValue: updated,
      }));
      return updated;
    });

    if (!pricing) return res.status(404).json({ error: 'Pricing entry not found' });
    return res.json({ success: true, data: pricing });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to update pricing');
    return res.status(500).json({ error: 'Failed to update pricing' });
  }
}

export async function createStoragePricing(req: Request, res: Response) {
  try {
    const parsed = parseStoragePricingInput(req.body);
    if (parsed.error || !parsed.value) return res.status(400).json({ error: parsed.error });
    const values = parsed.value;

    const entry = await db.transaction(async (tx: typeof db) => {
      const [created] = await tx.insert(storagePricingTable).values({
        pricingKey: values.pricingKey!,
        name: values.name!,
        description: values.description ?? null,
        pricePerGbCents: values.pricePerGbCents!,
        currency: values.currency!,
        isActive: values.isActive ?? true,
      })
      .returning();
      await tx.insert(pricingAuditTable).values(pricingAuditValues({
        domain: 'storage_pricing', recordId: created.id, pricingKey: created.pricingKey, action: 'create',
        adminId: getAdminActorId(req), afterValue: created,
      }));
      return created;
    });

    return res.status(201).json({ success: true, data: entry });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ error: 'Pricing key already exists' });
    logger.error({ err: error }, '[AdminStorage] Failed to create pricing');
    return res.status(500).json({ error: 'Failed to create pricing entry' });
  }
}

// ─── User Quotas ────────────────────────────────────────────────────────────────

export async function getAllStorageQuotas(req: Request, res: Response) {
  try {
    const pagination = parsePagination(req);
    if (!pagination) return res.status(400).json({ error: 'Invalid pagination' });
    const { quotas, total } = await storageService.getAllQuotas(pagination);
    return res.json({
      success: true,
      data: { quotas, total, pagination: { ...pagination, hasMore: pagination.offset + quotas.length < total } },
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to get quotas');
    return res.status(500).json({ error: 'Failed to fetch storage quotas' });
  }
}

export async function getUserStorageDetail(req: Request, res: Response) {
  try {
    const userId = parsePositiveId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid user ID' });
    const summary = await storageService.getUsageSummary(userId);
    return res.json({ success: true, data: summary });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to get user storage detail');
    return res.status(500).json({ error: 'Failed to fetch user storage' });
  }
}

export async function setUserStorageLimit(req: Request, res: Response) {
  try {
    const userId = parsePositiveId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid user ID' });
    const { maxStorageBytes } = req.body;
    const parsedLimit = Number(maxStorageBytes);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 10 * 1024 ** 4) {
      return res.status(400).json({ error: 'maxStorageBytes must be between 1 byte and 10 TB' });
    }

    await storageService.setUserStorageLimit(userId, parsedLimit);
    return res.json({ success: true, message: 'Storage limit updated' });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to set user limit');
    return res.status(500).json({ error: 'Failed to set storage limit' });
  }
}

export async function setUserStoragePlan(req: Request, res: Response) {
  try {
    const userId = parsePositiveId(req.params.userId);
    const planId = parsePositiveId(req.body?.planId);
    if (!userId) return res.status(400).json({ error: 'Invalid user ID' });
    if (!planId) return res.status(400).json({ error: 'Invalid plan ID' });

    const [plan] = await db.select({ id: storagePlansTable.id }).from(storagePlansTable)
      .where(eq(storagePlansTable.id, planId)).limit(1);
    if (!plan) return res.status(404).json({ error: 'Storage plan not found' });
    await storageService.setUserPlan(userId, planId);
    return res.json({ success: true, message: 'Storage plan updated' });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to set user plan');
    return res.status(500).json({ error: 'Failed to set storage plan' });
  }
}

export async function recalculateUserStorage(req: Request, res: Response) {
  try {
    const userId = parsePositiveId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid user ID' });
    await storageService.recalculateUsage(userId);
    const summary = await storageService.getUsageSummary(userId);
    return res.json({ success: true, data: summary, message: 'Storage usage recalculated' });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to recalculate');
    return res.status(500).json({ error: 'Failed to recalculate storage' });
  }
}

// ─── User Files (Admin View) ────────────────────────────────────────────────────

export async function getUserFiles(req: Request, res: Response) {
  try {
    const userId = parsePositiveId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid user ID' });
    const pagination = parsePagination(req);
    if (!pagination) return res.status(400).json({ error: 'Invalid pagination' });
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (category && !/^[a-z][a-z0-9_]{0,99}$/.test(category)) return res.status(400).json({ error: 'Invalid category' });

    const { files, total } = await storageService.getAdminUserFiles(userId, { category, ...pagination });
    return res.json({ success: true, data: { files, total, pagination: { ...pagination, hasMore: pagination.offset + files.length < total } } });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to get user files');
    return res.status(500).json({ error: 'Failed to fetch user files' });
  }
}

export async function adminDeleteFile(req: Request, res: Response) {
  try {
    const fileId = parsePositiveId(req.params.fileId);
    const userId = parsePositiveId(req.params.userId);
    if (!fileId || !userId) return res.status(400).json({ error: 'Invalid user or file ID' });

    const deleted = await storageService.deleteFile(fileId, userId, undefined, 'storage_delete');
    if (!deleted) return res.status(404).json({ error: 'File not found' });
    return res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to delete file');
    return res.status(500).json({ error: 'Failed to delete file' });
  }
}

export async function adminBulkDeleteFiles(req: Request, res: Response) {
  try {
    const userId = parsePositiveId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid user ID' });
    const { fileIds } = req.body;
    if (!Array.isArray(fileIds) || fileIds.length === 0 || fileIds.length > 200) {
      return res.status(400).json({ error: 'fileIds must contain between 1 and 200 IDs' });
    }
    const parsedIds = fileIds.map(parsePositiveId);
    if (parsedIds.some((id) => !id)) return res.status(400).json({ error: 'fileIds must contain positive integer IDs' });
    const ids = [...new Set(parsedIds as number[])];
    const deletedCount = await storageService.deleteFiles(ids, userId, undefined, 'storage_delete');
    return res.json({ success: true, deletedCount });
  } catch (error) {
    logger.error({ err: error }, '[AdminStorage] Failed to bulk delete files');
    return res.status(500).json({ error: 'Failed to delete files' });
  }
}
