import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/express.js";
import { businessOwnerUserId } from "../tenancy/businessContext.js";
import {
  CampaignManualError,
  listManualCampaigns,
  createManualCampaign,
  getManualSequence,
  saveManualSequence,
  previewManualSequence,
  previewPendingManualEnrollments,
  applyPendingManualEnrollment,
} from "../services/outreach/CampaignManualFollowUpService.js";

export async function campaignManualFollowUps(
  req: AuthenticatedRequest,
  res: Response,
) {
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  try {
    const userId = businessOwnerUserId(req);
    if (req.method === "GET" && req.path.endsWith("/campaign-options"))
      return res.json({ campaigns: await listManualCampaigns(userId) });
    if (req.method === "POST" && req.path.endsWith("/campaign-options"))
      return res.json(await createManualCampaign(userId, req.body.name));
    if (req.method === "GET")
      return res.json(
        await getManualSequence(
          userId,
          { kind: req.query.kind, id: Number(req.query.campaignId) },
          req.query.channel,
        ),
      );
    if (req.path.endsWith("/pending-preview"))
      return res.json(await previewPendingManualEnrollments(userId, req.body));
    if (req.path.endsWith("/apply-reviewed"))
      return res.json(await applyPendingManualEnrollment(userId, req.body));
    if (req.path.endsWith("/preview"))
      return res.json(await previewManualSequence(userId, req.body));
    return res.json(await saveManualSequence(userId, req.body));
  } catch (error) {
    if (error instanceof CampaignManualError)
      return res
        .status(error.status)
        .json({ code: error.code, error: error.message });
    return res.status(409).json({
      code: "CAMPAIGN_MANUAL_REVIEW_REQUIRED",
      error:
        error instanceof Error
          ? error.message
          : "The campaign sequence could not be verified.",
    });
  }
}
