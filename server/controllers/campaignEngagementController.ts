import type { Request, Response } from "express";
import { ZodError } from "zod";
import { requireBusinessScope } from "../tenancy/businessContext.js";
import {
  getCampaignCustomers,
  getCampaignHistory,
} from "../services/outreach/CustomerEngagementService.js";
import { CampaignReportError } from "../services/outreach/CampaignReportingService.js";
import { DashboardOperationError } from "../services/operations/DashboardOperations.js";
import { logger } from "../utils/logger.js";
export async function campaignEngagement(req: Request, res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  const { after, pageSize, customerKey, respondedOnly, ...filters } = req.query;
  try {
    return res.json(
      req.path.endsWith("/history")
        ? await getCampaignHistory(requireBusinessScope().userId, filters, {
            after,
            pageSize,
            customerKey,
          })
        : await getCampaignCustomers(requireBusinessScope().userId, filters, {
            after,
            pageSize,
            respondedOnly,
          }),
    );
  } catch (error) {
    if (error instanceof ZodError)
      return res
        .status(400)
        .json({
          error: "Check the customer filters or page cursor.",
          issues: error.issues,
        });
    if (
      error instanceof CampaignReportError ||
      error instanceof DashboardOperationError
    )
      return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, "[CampaignEngagement] View unavailable");
    return res
      .status(503)
      .json({ error: "Customer engagement could not be loaded. Try again." });
  }
}
