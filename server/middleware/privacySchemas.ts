import { z } from "zod";

export const optOutSchema = z.object({
  channels: z
    .array(z.enum(["email", "sms", "whatsapp", "instagram", "facebook", "all"]))
    .min(1, "At least one channel required"),
  reason: z.string().max(500).optional(),
});

export const dataExportRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});
