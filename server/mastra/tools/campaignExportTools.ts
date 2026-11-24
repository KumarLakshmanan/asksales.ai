import { createTool } from "@mastra/core/tools";
import { createHash } from "node:crypto";
import { z } from "zod";
import { runDashboardTool, toolContext as contextFrom } from "./dashboardOperationTools.js";
import {
  campaignExportSchema,
  createCampaignExport,
  getCampaignExport,
} from "../../services/outreach/CampaignExportService.js";
const outputSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export const createCampaignExportTool = createTool({
  id: "create_campaign_export",
  description:
    "Generate PDF, Word, Excel and protected conversation-history downloads from one immutable timestamped campaign snapshot using the shared reporting filters. Runs as a durable background operation with live progress. Files use business storage and expire after 30 days. Returns a dashboard download action, never a public URL. Never alters delivery counts, imports contacts, retries or sends messages.",
  inputSchema: campaignExportSchema.extend({
    requestKey: campaignExportSchema.shape.requestKey.optional(),
  }),
  outputSchema,
  execute: async (input, { mastra }) => {
    const context = contextFrom(mastra);
    return runDashboardTool(
      "create_campaign_export",
      "outreach",
      context,
      () => {
        const requestKey =
          input.requestKey ||
          `export-${createHash("sha256")
            .update(
              JSON.stringify([
                context.runContext?.runId,
                context.threadId,
                new Date().toISOString().slice(0, 10),
                input,
              ]),
            )
            .digest("hex")}`;
        return createCampaignExport(
          campaignExportSchema.parse({ ...input, requestKey }),
        );
      },
    );
  },
});
export const getCampaignExportTool = createTool({
  id: "get_campaign_export",
  description:
    "Read an owned campaign report export progress, saved snapshot time and authenticated dashboard download action. It is a frozen snapshot; query analytics_query for newer live counts. Never regenerates, resumes or sends.",
  inputSchema: z.object({ operationId: z.string().uuid() }).strict(),
  outputSchema,
  execute: async (input, { mastra }) =>
    runDashboardTool(
      "get_campaign_export",
      "outreach",
      contextFrom(mastra),
      () => getCampaignExport(input.operationId),
    ),
});
