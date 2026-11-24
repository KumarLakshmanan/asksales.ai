import { z } from 'zod';

// These legacy ICP-based handlers do not consume the free-form prompt/brief
// shapes used by the current creators. Keep their contracts local to studio.
// Prepared for review; production route activation is held pending the shared
// receipt and Tenant billing decisions recorded in the audit report.
const id = z.number().int().positive().safe();
const contentType = z.enum(['ad_copy', 'email', 'social_post', 'blog', 'video_script', 'dm', 'landing_page']);
const count = z.number().int().min(1).max(20);

export const contentStudioPlanSchema = z.object({
  icp_id: id,
  duration_days: z.number().int().positive().safe().optional(),
}).strict();

export const contentStudioCreativesSchema = z.object({
  icp_id: id,
  creative_type: z.enum(['image', 'video', 'infographic', 'carousel']),
  count: count.optional(),
}).strict();

export const contentStudioMetaPromptSchema = z.object({
  icp_id: id,
  brand_toolkit_id: id.optional(),
  content_type: contentType.optional(),
  target_platform: z.string().trim().max(100).optional(),
  campaign_objective: z.string().trim().max(10000).optional(),
  additional_context: z.string().trim().max(10000).optional(),
}).strict();

export const contentStudioPromptVariationsSchema = z.object({
  icp_id: id,
  brand_toolkit_id: id.optional(),
  base_prompt: z.string().trim().min(1).max(20000),
  content_type: contentType.optional(),
  count: count.optional(),
}).strict();
