import { z } from "zod";

// Content Asset Preview
export const contentAssetPreviewSchema = z.object({
  id: z.string(),
  type: z.enum(["text_image", "text_video", "text_only"]),
  message: z.string(),
  imageUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  channel: z.enum(["calls", "email", "linkedin", "instagram", "facebook", "twitter"]),
  leadId: z.string(),
  leadName: z.string(),
  status: z.enum(["pending_approval", "approved", "rejected"]),
});

export type ContentAssetPreview = z.infer<typeof contentAssetPreviewSchema>;
