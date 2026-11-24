/**
 * Mastra Content Studio Tools
 * Wraps existing content executor functions as Mastra createTool instances.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { reviewedMediaCountSchema } from '../../services/media/ReviewedMediaBudget.js';
import { youtubePublishingOptionsSchema } from '../../utils/youtubePublishingOptions.js';
import { instagramPublishingOptionsSchema } from '../../utils/instagramPublishingOptions.js';

const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
  requiresApproval: z.boolean().optional(),
});

// ─── Brand Toolkit Tools ───────────────────────────────────────────

export const selectBrandToolkitTool = createTool({
  id: 'select_brand_toolkit',
  description: 'Select, create, or skip a brand toolkit.',
  inputSchema: z.object({
    action: z.enum(['list', 'select', 'create', 'skip']).default('list'),
    toolkit_id: z.number().optional(),
    toolkit_name: z.string().optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeSelectBrandToolkit } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeSelectBrandToolkit(input as any, (mastra as any)?.__toolContext);
  },
});

export const getBrandToolkitsTool = createTool({
  id: 'get_brandtoolkits',
  description: 'Get all brand toolkits for the current user.',
  inputSchema: z.object({}),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (_input: any, { mastra }: any) => {
    const { executeGetBrandToolkits } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGetBrandToolkits((mastra as any)?.__toolContext);
  },
});

export const getBrandToolkitTool = createTool({
  id: 'get_brandtoolkit',
  description: 'Get detailed information about a specific brand toolkit by its ID.',
  inputSchema: z.object({
    toolkit_id: z.number().describe('ID of the brand toolkit to retrieve'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGetBrandToolkit } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGetBrandToolkit(input, (mastra as any)?.__toolContext);
  },
});

export const getBusinessProfilesTool = createTool({
  id: 'get_businessprofiles',
  description: "Get all business profiles for the current user.",
  inputSchema: z.object({}),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (_input: any, { mastra }: any) => {
    const { executeGetBusinessProfiles } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGetBusinessProfiles((mastra as any)?.__toolContext);
  },
});

export const getBusinessProfileTool = createTool({
  id: 'get_businessprofile',
  description: 'Get detailed information about a specific business profile by its ID.',
  inputSchema: z.object({
    profile_id: z.number().describe('ID of the business profile to retrieve'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGetBusinessProfile } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGetBusinessProfile(input, (mastra as any)?.__toolContext);
  },
});

// ─── Image / Video Generation Tools ────────────────────────────────

export const generateImageTool = createTool({
  id: 'generate_image',
  description: 'Generate an image using AI based on a text prompt.',
  inputSchema: z.object({
    prompt: z.string().describe('Detailed description of the image to generate'),
    provider: z.enum(['google', 'openrouter']).optional().describe('Media provider override; otherwise the saved user default is used'),
    model: z.string().max(200).optional().describe('Image model ID from the configured provider'),
    aspect_ratio: z.enum(['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    image_size: z.enum(['1K', '2K', '4K']).optional(),
    number_of_images: z.number().optional(),
    negative_prompt: z.string().optional(),
    include_brand_logo: z.boolean().optional().describe('Set false when the user requests no logos, watermark, branding or text. Reviewed exclusions override brand defaults.'),
    seed: z.number().optional(),
    for_content_type: z.enum(['email', 'sms', 'social_post', 'social_dm', 'ad_copy', 'blog_post', 'general']).optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateImage } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateImage(input, (mastra as any)?.__toolContext);
  },
});

export const generateVideoTool = createTool({
  id: 'generate_video',
  description: 'Generate a video using AI based on a text prompt.',
  inputSchema: z.object({
    prompt: z.string().describe('Detailed description of the video to generate'),
    provider: z.enum(['google', 'openrouter']).optional().describe('Media provider override; otherwise the saved user default is used'),
    model: z.string().max(200).optional().describe('Video model ID, including OpenRouter Seedance models'),
    aspect_ratio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    resolution: z.enum(['480p', '720p', '1080p', '1K', '2K', '4K']).optional(),
    duration_seconds: z.number().optional(),
    generate_audio: z.boolean().optional(),
    number_of_videos: z.number().optional(),
    person_generation: z.enum(['allow_adult', 'dont_allow']).optional(),
    negative_prompt: z.string().optional(),
    include_brand_logo: z.boolean().optional().describe('Set false when the user requests no logos, watermark, branding or text. Reviewed exclusions override brand defaults.'),
    seed: z.number().optional(),
    for_content_type: z.enum(['email', 'sms', 'social_post', 'social_dm', 'ad_copy', 'blog_post', 'general']).optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateVideo } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateVideo(input, (mastra as any)?.__toolContext);
  },
});

export const generateImageFromImageTool = createTool({
  id: 'generate_image_from_image',
  description: 'Generate a new image based on an existing image and a text prompt.',
  inputSchema: z.object({
    prompt: z.string(),
    provider: z.enum(['google', 'openrouter']).optional(),
    model: z.string().max(200).optional(),
    source_image_id: z.string().optional(),
    aspect_ratio: z.enum(['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    image_size: z.enum(['1K', '2K', '4K']).optional(),
    number_of_images: z.number().optional(),
    negative_prompt: z.string().optional(),
    include_brand_logo: z.boolean().optional().describe('Set false when the user requests no logos, watermark, branding or text. Reviewed exclusions override brand defaults.'),
    seed: z.number().optional(),
    for_content_type: z.enum(['email', 'sms', 'social_post', 'social_dm', 'ad_copy', 'blog_post', 'general']).optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateImageFromImage } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateImageFromImage(input, (mastra as any)?.__toolContext);
  },
});

export const generateVideoFromImageTool = createTool({
  id: 'generate_video_from_image',
  description: 'Generate a video from a static image and a text prompt.',
  inputSchema: z.object({
    prompt: z.string(),
    provider: z.enum(['google', 'openrouter']).optional(),
    model: z.string().max(200).optional(),
    source_image_id: z.string().optional(),
    image_role: z.enum(['reference', 'start_frame']).optional().describe('reference (default): the image is the subject/product/style and the prompt directs the scene. start_frame: only when the user wants the video to open on this exact image.'),
    aspect_ratio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    resolution: z.enum(['480p', '720p', '1080p', '1K', '2K', '4K']).optional(),
    duration_seconds: z.number().optional(),
    generate_audio: z.boolean().optional(),
    number_of_videos: z.number().optional(),
    person_generation: z.enum(['allow_adult', 'dont_allow']).optional(),
    negative_prompt: z.string().optional(),
    include_brand_logo: z.boolean().optional().describe('Set false when the user requests no logos, watermark, branding or text. Reviewed exclusions override brand defaults.'),
    seed: z.number().optional(),
    for_content_type: z.enum(['email', 'sms', 'social_post', 'social_dm', 'ad_copy', 'blog_post', 'general']).optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateVideoFromImage } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateVideoFromImage(input, (mastra as any)?.__toolContext);
  },
});

// ─── Content Generation Tools ──────────────────────────────────────

export const generateSocialMediaPostTool = createTool({
  id: 'generate_social_media_post',
  description: 'Generate a comprehensive social media post including caption, keywords, hashtags. Use platform="all" for universal content.',
  inputSchema: z.object({
    platform: z.enum(['linkedin', 'twitter', 'facebook', 'instagram', 'all']),
    topic: z.string(),
    tone: z.enum(['professional', 'casual', 'funny', 'inspirational', 'informative', 'provocative']).optional(),
    length: z.enum(['short', 'medium', 'long']).optional(),
    language: z.string().optional(),
    include_emojis: z.boolean().optional(),
    include_cta: z.boolean().optional(),
    cta_text: z.string().optional().describe('Exact requested CTA, including punctuation. Copy verbatim; never paraphrase.'),
    content_instructions: z.string().optional().describe('Preserve all user content constraints, tone nuances, and exclusions for the reviewed generation step.'),
    post_format: z.enum(['text', 'carousel', 'story', 'reel']).optional(),
    include_image_prompt: z.boolean().optional(),
    include_video_prompt: z.boolean().optional(),
    auto_generate_image: z.boolean().optional(),
    auto_generate_video: z.boolean().optional(),
    image_provider: z.enum(['google', 'openrouter']).optional(),
    image_model: z.string().max(200).optional(),
    video_provider: z.enum(['google', 'openrouter']).optional(),
    video_model: z.string().max(200).optional(),
    image_aspect_ratio: z.enum(['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    image_size: z.enum(['1K', '2K', '4K']).optional(),
    image_count: reviewedMediaCountSchema.optional(),
    video_aspect_ratio: z.enum(['16:9', '9:16']).optional(),
    video_resolution: z.enum(['720p', '1080p']).optional(),
    video_duration_seconds: z.number().optional(),
    video_count: reviewedMediaCountSchema.optional(),
    hashtags: z.boolean().optional(),
    number_of_hashtags: z.number().optional(),
    brand_toolkit_id: z.number().optional(),
    number_of_posts: z.number().int().min(1).max(30).optional()
      .describe('Number of separate posts for a content plan, calendar or series, e.g. 30 for a 30-day plan or 7 for a week. Each post is generated, checked against the platform limit and saved separately. Default 1.'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateSocialMediaPost }= await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateSocialMediaPost(input, (mastra as any)?.__toolContext);
  },
});

export const generateSocialChatTemplateTool = createTool({
  id: 'generate_social_chat_template',
  description: 'Generate a direct message or chat template for social media platforms.',
  inputSchema: z.object({
    platform: z.enum(['linkedin', 'instagram', 'twitter', 'messenger']),
    objective: z.string(),
    cta_text: z.string().optional().describe('Exact reviewed CTA, including punctuation. Never paraphrase.'),
    content_instructions: z.string().optional().describe('Preserve user constraints and campaign identity; these override workspace brand defaults.'),
    message_style: z.enum(['introduction', 'follow_up', 'pitch', 'thank_you', 'cold_outreach', 'networking', 'partnership']).optional(),
    tone: z.enum(['professional', 'friendly', 'casual', 'persuasive', 'witty', 'empathetic']).optional(),
    language: z.string().optional(),
    recipient_context: z.string().optional(),
    include_personalization: z.boolean().optional(),
    urgency: z.enum(['low', 'medium', 'high']).optional(),
    include_follow_ups: z.boolean().optional(),
    number_of_follow_ups: z.number().optional(),
    include_image_prompt: z.boolean().optional(),
    include_video_prompt: z.boolean().optional(),
    auto_generate_image: z.boolean().optional(),
    auto_generate_video: z.boolean().optional(),
    image_provider: z.enum(['google', 'openrouter']).optional(),
    image_model: z.string().max(200).optional(),
    video_provider: z.enum(['google', 'openrouter']).optional(),
    video_model: z.string().max(200).optional(),
    image_aspect_ratio: z.enum(['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    image_size: z.enum(['1K', '2K', '4K']).optional(),
    image_count: reviewedMediaCountSchema.optional(),
    video_aspect_ratio: z.enum(['16:9', '9:16']).optional(),
    video_resolution: z.enum(['720p', '1080p']).optional(),
    video_duration_seconds: z.number().optional(),
    video_count: reviewedMediaCountSchema.optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateSocialChatTemplate } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateSocialChatTemplate(input, (mastra as any)?.__toolContext);
  },
});

export const generateBlogPostTool = createTool({
  id: 'generate_blog_post',
  description: 'Generate a blog post with SEO optimization, structured sections, and optional featured image.',
  inputSchema: z.object({
    topic: z.string(),
    cta_text: z.string().optional().describe('Exact reviewed CTA, including punctuation. Never paraphrase.'),
    content_instructions: z.string().optional().describe('Reviewed copy requirements override workspace defaults.'),
    tone: z.enum(['professional', 'casual', 'informative', 'inspirational', 'conversational', 'authoritative']).optional(),
    length: z.enum(['short', 'medium', 'long']).optional(),
    target_audience: z.string().optional(),
    seo_keywords: z.array(z.string()).optional(),
    outline: z.array(z.string()).optional(),
    language: z.string().optional(),
    include_meta_description: z.boolean().optional(),
    include_image_prompt: z.boolean().optional(),
    auto_generate_image: z.boolean().optional(),
    image_provider: z.enum(['google', 'openrouter']).optional(),
    image_model: z.string().max(200).optional(),
    image_aspect_ratio: z.enum(['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    image_size: z.enum(['1K', '2K', '4K']).optional(),
    image_count: reviewedMediaCountSchema.optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateBlogPost } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateBlogPost(input, (mastra as any)?.__toolContext);
  },
});

export const publishSocialPostInputSchema = z.object({
  content_asset_id: z.number().describe('ID of the content asset to publish'),
  expected_version: z.number().int().positive().optional().describe('Source version displayed in the publication review'),
  expected_review_token: z.string().min(1).max(128).optional().describe('publishingReviewToken returned with the reviewed saved asset; do not invent it'),
  platform: z.enum(['facebook', 'instagram', 'youtube', 'linkedin', 'twitter']).optional().describe('Legacy single target platform'),
  targets: z.array(z.object({
      platform: z.enum(['facebook', 'instagram', 'youtube', 'linkedin']),
      credentialId: z.number().int().positive().optional(),
      caption: z.string().optional(),
      postType: z.enum(['post', 'feed', 'reel', 'story', 'carousel', 'text', 'photo', 'image', 'video', 'short']).optional(),
      title: z.string().optional(),
      tags: z.array(z.string()).optional(),
      privacyStatus: z.enum(['public', 'private', 'unlisted']).optional(),
      youtubeOptions: youtubePublishingOptionsSchema.optional(),
      instagramOptions: instagramPublishingOptionsSchema.optional(),
  })).min(1).max(4).optional().describe('Reviewed per-platform destinations for durable multi-network publishing'),
  caption: z.string().optional().describe('Optional custom caption to override asset content'),
  title: z.string().optional().describe('Optional title (required for YouTube and optional for others)'),
  scheduled_for: z.string().optional().describe('Optional ISO timestamp to schedule post'),
  post_type: z.enum(['post', 'feed', 'reel', 'story', 'carousel', 'text', 'photo', 'video', 'short']).optional()
    .describe('Post type. For YouTube only use video or short; Community Posts are not supported by the public API.'),
  tags: z.array(z.string()).optional().describe('Optional tags for YouTube'),
  privacy_status: z.enum(['public', 'private', 'unlisted']).optional().describe('YouTube video privacy'),
  youtube_options: youtubePublishingOptionsSchema.optional().describe('YouTube audience, disclosure, category, language and license'),
  credential_id: z.number().int().positive().optional().describe('Exact connected account credential selected by the user'),
  timezone: z.string().max(100).optional().describe('IANA timezone used when reviewing a scheduled time'),
  idempotency_key: z.string().max(128).optional().describe('Stable key used to prevent duplicate provider side effects'),
  instagram_options: instagramPublishingOptionsSchema.optional().describe('Instagram cover, accessibility, location, collaborators and feed sharing'),
}).refine((value) => Boolean(value.platform || value.targets?.length), {
  message: 'Choose a platform or at least one reviewed target.',
});

export const publishSocialPostTool = createTool({
  id: 'publish_social_post',
  description: 'Publish a saved social post to one or more reviewed destinations. Facebook, Instagram, and YouTube can be reviewed together with independent accounts, copy, formats, and options. Requires user approval.',
  inputSchema: publishSocialPostInputSchema,
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    return {
      success: true,
      toolName: 'publish_social_post',
      requiresApproval: true,
      output: {
        requiresApproval: true,
        message: `Ready to publish content asset #${input.content_asset_id} to **${input.targets?.map((target) => target.platform).join(', ') || input.platform}**${input.scheduled_for ? ` scheduled for ${input.scheduled_for}` : ''}. Approve?`,
        args: input,
      },
    };
  },
});

export const generateWhatsappTemplateTool = createTool({
  id: 'generate_whatsapp_template',
  description: 'Generate a WhatsApp Business message template with interactive elements (buttons, headers, footers) based on marketing objectives.',
  inputSchema: z.object({
    template_name: z.string().regex(/^[a-z0-9_]+$/).describe('Name of the WhatsApp template (alphanumeric and underscores only)'),
    category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']).default('MARKETING').describe('WhatsApp category'),
    language: z.string().default('en_US').describe('ISO language code (e.g. en_US, es_ES)'),
    header_text: z.string().optional().describe('Optional header text (bold at top of message)'),
    body_text: z.string().min(1).max(1024).describe('Main message content. Can include parameters like {{1}}, {{2}} for personalization.'),
    footer_text: z.string().optional().describe('Optional footer text (small grey text at bottom)'),
    cta_button_label: z.string().optional().describe('Optional text for Call to Action button (e.g. "Visit Website")'),
    cta_button_url: z.string().optional().describe('Optional URL for Call to Action button'),
    quick_reply_buttons: z.array(z.string().min(1).max(25)).max(3).optional().describe('Optional array of quick reply button labels (max 3 buttons)'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateWhatsappTemplate } = await import('./executors/contentExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeGenerateWhatsappTemplate(input, (mastra as any)?.__toolContext);
  },
});
