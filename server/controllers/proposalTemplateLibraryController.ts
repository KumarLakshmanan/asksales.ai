import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { z } from "zod";
import {
  getFavoriteProposalTemplateIds,
  setProposalTemplateFavorite,
} from "../services/ProposalTemplateLibraryService.js";
import { logger } from "../utils/logger.js";

export async function listTemplateFavorites(req: Request, res: Response) {
  if (!businessOwnerUserId(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    return res.json({
      success: true,
      data: await getFavoriteProposalTemplateIds(businessOwnerUserId(req)),
    });
  } catch (error) {
    logger.error({ err: error }, "Unable to load proposal template favorites");
    return res.status(500).json({ error: "Unable to load template favorites" });
  }
}

const favoriteSchema = z.object({ favorite: z.boolean() }).strict();
export async function setTemplateFavorite(req: Request, res: Response) {
  if (!businessOwnerUserId(req)) return res.status(401).json({ error: "Unauthorized" });
  const id = Number(req.params.id);
  const body = favoriteSchema.safeParse(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !body.success)
    return res
      .status(400)
      .json({ error: "Provide a valid template ID and favorite choice" });
  try {
    const result = await setProposalTemplateFavorite(
      businessOwnerUserId(req),
      id,
      body.data.favorite,
    );
    if (!result) return res.status(404).json({ error: "Template not found" });
    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ err: error }, "Unable to update proposal template favorite");
    return res
      .status(500)
      .json({ error: "Unable to update template favorite" });
  }
}
