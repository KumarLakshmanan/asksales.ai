/**
 * Admin Business Profile Categories Controller
 * CRUD endpoints for managing business profile categories and subcategories.
 */

import { Request, Response } from 'express';
import { db } from '../models/db';
import {
  businessProfileCategoriesTable,
  businessProfileSubcategoriesTable,
} from '../models/businessProfileCategories/schema';
import { companySettings } from '../models/companySettings/schema';
import { eq, asc, and, count } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── Categories ──────────────────────────────────────────────────────────────

export async function getCategories(_req: Request, res: Response) {
  try {
    // Phase 3.12 / PERF-001: replaced N+1 loop (3 queries per category) with
    // 3 batched queries — categories, subcategories, and a single
    // GROUP BY count over company_settings.
    const [categories, subcategories, usageRows] = await Promise.all([
      db
        .select()
        .from(businessProfileCategoriesTable)
        .orderBy(asc(businessProfileCategoriesTable.sortOrder), asc(businessProfileCategoriesTable.name)),
      db
        .select()
        .from(businessProfileSubcategoriesTable)
        .orderBy(
          asc(businessProfileSubcategoriesTable.sortOrder),
          asc(businessProfileSubcategoriesTable.name),
        ),
      db
        .select({
          categoryId: companySettings.categoryId,
          count: count(),
        })
        .from(companySettings)
        .groupBy(companySettings.categoryId),
    ]);

    const subsByCategory = new Map<number, typeof subcategories>();
    for (const sub of subcategories) {
      const list = subsByCategory.get(sub.categoryId) ?? [];
      list.push(sub);
      subsByCategory.set(sub.categoryId, list);
    }
    const usageByCategory = new Map<number, number>();
    for (const row of usageRows) {
      if (row.categoryId != null) usageByCategory.set(row.categoryId, Number(row.count));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const categoriesWithSubs = categories.map((cat: any) => ({
      ...cat,
      subcategories: subsByCategory.get(cat.id) ?? [],
      profileCount: usageByCategory.get(cat.id) ?? 0,
    }));

    return res.json({ success: true, data: categoriesWithSubs });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getCategories] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

export async function getCategoryById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [category] = await db
      .select()
      .from(businessProfileCategoriesTable)
      .where(eq(businessProfileCategoriesTable.id, Number(id)));

    if (!category) return res.status(404).json({ error: 'Category not found' });

    const subcategories = await db
      .select()
      .from(businessProfileSubcategoriesTable)
      .where(eq(businessProfileSubcategoriesTable.categoryId, category.id))
      .orderBy(asc(businessProfileSubcategoriesTable.sortOrder));

    return res.json({ success: true, data: { ...category, subcategories } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getCategoryById] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

export async function createCategory(req: Request, res: Response) {
  try {
    const {
      name, description, icon, color, isActive,
      sortOrder, defaultFollowUpDays, defaultLeadPriority,
      autoAssignSupport, supportAiInstructions,
      cmsTemplateInstructions, customFields, settings,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const slug = slugify(name);

    // Check for duplicate slug
    const [existing] = await db
      .select()
      .from(businessProfileCategoriesTable)
      .where(eq(businessProfileCategoriesTable.slug, slug));
    if (existing) return res.status(409).json({ error: 'Category with this name already exists' });

    const [category] = await db
      .insert(businessProfileCategoriesTable)
      .values({
        name: name.trim(),
        slug,
        description: description || null,
        icon: icon || null,
        color: color || null,
        isActive: isActive !== false,
        sortOrder: sortOrder ?? 0,
        defaultFollowUpDays: defaultFollowUpDays ?? 7,
        defaultLeadPriority: defaultLeadPriority || 'normal',
        autoAssignSupport: autoAssignSupport ?? false,
        supportAiInstructions: supportAiInstructions || null,
        cmsTemplateInstructions: cmsTemplateInstructions || null,
        customFields: customFields || [],
        settings: settings || {},
      })
      .returning();

    return res.status(201).json({ success: true, data: category });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[createCategory] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

export async function updateCategory(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const allowedFields = ['name', 'description', 'icon', 'color', 'isActive', 'sortOrder', 'defaultFollowUpDays', 'defaultLeadPriority', 'autoAssignSupport', 'supportAiInstructions', 'cmsTemplateInstructions', 'customFields', 'settings'];
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // If name changed, update slug
    if (updates.name) {
      updates.slug = slugify(updates.name as string);
      // Check for duplicate slug (exclude current)
      const [existing] = await db
        .select()
        .from(businessProfileCategoriesTable)
        .where(
          and(
            eq(businessProfileCategoriesTable.slug, updates.slug as string),
          )
        );
      if (existing && existing.id !== Number(id)) {
        return res.status(409).json({ error: 'Category with this name already exists' });
      }
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(businessProfileCategoriesTable)
      .set(updates)
      .where(eq(businessProfileCategoriesTable.id, Number(id)))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Category not found' });

    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[updateCategory] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

export async function deleteCategory(req: Request, res: Response) {
  try {
    const { id } = req.params;

    // Check if any profiles use this category
    const [usage] = await db
      .select({ count: count() })
      .from(companySettings)
      .where(eq(companySettings.categoryId, Number(id)));

    if (Number(usage?.count ?? 0) > 0) {
      return res.status(400).json({
        error: `Cannot delete: ${usage.count} business profile(s) are using this category. Reassign them first.`,
      });
    }

    const [deleted] = await db
      .delete(businessProfileCategoriesTable)
      .where(eq(businessProfileCategoriesTable.id, Number(id)))
      .returning();

    if (!deleted) return res.status(404).json({ error: 'Category not found' });

    return res.json({ success: true, data: deleted });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[deleteCategory] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

// ─── Subcategories ───────────────────────────────────────────────────────────

export async function getSubcategories(req: Request, res: Response) {
  try {
    const { categoryId } = req.params;
    const subcategories = await db
      .select()
      .from(businessProfileSubcategoriesTable)
      .where(eq(businessProfileSubcategoriesTable.categoryId, Number(categoryId)))
      .orderBy(asc(businessProfileSubcategoriesTable.sortOrder), asc(businessProfileSubcategoriesTable.name));

    return res.json({ success: true, data: subcategories });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getSubcategories] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

export async function createSubcategory(req: Request, res: Response) {
  try {
    const { categoryId } = req.params;
    const {
      name, description, isActive, sortOrder,
      followUpDays, leadReminderDays, leadPriority,
      autoActions, settings,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    // Verify category exists
    const [category] = await db
      .select()
      .from(businessProfileCategoriesTable)
      .where(eq(businessProfileCategoriesTable.id, Number(categoryId)));
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const slug = slugify(name);

    // Check duplicate within category
    const [existing] = await db
      .select()
      .from(businessProfileSubcategoriesTable)
      .where(
        and(
          eq(businessProfileSubcategoriesTable.categoryId, Number(categoryId)),
          eq(businessProfileSubcategoriesTable.slug, slug),
        )
      );
    if (existing) return res.status(409).json({ error: 'Subcategory with this name already exists in this category' });

    const [subcategory] = await db
      .insert(businessProfileSubcategoriesTable)
      .values({
        categoryId: Number(categoryId),
        name: name.trim(),
        slug,
        description: description || null,
        isActive: isActive !== false,
        sortOrder: sortOrder ?? 0,
        followUpDays: followUpDays ?? null,
        leadReminderDays: leadReminderDays ?? 3,
        leadPriority: leadPriority || null,
        autoActions: autoActions || [],
        settings: settings || {},
      })
      .returning();

    return res.status(201).json({ success: true, data: subcategory });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[createSubcategory] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

export async function updateSubcategory(req: Request, res: Response) {
  try {
    const { categoryId, subId } = req.params;
    const allowedFields = ['name', 'description', 'isActive', 'sortOrder', 'followUpDays', 'leadReminderDays', 'leadPriority', 'autoActions', 'settings'];
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (updates.name) {
      updates.slug = slugify(updates.name as string);
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(businessProfileSubcategoriesTable)
      .set(updates)
      .where(
        and(
          eq(businessProfileSubcategoriesTable.id, Number(subId)),
          eq(businessProfileSubcategoriesTable.categoryId, Number(categoryId)),
        )
      )
      .returning();

    if (!updated) return res.status(404).json({ error: 'Subcategory not found' });

    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[updateSubcategory] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

export async function deleteSubcategory(req: Request, res: Response) {
  try {
    const { categoryId, subId } = req.params;

    // Check if any profiles use this subcategory
    const [usage] = await db
      .select({ count: count() })
      .from(companySettings)
      .where(eq(companySettings.subcategoryId, Number(subId)));

    if (Number(usage?.count ?? 0) > 0) {
      return res.status(400).json({
        error: `Cannot delete: ${usage.count} business profile(s) are using this subcategory.`,
      });
    }

    const [deleted] = await db
      .delete(businessProfileSubcategoriesTable)
      .where(
        and(
          eq(businessProfileSubcategoriesTable.id, Number(subId)),
          eq(businessProfileSubcategoriesTable.categoryId, Number(categoryId)),
        )
      )
      .returning();

    if (!deleted) return res.status(404).json({ error: 'Subcategory not found' });

    return res.json({ success: true, data: deleted });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[deleteSubcategory] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}
