import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/express.js";
import {
  getInboxItem,
  listInbox,
  parseInboxQuery,
} from "../services/outreach/InboxService.js";
import { logger } from "../utils/logger.js";

export async function getOutreachInbox(
  req: AuthenticatedRequest,
  res: Response,
) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  let query;
  try {
    query = parseInboxQuery(req.query);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  const started = Date.now();
  try {
    res.setHeader('Cache-Control', 'no-store');
    const page = await listInbox(userId, query, req.user!.id);
    logger.info(
      {
        userId,
        durationMs: Date.now() - started,
        items: page.items.length,
        historicalItems: page.items.filter((item) => item.kind === "legacy")
          .length,
      },
      "[OutreachInbox] Loaded inbox",
    );
    return res.json(page);
  } catch (error) {
    logger.error({ err: error, userId }, "[OutreachInbox] List failed");
    return res
      .status(500)
      .json({ error: "The inbox could not be loaded. Please try again." });
  }
}

export async function getOutreachInboxItem(
  req: AuthenticatedRequest,
  res: Response,
) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const { kind, id } = req.params;
  if (
    !["conversation", "legacy"].includes(kind) ||
    !/^\d+$/.test(id) ||
    !Number.isSafeInteger(Number(id)) ||
    Number(id) < 1
  )
    return res.status(400).json({ error: "Invalid inbox item." });
  try {
    res.setHeader('Cache-Control', 'no-store');
    const result = await getInboxItem(
      userId,
      kind as "conversation" | "legacy",
      Number(id),
      req.user!.id,
    );
    return result
      ? res.json(result)
      : res.status(404).json({ error: "This inbox item is unavailable." });
  } catch (error) {
    logger.error({ err: error, userId }, "[OutreachInbox] Detail failed");
    return res
      .status(500)
      .json({
        error: "This conversation could not be loaded. Please try again.",
      });
  }
}
