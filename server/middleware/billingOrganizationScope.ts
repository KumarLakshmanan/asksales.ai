import type { Request, Response, NextFunction } from "express";
import {
  BillingOrganizationError,
  resolveBillingOrganization,
} from "../services/billing/organizations.js";
import {
  currentBusinessScope,
  withAccountScope,
} from "../tenancy/businessContext.js";
import { withBillingScope } from "../tenancy/billingContext.js";
import { db } from "../models/db.js";
import { isAccountPrivacyPath } from '../tenancy/accountPrivacy.js';
import { sql } from "drizzle-orm";
import { logger } from "../utils/logger.js";

const selectorPaths =
  /^\/api\/(?:wallet(?:\/|$)|billing(?:\/|$)|subscriptions?(?:\/|$)|organizations(?:\/|$)|settings\/business-profiles(?:\/|$))/;

/** Billing follows the authorized business profile. A legacy billing header may
 * pin a request to its original payer, but can never select another account. */
export async function billingOrganizationScope(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const actorUserId = Number(req.user?.id);
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0)
    return res.status(401).json({ error: "Authentication required." });
  try {
    const path = req.originalUrl.split("?")[0];
    if (isAccountPrivacyPath(path)) return withAccountScope(next);
    // A stale browser selection must not prevent a revoked member from listing
    // their remaining organizations and selecting a valid one.
    const listsOrganizations =
      req.method === "GET" && /^\/api\/organizations\/?$/.test(path);
    const createsBusiness =
      req.method === "POST" &&
      /^\/api\/settings\/business-profiles\/?$/.test(path);
    const value =
      !listsOrganizations && !createsBusiness && selectorPaths.test(path)
        ? req.headers["x-billing-organization-id"]
        : undefined;
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        !/^[1-9]\d*$/.test(value) ||
        !Number.isSafeInteger(Number(value)))
    ) {
      return res
        .status(400)
        .json({
          code: "INVALID_ORGANIZATION",
          error: "Invalid billing organization.",
        });
    }
    const organizationId = createsBusiness
      ? Number(
          (
            await db.execute(
              sql`SELECT billing_default_organization(${actorUserId}) AS id`,
            )
          ).rows[0].id,
        )
      : await resolveBillingOrganization(actorUserId);
    if (value !== undefined && Number(value) !== organizationId)
      return res
        .status(409)
        .json({
          code: "BILLING_CONTEXT_MISMATCH",
          error:
            "Billing follows the selected business profile. Refresh this page before continuing.",
        });
    const business = createsBusiness ? undefined : currentBusinessScope();
    const run = () =>
      withBillingScope(
        {
          organizationId,
          actorUserId,
          businessProfileId: business?.businessProfileId,
          businessOwnerUserId: business?.userId,
        },
        next,
      );
    return createsBusiness ? withAccountScope(run) : run();
  } catch (error) {
    if (error instanceof BillingOrganizationError)
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    logger.error(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Billing organization scope unavailable",
    );
    return res
      .status(503)
      .json({
        error: "Billing organization is temporarily unavailable.",
        code: "BILLING_UNAVAILABLE",
      });
  }
}
