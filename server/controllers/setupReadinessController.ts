import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { currentBusinessScope } from "../tenancy/businessContext.js";
import { logger } from "../utils/logger.js";
function array(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
export async function setupReadiness(req: Request, res: Response) {
  const scope = currentBusinessScope();
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  if (!scope)
    return res
      .status(409)
      .json({ error: "Select a workspace to view setup progress." });
  try {
    const result =
      await db.execute(sql`SELECT application_uses,preferred_channels,setup_goal,workspace_type,company_size,
      EXISTS(SELECT 1 FROM brand_toolkits WHERE business_profile_id=${scope.businessProfileId} AND user_id=${scope.userId} AND is_active=true) AS brand,
      EXISTS(SELECT 1 FROM content_assets WHERE business_profile_id=${scope.businessProfileId} AND user_id=${scope.userId}) AS content,
      EXISTS(SELECT 1 FROM campaigns WHERE business_profile_id=${scope.businessProfileId} AND user_id=${scope.userId}) AS campaign,
      EXISTS(SELECT 1 FROM business_profile_memberships WHERE business_profile_id=${scope.businessProfileId} AND status='active' AND role<>'owner') AS team
      FROM company_settings WHERE id=${scope.businessProfileId} AND user_id=${scope.userId} AND archived_at IS NULL`);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Workspace not found." });
    return res.json({
      profile: {
        applicationUses: array(row.application_uses),
        preferredChannels: array(row.preferred_channels),
        setupGoal: row.setup_goal ?? "",
        workspaceType: row.workspace_type,
        companySize: row.company_size,
      },
      completedTasks: ["brand", "content", "campaign", "team"].filter(
        (key) => row[key] === true,
      ),
      connectedChannels: [],
      connectionsAvailable: false,
    });
  } catch (error) {
    logger.error({ err: error }, "Unable to load workspace setup progress");
    return res
      .status(500)
      .json({ error: "Unable to load workspace setup progress." });
  }
}
