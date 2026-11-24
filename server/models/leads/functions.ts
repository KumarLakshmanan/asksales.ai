import { db } from "../db";
import { leadsTable, type LeadRecord, type InsertLead } from "./schema";
import { eq, sql, and } from "drizzle-orm";
import { icpProfilesTable } from "../icpData/schema";
import { companySettings } from "../companySettings/schema";
import { businessProfileCategoriesTable, businessProfileSubcategoriesTable } from "../businessProfileCategories/schema";

export interface BusinessCategoryInfo {
  businessCategoryId: number | null;
  businessCategoryName: string | null;
  businessSubcategoryId: number | null;
  businessSubcategoryName: string | null;
}

export class LeadModel {
  /**
   * Resolve business category from an ICP promptId or userId.
   * Path: promptId → icp_profiles.businessId → company_settings.categoryId → business_profile_categories.name
   */
  static async resolveBusinessCategory(opts: { promptId?: number | null; userId?: number | null }): Promise<BusinessCategoryInfo> {
    const result: BusinessCategoryInfo = { businessCategoryId: null, businessCategoryName: null, businessSubcategoryId: null, businessSubcategoryName: null };
    try {
      let categoryId: number | null = null;
      let subcategoryId: number | null = null;

      // Try via promptId → ICP → company_settings
      if (opts.promptId) {
        const [icp] = await db.select({ businessId: icpProfilesTable.businessId }).from(icpProfilesTable).where(eq(icpProfilesTable.id, opts.promptId)).limit(1);
        if (icp?.businessId) {
          const [cs] = await db.select({ categoryId: companySettings.categoryId, subcategoryId: companySettings.subcategoryId }).from(companySettings).where(eq(companySettings.id, icp.businessId)).limit(1);
          categoryId = cs?.categoryId ?? null;
          subcategoryId = cs?.subcategoryId ?? null;
        }
      }

      // Fallback: try via userId → default company_settings
      if (!categoryId && opts.userId) {
        const [cs] = await db.select({ categoryId: companySettings.categoryId, subcategoryId: companySettings.subcategoryId }).from(companySettings).where(and(eq(companySettings.userId, opts.userId), eq(companySettings.id, requireBusinessScope().businessProfileId))).limit(1);
        categoryId = cs?.categoryId ?? null;
        subcategoryId = cs?.subcategoryId ?? null;
      }

      if (categoryId) {
        result.businessCategoryId = categoryId;
        const [cat] = await db.select({ name: businessProfileCategoriesTable.name }).from(businessProfileCategoriesTable).where(eq(businessProfileCategoriesTable.id, categoryId)).limit(1);
        result.businessCategoryName = cat?.name ?? null;
      }
      if (subcategoryId) {
        result.businessSubcategoryId = subcategoryId;
        const [sub] = await db.select({ name: businessProfileSubcategoriesTable.name }).from(businessProfileSubcategoriesTable).where(eq(businessProfileSubcategoriesTable.id, subcategoryId)).limit(1);
        result.businessSubcategoryName = sub?.name ?? null;
      }
    } catch { /* non-blocking */ }
    return result;
  }
  static async findAll(): Promise<LeadRecord[]> {
    return await db.select().from(leadsTable);
  }

  static async findById(id: number): Promise<LeadRecord | undefined> {
    const result = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
    return result[0];
  }

  static async findByIdForUser(id: number, userId: number): Promise<LeadRecord | undefined> {
    const result = await db.select().from(leadsTable).where(and(
      eq(leadsTable.id, id),
      eq(leadsTable.userId, userId),
    )).limit(1);
    return result[0];
  }

  static async findByEmail(email: string): Promise<LeadRecord | undefined> {
    const result = await db.select().from(leadsTable).where(eq(leadsTable.email, email)).limit(1);
    return result[0];
  }

  static async create(
    data: InsertLead,
    options: { billAsGeneratedLead?: boolean } = {},
  ): Promise<LeadRecord> {
    const lead = await db.transaction(async (tx: any) => {
      const { crmService, lockCrmContactResolution } = await import('../../services/CRMService.js');
      if (data.userId && data.phone) await lockCrmContactResolution(tx, data.userId);
      const [created] = await tx.insert(leadsTable).values(data).returning();
      if (created?.userId && created.phone) {
        await crmService.syncLeadContact(created.userId, created.id, undefined, tx);
        return (await tx.select().from(leadsTable).where(and(eq(leadsTable.id, created.id), eq(leadsTable.userId, created.userId))).limit(1))[0];
      }
      return created;
    });

    // Manual/admin CRUD must not be charged as provider-backed generation.
    // Automated generation callers must opt in after the lead is persisted.
    if (data.userId && options.billAsGeneratedLead) {
      try {
        const { deductCreditsForLead } = await import('../../services/CreditDeductionHooks.js');
        await deductCreditsForLead(data.userId, 'generation', {
          leadId: lead.id,
          service: 'LeadModel',
        });
      } catch (_err) {
        // Credit deduction failure should not break lead creation
      }
    }

    return lead;
  }

  static async update(id: number, data: Partial<InsertLead>): Promise<LeadRecord | undefined> {
    return db.transaction(async (tx: any) => {
      const { crmService, lockCrmContactResolution } = await import('../../services/CRMService.js');
      const sharedFields = ['name', 'firstName', 'lastName', 'phone', 'email', 'company', 'role', 'website', 'linkedinUrl', 'status', 'leadStatus', 'assignedTo'] as const;
      const changes = Object.fromEntries(sharedFields.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
      const [existing] = Object.keys(changes).length ? await tx.select({ userId: leadsTable.userId }).from(leadsTable).where(eq(leadsTable.id, id)).limit(1) : [];
      let configuration;
      if (existing?.userId) {
        const { getCrmConfiguration } = await import('../../services/CRMConfigurationService.js');
        configuration = await getCrmConfiguration(existing.userId, tx, true);
        await lockCrmContactResolution(tx, existing.userId);
      }
      const result = await tx.update(leadsTable).set(data).where(eq(leadsTable.id, id)).returning();
      if (result[0]?.userId && configuration) {
        await crmService.syncLeadContact(result[0].userId, id, changes, tx, configuration);
        return (await tx.select().from(leadsTable).where(and(eq(leadsTable.id, id), eq(leadsTable.userId, result[0].userId))).limit(1))[0];
      }
      return result[0];
    });
  }

  static async delete(id: number): Promise<void> {
    await db.delete(leadsTable).where(eq(leadsTable.id, id));
  }

  /** Count leads for a specific user + thread combination */
  static async countByUserAndThread(userId: number, threadId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.userId, userId),
          sql`(${leadsTable.campaignData}->>'threadId')::int = ${threadId}`
        )
      );
    return Number(result[0]?.count || 0);
  }

  /** Count all leads for a user */
  static async countByUser(userId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(leadsTable)
      .where(eq(leadsTable.userId, userId));
    return Number(result[0]?.count || 0);
  }
}
import { requireBusinessScope } from '../../tenancy/businessContext.js';
