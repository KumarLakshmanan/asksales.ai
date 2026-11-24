import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../models/db.js";
import { companySettings } from "../models/companySettings/schema.js";
import { requireBusinessScope } from "../tenancy/businessContext.js";

export interface WebsiteAnalysisSummary {
  pages: number;
  knowledgeSaved: boolean;
  warnings: string[];
}

/** Durable handoff to profile and toolkit setup, scoped to the owning workspace. */
export async function saveWorkspaceWebsiteAnalysis(
  userId: number,
  businessProfileId: number,
  url: string,
  data: Record<string, unknown>,
  kbEntryId: number | null,
  summary: WebsiteAnalysisSummary,
  executor: Pick<NodePgDatabase, "update"> = db,
) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId || scope.businessProfileId !== businessProfileId)
    throw new Error("Website analysis must be saved to the active workspace.");
  const [saved] = await executor
    .update(companySettings)
    .set({
      websiteAnalysis: {
        url,
        data,
        kbEntryId,
        summary,
        analyzedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(companySettings.id, businessProfileId),
        eq(companySettings.userId, userId),
      ),
    )
    .returning({ id: companySettings.id });
  if (!saved)
    throw new Error(
      "The workspace for this website analysis no longer exists.",
    );
}
