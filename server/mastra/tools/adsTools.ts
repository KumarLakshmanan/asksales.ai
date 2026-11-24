/**
 * Mastra Ads / Performance Marketing Tools
 * Wraps existing ads executor functions as Mastra createTool instances.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  approvalData: z.any().optional(),
});

export const adCreativeInputSchema = z.object({
  creative_brief_id: z.number().int().positive().optional().describe('Owned, reviewed competitor creative brief ID'),
  creative_brief_revision: z.number().int().positive().optional(),
  creative_concept_id: z.string().max(60).optional(),
  platform: z.enum(['meta', 'google', 'linkedin']).describe('Ad platform'),
  objective: z.enum(['awareness', 'traffic', 'engagement', 'leads', 'sales', 'app_installs']).default('traffic'),
  ad_format: z.enum(['image', 'video', 'carousel', 'text']).default('image'),
  headline: z.string().optional(),
  description_text: z.string().optional(),
  cta_text: z.string().optional().describe('Exact user-requested CTA for primary copy, including punctuation; separate from the platform CTA button. Copy verbatim.'),
  content_instructions: z.string().optional().describe('Preserve tone nuances, exclusions, no emoji and no unverified claims verbatim for the reviewed generator.'),
  target_audience: z.string().optional(),
  budget_range: z.string().optional(),
  number_of_variations: z.number().int().min(1).max(5).default(1).describe('Exact number of distinct ad-copy variations requested for review.'),
  cta_type: z.enum(['learn_more', 'shop_now', 'sign_up', 'book_now', 'contact_us', 'download']).optional().describe('Platform CTA button, not an objective or free-text CTA. Use cta_text for exact requested copy.'),
  landing_url: z.string().url().optional(),
  tone: z.enum(['professional', 'casual', 'urgent', 'inspiring', 'informative', 'bold']).default('professional'),
  language: z.string().default('English'),
  include_image_prompt: z.boolean().optional(),
  auto_generate_image: z.boolean().default(false),
  image_aspect_ratio: z.enum(['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
  image_size: z.enum(['1K', '2K', '4K']).optional(),
  image_count: z.number().int().min(1).max(4).optional(),
  image_style: z.enum(['photorealistic', 'digital-art', 'illustration', '3d-render', 'watercolor', 'minimalist', 'cinematic', 'flat-design']).optional(),
  include_video_prompt: z.boolean().optional(),
  auto_generate_video: z.boolean().default(false),
  video_aspect_ratio: z.enum(['16:9', '9:16']).optional(),
  video_resolution: z.enum(['720p', '1080p']).optional(),
  video_duration_seconds: z.number().int().min(5).max(30).optional(),
  video_count: z.number().int().min(1).max(4).optional(),
});

export const generateAdTool = createTool({
  id: 'generate_ad',
  description: 'Generate an ad creative for a specific platform (Meta, Google, LinkedIn).',
  inputSchema: adCreativeInputSchema,
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateAd } = await import('./executors/adsExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateAd(input as any, (mastra as any)?.__toolContext);
  },
});

const adPublishFields = {
  campaign_id: z.string().optional().describe('Existing performance campaign ID'),
  review_revision: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Server-issued fingerprint of the saved campaign review shown to the client'),
  asset_ids: z.array(z.number().int().positive()).min(1).optional().describe('Saved ad-copy plus optional image/video asset IDs'),
  campaign_name: z.string().min(1).max(255).optional(),
  objective: z.enum(['awareness', 'traffic', 'engagement', 'leads', 'sales', 'app_promotion']).default('traffic'),
  budget_amount_minor: z.number().int().positive().optional().describe('Lifetime budget in minor currency units'),
  budget: z.number().positive().optional().describe('Legacy lifetime budget in major currency units'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  budget_type: z.literal('lifetime').default('lifetime'),
  landing_url: z.string().url().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  placements: z.array(z.string()).min(1).default(['Automatic']),
  locations: z.array(z.object({
    countryCode: z.string().trim().min(2).max(2).transform(value => value.toUpperCase()),
    region: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    googleGeoTargetId: z.string().min(1).optional(),
    metaLocationKey: z.string().min(1).optional(),
  })).min(1).optional(),
  provider_account_ids: z.object({
    meta: z.string().min(1).optional(),
    google: z.string().min(1).optional(),
  }).optional(),
  creative_revision: z.number().int().positive().optional(),
  special_ad_categories: z.array(z.enum(['HOUSING', 'EMPLOYMENT', 'CREDIT', 'ISSUES_ELECTIONS_POLITICS'])).max(4).optional(),
};

export const adPublishInputSchema = z.object(adPublishFields).refine((input) => Boolean(input.campaign_id || input.asset_ids?.length), {
  message: 'Provide an existing campaign_id or at least one saved asset_id.',
}).refine((input) => Boolean(input.campaign_id || input.budget_amount_minor || input.budget), {
  message: 'A lifetime budget is required when creating a campaign from assets.',
});

export const unifiedAdPublishInputSchema = z.object({
  ...adPublishFields,
  platforms: z.array(z.enum(['meta', 'google'])).min(1).max(2).transform(values => [...new Set(values)]),
  creative_revision: z.number().int().positive().default(1),
}).refine((input) => Boolean(input.campaign_id || input.asset_ids?.length), {
  message: 'Provide an existing campaign_id or at least one saved asset_id.',
}).refine((input) => Boolean(input.campaign_id || input.budget_amount_minor || input.budget), {
  message: 'A lifetime budget is required when creating a campaign from assets.',
});

export const publishAdsTool = createTool({
  id: 'publish_ads',
  description: 'Create the required review for one saved campaign across Meta, Google, or both. Always include every requested platform even when an account is disconnected; this tool only requests approval and does not mutate providers.',
  inputSchema: unifiedAdPublishInputSchema,
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => ({
    success: true,
    toolName: 'publish_ads',
    requiresApproval: true,
    output: {
      requiresApproval: true,
      message: `Ready to launch ${input.platforms.join(' + ')} campaign "${input.campaign_name || 'Campaign'}" after final account, budget, creative, destination, and policy validation. One approval authorizes live activation on every selected platform.`,
      args: input,
    },
  }),
});

export const publishMetaAdsTool = createTool({
  id: 'publish_meta_ads',
  description: 'Publish ad creatives to Meta Ads (Facebook/Instagram). Requires user approval before publishing.',
  inputSchema: adPublishInputSchema,
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    return {
      success: true,
      toolName: 'publish_meta_ads',
      requiresApproval: true,
      output: {
        requiresApproval: true,
        message: `Ready to launch Meta Ads campaign "${input.campaign_name || 'Campaign'}" after final account, budget, creative, destination, and policy validation. Approval authorizes live activation.`,
        args: input,
      },
    };
  },
});

export const publishGoogleAdsTool = createTool({
  id: 'publish_google_ads',
  description: 'Publish ad creatives to Google Ads. Requires user approval before publishing.',
  inputSchema: adPublishInputSchema,
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    return {
      success: true,
      toolName: 'publish_google_ads',
      requiresApproval: true,
      output: {
        requiresApproval: true,
        message: `Ready to launch Google Ads campaign "${input.campaign_name || 'Campaign'}" after final account, budget, creative, destination, and policy validation. Approval authorizes live activation.`,
        args: input,
      },
    };
  },
});
