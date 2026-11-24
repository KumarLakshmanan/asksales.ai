import type { Request, Response } from "express";
import { eq, and, asc } from "drizzle-orm";
import { db } from "../models/db.js";
import { policyPagesTable } from "../models/policyPages/schema.js";
import { accountDeletionRequestsTable } from "../models/accountDeletionRequests/schema.js";
import { logger } from "../utils/logger.js";
import { normalizeSlug } from "../../shared/slug.js";
import { isEmailAddress as isValidEmail } from "../../shared/emailAddress.js";

/** GET /api/legal/policies */
export async function listPublishedPolicies(req: Request, res: Response) {
  try {
    const policies = await db
      .select({
        id: policyPagesTable.id,
        slug: policyPagesTable.slug,
        title: policyPagesTable.title,
        updatedAt: policyPagesTable.updatedAt,
      })
      .from(policyPagesTable)
      .where(eq(policyPagesTable.published, true))
      .orderBy(asc(policyPagesTable.title));

    return res.json({ success: true, data: policies });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[LegalController] Failed to list published policies");
    return res.status(500).json({ success: false, error: "Failed to load policies" });
  }
}

/** GET /api/legal/policies/:slug */
export async function getPublishedPolicyBySlug(req: Request, res: Response) {
  try {
    const slug = normalizeSlug(String(req.params.slug || ""));
    if (!slug) {
      return res.status(400).json({ success: false, error: "Invalid policy slug" });
    }

    const [policy] = await db
      .select()
      .from(policyPagesTable)
      .where(and(eq(policyPagesTable.slug, slug), eq(policyPagesTable.published, true)))
      .limit(1);

    if (!policy) {
      return res.status(404).json({ success: false, error: "Policy not found" });
    }

    return res.json({ success: true, data: policy });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[LegalController] Failed to fetch policy by slug");
    return res.status(500).json({ success: false, error: "Failed to load policy" });
  }
}

/** POST /api/legal/account-deletion-requests */
export async function submitAccountDeletionRequest(req: Request, res: Response) {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const fullNameRaw = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const sourceRaw = typeof req.body?.source === "string" ? req.body.source.trim() : "public_page";

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "A valid email is required" });
    }

    const [created] = await db
      .insert(accountDeletionRequestsTable)
      .values({
        // The public form cannot assert account ownership. An administrator may
        // associate the request with an account after verifying the requester.
        userId: null,
        email,
        fullName: fullNameRaw || null,
        reason: reasonRaw || null,
        source: sourceRaw.slice(0, 50) || "public_page",
        status: "pending",
        updatedAt: new Date(),
      })
      .returning();

    return res.status(201).json({
      success: true,
      data: {
        id: created.id,
        status: created.status,
        requestedAt: created.requestedAt,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[LegalController] Failed to submit account deletion request");
    return res.status(500).json({ success: false, error: "Failed to submit request" });
  }
}
