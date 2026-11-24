import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  createCampaignExport,
  getCampaignExport,
  resumeCampaignExport,
  downloadCampaignExport,
  campaignExportSchema,
  campaignExportFormatSchema,
} from "../services/outreach/CampaignExportService.js";
import { DashboardOperationError } from "../services/operations/DashboardOperations.js";
import { CampaignReportError } from "../services/outreach/CampaignReportingService.js";
import { operationIdSchema } from "../services/operations/ContactAnalysisValidation.js";
import { logger } from "../utils/logger.js";
export async function campaignExport(req: Request, res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (req.method === "POST" && !req.params.id)
      return res
        .status(202)
        .json(await createCampaignExport(campaignExportSchema.parse(req.body)));
    const id = operationIdSchema.parse(req.params.id);
    if (req.method === "POST") return res.json(await resumeCampaignExport(id));
    if (req.params.format) {
      const file = await downloadCampaignExport(
        id,
        campaignExportFormatSchema.parse(req.params.format),
      );
      res.setHeader("Content-Type", file.type);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${file.name}"`,
      );
      return res.send(file.bytes);
    }
    return res.json(await getCampaignExport(id));
  } catch (error) {
    if (error instanceof ZodError)
      return res
        .status(400)
        .json({
          error: "Check the report filters, saved export or download format.",
          issues: error.issues,
        });
    if (
      error instanceof DashboardOperationError ||
      error instanceof CampaignReportError
    )
      return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, "[CampaignExport] Export unavailable");
    return res
      .status(503)
      .json({
        error:
          "The saved report is unavailable. Refresh its progress and retry.",
      });
  }
}
