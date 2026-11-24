import { z } from "zod";
import { agentTypes } from "./agent";
import { workflowStageSchema } from "./workflow";

// Agent Status
export const agentStatusSchema = z.object({
  agentType: z.enum(agentTypes),
  status: z.enum(["idle", "processing", "completed", "error"]),
  progress: z.number().min(0).max(100),
  currentTask: z.string().optional(),
  timeElapsed: z.number().optional(),
  workflowStage: workflowStageSchema.optional(),
});

export type AgentStatus = z.infer<typeof agentStatusSchema>;