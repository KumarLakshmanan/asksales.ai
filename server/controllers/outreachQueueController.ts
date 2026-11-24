import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/express.js";
import { businessOwnerUserId } from "../tenancy/businessContext.js";
import { getOutreachQueueOverview } from "../services/outreach/QueueOverview.js";
import { logger } from "../utils/logger.js";

export async function getOutreachQueue(
  req: AuthenticatedRequest,
  res: Response,
) {
  const userId = businessOwnerUserId(req);
  if (!req.user?.id || !userId)
    return res.status(401).json({ error: "Unauthorized" });
  try {
    return res.json(await getOutreachQueueOverview(userId));
  } catch (error) {
    logger.error({ err: error }, "[OutreachQueue] Queue overview unavailable");
    return res
      .status(503)
      .json({ error: "The outreach queue could not be loaded. Try again." });
  }
}
