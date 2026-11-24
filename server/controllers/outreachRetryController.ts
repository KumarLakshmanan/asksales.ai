import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import { requireBusinessScope } from "../tenancy/businessContext.js";
import {
  previewOutreachRetries,
  getRetryPreview,
  applyOutreachRetryPreview,
  resumeOutreachRetryPreview,
} from "../services/outreach/OutreachRetryService.js";
import { DashboardOperationError } from "../services/operations/DashboardOperations.js";
import { CampaignReportError } from "../services/outreach/CampaignReportingService.js";
import { operationIdSchema } from "../services/operations/ContactAnalysisValidation.js";
import { logger } from "../utils/logger.js";
const confirmation = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();
export async function outreachRetries(req: Request, res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (req.path.endsWith("/preview") && req.method === "POST")
      return res
        .status(201)
        .json(
          await previewOutreachRetries(requireBusinessScope().userId, req.body),
        );
    const id = operationIdSchema.parse(req.params.id);
    if(req.method==='POST' && req.path.endsWith('/resume'))return res.json(await resumeOutreachRetryPreview(id));
    if (req.method === "POST") {
      const input = confirmation.parse(req.body);
      return res.json(await applyOutreachRetryPreview(id, input.fingerprint));
    }
    return res.json(await getRetryPreview(id));
  } catch (error) {
    if (error instanceof ZodError)
      return res
        .status(400)
        .json({
          error: "Check the report filters and retry confirmation.",
          issues: error.issues,
        });
    if (
      error instanceof DashboardOperationError ||
      error instanceof CampaignReportError
    )
      return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, "[OutreachRetries] Retry review unavailable");
    return res
      .status(503)
      .json({
        error:
          "The retry review could not be loaded. No new messages were created.",
      });
  }
}
