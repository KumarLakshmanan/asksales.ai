import type { Request, Response } from "express";
import { z } from "zod";
import { createProposalTemplateSchema } from "../middleware/schemas.js";
import {
  adminProposalTemplateService,
  TemplateLibraryError,
} from "../services/AdminProposalTemplateService.js";
import { logger } from "../utils/logger.js";

export const adminProposalTemplateSchema = createProposalTemplateSchema.extend({
  published: z.boolean().default(false),
  replaceTemplateId: z.number().int().positive().optional(),
  expectedVersion: z.number().int().positive().optional(),
});
export const rollbackProposalTemplateSchema = z
  .object({
    historyId: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    replaceTemplateId: z.number().int().positive().optional(),
  })
  .strict();

function templateId(req: Request) {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function handleError(error: unknown, res: Response) {
  if (error instanceof TemplateLibraryError)
    return res
      .status(error.status)
      .json({ error: error.message, details: error.details });
  logger.error({ err: error }, "Unable to update admin proposal library");
  return res
    .status(500)
    .json({ error: "Unable to update proposal template library" });
}
function canRead(req: Request) {
  return (
    !!req.user?.id &&
    ["admin", "super_admin"].includes(
      (req.user as { role?: string }).role || "",
    )
  );
}
function canEdit(req: Request) {
  return (
    !!req.user?.id && (req.user as { role?: string }).role === "super_admin"
  );
}

export async function listAdminProposalTemplates(req: Request, res: Response) {
  if (!canRead(req))
    return res.status(403).json({ error: "Admin access required" });
  try {
    return res.json(await adminProposalTemplateService.list());
  } catch (error) {
    return handleError(error, res);
  }
}
export async function saveAdminProposalTemplate(req: Request, res: Response) {
  if (!canEdit(req))
    return res.status(403).json({ error: "Super admin access required" });
  const id = req.params.id ? templateId(req) : undefined;
  if (id === null)
    return res.status(400).json({ error: "Invalid template ID" });
  const parsed = adminProposalTemplateSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({
        error: "Invalid template fields",
        details: parsed.error.issues.map((issue) => issue.message),
      });
  try {
    return res
      .status(id ? 200 : 201)
      .json(
        await adminProposalTemplateService.save(parsed.data, req.user!.id, id),
      );
  } catch (error) {
    return handleError(error, res);
  }
}
export async function getAdminProposalTemplateHistory(
  req: Request,
  res: Response,
) {
  if (!canRead(req))
    return res.status(403).json({ error: "Admin access required" });
  const id = templateId(req);
  if (!id) return res.status(400).json({ error: "Invalid template ID" });
  try {
    return res.json(await adminProposalTemplateService.history(id));
  } catch (error) {
    return handleError(error, res);
  }
}
export async function rollbackAdminProposalTemplate(
  req: Request,
  res: Response,
) {
  if (!canEdit(req))
    return res.status(403).json({ error: "Super admin access required" });
  const id = templateId(req),
    parsed = rollbackProposalTemplateSchema.safeParse(req.body);
  if (!id || !parsed.success)
    return res
      .status(400)
      .json({ error: "Choose a valid template version to restore" });
  try {
    return res.json(
      await adminProposalTemplateService.rollback(
        id,
        parsed.data.historyId,
        req.user!.id,
        parsed.data.expectedVersion,
        parsed.data.replaceTemplateId,
      ),
    );
  } catch (error) {
    return handleError(error, res);
  }
}
