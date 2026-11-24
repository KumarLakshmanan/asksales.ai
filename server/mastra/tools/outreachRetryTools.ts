import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { runDashboardTool, toolContext as contextFrom } from "./dashboardOperationTools.js";
import { campaignReportFiltersSchema } from "../../services/outreach/CampaignReportFilters.js";
import {
  previewOutreachRetries,
  getRetryPreview,
} from "../../services/outreach/OutreachRetryService.js";
const outputSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export const previewOutreachRetriesTool = createTool({
  id: "preview_outreach_retries",
  description:
    "Preview all selected outreach retry eligibility using the campaign report filters. Explains expired authority, accepted/uncertain outcomes, exclusions and saved schedules. Creates a five-minute review only. Returns the dashboard confirmation action; never retries, sends, shortens cooldowns or creates another send intent.",
  inputSchema: campaignReportFiltersSchema,
  outputSchema,
  execute: async (input, { mastra }) => {
    const context = contextFrom(mastra);
    return runDashboardTool(
      "preview_outreach_retries",
      "outreach",
      context,
      () => previewOutreachRetries(context.userId, input),
    );
  },
});
export const getOutreachRetryPreviewTool = createTool({
  id: "get_outreach_retry_preview",
  description:
    "Read an owned retry preview or its confirmed recovery progress. Registered retries are existing intents placed into recovery, not new deliveries. Use analytics_query for current delivery counts. Never applies or sends.",
  inputSchema: z.object({ operationId: z.string().uuid() }).strict(),
  outputSchema,
  execute: async (input, { mastra }) =>
    runDashboardTool(
      "get_outreach_retry_preview",
      "outreach",
      contextFrom(mastra),
      () => getRetryPreview(input.operationId),
    ),
});
