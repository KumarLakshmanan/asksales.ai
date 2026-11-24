import { z } from "zod";

// Workflow Stage
export const workflowStageSchema = z.enum([
  "icp_building",
  "strategy_creation",
  "awaiting_approval",
  "executing",
  "outreach_recommendation",
  "outreaching",
  "content_creation",
  "content_approval",
  "completed",
  "performance_marketing_recommendation",
  "ad_set_approval",
  "performance_marketing_setup",
  "ads_running"
]);

export type WorkflowStage = z.infer<typeof workflowStageSchema>;