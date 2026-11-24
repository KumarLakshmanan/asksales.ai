import { z } from "zod";
import { agentTypes } from "./agent";

// Message Types
export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "agent", "system"]),
  content: z.string(),
  agentType: z.enum(agentTypes).optional(),
  timestamp: z.number(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type Message = z.infer<typeof messageSchema>;