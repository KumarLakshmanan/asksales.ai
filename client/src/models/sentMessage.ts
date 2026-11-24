import { z } from "zod";

// Sent Message (for outreach tracking)
export const sentMessageSchema = z.object({
  id: z.string(),
  leadId: z.string(),
  leadName: z.string(),
  channel: z.string(),
  message: z.string(),
  imageUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  sentAt: z.string(),
  status: z.enum(["delivered", "opened", "replied", "failed"]),
});

export type SentMessage = z.infer<typeof sentMessageSchema>;