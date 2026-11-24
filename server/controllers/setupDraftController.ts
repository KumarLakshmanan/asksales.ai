import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../models/db.js";
import {
  requireBusinessAccess,
  BusinessProfileAccessError,
} from "../services/businessProfileStaff.js";
import { logger } from "../utils/logger.js";

function draftView(row: Record<string, unknown> | undefined) {
  return !row || row.data === null
    ? null
    : {
        data: row.data,
        step: Number(row.step),
        revision: Number(row.revision),
        updatedAt: row.updated_at,
      };
}
export function validateSetupDraft(body: Record<string, unknown>) {
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    throw new Error("Supply the revision of the draft you last loaded.");
  if (
    !Number.isSafeInteger(body.step) ||
    Number(body.step) < 0 ||
    Number(body.step) > 100
  )
    throw new Error("Choose a valid setup step.");
  if (
    !body.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data) ||
    Buffer.byteLength(JSON.stringify(body.data), "utf8") > 256 * 1024
  )
    throw new Error("Setup drafts must contain at most 256 KB of JSON data.");
}
async function authorize(req: Request) {
  const userId = Number(req.user?.id),
    key = String(req.params.draftKey ?? "");
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new BusinessProfileAccessError("Unauthorized", 401);
  if (
    !/^(?:workspace:(?:first|new)|brand:[1-9]\d*)$/.test(key) ||
    key.length > 100
  )
    throw new BusinessProfileAccessError("Invalid setup draft key.", 400);
  if (key.startsWith("brand:"))
    await requireBusinessAccess(userId, Number(key.slice(6)), true);
  return { userId, key };
}
export async function setupDraft(req: Request, res: Response) {
  try {
    const { userId, key } = await authorize(req);
    if (req.method === "GET") {
      const existing = await db.execute(
        sql`SELECT data,step,revision,updated_at FROM workspace_setup_drafts WHERE user_id=${userId} AND draft_key=${key}`,
      );
      return res.json({ draft: draftView(existing.rows[0]) });
    }
    if (req.method === "PUT") {
      try {
        validateSetupDraft(req.body);
      } catch (error) {
        return res.status(400).json({ error: (error as Error).message });
      }
      if (req.body.data.profileId != null) {
        const profileId = Number(req.body.data.profileId);
        if (!Number.isSafeInteger(profileId) || profileId < 1)
          return res.status(400).json({ error: "Invalid draft workspace." });
        await requireBusinessAccess(userId, profileId, true);
        if (key.startsWith("brand:") && Number(key.slice(6)) !== profileId)
          return res
            .status(400)
            .json({ error: "Draft workspace does not match its key." });
      }
      const saved =
        await db.execute(sql`INSERT INTO workspace_setup_drafts(user_id,draft_key,data,step)
        SELECT ${userId},${key},${JSON.stringify(req.body.data)}::jsonb,${req.body.step} WHERE ${req.body.expectedRevision}=0
        ON CONFLICT(user_id,draft_key) DO UPDATE SET data=EXCLUDED.data,step=EXCLUDED.step,
          revision=workspace_setup_drafts.revision+1,updated_at=now()
        WHERE workspace_setup_drafts.data IS NULL AND ${req.body.expectedRevision}=0 RETURNING data,step,revision,updated_at`);
      if (saved.rows[0]) {
        logger.info(
          {
            userId,
            draftKey: key,
            step: req.body.step,
            event: "setup_draft_saved",
          },
          "Setup draft saved",
        );
        return res.json({ draft: draftView(saved.rows[0]) });
      }
      const updated =
        req.body.expectedRevision > 0
          ? await db.execute(sql`UPDATE workspace_setup_drafts SET data=${JSON.stringify(req.body.data)}::jsonb,step=${req.body.step},revision=revision+1,updated_at=now()
        WHERE user_id=${userId} AND draft_key=${key} AND revision=${req.body.expectedRevision} AND data IS NOT NULL RETURNING data,step,revision,updated_at`)
          : { rows: [] };
      if (updated.rows[0])
        return res.json({ draft: draftView(updated.rows[0]) });
    } else {
      if (
        !Number.isSafeInteger(req.body?.expectedRevision) ||
        req.body.expectedRevision < 1
      )
        return res
          .status(400)
          .json({ error: "Supply the revision of the draft you last loaded." });
      const deleted =
        await db.execute(sql`UPDATE workspace_setup_drafts SET data=NULL,revision=revision+1,updated_at=now()
        WHERE user_id=${userId} AND draft_key=${key} AND revision=${req.body.expectedRevision} AND data IS NOT NULL RETURNING revision`);
      if (deleted.rows[0]) return res.json({ draft: null });
    }
    const current = await db.execute(
      sql`SELECT data,step,revision,updated_at FROM workspace_setup_drafts WHERE user_id=${userId} AND draft_key=${key}`,
    );
    return res
      .status(409)
      .json({
        code: "SETUP_DRAFT_CONFLICT",
        error:
          "This draft changed in another tab or device. Reload it before saving.",
        draft: draftView(current.rows[0]),
      });
  } catch (error) {
    if (error instanceof BusinessProfileAccessError)
      return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, "Unable to access setup draft");
    return res
      .status(500)
      .json({
        error: "Unable to save or load your setup draft. Please retry.",
      });
  }
}
