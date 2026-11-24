import type { Request, Response } from "express";
import { and, asc, desc, eq, ilike } from "drizzle-orm";
import { db } from "../models/db.js";
import { policyPagesTable } from "../models/policyPages/schema.js";
import { accountDeletionRequestsTable } from "../models/accountDeletionRequests/schema.js";
import { logger } from "../utils/logger.js";
import { normalizeSlug } from "../../shared/slug.js";

const ALLOWED_REQUEST_STATUSES = ["pending", "in_review", "approved", "rejected", "completed"] as const;
const COUNSEL_GATED_POLICY_SLUGS = new Set(['privacy-policy', 'data-processing-addendum', 'knowledge-upload-certification']);

function getAdminId(req: Request): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = (req as any).user;
  const parsed = Number(admin?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** GET /api/admin/policies */
export async function getAdminPoliciesHandler(req: Request, res: Response) {
  try {
    const policies = await db.select().from(policyPagesTable).orderBy(asc(policyPagesTable.title));
    return res.json({ success: true, data: policies });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminLegalController] Failed to list policies");
    return res.status(500).json({ success: false, error: "Failed to load policies" });
  }
}

/** POST /api/admin/policies */
export async function createAdminPolicyHandler(req: Request, res: Response) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const title = String(req.body?.title || "").trim();
    const contentMarkdown = String(req.body?.contentMarkdown || "").trim();
    const slugCandidate = String(req.body?.slug || title || "");
    const slug = normalizeSlug(slugCandidate);
    const requestedPublished = req.body?.published === undefined ? true : Boolean(req.body?.published);
    const published = COUNSEL_GATED_POLICY_SLUGS.has(slug) ? false : requestedPublished;

    if (!title) {
      return res.status(400).json({ success: false, error: "Title is required" });
    }
    if (!slug) {
      return res.status(400).json({ success: false, error: "Slug is required" });
    }
    if (!contentMarkdown) {
      return res.status(400).json({ success: false, error: "Markdown content is required" });
    }

    const [created] = await db
      .insert(policyPagesTable)
      .values({
        slug,
        title,
        contentMarkdown,
        published,
        approvalStatus: published ? 'published' : 'draft',
        createdByAdminId: adminId,
        updatedByAdminId: adminId,
        updatedAt: new Date(),
      })
      .returning();

    return res.status(201).json({ success: true, data: created });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === "23505") {
      return res.status(409).json({ success: false, error: "A policy with this slug already exists" });
    }
    logger.error({ err: error }, "[AdminLegalController] Failed to create policy");
    return res.status(500).json({ success: false, error: "Failed to create policy" });
  }
}

/** PUT /api/admin/policies/:id */
export async function updateAdminPolicyHandler(req: Request, res: Response) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const policyId = Number(req.params.id);
    if (!Number.isInteger(policyId) || policyId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid policy ID" });
    }
    const [existing] = await db.select().from(policyPagesTable).where(eq(policyPagesTable.id, policyId)).limit(1);
    if (!existing) return res.status(404).json({ success: false, error: 'Policy not found' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: any = {
      updatedAt: new Date(),
      updatedByAdminId: adminId,
    };

    if (req.body?.slug !== undefined) {
      const normalized = normalizeSlug(String(req.body.slug || ""));
      if (!normalized) {
        return res.status(400).json({ success: false, error: "Slug cannot be empty" });
      }
      updates.slug = normalized;
    }

    if (req.body?.title !== undefined) {
      const title = String(req.body.title || "").trim();
      if (!title) {
        return res.status(400).json({ success: false, error: "Title cannot be empty" });
      }
      updates.title = title;
    }

    if (req.body?.contentMarkdown !== undefined) {
      const contentMarkdown = String(req.body.contentMarkdown || "").trim();
      if (!contentMarkdown) {
        return res.status(400).json({ success: false, error: "Markdown content cannot be empty" });
      }
      updates.contentMarkdown = contentMarkdown;
      if (COUNSEL_GATED_POLICY_SLUGS.has(updates.slug || existing.slug)) {
        updates.published = false;
        updates.approvalStatus = 'legal_review';
        updates.counselApprovedAt = null;
        updates.counselApprovedBy = null;
      }
    }

    if (req.body?.published !== undefined) {
      const effectiveSlug = updates.slug || existing.slug;
      if (Boolean(req.body.published)
        && COUNSEL_GATED_POLICY_SLUGS.has(effectiveSlug)
        && (!existing.counselApprovedAt || req.body?.contentMarkdown !== undefined)) {
        return res.status(400).json({ success: false, error: 'Recorded Indian privacy counsel approval is required before publication' });
      }
      updates.published = Boolean(req.body.published);
      updates.approvalStatus = updates.published ? 'published' : existing.approvalStatus;
    }
    if (updates.slug && COUNSEL_GATED_POLICY_SLUGS.has(updates.slug) && existing.published && !existing.counselApprovedAt) {
      updates.published = false;
      updates.approvalStatus = 'legal_review';
    }

    const [updated] = await db
      .update(policyPagesTable)
      .set(updates)
      .where(eq(policyPagesTable.id, policyId))
      .returning();

    if (!updated) {
      return res.status(404).json({ success: false, error: "Policy not found" });
    }

    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === "23505") {
      return res.status(409).json({ success: false, error: "A policy with this slug already exists" });
    }
    logger.error({ err: error }, "[AdminLegalController] Failed to update policy");
    return res.status(500).json({ success: false, error: "Failed to update policy" });
  }
}

/** DELETE /api/admin/policies/:id */
export async function deleteAdminPolicyHandler(req: Request, res: Response) {
  try {
    const policyId = Number(req.params.id);
    if (!Number.isInteger(policyId) || policyId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid policy ID" });
    }

    const [deleted] = await db
      .delete(policyPagesTable)
      .where(eq(policyPagesTable.id, policyId))
      .returning();

    if (!deleted) {
      return res.status(404).json({ success: false, error: "Policy not found" });
    }

    return res.json({ success: true, data: { id: policyId } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminLegalController] Failed to delete policy");
    return res.status(500).json({ success: false, error: "Failed to delete policy" });
  }
}

/** GET /api/admin/account-deletion-requests */
export async function getAccountDeletionRequestsHandler(req: Request, res: Response) {
  try {
    const statusRaw = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (statusRaw && !ALLOWED_REQUEST_STATUSES.includes(statusRaw as any)) {
      return res.status(400).json({ success: false, error: "Invalid status filter" });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: any[] = [];
    if (statusRaw) {
      filters.push(eq(accountDeletionRequestsTable.status, statusRaw));
    }
    if (q) {
      const pattern = `%${q}%`;
      filters.push(ilike(accountDeletionRequestsTable.email, pattern));
    }

    const whereClause =
      filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

    const rows = whereClause
      ? await db
          .select()
          .from(accountDeletionRequestsTable)
          .where(whereClause)
          .orderBy(desc(accountDeletionRequestsTable.requestedAt))
      : await db
          .select()
          .from(accountDeletionRequestsTable)
          .orderBy(desc(accountDeletionRequestsTable.requestedAt));

    return res.json({ success: true, data: rows });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminLegalController] Failed to list account deletion requests");
    return res.status(500).json({ success: false, error: "Failed to load account deletion requests" });
  }
}

/** PATCH /api/admin/account-deletion-requests/:id */
export async function updateAccountDeletionRequestHandler(req: Request, res: Response) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid request ID" });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: any = {
      updatedAt: new Date(),
    };

    if (req.body?.status !== undefined) {
      const status = String(req.body.status || "").trim().toLowerCase();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!ALLOWED_REQUEST_STATUSES.includes(status as any)) {
        return res.status(400).json({ success: false, error: "Invalid status" });
      }
      updates.status = status;

      if (status === "pending") {
        updates.processedAt = null;
        updates.processedByAdminId = null;
      } else {
        updates.processedAt = new Date();
        updates.processedByAdminId = adminId;
      }
    }

    if (req.body?.adminNotes !== undefined) {
      const adminNotes = String(req.body.adminNotes || "").trim();
      updates.adminNotes = adminNotes || null;
    }

    const [updated] = await db
      .update(accountDeletionRequestsTable)
      .set(updates)
      .where(eq(accountDeletionRequestsTable.id, requestId))
      .returning();

    if (!updated) {
      return res.status(404).json({ success: false, error: "Request not found" });
    }

    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminLegalController] Failed to update account deletion request");
    return res.status(500).json({ success: false, error: "Failed to update account deletion request" });
  }
}
