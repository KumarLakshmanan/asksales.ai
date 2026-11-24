import { z } from 'zod';
import { createHash } from 'node:crypto';
import { leadDirectoryQuery } from '../services/leadDirectoryQuery.js';
import { LEAD_EXPORT_LIMIT } from '../../shared/leadExport.js';
import { EnrichmentBillingError } from '../services/enrichment/errors.js';
import { crmCsvCell } from '../utils/crmWorkspaceValidation.js';
import { businessOwnerUserId, requireBusinessScope } from '../tenancy/businessContext.js';
import { threadLeadIds } from '../services/threadLeadCohort.js';
import { isPostgresIntegerId } from '../utils/postgresIntegerId.js';
import { businessCacheKey } from '../tenancy/businessContext.js';
import { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { LeadModel } from "../models/leads/functions";
import { InsertLead, type LeadRecord } from "../models/leads/schema";
import { db } from "../models/db";
import { invalidateDashboardCache } from "../services/dashboardCache.js";
import { getCrmConfiguration, CrmConfigurationError } from '../services/CRMConfigurationService.js';
import { validateCrmAssignee } from '../services/CRMAssigneeService.js';

async function invalidateUserDashboardCache(userId: number): Promise<void> {
  await invalidateDashboardCache(userId);
}
import { leadsTable } from "../models/leads/schema";
import { icpProfilesTable } from "../models/icpData/schema";
import { outreachConversationsTable, outreachMessagesTable } from "../models/outreachConversations/schema";
import { sentMessagesTable } from "../models/sentMessages/schema";
import { ICPGenerationService } from "../services/ICPGenerationService";
import { eq, and, or, desc, inArray, sql } from "drizzle-orm";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { ApifyClient } from 'apify-client';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { getApifyKey } from "../services/credentialService";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { LLMProviderFactory } from "../services/agents/LLMProviderFactory";
import { NotificationService } from '../services/NotificationService.js';
import { CampaignWorkspaceError } from '../services/CampaignWorkspaceService.js';
import { saveCampaignLeadImport } from '../services/CampaignLeadImportService.js';

export const getLeads = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    // Validate userId - should be present after auth middleware
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    // Query parameters
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 10));
    const { conditions, displayedStatus, orderBy } = leadDirectoryQuery(userId, req.query);

    // Calculate offset
    const offset = (page - 1) * pageSize;

    // The three reads run one after another on one connection: the leads page
    // fires several requests at once and each standalone query takes its own
    // pooled connection and tenant-scope setup.
    const { total, leads, statusRows } = await db.transaction(async (tx: typeof db) => {
      const [countResult] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(leadsTable)
        .where(and(...conditions));
      const total = countResult?.count || 0;

      // Get paginated results
      let query = tx.select().from(leadsTable);

      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }
      const leads = await query.orderBy(...orderBy).limit(pageSize).offset(offset);

      // Discover legacy/provider states across this business, independent of filters
      // and pagination. Never expose another business's status vocabulary.
      const statusRows = await tx.select({ status: displayedStatus }).from(leadsTable)
        .where(and(...leadDirectoryQuery(userId, {}).conditions)).groupBy(displayedStatus);
      return { total, leads, statusRows };
    });
    const totalPages = Math.ceil(total / pageSize);

    res.json({
      data: leads,
      total,
      page,
      pageSize,
      totalPages,
      statuses: statusRows.map((row: { status: string }) => row.status).sort(),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error fetching leads');
    res.status(500).json({ error: "Unable to retrieve leads. Please try again." });
  }
};

export const getLead = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    // Validate id
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid lead ID" });
    }
    
    // Validate userId - should be present after auth middleware
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    const lead = await LeadModel.findByIdForUser(id, userId);
    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }
    
    // Count the messages actually present in the inbox. The legacy
    // messages_received counter is not maintained by every channel.
    const replies = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM outreach_messages message
      JOIN outreach_conversations conversation
        ON conversation.id = message.conversation_id
        AND conversation.user_id = message.user_id
        AND conversation.business_profile_id = message.business_profile_id
      WHERE conversation.lead_id = ${id} AND conversation.user_id = ${userId}
        AND conversation.business_profile_id = ${lead.businessProfileId}
        AND message.direction = 'inbound'
    `);
    res.json({ ...lead, inboxReplies: Number(replies.rows[0]?.count ?? 0) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Controller] Unhandled error');
    res.status(500).json({ error: "Unable to retrieve the lead. Please try again." });
  }
};

/**
 * GET /api/leads/thread/:threadId
 * Get all leads generated from a specific chat thread
 */
export const getLeadsByThread = async (req: Request, res: Response) => {
  try {
    const threadId = parseInt(req.params.threadId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!isPostgresIntegerId(req.params.threadId)) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }
    const business = requireBusinessScope().businessProfileId;

    // Active leads from every ICP profile of this thread plus leads linked by
    // legacy campaign metadata, through the indexed cohort lookup. A
    // campaign_data JSON filter here scanned every lead the account owns, and
    // the workspace polls this endpoint while a workflow runs.
    const leads = await db
      .select()
      .from(leadsTable)
      .where(and(
        eq(leadsTable.userId, userId),
        eq(leadsTable.businessProfileId, business),
        sql`${leadsTable.id} IN (${threadLeadIds(userId, business, threadId)})`,
      ))
      .orderBy(leadsTable.id);

    res.json(leads);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error fetching leads by thread');
    res.status(500).json({ error: "Unable to retrieve leads. Please try again." });
  }
};

/**
 * GET /api/leads/execution/:executionId
 * Get all leads from a specific workflow execution
 */
export const getLeadsByExecution = async (req: Request, res: Response) => {
  try {
    const executionId = req.params.executionId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    // Validate userId - should be present after auth middleware
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Only return leads that belong to this user
    const leads = await db
      .select()
      .from(leadsTable)
      .where(and(
        eq(leadsTable.executionId, executionId),
        eq(leadsTable.userId, userId)
      ));

    res.json(leads);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error fetching leads by execution');
    res.status(500).json({ error: "Unable to retrieve leads. Please try again." });
  }
};

/**
 * GET /api/leads/export?format=csv (directory filters, legacy thread/execution scope)
 * POST /api/leads/export?format=csv with { ids } (checked records)
 * Export leads in CSV or JSON format
 */
const leadExportSelectionSchema = z.object({
  ids: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(LEAD_EXPORT_LIMIT),
}).strict();

export const exportLeads = async (req: Request, res: Response) => {
  try {
    const { format = 'csv', threadId, executionId } = req.query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    // Validate userId - should be present after auth middleware
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const parsedSelection = req.method === 'POST' ? leadExportSelectionSchema.safeParse(req.body) : null;
    if (parsedSelection && !parsedSelection.success) {
      return res.status(400).json({ error: `Select between 1 and ${LEAD_EXPORT_LIMIT.toLocaleString('en-US')} valid lead IDs.` });
    }
    const ids = parsedSelection?.success ? [...new Set(parsedSelection.data.ids)] : null;
    // Checked records take precedence over directory filters, including selections
    // retained across pages. GET retains legacy thread/execution exports.
    const { conditions, orderBy } = leadDirectoryQuery(userId, ids ? { sortBy: req.query.sortBy } : req.query, { ignoreThreadId: true });
    if (ids) {
      conditions.push(inArray(leadsTable.id, ids));
    } else if (threadId) {
      if (typeof threadId !== 'string' || !/^[1-9]\d*$/.test(threadId) || !Number.isSafeInteger(Number(threadId))) {
        return res.status(400).json({ error: 'Invalid thread ID' });
      }
      const icp = await new ICPGenerationService().getICPForThread(userId, Number(threadId));
      conditions.push(or(
        sql`${leadsTable.campaignData}->>'threadId' = ${threadId}`,
        icp?.id ? eq(leadsTable.promptId, icp.id) : sql`false`,
      )!);
    } else if (executionId) {
      if (typeof executionId !== 'string') return res.status(400).json({ error: 'Invalid execution ID' });
      conditions.push(eq(leadsTable.executionId, executionId));
    }
    const leads: Array<LeadRecord & { platform?: string }> = await db.select().from(leadsTable).where(and(...conditions))
      .orderBy(...orderBy).limit(LEAD_EXPORT_LIMIT + 1);
    if (leads.length > LEAD_EXPORT_LIMIT) {
      return res.status(422).json({ error: `Export supports up to ${LEAD_EXPORT_LIMIT.toLocaleString('en-US')} leads. Narrow your filters and try again.` });
    }
    if (ids && leads.length !== ids.length) {
      // Fail the whole selection; never silently omit stale/foreign IDs or fall
      // back to a wider export. Do not disclose which IDs were unavailable.
      return res.status(404).json({ error: 'Some selected leads are unavailable in this business. Refresh your selection and try again.' });
    }

    // Map lead properties for CSV/JSON backward compatibility and field completeness
    const mappedLeads: Record<string, unknown>[] = leads.map(lead => ({
      ...lead,
      platform: lead.platformType || lead.platform,
      company: lead.companyName || lead.company,
      name: lead.fullName || lead.name,
      location: typeof lead.location === 'object' && lead.location 
        ? JSON.stringify(lead.location) 
        : lead.location
    }));

    if (format === 'csv') {
      // Convert to CSV
      const fields = [
        'id', 'name', 'fullName', 'email', 'firstName', 'lastName', 'phone', 'company', 
        'role', 'headline', 'location', 'platform', 'linkedinUsername',
        'twitter', 'website', 'fitScore', 'status', 'createdAt'
      ];
      
      const csv = [fields.map(crmCsvCell).join(','), ...mappedLeads.map(lead => fields.map(field => crmCsvCell(lead[field])).join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="leads-${Date.now()}.csv"`);
      res.send(csv);
    } else {
      // JSON format
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="leads-${Date.now()}.json"`);
      res.send(JSON.stringify(leads, null, 2));
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error exporting leads');
    res.status(500).json({ error: "Unable to export leads. Please try again." });
  }
};

export const bulkImportLeads = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { leads, threadId, fileName, requestId } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads array is required and must not be empty' });
    }
    if ((threadId !== undefined && (!Number.isSafeInteger(Number(threadId)) || Number(threadId) <= 0)) ||
        (fileName !== undefined && (typeof fileName !== 'string' || fileName.length > 500)) ||
        (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(requestId))) ||
        leads.some((lead: unknown) => !lead || typeof lead !== 'object' || Array.isArray(lead))) {
      return res.status(400).json({ error: 'Invalid lead import details.' });
    }
    const safeFileName = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : 'Lead upload';
    const fingerprint = createHash('sha256').update(JSON.stringify([leads, threadId ? Number(threadId) : null, safeFileName])).digest('hex');

    const campaignData = threadId ? {
      threadId: Number(threadId),
      source: 'csv_import',
      createdAt: new Date().toISOString(),
    } : undefined;

    // Resolve business category from user's default business profile
    const catInfo = await LeadModel.resolveBusinessCategory({ userId });

    const records: InsertLead[] = leads.map((l: Record<string, unknown>) => ({
      userId,
      name: (l.name as string) || `${((l.first_name || l.firstName) as string) || ''} ${((l.last_name || l.lastName) as string) || ''}`.trim() || (l.company as string) || (l.company_name as string) || null,
      firstName: ((l.first_name || l.firstName || null) as string | null),
      lastName: ((l.last_name || l.lastName || null) as string | null),
      email: ((l.email || null) as string | null),
      phone: ((l.phone || null) as string | null),
      company: ((l.company || l.company_name || null) as string | null),
      role: ((l.role || l.job_title || null) as string | null),
      website: ((l.website || null) as string | null),
      linkedin: ((l.linkedin || l.linkedin_url || null) as string | null),
      source: 'import',
      status: 'new',
      ...(campaignData && { campaignData }),
      ...(catInfo.businessCategoryId && {
        businessCategoryId: catInfo.businessCategoryId,
        businessCategoryName: catInfo.businessCategoryName,
        businessSubcategoryId: catInfo.businessSubcategoryId,
        businessSubcategoryName: catInfo.businessSubcategoryName,
      }),
    }));

    const saved = await saveCampaignLeadImport(userId, { threadId: threadId ? Number(threadId) : undefined,
      fileName: safeFileName, requestId, fingerprint, records });
    if (saved.conflict) return res.status(409).json({ error: 'This upload request was already used for different leads. Select the file again.' });
    // Save in-app notification
    if (!saved.replayed) NotificationService.leadsImported(userId, saved.count);
    void invalidateUserDashboardCache(userId);
    return res.json({ success: true, importId: saved.importId, imported: saved.count, matchedExisting: saved.matchedExisting ?? 0,
      replayed: saved.replayed, message: `Imported ${saved.count} leads` });
  } catch (error) {
    logger.error({ err: error }, '[bulkImportLeads] Error');
    if (error instanceof CampaignWorkspaceError) return res.status(404).json({ error: 'Campaign workspace not found.' });
    return res.status(500).json({ error: 'Failed to import leads' });
  }
};

export const createLead = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { threadId, campaignId, title, ...restData } = req.body;
    const pipelineStatus = restData.leadStatus || restData.status || 'new';
    
    // Build campaign data object if threadId or campaignId provided
    const campaignData = threadId || campaignId ? {
      ...(threadId && { threadId }),
      ...(campaignId && { campaignId }),
      source: 'manual_entry',
      createdAt: new Date().toISOString()
    } : undefined;

    // Resolve business category from user's business profile
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let catInfo: any = {};
    try {
      catInfo = await LeadModel.resolveBusinessCategory({ userId }) || {};
    } catch (err) {
      logger.warn({ err, userId }, '[createLead] Failed to resolve business category, continuing without it');
    }

    const leadData: InsertLead = {
      ...restData,
      userId,
      source: restData.source || 'manual',
      role: restData.role || title || null,
      status: restData.status || pipelineStatus,
      leadStatus: pipelineStatus,
      ...(campaignData && { campaignData }),
      ...(catInfo.businessCategoryId && {
        businessCategoryId: catInfo.businessCategoryId,
        businessCategoryName: catInfo.businessCategoryName,
        businessSubcategoryId: catInfo.businessSubcategoryId,
        businessSubcategoryName: catInfo.businessSubcategoryName,
      }),
    };
    
    const lead = await LeadModel.create(leadData);
    void invalidateUserDashboardCache(leadData.userId ?? userId ?? 0);
    res.status(201).json(lead);
  } catch (_error) {
    logger.error({ err: _error }, '[createLead] Error');
    res.status(500).json({ error: "Unable to create the lead. Please try again." });
  }
};

export const updateLead = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { title, ...requestedLeadData } = req.body;
    const leadData: Partial<InsertLead> = { ...requestedLeadData };
    
    // Validate userId - should be present after auth middleware
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!leadData.role && typeof title === 'string') leadData.role = title;
    
    // First verify the lead exists and belongs to the user
    const existingLead = await LeadModel.findByIdForUser(id, userId);
    if (!existingLead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    // `leadStatus` is the canonical pipeline state. Keep the legacy `status`
    // column synchronized so older integrations continue to behave correctly.
    if (leadData.leadStatus !== undefined) {
      leadData.status = leadData.leadStatus || existingLead.status;
    } else if (leadData.status !== undefined) {
      leadData.leadStatus = leadData.status || existingLead.leadStatus;
    }
    
    logger.info({ id, fields: Object.keys(leadData) }, '[LeadController] Updating lead');
    
    // Ensure updatedAt is set
    leadData.updatedAt = new Date();
    
    const { crmService, lockCrmContactResolution } = await import('../services/CRMService.js');
    const lead = await db.transaction(async (tx: any) => {
      const configuration = await getCrmConfiguration(userId, tx, true);
      await validateCrmAssignee(userId, leadData.assignedTo, tx);
      await lockCrmContactResolution(tx, userId);
      const [updated] = await tx.update(leadsTable).set(leadData)
        .where(and(eq(leadsTable.id, id), eq(leadsTable.userId, userId))).returning();
      if (updated) await crmService.syncLeadContact(userId, id, leadData, tx, configuration);
      // Lifecycle normalization may have updated the compatibility fields.
      return updated ? (await tx.select().from(leadsTable).where(and(eq(leadsTable.id, id), eq(leadsTable.userId, userId))).limit(1))[0] : undefined;
    });
    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }
    
    logger.info({ id }, '[LeadController] Lead updated successfully');
    void invalidateUserDashboardCache(userId);
    res.json(lead);
  } catch (error: unknown) {
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, '[LeadController] Error updating lead');
    res.status(500).json({ error: "Unable to update the lead. Please try again." });
  }
};

export const deleteLead = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    // Validate userId - should be present after auth middleware
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    // First verify the lead exists and belongs to the user
    const [deleted] = await db.delete(leadsTable)
      .where(and(eq(leadsTable.id, id), eq(leadsTable.userId, userId)))
      .returning({ id: leadsTable.id });
    if (!deleted) return res.status(404).json({ error: "Lead not found" });
    void invalidateUserDashboardCache(userId);
    res.status(204).send();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Controller] Unhandled error');
    res.status(500).json({ error: "Unable to delete the lead. Please try again." });
  }
};

/**
 * POST /api/leads/verify
 * Store manual verification results for leads
 */
export const verifyLeads = async (req: Request, res: Response) => {
  try {
    const { threadId: _threadId, executionId: _executionId, verifications, stats } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const requestedIds = Object.keys(verifications).map(Number).filter(Number.isSafeInteger);
    const ownedLeads: LeadRecord[] = requestedIds.length > 0
      ? await db.select().from(leadsTable).where(and(inArray(leadsTable.id, requestedIds), eq(leadsTable.userId, userId))) as LeadRecord[]
      : [];
    const ownedById = new Map(ownedLeads.map((lead) => [lead.id, lead]));

    logger.info({ count: Object.keys(verifications).length }, '[LeadController] Processing verification for leads');

    // Process each verification result
    const verificationResults = {
      approved: [] as string[],
      rejected: [] as string[],
      updated: 0,
    };

    for (const [leadId, verificationData] of Object.entries(verifications)) {
      const data = verificationData as { status: string; rejectionReason?: string };
      
      try {
        const leadIdNum = parseInt(leadId);
        const ownedLead = ownedById.get(leadIdNum);
        if (!ownedLead || data.status === 'pending') continue;
        
        if (data.status === 'approved') {
          const [updated] = await db.update(leadsTable)
            .set({
              verified: true,
              aiExtractedFields: {
                ...((ownedLead.aiExtractedFields as Record<string, unknown> | null) || {}),
                manualVerification: { status: 'approved', verifiedAt: new Date().toISOString() },
              },
              updatedAt: new Date(),
            })
            .where(and(eq(leadsTable.id, leadIdNum), eq(leadsTable.userId, userId)))
            .returning({ id: leadsTable.id });
          
          if (updated) {
            verificationResults.approved.push(leadId);
            verificationResults.updated++;
          }
        } else if (data.status === 'rejected') {
          const [updated] = await db.update(leadsTable)
            .set({
              verified: false,
              status: 'rejected',
              leadStatus: 'rejected',
              aiExtractedFields: {
                ...((ownedLead.aiExtractedFields as Record<string, unknown> | null) || {}),
                manualVerification: {
                  status: 'rejected',
                  rejectionReason: data.rejectionReason || 'No reason provided',
                  verifiedAt: new Date().toISOString(),
                },
              },
              updatedAt: new Date(),
            })
            .where(and(eq(leadsTable.id, leadIdNum), eq(leadsTable.userId, userId)))
            .returning({ id: leadsTable.id });
          
          if (updated) {
            verificationResults.rejected.push(leadId);
            verificationResults.updated++;
          }
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.error({ err, leadId }, '[LeadController] Error verifying lead');
      }
    }

    logger.info({ verificationResults }, '[LeadController] Verification complete');
    if (verificationResults.updated > 0) void invalidateUserDashboardCache(userId);

    res.json({
      success: true,
      message: `Verification processed: ${verificationResults.approved.length} approved, ${verificationResults.rejected.length} rejected`,
      results: verificationResults,
      stats,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error in verifyLeads');
    res.status(500).json({
      error: 'Unable to process verification. Please try again.',
      details: error.message,
    });
  }
};

/**
 * POST /api/leads/enrich
 * Enrich selected leads using the deep enrichment orchestrator.
 * Chains across websites, social media profiles, and LLM extraction.
 */
export const enrichLeads = async (req: Request, res: Response) => {
  try {
    const { leadIds, threadId: _threadId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No lead IDs provided',
      });
    }

    logger.info({ count: leadIds.length }, '[LeadController] Starting enrichment for leads');

    // Convert lead IDs to numbers
    const leadIdNumbers = leadIds.map((id: string | number) => Number(id));

    // Fetch the leads from database
    const leads = await db
      .select()
      .from(leadsTable)
      .where(and(inArray(leadsTable.id, leadIdNumbers), eq(leadsTable.userId, userId)));

    if (leads.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No leads found with the provided IDs',
      });
    }

    logger.info({ count: leads.length }, '[LeadController] Found leads to enrich');

    // Track enrichment results
    const enrichmentResults = {
      enriched: [] as number[],
      failed: [] as number[],
      skipped: [] as number[],
    };

    // Use the deep enrichment orchestrator for each lead
    const { leadEnrichmentOrchestrator } = await import('../services/enrichment/index.js');

    for (const lead of leads) {
      try {
        // Check if lead has any enrichable data (social handles, website, etc.)
        const hasWebsite = lead.website || lead.companyDomain;
        const hasSocial = lead.instagramHandle || lead.instagram || lead.twitterHandle ||
          lead.twitter || lead.linkedinUrl || lead.linkedin || lead.facebookUrl || lead.facebook;

        if (!hasWebsite && !hasSocial && !lead.profileUrl) {
          enrichmentResults.skipped.push(lead.id);
          await db.update(leadsTable)
            .set({
              enrichedData: {
                status: 'skipped',
                reason: 'No website URL or social handles available',
                attemptedAt: new Date().toISOString(),
              },
            })
            .where(and(eq(leadsTable.id, lead.id), eq(leadsTable.userId, userId)));
          continue;
        }

        logger.info({ leadId: lead.id, website: lead.website }, '[LeadController] Running deep enrichment for lead');

        const result = await leadEnrichmentOrchestrator.enrichLead(userId, lead.id, {
          threadId: _threadId ? parseInt(_threadId) : undefined,
        });

        if (result.success) {
          enrichmentResults.enriched.push(lead.id);
          logger.info({ leadId: lead.id, iterations: result.iterations }, '[LeadController] Successfully enriched lead');
        } else {
          enrichmentResults.failed.push(lead.id);
          logger.warn({ leadId: lead.id, error: result.error }, '[LeadController] Enrichment failed for lead');
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (enrichErr: any) {
        logger.error({ err: enrichErr, leadId: lead.id }, '[LeadController] Error enriching lead');
        enrichmentResults.failed.push(lead.id);

        await db.update(leadsTable)
          .set({
            enrichedData: {
              status: 'failed',
              error: enrichErr.message,
              attemptedAt: new Date().toISOString(),
            },
          })
          .where(and(eq(leadsTable.id, lead.id), eq(leadsTable.userId, userId)));
      }
    }

    logger.info({ enrichmentResults }, '[LeadController] Enrichment complete');

    // Save in-app notification
    if (userId && enrichmentResults.enriched.length > 0) {
      NotificationService.leadsEnriched(userId, enrichmentResults.enriched.length);
    }

    res.json({
      success: true,
      message: `Enrichment complete: ${enrichmentResults.enriched.length} enriched, ${enrichmentResults.failed.length} failed, ${enrichmentResults.skipped.length} skipped`,
      enrichedCount: enrichmentResults.enriched.length,
      results: enrichmentResults,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error in enrichLeads');
    res.status(500).json({
      success: false,
      error: 'Unable to enrich leads. Please try again.',
      details: error.message,
    });
  }
};

/**
 * POST /api/leads/:id/score
 * Generate/update AI score for a single lead based on ICP fit
 */
export const scoreLeadById = async (req: Request, res: Response) => {
  try {
    const leadId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { threadId } = req.body;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Fetch the lead from database
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Get the ICP profile for this user/thread
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let icpProfile: any = null;
    
    if (lead.promptId) {
      // Use lead's existing ICP
      const [icp] = await db
        .select()
        .from(icpProfilesTable)
        .where(and(eq(icpProfilesTable.id, lead.promptId), eq(icpProfilesTable.userId, userId)));
      icpProfile = icp;
    } else if (threadId) {
      // Try to get ICP from thread
      const icpService = new ICPGenerationService();
      icpProfile = await icpService.getICPForThread(userId, parseInt(threadId));
    } else if (userId) {
      // Get the most recent ICP for user
      const icpService = new ICPGenerationService();
      icpProfile = await icpService.getLatestICPForUser(userId);
    }

    logger.info({ leadId, icpId: icpProfile?.id }, '[LeadController] Scoring lead against ICP');

    const leadData = {
      name: lead.name || lead.fullName || `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || lead.company || lead.companyName || null,
      email: lead.email,
      company: lead.company || lead.companyName || null,
      role: lead.role || null,
      headline: lead.headline || null,
      industry: lead.industry || null,
      companySize: lead.companySize || null,
      location: lead.location || null,
      bio: lead.bio || null,
      skills: lead.skills || null,
      seniority: lead.seniority || null,
      website: lead.website || null,
      linkedin: lead.linkedin || null,
      source: lead.source || null,
    };

    // Check if we have enough data to score
    const hasSignificantData = leadData.company || leadData.role || leadData.headline || leadData.industry;

    const icpData = icpProfile ? {
      targetIndustries: icpProfile.targetIndustries,
      targetCompanySize: icpProfile.targetCompanySize,
      targetRoles: icpProfile.targetRoles,
      targetLocations: icpProfile.targetLocations,
      painPoints: icpProfile.painPoints,
      buyingSignals: icpProfile.buyingSignals,
      budget: icpProfile.budget,
      decisionMakingCriteria: icpProfile.decisionMakingCriteria,
    } : null;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const prompt = `Score this lead from 0-100 based on how well they match the Ideal Customer Profile (ICP).

Lead Data:
${JSON.stringify(leadData, null, 2)}

ICP Profile:
${icpData ? JSON.stringify(icpData, null, 2) : 'No ICP defined - score based on general B2B lead quality'}

IMPORTANT SCORING GUIDELINES:
- For incomplete lead data, make reasonable inferences from available information
- If headline or bio contains job title/company indicators, use them for scoring
- Email domain can indicate company type (e.g., @gmail.com vs @company.com)
- LinkedIn profiles indicate professional engagement
- ${hasSignificantData ? 'Score normally based on available data' : 'This lead has LIMITED DATA - assign a neutral score around 50 unless you can infer quality from email or other clues'}

Scoring Criteria:
1. Industry match (25 points) - Infer from company, headline, or email domain if not explicit
2. Company size fit (20 points) - Use email domain or company name as hints
3. Role/seniority alignment (25 points) - Look at headline, role, or name patterns
4. Location relevance (10 points) - Award points if available and matches
5. Decision-making authority indicators (20 points) - Titles like CEO, Director, Manager get higher scores

Respond ONLY with a JSON object in this exact format:
{
  "score": <number 0-100>,
  "breakdown": {
    "industryMatch": <number 0-25>,
    "companySizeFit": <number 0-20>,
    "roleAlignment": <number 0-25>,
    "locationRelevance": <number 0-10>,
    "decisionMakingAuthority": <number 0-20>
  },
  "reasoning": "<brief explanation>",
  "dataQuality": "${hasSignificantData ? 'good' : 'limited'}"
}`;

    // Use LeadScoringService (per-user provider)
    try {
      const { leadScoringService } = await import('../services/LeadScoringService');
      const scoreResult = await leadScoringService.scoreLead(userId, leadData, icpProfile);

      const newScore = Math.min(100, Math.max(0, Math.round(scoreResult.score || 0)));

      // Update lead with new score
      await db.update(leadsTable)
        .set({
          score: newScore,
          fitScore: newScore,
          aiConfidenceScore: 0.85,
          aiExtractedFields: {
            llmScore: scoreResult.llmScore || null,
            scoreReasoning: scoreResult.llmScore?.reasoning || '',
            scoredAt: new Date().toISOString(),
            icpId: icpProfile?.id,
          },
          updatedAt: new Date(),
        })
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));

      // Fetch updated lead
      const [updatedLead] = await db
        .select()
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));

      logger.info({ leadId, newScore }, '[LeadController] Lead scored');

      res.json({
        success: true,
        score: newScore,
        warning: scoreResult.warning,
        breakdown: scoreResult.llmScore || null,
        reasoning: scoreResult.llmScore?.reasoning || '',
        lead: updatedLead,
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.error({ err }, '[LeadController] Error scoring lead');
      res.status(500).json({ success: false, error: 'Unable to score the lead. Please try again.' });
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error scoring lead');
    res.status(500).json({
      success: false,
      error: 'Unable to score the lead. Please try again.',
      details: error.message,
    });
  }
};

/**
 * POST /api/leads/:id/enrich
 * Enrich a single lead by crawling their website
 */
export const enrichLeadById = async (req: Request, res: Response) => {
  try {
    const leadId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Fetch the lead from database
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Check if there's anything to enrich from
    const { buildInitialHandles } = await import('../services/enrichment/helpers.js');
    const hasEnrichableData = buildInitialHandles(lead).length > 0;

    if (!hasEnrichableData) {
      return res.status(400).json({
        success: false,
        error: 'No website URL or social profiles available for this lead',
      });
    }

    logger.info({ leadId }, '[LeadController] Enriching lead via orchestrator');

    const { leadEnrichmentOrchestrator } = await import('../services/enrichment/index.js');
    const result = await leadEnrichmentOrchestrator.enrichLead(userId, leadId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error || 'Lead enrichment did not complete' });
    }

    // Fetch updated lead
    const [updatedLead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));

    logger.info({ leadId, hasEnrichedData: !!updatedLead?.enrichedData }, '[LeadController] Lead enriched successfully');

    res.json({
      success: true,
      message: 'Lead enriched successfully',
      extractedData: updatedLead?.enrichedData || {},
      lead: updatedLead,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof EnrichmentBillingError) return res.status(error.status).json({ success: false, error: error.message, code: error.code });
    logger.error({ err: error }, '[LeadController] Error enriching lead');
    res.status(500).json({
      success: false,
      error: 'Unable to enrich the lead. Please try again.',
      details: error.message,
    });
  }
};

/**
 * POST /api/leads/:id/validate-email
 * Validate lead's email using ZeroBounce API
 */
export const validateEmailById = async (req: Request, res: Response) => {
  try {
    const leadId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Fetch the lead from database
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    if (!lead.email) {
      return res.status(400).json({
        success: false,
        error: 'Lead does not have an email address',
      });
    }

    logger.info({ leadId, email: lead.email }, '[LeadController] Validating email for lead');

    // Use the shared validation service so credential fallback, usage logging,
    // rate limiting, and the actual provider credit charge remain authoritative.
    const { getEmailValidationService } = await import('../services/EmailValidationService.js');
    const validationService = await getEmailValidationService(userId);
    const validationResult = await validationService.validateEmail(lead.email);

    if (!validationResult.success) {
      const isConfigurationError = validationResult.error?.toLowerCase().includes('not configured');
      return res.status(isConfigurationError ? 503 : 502).json({
        success: false,
        error: isConfigurationError
          ? 'Email validation is not configured. Ask an administrator to configure ZeroBounce.'
          : validationResult.error || 'The email validation provider could not complete the request.',
      });
    }

    logger.info({ email: lead.email, status: validationResult.status }, '[LeadController] ZeroBounce result');

    // Map ZeroBounce status to our email status
    let emailStatus: string;
    let emailVerified: boolean;

    switch (validationResult.status) {
      case 'valid':
        emailStatus = 'valid';
        emailVerified = true;
        break;
      case 'invalid':
        emailStatus = 'invalid';
        emailVerified = false;
        break;
      case 'catch-all':
        emailStatus = 'catch-all';
        emailVerified = false;
        break;
      case 'unknown':
        emailStatus = 'unknown';
        emailVerified = false;
        break;
      case 'spamtrap':
        emailStatus = 'spamtrap';
        emailVerified = false;
        break;
      case 'abuse':
        emailStatus = 'abuse';
        emailVerified = false;
        break;
      case 'do_not_mail':
        emailStatus = 'do_not_mail';
        emailVerified = false;
        break;
      default:
        emailStatus = 'unverified';
        emailVerified = false;
    }

    // Update lead with validation results
    await db.update(leadsTable)
      .set({
        emailStatus,
        emailVerified,
        updatedAt: new Date(),
        enrichedData: {
          ...(lead.enrichedData as object || {}),
          emailValidation: {
            validatedAt: new Date().toISOString(),
            status: validationResult.status,
            subStatus: validationResult.subStatus,
            freeEmail: validationResult.freeEmail,
            disposableEmail: validationResult.disposableEmail,
            roleAccount: validationResult.roleAccount,
            didYouMean: validationResult.didYouMean,
            score: validationResult.score,
            smtpProvider: validationResult.smtpProvider,
            mxFound: validationResult.mxFound,
            mxRecord: validationResult.mxRecord,
            firstName: validationResult.firstname,
            lastName: validationResult.lastname,
            gender: validationResult.gender,
            country: validationResult.country,
            region: validationResult.region,
            city: validationResult.city,
            zipCode: validationResult.zipcode,
            creditsRemaining: validationResult.creditsRemaining,
          },
        },
      })
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));

    // Fetch updated lead
    const [updatedLead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));

    res.json({
      success: true,
      email: lead.email,
      status: emailStatus,
      verified: emailVerified,
      details: {
        subStatus: validationResult.subStatus,
        freeEmail: validationResult.freeEmail,
        disposableEmail: validationResult.disposableEmail,
        roleAccount: validationResult.roleAccount,
        didYouMean: validationResult.didYouMean,
        score: validationResult.score,
        smtpProvider: validationResult.smtpProvider,
      },
      lead: updatedLead,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error validating email');
    res.status(500).json({
      success: false,
      error: 'Unable to validate the email. Please try again.',
      details: error.message,
    });
  }
};

/**
 * POST /api/leads/bulk-delete
 * Bulk delete multiple leads
 */
export const bulkDeleteLeads = async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required" });
    }

    // Validate leadIds are numbers
    const validIds = ids.filter(id => typeof id === 'number' && !isNaN(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: "No valid lead IDs provided" });
    }

    // Only delete leads that belong to this user
    const deleted = await db.delete(leadsTable)
      .where(and(
        inArray(leadsTable.id, validIds),
        eq(leadsTable.userId, userId)
      ))
      .returning({ id: leadsTable.id });

    logger.info({ count: deleted.length, userId }, '[LeadController] Bulk deleted leads');
    void invalidateUserDashboardCache(userId);

    res.json({
      success: true,
      deletedCount: deleted.length,
      message: `Successfully deleted ${deleted.length} leads`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error in bulk delete');
    res.status(500).json({ error: "Unable to bulk delete leads. Please try again." });
  }
};

/**
 * POST /api/leads/bulk-update
 * Bulk update multiple leads with the same data
 */
export const bulkUpdateLeads = async (req: Request, res: Response) => {
  try {
    const { ids, updates } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required" });
    }

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: "updates object is required" });
    }

    // Validate leadIds are numbers
    const validIds = ids.filter(id => typeof id === 'number' && !isNaN(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: "No valid lead IDs provided" });
    }

    // Only allow specific fields to be bulk updated (security)
    const allowedFields = ['status', 'leadStatus', 'score', 'tags', 'notes', 'assignedTo'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sanitizedUpdateData: Record<string, any> = {};
    
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        sanitizedUpdateData[field] = updates[field];
      }
    }

    if (sanitizedUpdateData.leadStatus !== undefined) {
      sanitizedUpdateData.status = sanitizedUpdateData.leadStatus;
    } else if (sanitizedUpdateData.status !== undefined) {
      sanitizedUpdateData.leadStatus = sanitizedUpdateData.status;
    }

    if (Object.keys(sanitizedUpdateData).length === 0) {
      return res.status(400).json({ 
        error: "No valid update fields provided",
        allowedFields 
      });
    }

    // Add updatedAt timestamp
    sanitizedUpdateData.updatedAt = new Date();

    // Only update leads that belong to this user
    const { crmService, lockCrmContactResolution } = await import('../services/CRMService.js');
    const updated = await db.transaction(async (tx: any) => {
      const configuration = await getCrmConfiguration(userId, tx, true);
      await validateCrmAssignee(userId, sanitizedUpdateData.assignedTo, tx);
      await lockCrmContactResolution(tx, userId);
      const changed = await tx.update(leadsTable).set(sanitizedUpdateData)
        .where(and(inArray(leadsTable.id, validIds), eq(leadsTable.userId, userId))).returning({ id: leadsTable.id });
      for (const lead of changed) await crmService.syncLeadContact(userId, lead.id, sanitizedUpdateData, tx, configuration);
      return changed;
    });

    logger.info({ count: updated.length, userId, fields: Object.keys(sanitizedUpdateData) }, '[LeadController] Bulk updated leads');
    void invalidateUserDashboardCache(userId);

    res.json({
      success: true,
      updatedCount: updated.length,
      updatedFields: Object.keys(sanitizedUpdateData).filter(k => k !== 'updatedAt'),
      message: `Successfully updated ${updated.length} leads`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error in bulk update');
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: "Unable to bulk update leads. Please try again." });
  }
};

/**
 * GET /api/leads/stats
 * Get comprehensive lead analytics computed from real data
 */
export const getLeadStats = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // 1. Status counts by leadStatus (pipeline status, across ALL leads)
    const statusCounts = await db
      .select({
        status: leadsTable.leadStatus,
        count: sql<number>`count(*)::int`,
      })
      .from(leadsTable)
      .where(eq(leadsTable.userId, userId))
      .groupBy(leadsTable.leadStatus);

    const statusMap: Record<string, number> = {};
    let totalLeads = 0;
    for (const row of statusCounts) {
      const key = (row.status || 'new').toLowerCase();
      statusMap[key] = row.count;
      totalLeads += row.count;
    }

    // 2. Source distribution (channel performance)
    const sourceCounts = await db
      .select({
        source: leadsTable.source,
        count: sql<number>`count(*)::int`,
      })
      .from(leadsTable)
      .where(eq(leadsTable.userId, userId))
      .groupBy(leadsTable.source)
      .orderBy(desc(sql`count(*)`));

    const sourceMap: Record<string, number> = {};
    for (const row of sourceCounts) {
      sourceMap[(row.source || 'unknown').toLowerCase()] = row.count;
    }

    // 3. Region distribution from location JSONB
    const regionCounts = await db
      .select({
        country: sql<string>`COALESCE(location->>'country', 'Unknown')`.as('country'),
        count: sql<number>`count(*)::int`,
      })
      .from(leadsTable)
      .where(eq(leadsTable.userId, userId))
      .groupBy(sql`COALESCE(location->>'country', 'Unknown')`)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const regions = regionCounts.map((r: any) => ({
      name: r.country || 'Unknown',
      count: r.count,
    }));

    // 4. Score aggregates
    const [scoreStats] = await db
      .select({
        avgScore: sql<number>`COALESCE(ROUND(AVG(score)), 0)::int`,
        highQuality: sql<number>`count(*) filter (where score >= 85)::int`,
      })
      .from(leadsTable)
      .where(eq(leadsTable.userId, userId));

    // 5. Engagement metrics from real data
    const [engagementStats] = await db
      .select({
        totalContacted: sql<number>`count(*) filter (where first_contacted_at is not null)::int`,
        totalReplied: sql<number>`count(*) filter (where replied_emails > 0 or messages_received > 0)::int`,
        totalConverted: sql<number>`count(*) filter (where status = 'converted')::int`,
        totalWithEmail: sql<number>`count(*) filter (where email is not null and email != '')::int`,
      })
      .from(leadsTable)
      .where(eq(leadsTable.userId, userId));

    const engagementRate = totalLeads > 0
      ? Math.round((engagementStats.totalReplied / totalLeads) * 100)
      : 0;
    const conversionRate = totalLeads > 0
      ? Math.round((engagementStats.totalConverted / totalLeads) * 100)
      : 0;

    // 6. Pipeline value estimate: qualified leads * average deal value (configurable)
    const qualifiedCount = statusMap['qualified'] || 0;
    const convertedCount = statusMap['converted'] || 0;
    const avgDealValue = 250; // base estimate per qualified lead
    const pipelineValue = (qualifiedCount + convertedCount) * avgDealValue;

    // 7. Platform type distribution
    const platformCounts = await db
      .select({
        platform: leadsTable.platformType,
        count: sql<number>`count(*)::int`,
      })
      .from(leadsTable)
      .where(eq(leadsTable.userId, userId))
      .groupBy(leadsTable.platformType)
      .orderBy(desc(sql`count(*)`));

    const platforms: Record<string, number> = {};
    for (const row of platformCounts) {
      platforms[(row.platform || 'unknown').toLowerCase()] = row.count;
    }

    res.json({
      success: true,
      stats: {
        total: totalLeads,
        new: statusMap['new'] || 0,
        contacted: statusMap['contacted'] || 0,
        engaged: statusMap['engaged'] || 0,
        qualified: qualifiedCount,
        converted: convertedCount,
        unqualified: statusMap['unqualified'] || 0,
        highQuality: scoreStats.highQuality || 0,
        avgScore: scoreStats.avgScore || 0,
        engagementRate,
        conversionRate,
        pipelineValue,
        sources: sourceMap,
        regions,
        platforms,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error fetching lead stats');
    res.status(500).json({ error: "Unable to retrieve lead stats. Please try again." });
  }
};

/**
 * GET /api/leads/:id/conversations
 * Get all outreach conversations and messages for a specific lead
 */
export const getLeadConversations = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const leadId = parseInt(req.params.id);
    if (isNaN(leadId)) {
      return res.status(400).json({ error: "Invalid lead ID" });
    }

    // Verify lead ownership
    const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));
    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    // Get all outreach conversations for this lead
    const conversations = await db
      .select()
      .from(outreachConversationsTable)
      .where(
        and(
          eq(outreachConversationsTable.userId, userId),
          eq(outreachConversationsTable.leadId, leadId)
        )
      )
      .orderBy(desc(outreachConversationsTable.lastMessageAt));

    // Get messages for each conversation
    const conversationsWithMessages = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conversations.map(async (conv: any) => {
        const messages = await db
          .select()
          .from(outreachMessagesTable)
          .where(eq(outreachMessagesTable.conversationId, conv.id))
          .orderBy(desc(outreachMessagesTable.createdAt))
          .limit(50);
        return { ...conv, messages };
      })
    );

    // Get sent messages (legacy) for this lead
    const sentMessages = await db
      .select()
      .from(sentMessagesTable)
      .where(
        and(
          eq(sentMessagesTable.userId, userId),
          eq(sentMessagesTable.leadId, leadId)
        )
      )
      .orderBy(desc(sentMessagesTable.createdAt))
      .limit(100);

    return res.json({
      conversations: conversationsWithMessages,
      sentMessages,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[LeadController] Error fetching lead conversations');
    res.status(500).json({ error: "Unable to retrieve lead conversations. Please try again." });
  }
};

/**
 * POST /api/leads/:id/deep-enrich
 * Run multi-platform deep enrichment on a lead.
 * Chains across Instagram, Facebook, Twitter/X, LinkedIn, and Website
 * using Apify actors with up to 8 iterations.
 * 
 * Can run synchronously (default) or via BullMQ queue (async=true).
 */
export const deepEnrichLeadById = async (req: Request, res: Response) => {
  try {
    const leadId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead ID' });

    const [ownedLead] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)))
      .limit(1);
    if (!ownedLead) return res.status(404).json({ error: 'Lead not found' });

    const useQueue = req.body?.async === true;

    if (useQueue) {
      // A short server-side claim prevents double-clicks and network retries from
      // queuing the same paid provider workflow more than once.
      const { idempotencyService } = await import('../services/IdempotencyService.js');
      const idempotencyKey = businessCacheKey(`lead-deep-enrich:${userId}:${leadId}`);
      const claim = await idempotencyService.checkAndStore(idempotencyKey, { ttlSeconds: 5 * 60 });

      if (claim.status === 'duplicate') {
        if (claim.previousResponse) {
          try {
            const previous = JSON.parse(claim.previousResponse);
            return res.status(previous.queueUncertain ? 503 : 200).json({ ...previous, duplicate: true });
          } catch {
            logger.warn({ userId, leadId }, '[LeadController] Ignoring malformed cached enrichment response');
          }
        }
        return res.status(409).json({
          success: false,
          error: 'Deep enrichment is already being queued for this lead.',
        });
      }

      let reservation: Awaited<ReturnType<typeof import('../services/enrichment/deepExecution.js').reserveDeepEnrichment>> | undefined;
      try {
        const { jobDispatcher } = await import('../queues/JobDispatcher.js');
        const { reserveDeepEnrichment } = await import('../services/enrichment/deepExecution.js');
        reservation = await reserveDeepEnrichment(userId, leadId, req.get('Idempotency-Key'));
        const result = await jobDispatcher.dispatch('deep_enrich_lead', {
          userId,
          leadId,
          enrichmentType: 'deep_enrichment',
          enrichmentRunId: reservation.run.id,
          threadId: req.body?.threadId,
        });
        const response = {
          success: true,
          message: 'Deep enrichment job queued',
          runId: reservation.run.id,
          jobId: result.jobId,
          correlationId: result.correlationId,
        };
        await idempotencyService.storeResponse(idempotencyKey, JSON.stringify(response));
        return res.json(response);
      } catch (error) {
        if (reservation) {
          // Redis may have accepted the job before losing the response. Keep
          // the existing claim and receipt; never refund or enqueue blindly.
          const outcome = { success: false, queueUncertain: true, runId: reservation.run.id,
            error: 'Queue dispatch could not be confirmed. Review this saved enrichment before starting another request.', code: 'ENRICHMENT_QUEUE_UNCERTAIN' };
          await idempotencyService.storeResponse(idempotencyKey, JSON.stringify(outcome));
          return res.status(503).json(outcome);
        }
        await idempotencyService.forget(idempotencyKey);
        throw error;
      }
    }

    // Synchronous execution
    const { leadEnrichmentOrchestrator } = await import('../services/enrichment/index.js');
    const result = await leadEnrichmentOrchestrator.enrichLead(userId, leadId, { threadId: req.body?.threadId });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // Fetch the updated lead
    const [updatedLead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)))
      .limit(1);

    return res.json({
      success: true,
      message: 'Lead deep enrichment completed',
      iterations: result.iterations,
      handlesProcessed: result.totalHandlesProcessed,
      iterationLog: result.iterationLog,
      aggregatedData: {
        emails: result.aggregatedData.emails,
        phones: result.aggregatedData.phones,
        websites: result.aggregatedData.websites,
        socialProfiles: result.aggregatedData.socialProfiles,
      },
      lead: updatedLead,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof EnrichmentBillingError) return res.status(error.status).json({ success: false, error: error.message, code: error.code });
    logger.error({ err: error }, '[LeadController] Error in deep enrichment');
    res.status(500).json({ success: false, error: 'Unable to run deep enrichment. Please try again.' });
  }
};
