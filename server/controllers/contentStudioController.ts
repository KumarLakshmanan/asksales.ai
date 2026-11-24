import { businessOwnerUserId } from '../tenancy/businessContext.js';
/**
 * Content Studio Controller
 * Handles content generation requests including image and video generation
 */

import { Request, Response } from 'express';
import { businessCacheKey } from '../tenancy/businessContext.js';
import { logger } from '../utils/logger.js';
import { ContentStudioAgent } from '../services/agents/ContentStudioAgent';
import { MetaPromptEngine } from '../services/agents/MetaPromptEngine';
import { db } from '../models/db';
import { NotificationService } from '../services/NotificationService.js';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mapLegacyContentRequest } from '../services/content/LegacyContentGenerationAdapter.js';
import { ContentTextGenerationError, respondToContentTextGenerationError, type ContentTextKind } from '../services/content/ContentTextGenerationError.js';
import { contentStudioEmailSchema } from '../middleware/schemas.js';
import { knowledgeGateway } from '../services/knowledge/KnowledgeGateway.js';
import { SMS_CHAR_LIMIT, TWITTER_CHAR_LIMIT, INSTAGRAM_POST_CAPTION_LIMIT, LINKEDIN_CHAR_LIMIT, FACEBOOK_CHAR_LIMIT, INSTAGRAM_DM_LIMIT, LINKEDIN_INMAIL_LIMIT, TWITTER_DM_LIMIT, FACEBOOK_MESSENGER_LIMIT, META_AD_PRIMARY_TEXT_MAX } from '../utils/channelConstants';
import { ContentAssetModel } from '../models/contentAssets/functions';
import type { ContentAssetRecord } from '../models/contentAssets/schema';
import { jobDispatcher } from '../queues/JobDispatcher.js';
import { getChatThreadById } from '../models/chatThreads/functions.js';
import { sanitizePromptInput } from '../utils/promptSanitizer.js';
import { textDraftMessages, parseTextDraft, persistTextDraft, contentGenerationPolicy, reviewedContentOptions } from '../services/content/TextContentGenerationService.js';
import {
  ContentBrandContextError,
  formatContentBrandContext,
  formatMediaBrandContext,
  resolveContentBrandContext,
  type ResolvedContentBrandContext,
} from '../services/content/ContentBrandContextService.js';
import {
  ContentComplianceError,
  contentOutputSchemas,
  validateGeneratedContent,
} from '../services/content/ContentComplianceService.js';
import { primaryBrandLogoUrl } from '../services/content/BrandMediaComposer.js';
import { buildImageGenerationPrompt, formatImageBrandContext, type ImageBrandSource } from '../services/content/ImagePromptBuilder.js';
import { AUTO_IMAGE_SETTING, detectPromptAspectRatio } from '../../shared/imageSettings.js';
import { sanitizeEmailHtml } from '../utils/contentTemplateRendering.js';
import { generatedMediaKey, saveGeneratedMediaToGallery, type GeneratedMediaKind } from '../services/media/GeneratedMediaGallery.js';
import {
  contentTemplatesTable,
  type ContentTemplate,
} from '../models/contentTemplates/schema.js';
import type { LLMChatOptions, LLMResponse } from '../services/agents/LLMProvider.js';

const contentStudioAgent = new ContentStudioAgent();
const metaPromptEngine = new MetaPromptEngine();

const magicPromptResultSchema = z.object({
  enhancedPrompt: z.string().trim().min(1).max(20000),
  suggestions: z.array(z.string().trim().min(1).max(5000)).max(5).optional(),
  tips: z.string().max(5000).optional(),
}).passthrough();

const generatedSocialSchema = contentOutputSchemas.social;
const generatedSocialMessageSchema = contentOutputSchemas.social_message;
const generatedAdSchema = contentOutputSchemas.ad;
const generatedBlogSchema = contentOutputSchemas.blog;

function approvedLogoUrl(context: ResolvedContentBrandContext): string | undefined {
  if (context.brandToolkit.logoVisibility === false) return undefined;
  return primaryBrandLogoUrl(context.brandToolkit);
}

async function resolveRequestBrandContext(
  res: Response,
  userId: number,
  body: Record<string, unknown>,
): Promise<ResolvedContentBrandContext | null> {
  try {
    return await resolveContentBrandContext(userId, {
      businessProfileId: body.businessProfileId as number | string | null | undefined,
      brandToolkitId: body.brandToolkitId as number | string | null | undefined,
    });
  } catch (error) {
    if (error instanceof ContentBrandContextError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return null;
    }
    throw error;
  }
}

function validateGeneratedOrRespond(
  res: Response,
  options: Parameters<typeof validateGeneratedContent>[0],
): boolean {
  try {
    validateGeneratedContent(options);
    return true;
  } catch (error) {
    if (error instanceof ContentComplianceError) {
      res.status(422).json({
        error: 'Generated content did not pass brand and channel validation.',
        violations: error.violations,
      });
      return false;
    }
    throw error;
  }
}

function generatedContentViolations(
  options: Parameters<typeof validateGeneratedContent>[0],
): string[] {
  try {
    validateGeneratedContent(options);
    return [];
  } catch (error) {
    if (error instanceof ContentComplianceError) return error.violations;
    throw error;
  }
}

async function createContentTextCompletion(
  userId: number,
  options: Pick<
    LLMChatOptions,
    'messages' | 'temperature' | 'max_tokens' | 'response_format' | 'loggingContext'
  >,
): Promise<LLMResponse> {
  const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory');
  const response = await LLMProviderFactory.createChatCompletionWithFallback(userId, reviewedContentOptions({ ...options, model: '' }));
  if (!response.success) {
    // Every generator answers with a classified provider failure, not a generic 500.
    throw new ContentTextGenerationError(response.error, CONTENT_TEXT_KINDS[String(options.loggingContext?.action)] ?? 'this content');
  }
  return response;
}

const CONTENT_TEXT_KINDS: Record<string, ContentTextKind> = {
  generate_email: 'an email',
  generate_email_html_template: 'an email template',
  generate_sms: 'an SMS',
  generate_social: 'a social post',
  repair_social: 'a social post',
  generate_social_message: 'a social message',
  generate_ad_copy: 'ad copy',
  repair_ad_copy: 'ad copy',
  generate_blog_post: 'a blog post',
};

function generationPolicyPersistence(context: ResolvedContentBrandContext, type: string, platform?: string, template?: ContentTemplate | null) {
  return contentGenerationPolicy(context, type, platform, template);
}

async function resolveGenerationThread(res: Response, userId: number, value: unknown): Promise<number | null | undefined> {
  if (value === undefined || value === null) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'threadId must be a positive integer.' });
    return undefined;
  }
  const thread = await getChatThreadById(id);
  if (!thread || thread.userId !== userId) {
    res.status(404).json({ error: 'Chat thread not found' });
    return undefined;
  }
  return id;
}

async function resolveGenerationTemplate(
  res: Response,
  userId: number,
  templateId: unknown,
  context: ResolvedContentBrandContext,
  allowedTypes: string[],
): Promise<ContentTemplate | null | undefined> {
  if (templateId === undefined || templateId === null || templateId === '') return undefined;
  const id = Number(templateId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'templateId must be a positive integer.' });
    return null;
  }
  const [template] = await db
    .select()
    .from(contentTemplatesTable)
    .where(and(
      eq(contentTemplatesTable.id, id),
      eq(contentTemplatesTable.isApproved, true),
      or(
        eq(contentTemplatesTable.userId, userId),
        eq(contentTemplatesTable.isPredefined, true),
      ),
    ))
    .limit(1);
  if (!template) {
    res.status(404).json({
      error: 'The selected template was not found or has not been approved.',
    });
    return null;
  }
  if (!allowedTypes.includes(template.type)) {
    res.status(409).json({
      error: `Template type "${template.type}" cannot be used for this content format.`,
    });
    return null;
  }
  if (template.userId === userId && template.isPredefined !== true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = template.brandContextSnapshot as any;
    const snapshotBusiness = snapshot?.provenance?.businessProfile;
    const snapshotToolkit = snapshot?.provenance?.brandToolkit;
    const isCurrent =
      template.businessProfileId === context.businessProfile.id
      && template.brandToolkitId === context.brandToolkit.id
      && snapshotBusiness?.id === context.businessProfile.id
      && snapshotBusiness?.version === context.businessProfile.version
      && snapshotToolkit?.id === context.brandToolkit.id
      && snapshotToolkit?.version === context.brandToolkit.version;
    if (!isCurrent) {
      res.status(409).json({
        error: 'This template was approved against an older business or Brand Toolkit version. Review and approve it again before generation.',
        code: 'TEMPLATE_REAPPROVAL_REQUIRED',
      });
      return null;
    }
  }
  return template;
}

function formatGenerationTemplate(template?: ContentTemplate | null): string {
  if (!template) return '';
  return `<approved_generation_template id="${template.id}" version="${template.version}">
Name: ${template.name}
Subject: ${template.subject || ''}
Content: ${template.content}
HTML: ${template.htmlContent || ''}
Declared variables: ${JSON.stringify(template.variables || [])}
</approved_generation_template>`;
}

async function enqueueGeneratedAssetMedia(options: {
  userId: number;
  parentAssetId: number;
  assetType: string;
  threadId?: number | null;
  imagePrompt?: string;
  videoPrompt?: string;
  brandContext: string;
  brandLogoUrl?: string;
  /** Visual brand data for the image prompt; the text brand context (taglines, claims) is never sent to image models. */
  imageBrand?: ImageBrandSource;
  referenceImages?: Array<{ base64Data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }>;
}): Promise<{ imageQueued: boolean; videoQueued: boolean; warnings: string[] }> {
  const tasks: Array<{ kind: 'image' | 'video'; promise: Promise<unknown> }> = [];
  const common = {
    userId: options.userId,
    parentAssetId: options.parentAssetId,
    assetType: options.assetType,
    threadId: options.threadId || undefined,
    brandContext: options.brandContext,
    brandLogoUrl: options.brandLogoUrl,
  };
  if (options.imagePrompt) {
    tasks.push({
      kind: 'image',
      promise: jobDispatcher.dispatch('generate_image', {
        ...common,
        brandContext: '',
        prompt: buildImageGenerationPrompt({ userPrompt: options.imagePrompt, brandContext: options.imageBrand, includeLogo: Boolean(options.brandLogoUrl) }),
        ...(options.referenceImages?.length ? { referenceImages: options.referenceImages } : {}),
      }),
    });
  }
  if (options.videoPrompt) {
    tasks.push({
      kind: 'video',
      promise: jobDispatcher.dispatch('generate_video', { ...common, prompt: options.videoPrompt }),
    });
  }
  if (tasks.length === 0) return { imageQueued: false, videoQueued: false, warnings: [] };

  const settled = await Promise.allSettled(tasks.map((task) => task.promise));
  const warnings: string[] = [];
  let imageQueued = false;
  let videoQueued = false;
  settled.forEach((result, index) => {
    const kind = tasks[index].kind;
    if (result.status === 'fulfilled') {
      if (kind === 'image') imageQueued = true;
      if (kind === 'video') videoQueued = true;
      return;
    }
    warnings.push(`${kind} generation could not be queued`);
    logger.error({ err: result.reason, parentAssetId: options.parentAssetId, kind }, '[ContentStudioController] Failed to enqueue generated media');
  });
  return { imageQueued, videoQueued, warnings };
}

/**
 * Sanitize user input for LLM prompts to prevent prompt injection attacks.
 * This function:
 * 1. Removes potential instruction override patterns
 * 2. Escapes special characters that could be used to break out of context
 * 3. Limits input length to prevent token flooding attacks
 */


/**
 * Extract and parse JSON content safely from model outputs
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractJsonContent(content: string): any {
  if (!content) return {};
  let cleaned = content.trim();
  
  if (cleaned.includes('```')) {
    cleaned = cleaned.replace(/```json/gi, '').replace(/```/g, '').trim();
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (nestedErr) {
        logger.error({ err: nestedErr, content: match[0] }, '[ContentStudioController] Nested JSON parse failed');
      }
    }
    throw err;
  }
}

/**
 * POST /api/content/studio/plan
 * Generate content plan for ICP
 */
export async function generateContentPlan(req: Request, res: Response) {
  try {
    const { icp_id, duration_days = 30 } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id) {
      return res.status(400).json({ error: 'icp_id is required' });
    }

    // Fetch ICP from database
    const icpResult = await db.execute(sql`
      SELECT * FROM icp_profiles WHERE id = ${icp_id} AND user_id = ${userId}
    `);

    if (icpResult.rows.length === 0) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icp = icpResult.rows[0] as any;

    // Generate content plan
    const contentPlan = await contentStudioAgent.generateContentPlan(userId, icp, duration_days);

    // Save to database
    const planId = await contentStudioAgent.saveContentPlan(contentPlan, userId);

    res.json({
      success: true,
      plan_id: planId,
      content_plan: contentPlan,
      message: `Generated ${contentPlan.calendar.length}-item content calendar`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error generating content plan');
    res.status(500).json({ error: 'Unable to generate the content plan. Please try again.' });
  }
}

/**
 * POST /api/content/studio/ad-copy
 * Generate ad copy for specific platform
 */
export async function generateAdCopy(req: Request, res: Response) {
  try {
    const { icp_id, platform, variations = 3 } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id || !platform) {
      return res.status(400).json({ error: 'icp_id and platform are required' });
    }

    const validPlatforms = ['google', 'facebook', 'linkedin', 'twitter', 'instagram'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}` });
    }

    // Fetch ICP from database
    const icpResult = await db.execute(sql`
      SELECT * FROM icp_profiles WHERE id = ${icp_id} AND user_id = ${userId}
    `);

    if (icpResult.rows.length === 0) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icp = icpResult.rows[0] as any;

    // Fetch business website from company settings
    let businessWebsite = '';
    const businessResult = await db.execute(sql`
      SELECT website FROM company_settings WHERE user_id = ${userId} AND id=app_business_profile_id() LIMIT 1
    `);
    if (businessResult.rows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      businessWebsite = (businessResult.rows[0] as any).website || '';
    }

    // Generate ad copy with business website
    const adCopy = await contentStudioAgent.generateAdCopy(userId, icp, platform, variations, businessWebsite);

    // Save to database
    const adCopyId = await contentStudioAgent.saveAdCopy(adCopy, userId);

    res.json({
      success: true,
      ad_copy_id: adCopyId,
      ad_copy: adCopy,
      message: `Generated ${platform} ad copy with ${adCopy.variations?.length || 0} variations`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToContentTextGenerationError(res, error, logger, 'ContentStudioController')) return;
    logger.error({ err: error }, '[ContentStudioController] Error generating ad copy');
    res.status(500).json({ success: false, code: 'CONTENT_GENERATION_FAILED', error: 'Unable to generate ad copy. Please try again.' });
  }
}

/** Compatibility endpoint; all new drafts use canonical content_assets handlers. */
export async function generateContent(req: Request, res: Response) {
  try {
    const mapped = mapLegacyContentRequest(req.body);
    if (!mapped.supported) {
      return res.status(410).json({
        error: `The legacy ${mapped.type} format is unavailable. Use a supported Content Studio creator. Video scripts do not automatically create paid videos.`,
        code: 'CONTENT_FORMAT_RETIRED',
        supportedFormats: ['email', 'sms', 'blog', 'social_post', 'video'],
        endpoints: { email: '/api/content/studio/email', sms: '/api/content/studio/sms', blog: '/api/content/studio/blog-post', social_post: '/api/content/studio/social', video: '/api/content/studio/video' },
      });
    }
    req.body = mapped.body;
    // Keep the authenticated request and durable receipt response unchanged.
    // A canonical assetId receipt replaces the obsolete content_pieces result.
    switch (mapped.type) {
      case 'email': return generateEmail(req, res);
      case 'sms': return generateSMS(req, res);
      case 'blog': return generateBlogPost(req, res);
      case 'social': return generateSocial(req, res);
      case 'video': return generateVideo(req, res);
    }
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
    logger.error({ err: error }, '[ContentStudioController] Legacy generation compatibility failed');
    return res.status(500).json({ error: 'Unable to generate content. Please try again.' });
  }
}

/**
 * POST /api/content/studio/creatives
 * Generate creative prompts for visual content
 */
export async function generateCreatives(req: Request, res: Response) {
  try {
    const { icp_id, creative_type, count = 3 } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id || !creative_type) {
      return res.status(400).json({ error: 'icp_id and creative_type are required' });
    }

    const validCreativeTypes = ['image', 'video', 'infographic', 'carousel'];
    if (!validCreativeTypes.includes(creative_type)) {
      return res.status(400).json({
        error: `Invalid creative_type. Must be one of: ${validCreativeTypes.join(', ')}`,
      });
    }

    // Fetch ICP from database
    const icpResult = await db.execute(sql`
      SELECT * FROM icp_profiles WHERE id = ${icp_id} AND user_id = ${userId}
    `);

    if (icpResult.rows.length === 0) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icp = icpResult.rows[0] as any;

    // Generate creative prompts
    const creativePrompts = await contentStudioAgent.generateCreativePrompts(userId, icp, creative_type, count);

    // Persist the requested batch atomically; a failed insert must not leave
    // hidden partial drafts behind a failed generation response.
    const savedIds = await db.transaction(async (tx: typeof db) => {
      const ids: number[] = [];
      for (const prompt of creativePrompts) {
        const result = await tx.execute(sql`
          INSERT INTO creative_prompts (
            icp_id,
            user_id,
            creative_type,
            prompt,
            style_guide,
            dimensions,
            color_palette,
            key_elements,
            created_at
          ) VALUES (
            ${icp_id},
            ${userId},
            ${creative_type},
            ${prompt.prompt},
            ${prompt.style_guide},
            ${prompt.dimensions},
            ${JSON.stringify(prompt.color_palette)}::jsonb,
            ${JSON.stringify(prompt.key_elements)}::jsonb,
            NOW()
          )
          RETURNING id
        `);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const id = (result.rows[0] as any)?.id;
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Creative prompt save was not confirmed');
        ids.push(id);
      }
      return ids;
    });

    res.json({
      success: true,
      creative_ids: savedIds,
      creative_prompts: creativePrompts,
      message: `Generated ${creativePrompts.length} ${creative_type} creative prompts`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error generating creatives');
    res.status(500).json({ error: 'Unable to generate creative prompts. Please try again.' });
  }
}

/**
 * GET /api/content/studio/plans
 * Get all content plans for user
 */
export async function getContentPlans(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { icp_id } = req.query;

    let query = sql`
      SELECT cp.*, ip.campaign_name, ip.target_audience
      FROM content_plans cp
      JOIN icp_profiles ip ON cp.icp_id = ip.id
      WHERE ip.user_id = ${userId}
    `;

    if (icp_id) {
      query = sql`${query} AND cp.icp_id = ${icp_id}`;
    }

    query = sql`${query} ORDER BY cp.created_at DESC LIMIT 50`;

    const result = await db.execute(query);

    res.json({
      success: true,
      content_plans: result.rows,
      count: result.rows.length,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error fetching content plans');
    res.status(500).json({ error: 'Unable to retrieve content plans. Please try again.' });
  }
}

// Backwards-compatible handler aliases for tests
export const generateContentPlanHandler = generateContentPlan;
export const generateAdCopyHandler = generateAdCopy;
export const generateContentHandler = generateContent;
export const generateCreativePromptsHandler = generateCreatives;
export const getContentPlansHandler = getContentPlans;

/**
 * POST /api/content/studio/outreach-copy
 * Generate personalized outreach copy (email, SMS, DM)
 */
export async function generateOutreachCopy(req: Request, res: Response) {
  try {
    const { 
      icp_id, 
      thread_id,
      brand_toolkit_id,
      outreach_type = 'email', 
      tone = 'professional',
      purpose = 'introduction',
      lead_ids = [],
      conversation_history = [],
      custom_prompt,
    } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const validTypes = ['email', 'sms', 'dm'];
    if (!validTypes.includes(outreach_type)) {
      return res.status(400).json({ error: `Invalid outreach_type. Must be one of: ${validTypes.join(', ')}` });
    }

    // Fetch ICP from database - try multiple sources
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let icp: any = null;
    
    // 1. Try direct icp_id
    if (icp_id) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icp_id} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        icp = icpResult.rows[0];
      }
    }
    
    // 2. Try to get ICP from thread_id
    if (!icp && thread_id) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE thread_id = ${thread_id} AND user_id = ${userId}
        ORDER BY created_at DESC LIMIT 1
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        icp = icpResult.rows[0];
      }
    }
    
    // 3. If still no ICP, create a minimal one for generation
    if (!icp) {
      icp = {
        id: 0,
        campaignName: 'Outreach Campaign',
        targetAudience: 'Potential customers',
        industry: 'General',
        painPoints: ['Looking for solutions', 'Need efficiency'],
        goals: ['Connect with leads', 'Generate interest'],
      };
    }

    // Fetch brand toolkit if provided
    let brandToolkit = null;
    if (brand_toolkit_id) {
      const toolkitResult = await db.execute(sql`
        SELECT * FROM brand_toolkits WHERE id = ${brand_toolkit_id} AND user_id = ${userId}
      `);
      if (toolkitResult.rows.length === 0) return res.status(404).json({ error: 'Brand toolkit not found' });
      if (toolkitResult.rows.length > 0) {
        brandToolkit = toolkitResult.rows[0];
      }
    }

    // Fetch lead details if provided
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let leads: any[] = [];
    if (lead_ids && lead_ids.length > 0) {
      const idsArray = Array.isArray(lead_ids) ? lead_ids : [lead_ids];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pgArray = `{${idsArray.map((id: any) => Number(id)).join(',')}}`;
      const leadsResult = await db.execute(sql`
        SELECT id, name, email, company_name as company, role as title
        FROM leads 
        WHERE id = ANY(${pgArray}::int[]) AND user_id = ${userId}
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      leads = leadsResult.rows as any[];
    }

    // Generate outreach copy using AI (pass userId for LLM provider)
    const outreachCopy = await contentStudioAgent.generateOutreachCopy(
      userId,
      icp, 
      outreach_type, 
      tone, 
      purpose, 
      brandToolkit,
      leads,
      conversation_history,
      custom_prompt
    );

    res.json({
      success: true,
      outreach_copy: outreachCopy,
      message: `Generated ${outreach_type} outreach copy`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error generating outreach copy');
    res.status(500).json({ error: 'Unable to generate outreach copy. Please try again.' });
  }
}

/**
 * POST /api/content/studio/meta-prompt
 * Generate a meta-prompt tree for content generation
 */
export async function generateMetaPrompt(req: Request, res: Response) {
  try {
    const { 
      icp_id, 
      brand_toolkit_id,
      content_type = 'ad_copy',
      target_platform,
      campaign_objective,
      additional_context
    } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id) {
      return res.status(400).json({ error: 'icp_id is required' });
    }

    const validContentTypes = ['ad_copy', 'email', 'social_post', 'blog', 'video_script', 'dm', 'landing_page'];
    if (!validContentTypes.includes(content_type)) {
      return res.status(400).json({ error: `Invalid content_type. Must be one of: ${validContentTypes.join(', ')}` });
    }

    // Fetch ICP from database
    const icpResult = await db.execute(sql`
      SELECT * FROM icp_profiles WHERE id = ${icp_id} AND user_id = ${userId}
    `);

    if (icpResult.rows.length === 0) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icp = icpResult.rows[0] as any;

    // Fetch brand toolkit if provided
    let brandToolkit = null;
    if (brand_toolkit_id) {
      const toolkitResult = await db.execute(sql`
        SELECT * FROM brand_toolkits WHERE id = ${brand_toolkit_id} AND user_id = ${userId}
      `);
      if (toolkitResult.rows.length === 0) return res.status(404).json({ error: 'Brand toolkit not found' });
      if (toolkitResult.rows.length > 0) {
        brandToolkit = toolkitResult.rows[0];
      }
    }

    // Generate meta-prompt tree
    const promptTree = await metaPromptEngine.generatePromptTree({
      icp,
      brandToolkit: brandToolkit || undefined,
      contentType: content_type,
      targetPlatform: target_platform,
      campaignObjective: campaign_objective,
      additionalContext: additional_context,
    }, userId);

    res.json({
      success: true,
      prompt_tree: promptTree,
      message: `Generated meta-prompt tree for ${content_type}`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error generating meta-prompt');
    res.status(500).json({ error: 'Unable to generate meta-prompt. Please try again.' });
  }
}

/**
 * POST /api/content/studio/prompt-variations
 * Generate variations of a prompt for A/B testing
 */
export async function generatePromptVariations(req: Request, res: Response) {
  try {
    const { 
      icp_id, 
      brand_toolkit_id,
      base_prompt,
      content_type = 'ad_copy',
      count = 3
    } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id || !base_prompt) {
      return res.status(400).json({ error: 'icp_id and base_prompt are required' });
    }

    // Fetch ICP from database
    const icpResult = await db.execute(sql`
      SELECT * FROM icp_profiles WHERE id = ${icp_id} AND user_id = ${userId}
    `);

    if (icpResult.rows.length === 0) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icp = icpResult.rows[0] as any;

    // Fetch brand toolkit if provided
    let brandToolkit = null;
    if (brand_toolkit_id) {
      const toolkitResult = await db.execute(sql`
        SELECT * FROM brand_toolkits WHERE id = ${brand_toolkit_id} AND user_id = ${userId}
      `);
      if (toolkitResult.rows.length === 0) return res.status(404).json({ error: 'Brand toolkit not found' });
      if (toolkitResult.rows.length > 0) {
        brandToolkit = toolkitResult.rows[0];
      }
    }

    // Generate prompt variations
    const variations = await metaPromptEngine.generatePromptVariations(
      {
        icp,
        brandToolkit: brandToolkit || undefined,
        contentType: content_type,
      },
      base_prompt,
      count,
      userId
    );

    res.json({
      success: true,
      variations,
      message: `Generated ${variations.length} prompt variations`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error generating prompt variations');
    res.status(500).json({ error: 'Unable to generate prompt variations. Please try again.' });
  }
}

/**
 * Media generated for a post/email/ad is attached to that draft AND listed in
 * the Image/Video gallery (idempotent per stored file). The attach already
 * succeeded, so a gallery failure is logged instead of failing the request.
 */
async function addGeneratedMediaToGallery(
  userId: number,
  kind: GeneratedMediaKind,
  url: string | undefined,
  parent: ContentAssetRecord,
  details: { prompt?: string; provider?: string; model?: string; mediaProbe?: import('../services/media/MediaTranscodingService.js').MediaProbe },
): Promise<void> {
  if (!url) return;
  try {
    await saveGeneratedMediaToGallery({ userId, kind, url, parent, ...details });
  } catch (error) {
    logger.error({ err: error, userId, parentAssetId: parent.id, kind }, '[ContentStudioController] Generated media was attached but not added to the gallery');
  }
}

/**
 * POST /api/content/studio/image
 * Generate an image using Gemini 2.5 Flash Image API
 * Generate image using Vertex AI
 */
export async function generateImage(req: Request, res: Response) {
  try {
    const { prompt, images, title, threadId, sourceType, sourceTitle, sourceCaption, channel, brandToolkitId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const ownedThreadId = await resolveGenerationThread(res, Number(userId), threadId);
    if (ownedThreadId === undefined) return;
    const parentAssetId = req.body.assetId ? Number(req.body.assetId) : undefined;
    let parentAsset: ContentAssetRecord | undefined;
    if (parentAssetId) {
      parentAsset = await ContentAssetModel.findByIdForUser(parentAssetId, Number(userId));
      if (!parentAsset) return res.status(404).json({ error: 'Content asset not found' });
      if (['published', 'scheduled', 'processing'].includes(parentAsset.status)) {
        return res.status(409).json({ error: 'Content with an active or completed publication is immutable. Cancel the schedule or create a new draft before adding media.' });
      }
    }

    // The request goes first and whole; brand context is visual-only and never
    // carries taglines or product copy the model could paint into the image.
    const enhancedPrompt = buildImageGenerationPrompt({
      userPrompt: String(prompt),
      style: req.body.style,
      brandContext: resolvedBrandContext,
    });
    // "auto" (or no choice) follows a ratio written in the prompt, e.g. "4:5",
    // and otherwise keeps the creator's square default.
    const requestedAspectRatio = req.body.aspectRatio && req.body.aspectRatio !== AUTO_IMAGE_SETTING
      ? req.body.aspectRatio
      : detectPromptAspectRatio(String(prompt)) || '1:1';

    // Validate images if provided
    let processedImages: { base64Data: string; mimeType: string }[] | undefined;
    if (images && Array.isArray(images)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      processedImages = images.map((img: any) => ({
        base64Data: img.base64Data || img.data,
        mimeType: img.mimeType || 'image/jpeg',
      }));
    }

    logger.info('[ContentStudioController] Generating image with prompt');

    // Pass userId to use Gemini API key from user's integrations
    const result = await contentStudioAgent.generateImage(enhancedPrompt, processedImages, userId, {
      provider: req.body.provider,
      model: req.body.model,
      aspectRatio: requestedAspectRatio,
      imageSize: req.body.imageSize,
      seed: req.body.seed,
      brandLogoUrl: approvedLogoUrl(resolvedBrandContext) ?? null,
    });
    const appliedAspectRatio = result.imageSettings?.aspectRatio ?? requestedAspectRatio;
    const appliedImageSize = result.imageSettings ? result.imageSettings.imageSize : req.body.imageSize;
    const settingsNote = result.imageSettings?.adjustments.length ? result.imageSettings.adjustments.join(' ') : undefined;

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Unable to generate the image. Please try again.',
      });
    }

    // Save to content_assets table - store URL instead of base64
    let assetId: number | undefined;
    let persistenceWarning: string | undefined;
    const shouldPersist = Boolean(parentAsset || req.body.saveToAssets === true);
    if ((!result.imageUrl && !result.imageData) || (shouldPersist && !result.imageUrl)) {
      return res.status(502).json({ success: false, error: 'The image provider did not return a durable media URL. No library asset was created.' });
    }
    try {
      if (parentAssetId && parentAsset) {
        const existingAsset = parentAsset;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let contentJson: Record<string, any> = {};
          try {
            contentJson = existingAsset.content ? JSON.parse(existingAsset.content) : {};
          } catch {
            contentJson = { content: existingAsset.content };
          }
          
          contentJson.imageUrl = result.imageUrl;
          contentJson.generatedImage = result.imageUrl;
          if (Array.isArray(contentJson.imageUrls)) {
            if (result.imageUrl && !contentJson.imageUrls.includes(result.imageUrl)) {
              contentJson.imageUrls.push(result.imageUrl);
            }
          } else {
            contentJson.imageUrls = result.imageUrl ? [result.imageUrl] : [];
          }
          
          const rootImageUrls = Array.isArray(existingAsset.imageUrls) ? [...existingAsset.imageUrls] : [];
          if (result.imageUrl && !rootImageUrls.includes(result.imageUrl)) {
            rootImageUrls.push(result.imageUrl);
          }
          
          const { updateEditableContentAsset } = await import('../services/social/OrganicPublishLifecycleService.js');
          const updatedAsset = await updateEditableContentAsset(Number(userId), parentAssetId, {
            content: JSON.stringify(contentJson),
            imageUrl: result.imageUrl || existingAsset.imageUrl,
            imageUrls: rootImageUrls,
            version: existingAsset.version + 1,
            ...generationPolicyPersistence(resolvedBrandContext, 'image', channel || existingAsset.channel),
          });
          if (!updatedAsset) throw new Error('Content asset changed before media could be attached');
          assetId = parentAssetId;
          logger.info({ parentAssetId, imageUrl: result.imageUrl }, '[ContentStudioController] Updated parent asset with generated image');
          await addGeneratedMediaToGallery(Number(userId), 'image', result.imageUrl, updatedAsset, { prompt, provider: result.provider, model: result.model });
      }
      
      if (!assetId && req.body.saveToAssets === true) {
        const imageRow: Parameters<typeof ContentAssetModel.create>[0] = {
          type: 'image',
          title: title || `Generated Image - ${new Date().toLocaleDateString()}`,
          content: result.imageUrl || '', // Store URL instead of base64
          imageUrl: result.imageUrl || null,
          imageUrls: result.imageUrl ? [result.imageUrl] : [],
          channel: channel || 'content_studio',
          status: 'draft',
          userId,
          threadId: ownedThreadId,
          performance: {
            prompt, 
            mimeType: result.mimeType, 
            fileName: result.fileName,
            imageUrl: result.imageUrl, // Also store in performance for reference
            sourceType: sourceType || undefined,
            sourceTitle: sourceTitle || undefined,
            sourceCaption: sourceCaption || undefined,
            aspectRatio: appliedAspectRatio,
            style: req.body.style,
            imageSize: appliedImageSize,
            requestedAspectRatio: req.body.aspectRatio,
            requestedImageSize: req.body.imageSize,
            seed: req.body.seed,
            provider: result.provider,
            model: result.model,
          },
          ...generationPolicyPersistence(resolvedBrandContext, 'image', channel || 'content_studio'),
        };
        // One gallery row per generated file, even if this save is replayed.
        const savedAsset = result.imageUrl
          ? (await ContentAssetModel.createOnce(imageRow, generatedMediaKey('image', result.imageUrl))).asset
          : await ContentAssetModel.create(imageRow);
        assetId = savedAsset.id;
        logger.info({ assetId }, '[ContentStudioController] Image saved to content_assets');
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (saveError: any) {
      logger.error({ err: saveError, userId, prompt, brandToolkitId }, '[ContentStudioController] Failed to save image to content_assets — assetId will be null');
      persistenceWarning = 'The image was generated, but it could not be saved to your content library.';
    }

    // Save in-app notification
    if (userId) NotificationService.imageGenerated(userId, prompt?.slice(0, 80));

    res.json({
      success: true,
      imageData: result.imageData, // Keep for backward compatibility
      imageUrl: result.imageUrl,   // New: URL to the saved file
      mimeType: result.mimeType,
      fileName: result.fileName,
      assetId: assetId ?? null,
      persisted: shouldPersist ? Boolean(assetId) : false,
      persistenceWarning,
      brandContext: resolvedBrandContext.provenance,
      branding: result.branding,
      brandReference: result.brandReference,
      provider: result.provider,
      model: result.model,
      aspectRatio: appliedAspectRatio,
      imageSize: appliedImageSize,
      settingsNote,
      message: persistenceWarning || 'Image generated successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error generating image');
    res.status(500).json({ error: 'Unable to generate the image. Please try again.' });
  }
}

/**
 * POST /api/content/studio/video
 * Generate a video using Veo 3 API
 * Generate video using Vertex AI
 * Note: This is a long-running operation - video generation can take several minutes
 */
export async function generateVideo(req: Request, res: Response) {
  try {
    const { prompt, image, title, threadId, sourceType, sourceTitle, sourceCaption, channel, brandToolkitId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const ownedThreadId = await resolveGenerationThread(res, Number(userId), threadId);
    if (ownedThreadId === undefined) return;

    const parentAssetId = req.body.assetId ? Number(req.body.assetId) : undefined;
    let parentAsset: ContentAssetRecord | undefined;
    if (parentAssetId) {
      parentAsset = await ContentAssetModel.findByIdForUser(parentAssetId, Number(userId));
      if (!parentAsset) return res.status(404).json({ error: 'Content asset not found' });
      if (['published', 'scheduled', 'processing'].includes(parentAsset.status)) {
        return res.status(409).json({ error: 'Content with an active or completed publication is immutable. Cancel the schedule or create a new draft before adding media.' });
      }
    }

    // The user's request and style come first so trimming to the provider's
    // 4,000-character limit only ever shortens the trailing brand context.
    let enhancedPrompt = String(prompt).slice(0, 4000);
    if (req.body.style) enhancedPrompt += `\n\nRequested video style: ${req.body.style}.`;
    enhancedPrompt += `\n\n${formatMediaBrandContext(resolvedBrandContext)}`;

    // Validate the image before any draft is saved or provider is called, so a
    // tiny or unreadable upload gets a clear message instead of a provider 400.
    let processedImage: { base64Data: string; mimeType: string } | undefined;
    const imageRole = req.body.imageRole === 'start_frame' ? 'start_frame' as const : 'reference' as const;
    if (image) {
      const { prepareVideoInputImage, VideoInputImageError } = await import('../services/media/VideoInputImage.js');
      try {
        const prepared = await prepareVideoInputImage({
          base64Data: image.base64Data || image.data,
          mimeType: image.mimeType || 'image/jpeg',
        }, { role: imageRole, aspectRatio: req.body.aspectRatio });
        processedImage = { base64Data: prepared.base64Data, mimeType: prepared.mimeType };
      } catch (imageError) {
        if (imageError instanceof VideoInputImageError) return res.status(400).json({ success: false, error: imageError.message });
        throw imageError;
      }
    }

    logger.info('[ContentStudioController] Generating video with prompt');

    // The standalone creator saves a durable record before any paid provider call.
    // Workers own submission/recovery, so leaving the page cannot abandon the job.
    if (req.body.background === true) {
      if (parentAssetId || req.body.saveToAssets !== true) return res.status(400).json({ error: 'Background video generation requires a new saved video draft.' });
      const savedAsset = await ContentAssetModel.create({
        type: 'video', title: title || `Generated Video - ${new Date().toLocaleDateString()}`,
        content: JSON.stringify({ videoUrl: '', mimeType: 'video/mp4' }),
        channel: channel || 'video_generation', status: 'pending', userId, threadId: ownedThreadId,
        performance: {
          prompt, duration: req.body.duration, resolution: req.body.resolution,
          aspectRatio: req.body.aspectRatio, style: req.body.style, seed: req.body.seed,
          ...(processedImage ? { imageRole } : {}),
          mediaGeneration: { video: { status: 'queued', updatedAt: new Date().toISOString() } },
        },
        ...generationPolicyPersistence(resolvedBrandContext, 'video', channel || 'video_generation'),
      });
      const { queueSavedContentVideos } = await import('../services/media/SavedContentVideoQueueService.js');
      const queued = await queueSavedContentVideos({
        userId: Number(userId), threadId: ownedThreadId ?? undefined, parentAssetId: savedAsset.id, assetType: 'video',
        prompts: [enhancedPrompt], provider: req.body.provider, model: req.body.model, image: processedImage,
        brandLogoUrl: req.body.includeBrandLogo === false ? null : approvedLogoUrl(resolvedBrandContext) ?? null,
        videoConfig: {
          durationSeconds: req.body.duration ? Number(req.body.duration) : undefined,
          aspectRatio: req.body.aspectRatio, resolution: req.body.resolution,
          generateAudio: req.body.generateAudio, personGeneration: req.body.personGeneration, seed: req.body.seed,
          ...(processedImage ? { imageRole } : {}),
        },
      });
      if (!queued.jobIds.length) {
        await ContentAssetModel.updateForUser(savedAsset.id, Number(userId), {
          status: 'failed',
          performance: { ...(savedAsset.performance as Record<string, unknown> || {}), mediaGeneration: { video: { status: 'failed', error: queued.errors[0] || 'Video could not be queued.' } } },
        });
        return res.status(503).json({ success: false, assetId: savedAsset.id, persisted: true, error: queued.errors[0] || 'Video could not be queued. Your draft was saved.' });
      }
      return res.status(202).json({ success: true, status: 'pending', assetId: savedAsset.id, persisted: true, jobId: queued.jobIds[0], message: 'Video draft saved and queued. It will continue in the background.' });
    }

    // Pass userId to use Gemini API key from user's integrations
    const durationSeconds = req.body.duration ? Number(req.body.duration) : undefined;
    const result = await contentStudioAgent.generateVideo(enhancedPrompt, processedImage, userId, {
      provider: req.body.provider,
      model: req.body.model,
      numberOfVideos: 1,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : undefined,
      aspectRatio: req.body.aspectRatio,
      resolution: req.body.resolution,
      generateAudio: req.body.generateAudio,
      personGeneration: req.body.personGeneration,
      seed: req.body.seed,
      ...(processedImage ? { imageRole } : {}),
      brandLogoUrl: req.body.includeBrandLogo === false ? null : approvedLogoUrl(resolvedBrandContext) ?? null,
    });

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Unable to generate the video. Please try again.',
      });
    }

    // Save to content_assets table
    let assetId: number | undefined;
    let persistenceWarning: string | undefined;
    const shouldPersist = Boolean(parentAsset || req.body.saveToAssets === true);
    if (!result.videoUrl && !result.operationName) {
      return res.status(502).json({ success: false, error: 'The video provider did not return a media URL or a recoverable operation. No library asset was created.' });
    }
    try {
      if (parentAssetId && parentAsset) {
        const existingAsset = parentAsset;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let contentJson: Record<string, any> = {};
          try {
            contentJson = existingAsset.content ? JSON.parse(existingAsset.content) : {};
          } catch {
            contentJson = { content: existingAsset.content };
          }
          
          contentJson.videoUrl = result.videoUrl;
          contentJson.generatedVideo = result.videoUrl;
          if (Array.isArray(contentJson.videoUrls)) {
            if (result.videoUrl && !contentJson.videoUrls.includes(result.videoUrl)) {
              contentJson.videoUrls.push(result.videoUrl);
            }
          } else {
            contentJson.videoUrls = result.videoUrl ? [result.videoUrl] : [];
          }
          
          const rootVideoUrls = Array.isArray(existingAsset.videoUrls) ? [...existingAsset.videoUrls] : [];
          if (result.videoUrl && !rootVideoUrls.includes(result.videoUrl)) {
            rootVideoUrls.push(result.videoUrl);
          }
          
          const existingPerformance = existingAsset.performance && typeof existingAsset.performance === 'object'
            ? existingAsset.performance as Record<string, unknown>
            : {};
          const { updateEditableContentAsset } = await import('../services/social/OrganicPublishLifecycleService.js');
          const { withVideoProbeMetadata } = await import('../services/media/MediaTranscodingService.js');
          const updatedAsset = await updateEditableContentAsset(Number(userId), parentAssetId, {
            content: JSON.stringify(contentJson),
            videoUrl: result.videoUrl || existingAsset.videoUrl,
            videoUrls: rootVideoUrls,
            version: existingAsset.version + 1,
            metadata: withVideoProbeMetadata(result.videoUrl, result.mediaProbe, existingAsset.metadata || {}),
            status: result.videoUrl ? existingAsset.status : 'pending',
            performance: {
              ...existingPerformance,
              prompt,
              operationName: result.operationName,
              duration: req.body.duration,
              resolution: req.body.resolution,
              aspectRatio: req.body.aspectRatio,
              style: req.body.style,
              seed: req.body.seed,
              provider: result.provider,
              model: result.model,
            },
            ...generationPolicyPersistence(resolvedBrandContext, 'video', channel || existingAsset.channel),
          });
          if (!updatedAsset) throw new Error('Content asset changed before media could be attached');
          assetId = parentAssetId;
          logger.info({ parentAssetId, videoUrl: result.videoUrl }, '[ContentStudioController] Updated parent asset with generated video');
          await addGeneratedMediaToGallery(Number(userId), 'video', result.videoUrl, updatedAsset, { prompt, provider: result.provider, model: result.model, mediaProbe: result.mediaProbe });
      }
      
      if (!assetId && req.body.saveToAssets === true) {
        const { withVideoProbeMetadata } = await import('../services/media/MediaTranscodingService.js');
        const savedAsset = await ContentAssetModel.create({
          type: 'video',
          title: title || `Generated Video - ${new Date().toLocaleDateString()}`,
          content: JSON.stringify({ 
            videoUrl: result.videoUrl || '', 
            mimeType: result.mimeType || 'video/mp4',
            fileName: result.fileName || 'video.mp4' 
          }),
          videoUrl: result.videoUrl || null,
          videoUrls: result.videoUrl ? [result.videoUrl] : [],
          metadata: withVideoProbeMetadata(result.videoUrl, result.mediaProbe),
          channel: channel || 'content_studio',
          status: result.videoUrl ? 'draft' : 'pending',
          userId,
          threadId: ownedThreadId,
          performance: { 
            prompt, 
            operationName: result.operationName,
            sourceType: sourceType || undefined,
            sourceTitle: sourceTitle || undefined,
            sourceCaption: sourceCaption || undefined,
            duration: req.body.duration,
            resolution: req.body.resolution,
            aspectRatio: req.body.aspectRatio,
            style: req.body.style,
            seed: req.body.seed,
            provider: result.provider,
            model: result.model,
          },
          ...generationPolicyPersistence(resolvedBrandContext, 'video', channel || 'content_studio'),
        });
        assetId = savedAsset.id;
        logger.info({ assetId }, '[ContentStudioController] Video saved to content_assets');
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (saveError: any) {
      logger.error({ err: saveError, userId, prompt, brandToolkitId }, '[ContentStudioController] Failed to save video to content_assets — assetId will be null');
      persistenceWarning = 'The video was generated, but it could not be saved to your content library.';
    }

    res.json({
      success: true,
      videoData: result.videoData,
      videoUrl: result.videoUrl,
      mimeType: result.mimeType,
      fileName: result.fileName,
      operationName: result.operationName,
      assetId: assetId ?? null,
      persisted: shouldPersist ? Boolean(assetId) : false,
      persistenceWarning,
      brandContext: resolvedBrandContext.provenance,
      branding: result.branding,
      brandReference: result.brandReference,
      provider: result.provider,
      model: result.model,
      message: persistenceWarning || 'Video generated successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error generating video');
    res.status(500).json({ error: 'Unable to generate the video. Please try again.' });
  }
}

/**
 * POST /api/content/studio/video/start
 * Legacy async start. This does not save the owned asset required by status;
 * new creator callers use the saved/background /studio/video lifecycle.
 * Legacy activation/retirement requires the decision recorded in the audit.
 */
export async function startVideoGeneration(req: Request, res: Response) {
  try {
    const { prompt, image } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;

    // Validate image if provided
    let processedImage: { base64Data: string; mimeType: string } | undefined;
    if (image) {
      processedImage = {
        base64Data: image.base64Data || image.data,
        mimeType: image.mimeType || 'image/jpeg',
      };
    }

    logger.info('[ContentStudioController] Starting async video generation');

    // Pass userId to use Gemini API key from user's integrations
    // Keep the full request (up to the provider limit); only brand context is trimmed later.
    const result = await contentStudioAgent.startVideoGeneration(
      `${String(prompt).slice(0, 4000)}\n\n${formatMediaBrandContext(resolvedBrandContext)}`,
      processedImage,
      userId,
      {
        provider: req.body.provider,
        model: req.body.model,
        durationSeconds: req.body.duration,
        resolution: req.body.resolution,
        aspectRatio: req.body.aspectRatio,
        generateAudio: req.body.generateAudio,
        seed: req.body.seed,
        brandLogoUrl: req.body.includeBrandLogo === false ? null : approvedLogoUrl(resolvedBrandContext) ?? null,
        ...(processedImage ? { imageRole: req.body.imageRole === 'start_frame' ? 'start_frame' as const : 'reference' as const } : {}),
      },
    );

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Unable to start video generation. Please try again.',
      });
    }

    res.json({
      success: true,
      operationName: result.operationName,
      provider: result.provider,
      model: result.model,
      brandContext: resolvedBrandContext.provenance,
      brandReference: result.brandReference,
      message: 'Video generation started. Use the operation name to check status.',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error starting video generation');
    res.status(500).json({ error: 'Unable to start video generation. Please try again.' });
  }
}

/**
 * GET /api/content/studio/video/status/:operationName
 * Check video generation status by operation name
 */
export async function checkVideoStatus(req: Request, res: Response) {
  try {
    const { operationName } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!operationName || operationName.length > 500 || !/^[A-Za-z0-9_./-]+$/.test(operationName)) {
      return res.status(400).json({ error: 'operationName is required' });
    }

    logger.info({ operationName }, '[ContentStudioController] Checking video status for operation');

    const asset = await ContentAssetModel.findByVideoOperationForUser(operationName, Number(userId));
    if (!asset) return res.status(404).json({ success: false, error: 'Saved video operation not found' });
    const snapshotToolkit = asset && typeof asset.brandContextSnapshot === 'object'
      ? (asset.brandContextSnapshot as Record<string, any>)?.brandToolkit
      : undefined;
    const requestedLogoUrl = snapshotToolkit
      ? snapshotToolkit.logoVisibility === false
        ? null
        : primaryBrandLogoUrl(snapshotToolkit)
      : undefined;
    const assetPerformance = asset?.performance && typeof asset.performance === 'object'
      ? asset.performance as Record<string, unknown>
      : {};
    const requestedProvider = assetPerformance.provider || req.query.provider;
    const requestedModel = assetPerformance.model || req.query.model;
    const mediaSelection: { provider?: 'google' | 'openrouter'; model?: string } = {
      provider: requestedProvider === 'google' || requestedProvider === 'openrouter' ? requestedProvider : undefined,
      model: typeof requestedModel === 'string' && requestedModel.length <= 200 ? requestedModel : undefined,
    };

    // Once a completed operation has been attached, return the persisted result.
    // Polling a completed provider job downloads and persists the video, so invoking
    // the worker again would create a fresh duplicate file on every status request.
    if (asset?.videoUrl && asset.status !== 'pending') {
      const videoGeneration = assetPerformance.videoGeneration && typeof assetPerformance.videoGeneration === 'object'
        ? assetPerformance.videoGeneration as Record<string, unknown>
        : {};
      return res.json({
        success: true,
        done: true,
        operationName,
        videoUrl: asset.videoUrl,
        assetId: asset.id,
        persisted: true,
        provider: mediaSelection.provider,
        model: mediaSelection.model,
        branding: videoGeneration.branding,
        brandReference: videoGeneration.brandReference,
      });
    }

    // Keep the exact toolkit selected when the long-running generation was started.
    const status = await contentStudioAgent.checkVideoGenerationStatus(operationName, userId, requestedLogoUrl, mediaSelection);

    if (status && status.done && status.videoUrl) {
      try {
        if (asset) {
          let contentJson: Record<string, unknown> = {};
          try {
            const parsed = asset.content ? JSON.parse(asset.content) : {};
            contentJson = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : { content: asset.content };
          } catch {
            contentJson = { content: asset.content };
          }

          const contentVideoUrls = Array.isArray(contentJson.videoUrls)
            ? contentJson.videoUrls.filter((url): url is string => typeof url === 'string')
            : [];
          if (!contentVideoUrls.includes(status.videoUrl)) contentVideoUrls.push(status.videoUrl);

          const rootVideoUrls = Array.isArray(asset.videoUrls) ? [...asset.videoUrls] : [];
          if (!rootVideoUrls.includes(status.videoUrl)) rootVideoUrls.push(status.videoUrl);

          const { updateEditableContentAsset } = await import('../services/social/OrganicPublishLifecycleService.js');
          const { withVideoProbeMetadata } = await import('../services/media/MediaTranscodingService.js');
          const updatedAsset = await updateEditableContentAsset(Number(userId), asset.id, {
            status: asset.status === 'pending' ? 'draft' : asset.status,
            version: asset.version + 1,
            metadata: withVideoProbeMetadata(status.videoUrl, status.mediaProbe, asset.metadata || {}),
            content: JSON.stringify({
              ...contentJson,
              videoUrl: status.videoUrl,
              generatedVideo: status.videoUrl,
              videoUrls: contentVideoUrls,
              mimeType: contentJson.mimeType || 'video/mp4',
              fileName: contentJson.fileName || 'video.mp4',
            }),
            videoUrl: status.videoUrl,
            videoUrls: rootVideoUrls,
            performance: {
              ...(asset.performance || {}),
              videoGeneration: {
                ...((asset.performance as Record<string, any> | null)?.videoGeneration || {}),
                branding: status.branding,
                brandReference: status.brandReference,
              },
            },
            lastError: null,
          });
          if (!updatedAsset) throw new Error('Content asset changed before video completion could be attached');

          logger.info({ assetId: asset.id, operationName }, '[ContentStudioController] Updated content asset with polled video url');
          await addGeneratedMediaToGallery(Number(userId), 'video', status.videoUrl, updatedAsset, { prompt: typeof assetPerformance.prompt === 'string' ? assetPerformance.prompt : undefined, mediaProbe: status.mediaProbe });
        }
      } catch (dbErr) {
        logger.error({ err: dbErr, operationName }, '[ContentStudioController] Failed to update asset for completed video operation');
        return res.status(503).json({ success: false, done: false, providerDone: true, persisted: false, assetId: asset.id, error: 'Video generated but not confirmed saved. Retry the status check.' });
      }
    } else if (status?.done && status.error && asset) {
      try {
        let contentJson: Record<string, unknown> = {};
        try {
          const parsed = asset.content ? JSON.parse(asset.content) : {};
          contentJson = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        } catch { /* retain an empty object for invalid legacy content */ }
        const { updateEditableContentAsset } = await import('../services/social/OrganicPublishLifecycleService.js');
        const updatedFailure = await updateEditableContentAsset(Number(userId), asset.id, {
          status: 'failed',
          content: JSON.stringify({ ...contentJson, error: status.error }),
          lastError: status.error,
        });
        if (!updatedFailure) throw new Error('Content asset changed before video failure could be saved');
        logger.warn({ assetId: asset.id, operationName }, '[ContentStudioController] Marked failed video operation on content asset');
      } catch (dbErr) {
        logger.error({ err: dbErr, operationName }, '[ContentStudioController] Failed to persist video operation failure');
        return res.status(503).json({ success: false, done: false, providerDone: true, persisted: false, assetId: asset.id, error: 'Video status could not be saved. Retry the status check.' });
      }
    }

    res.json({
      ...status,
      success: true,
      assetId: asset.id,
      persisted: true,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error checking video status');
    res.status(500).json({ error: 'Unable to check video status. Please try again.' });
  }
}

/**
 * GET /api/content/studio/media/status
 * Get status of image and video generation workers
 */
export async function getMediaStatus(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    // Pass userId to check user-specific integrations
    const status = await contentStudioAgent.getMediaGenerationStatus(userId);

    res.json({
      success: true,
      ...status,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error getting media status');
    res.status(500).json({ error: 'Unable to get media status. Please try again.' });
  }
}

/**
 * POST /api/content/studio/email
 * Generate an email template for marketing campaigns
 */
export async function generateEmail(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const input = contentStudioEmailSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ success: false, code: 'EMAIL_INPUT_INVALID', error: 'Enter a non-empty email prompt of at most 20,000 characters and valid generation settings.' });
    const body = input.data;
    const { prompt, icpId, tone = 'professional', threadId, persist = true } = body;
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), body);
    if (!resolvedBrandContext) return;
    const generationTemplate = await resolveGenerationTemplate(
      res,
      Number(userId),
      body.templateId,
      resolvedBrandContext,
      ['email', 'email_template'],
    );
    if (body.templateId && !generationTemplate) return;
    const ownedThreadId = await resolveGenerationThread(res, Number(userId), threadId);
    if (ownedThreadId === undefined) return;

    // Fetch ICP if provided
    let icpContext = '';
    if (icpId) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const icp = icpResult.rows[0] as any;
        icpContext = `Target Audience: ${icp.target_audience || ''}\nIndustry: ${icp.industry || ''}\nPain Points: ${icp.pain_points || ''}`;
      }
    }

    const brandContext = formatContentBrandContext(resolvedBrandContext);

    // Fetch Knowledge Base context using embedding-based semantic search
    let kbContext = '';
    if (userId) {
      try {
        const semanticResult = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'content_draft', channel: 'internal', audience: 'internal', redactedText: prompt, redactedHistory: [], entities: {}, risk: 'low' });
        if (semanticResult) {
          kbContext = `\nKnowledge Base Context:\n${semanticResult}`;
        }
      } catch (err) {
        logger.warn({ err, userId }, '[generateEmail] Failed to get semantic context from Knowledge Base, continuing without it');
      }
    }

    const draftRequest = { request: prompt, tone, brandContext, audienceContext: icpContext, knowledgeContext: kbContext, templateContext: formatGenerationTemplate(generationTemplate), reviewedCta: body.cta, includeImagePrompt: body.includeImagePrompt };
    const response = await createContentTextCompletion(userId, {
      messages: textDraftMessages('email', draftRequest),
      temperature: 0.7,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId,
        purpose: 'content_generation',
        service: 'ContentStudioController',
        action: 'generate_email',
      },
    });

    let emailContent: z.infer<typeof contentOutputSchemas.email>;
    try {
      emailContent = parseTextDraft('email', response.content || '{}', draftRequest);
    } catch {
      logger.warn({ code: 'AI_PROVIDER_INVALID_RESPONSE' }, '[ContentStudioController] Email provider response failed validation');
      return res.status(502).json({ success: false, code: 'AI_PROVIDER_INVALID_RESPONSE', error: 'The AI provider returned an invalid email. Please generate it again.' });
    }

    // Validate that we have actual content
    if (!emailContent.body || (emailContent.body.toLowerCase().includes('generate') && emailContent.body.toLowerCase().includes('email') && emailContent.body.length < 100)) {
      if (!emailContent.body) {
        return res.status(500).json({ error: 'Unable to generate email content. Please try again with a more specific prompt.' });
      }
    }
    if (!validateGeneratedOrRespond(res, {
      type: 'email',
      output: emailContent,
      context: resolvedBrandContext,
      platform: 'email',
    })) return;

    if (persist === false) {
      return res.json({
        success: true,
        content: JSON.stringify(emailContent),
        emailContent,
        brandContext: resolvedBrandContext.provenance,
        message: 'Email generated successfully',
      });
    }

    let savedAsset: Awaited<ReturnType<typeof persistTextDraft>>;
    try {
      savedAsset = await persistTextDraft({ type: 'email', output: emailContent, userId: Number(userId), threadId: ownedThreadId, context: resolvedBrandContext, template: generationTemplate });
      if (!Number.isSafeInteger(savedAsset?.id) || savedAsset.id <= 0) throw new Error('Missing saved email receipt');
    } catch {
      logger.error({ code: 'EMAIL_SAVE_UNCONFIRMED', userId }, '[ContentStudioController] Email draft persistence could not be confirmed');
      return res.status(503).json({ success: false, code: 'EMAIL_SAVE_UNCONFIRMED', error: 'Email generation finished, but the saved draft could not be confirmed. Check email templates before generating again.' });
    }

    const mediaQueue = await enqueueGeneratedAssetMedia({
      userId: Number(userId),
      parentAssetId: savedAsset.id,
      assetType: 'email_template',
      threadId: savedAsset.threadId,
      imagePrompt: undefined, // Email generation is copy-only; media is attached explicitly after review.
      brandContext: formatContentBrandContext(resolvedBrandContext),
      brandLogoUrl: approvedLogoUrl(resolvedBrandContext),
    });

    res.json({
      success: true,
      persisted: true,
      content: JSON.stringify(emailContent),
      subject: emailContent.subject,
      body: emailContent.body,
      greeting: emailContent.greeting,
      closing: emailContent.closing,
      signature: emailContent.signature,
      cta: emailContent.cta,
      imagePrompt: emailContent.imagePrompt,
      assetId: savedAsset.id,
      mediaGeneration: mediaQueue,
      brandContext: resolvedBrandContext.provenance,
      message: 'Email template generated successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToContentTextGenerationError(res, error, logger, 'ContentStudioController')) return;
    logger.error({ err: error }, '[ContentStudioController] Error generating email');
    res.status(500).json({ success: false, code: 'EMAIL_GENERATION_FAILED', error: 'Email generation failed before a draft was created. Your prompt and settings are kept; please try again.' });
  }
}

/**
 * POST /api/content/studio/sms
 * Generate an SMS message for marketing campaigns
 */
export async function generateSMS(req: Request, res: Response) {
  try {
    const { prompt, icpId, threadId, persist = true } = req.body;
    const maxCharacters = req.body.maxCharacters === 320 ? 320 : SMS_CHAR_LIMIT;
    const includeOptOut = req.body.includeOptOut === true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const generationTemplate = await resolveGenerationTemplate(
      res,
      Number(userId),
      req.body.templateId,
      resolvedBrandContext,
      ['sms', 'sms_template'],
    );
    if (req.body.templateId && !generationTemplate) return;
    const ownedThreadId = threadId ? Number(threadId) : null;
    if (ownedThreadId) {
      const thread = await getChatThreadById(ownedThreadId);
      if (!thread || thread.userId !== Number(userId)) return res.status(404).json({ error: 'Chat thread not found' });
    }

    let icpContext = '';
    if (icpId) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const icp = icpResult.rows[0] as any;
      icpContext = `Target Audience: ${icp.target_audience || ''}\nPain Points: ${icp.pain_points || ''}`;
    }

    const brandContext = formatContentBrandContext(resolvedBrandContext);

    // Fetch Knowledge Base context using embedding-based semantic search
    let kbContext = '';
    if (userId) {
      const semanticResult = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'content_draft', channel: 'internal', audience: 'internal', redactedText: prompt, redactedHistory: [], entities: {}, risk: 'low' });
      if (semanticResult) {
        kbContext = `\nKey Info:\n${semanticResult}`;
      }
    }

    const draftRequest = { request: prompt, brandContext, audienceContext: icpContext, knowledgeContext: kbContext, templateContext: formatGenerationTemplate(generationTemplate), maxCharacters, includeOptOut, includeImagePrompt: req.body.includeImagePrompt };
    const response = await createContentTextCompletion(userId, {
      messages: textDraftMessages('sms', draftRequest),
      temperature: 0.7,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId,
        purpose: 'content_generation',
        service: 'ContentStudioController',
        action: 'generate_sms',
      },
    });

    let smsContent: z.infer<typeof contentOutputSchemas.sms>;
    try {
      smsContent = parseTextDraft('sms', response.content || '{}', draftRequest);
    } catch (parseError) {
      logger.error({ err: parseError }, '[ContentStudioController] SMS provider response failed validation');
      return res.status(502).json({ error: `The AI provider returned an invalid SMS. Generate again to keep it within ${maxCharacters} characters${includeOptOut ? ' and include the requested opt-out instruction' : ''}.` });
    }

    // Validate that message is actual content, not the prompt
    const generatedMessage = smsContent.message || '';
    if (!generatedMessage) {
      return res.status(500).json({ error: 'Unable to generate SMS content. Please try again with a more specific prompt.' });
    }
    if (!validateGeneratedOrRespond(res, {
      type: 'sms',
      output: smsContent,
      context: resolvedBrandContext,
      platform: 'sms',
      smsMaxCharacters: maxCharacters,
    })) return;

    if (persist === false) {
      return res.json({
        success: true,
        content: generatedMessage,
        message: generatedMessage,
        characterCount: generatedMessage.length,
        imagePrompt: smsContent.imagePrompt,
        brandContext: resolvedBrandContext.provenance,
      });
    }

    const savedAsset = await persistTextDraft({ type: 'sms', output: smsContent, userId: Number(userId), threadId: ownedThreadId, context: resolvedBrandContext, template: generationTemplate, performance: { maxCharacters, includeOptOut } });

    res.json({
      success: true,
      content: generatedMessage,
      message: generatedMessage,
      characterCount: generatedMessage.length,
      imagePrompt: smsContent.imagePrompt,
      assetId: savedAsset.id,
      brandContext: resolvedBrandContext.provenance,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToContentTextGenerationError(res, error, logger, 'ContentStudioController')) return;
    logger.error({ err: error }, '[ContentStudioController] Error generating SMS');
    res.status(500).json({ success: false, code: 'CONTENT_GENERATION_FAILED', error: 'Unable to generate the SMS. Please try again.' });
  }
}

/**
 * POST /api/content/studio/social
 * Generate a social media post
 */
export async function generateSocial(req: Request, res: Response) {
  try {
    const { prompt, icpId, platform = 'linkedin', persist = true, referenceImage } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const generationTemplate = await resolveGenerationTemplate(
      res,
      Number(userId),
      req.body.templateId,
      resolvedBrandContext,
      ['social', 'social_post'],
    );
    if (req.body.templateId && !generationTemplate) return;
    const ownedThreadId = await resolveGenerationThread(res, Number(userId), req.body.threadId);
    if (ownedThreadId === undefined) return;

    // Fetch ICP if provided
    let icpContext = '';
    if (icpId) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const icp = icpResult.rows[0] as any;
        icpContext = `Target Audience: ${icp.target_audience || ''}\nIndustry: ${icp.industry || ''}`;
      }
    }

    const brandContext = formatContentBrandContext(resolvedBrandContext);

    // Fetch Knowledge Base context using embedding-based semantic search
    let kbContext = '';
    if (userId) {
      const semanticResult = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'content_draft', channel: 'internal', audience: 'internal', redactedText: prompt, redactedHistory: [], entities: {}, risk: 'low' });
      if (semanticResult) {
        kbContext = `\nKnowledge Base Info:\n${semanticResult}`;
      }
    }

    const platformLimits: Record<string, number> = {
      twitter: TWITTER_CHAR_LIMIT,
      linkedin: LINKEDIN_CHAR_LIMIT,
      facebook: FACEBOOK_CHAR_LIMIT,
      instagram: INSTAGRAM_POST_CAPTION_LIMIT,
      youtube: 5000,
    };

    // Generate social post using AI
    // Sanitize user input to prevent prompt injection
    const sanitizedPrompt = sanitizePromptInput(prompt);
    const sanitizedPlatform = sanitizePromptInput(platform, 50);

    const isMultiPlatform = platform === 'all' || !platform;
    const resolvedPlatformLabel = isMultiPlatform ? 'multi-platform' : sanitizedPlatform;
    const characterLimitText = isMultiPlatform 
      ? 'Under 280 characters to ensure compatibility with Twitter/X, while remaining highly engaging for LinkedIn, Facebook, and Instagram.' 
      : (platformLimits[platform] || INSTAGRAM_POST_CAPTION_LIMIT);

    const socialPrompt = `Generate a ${resolvedPlatformLabel} social media post based on:
${sanitizedPrompt}

${icpContext ? `\n${icpContext}` : ''}
${brandContext ? `\n${brandContext}` : ''}
${formatGenerationTemplate(generationTemplate)}
${kbContext}

Character limit: ${characterLimitText}
The limit includes the final caption, callToAction, separating newlines, and all hashtags combined. Reserve room for every returned field.

Use any relevant information from the Knowledge Base Info above to make the post more accurate and valuable.

Return a JSON object with:
- title: A short, catchy title for this post (max 50 chars)
- caption: The main post text
- hashtags: Array of relevant hashtags (5-10)
- keywords: Array of keywords
- callToAction: Suggested call to action
- imagePrompt: A detailed prompt to generate a visually engaging image for this post. Describe style, composition, colors, and mood.
- videoPrompt: (optional) If a short video (15-60 sec) would work better for this ${resolvedPlatformLabel} post, provide a detailed prompt describing scenes, transitions, and tone.`;

    const systemPrompt = isMultiPlatform
      ? 'You are an expert social media content creator. Generate engaging posts that are optimized to work well across all major platforms (Facebook, Instagram, LinkedIn, and Twitter/X) simultaneously.'
      : `You are an expert ${sanitizedPlatform} content creator. Generate engaging posts that drive engagement and align with the brand voice. Always provide creative prompts for images and videos.`;

    const socialCharacterLimit = isMultiPlatform ? TWITTER_CHAR_LIMIT : (platformLimits[platform] || INSTAGRAM_POST_CAPTION_LIMIT);
    let socialContent: z.infer<typeof generatedSocialSchema> | undefined;
    let socialViolations: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = socialViolations.length
        ? `\n\nYour previous response was rejected. Regenerate the complete JSON object and correct every issue:\n- ${socialViolations.join('\n- ')}\nDo not explain the corrections.`
        : '';
      const response = await createContentTextCompletion(userId, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${socialPrompt}${correction}` },
        ],
        temperature: attempt === 0 ? 0.8 : 0.4,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'content_generation',
          service: 'ContentStudioController',
          action: attempt === 0 ? 'generate_social' : 'repair_social',
        },
      });

      try {
        socialContent = generatedSocialSchema.parse(extractJsonContent(response.content || '{}'));
      } catch (parseError) {
        logger.warn({ err: parseError, attempt: attempt + 1 }, '[ContentStudioController] Social provider response failed validation');
        socialViolations = ['Return valid JSON with every required social-post field.'];
        continue;
      }
      socialViolations = [];
      if (socialContent.caption.length > socialCharacterLimit) {
        socialViolations.push(`Caption must be ${socialCharacterLimit} characters or fewer; it was ${socialContent.caption.length}.`);
      }
      socialViolations.push(...generatedContentViolations({
        type: 'social',
        output: socialContent,
        context: resolvedBrandContext,
        platform: isMultiPlatform ? 'twitter' : platform,
      }));
      if (socialViolations.length === 0) break;
    }
    if (!socialContent || socialViolations.length > 0) {
      return res.status(422).json({
        error: 'The AI provider could not produce a compliant social post after an automatic correction attempt.',
        violations: socialViolations,
      });
    }

    // Create a meaningful title from the generated content or prompt
    const generatedTitle = socialContent.title 
      ? socialContent.title.substring(0, 150)
      : (sanitizedPrompt.length > 150 ? sanitizedPrompt.substring(0, 150) + '...' : sanitizedPrompt);
    const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);

    // Composer surfaces can request generated copy without creating an orphan
    // draft asset; the final edited post is persisted by the composer itself.
    if (persist === false) {
      return res.json({
        success: true,
        content: socialContent.caption,
        caption: socialContent.caption,
        hashtags: socialContent.hashtags,
        keywords: socialContent.keywords,
        callToAction: socialContent.callToAction,
        imagePrompt: socialContent.imagePrompt,
        videoPrompt: socialContent.videoPrompt,
        platform,
        brandContext: resolvedBrandContext.provenance,
        message: 'Social post generated successfully',
      });
    }

    // Save to content_assets table
    const { ContentAssetModel } = await import('../models/contentAssets/functions');
    const savedAsset = await ContentAssetModel.create({
      type: 'social_post',
      title: `${platformName} - ${generatedTitle}`,
      content: JSON.stringify(socialContent),
      channel: platform,
      status: 'draft',
      userId: userId || null,
      performance: null,
      threadId: ownedThreadId,
      ...generationPolicyPersistence(resolvedBrandContext, 'social', platform, generationTemplate),
    });

    const mediaQueue = await enqueueGeneratedAssetMedia({
      userId: Number(userId),
      parentAssetId: savedAsset.id,
      assetType: 'social_post',
      threadId: savedAsset.threadId,
      imagePrompt: req.body.mediaGeneration?.image === true ? socialContent.imagePrompt : undefined,
      videoPrompt: req.body.mediaGeneration?.video === true ? socialContent.videoPrompt : undefined,
      brandContext: formatContentBrandContext(resolvedBrandContext),
      imageBrand: resolvedBrandContext,
      brandLogoUrl: approvedLogoUrl(resolvedBrandContext),
      referenceImages: referenceImage ? [{
        base64Data: referenceImage.base64Data || referenceImage.data,
        mimeType: referenceImage.mimeType,
      }] : undefined,
    });

    res.json({
      success: true,
      content: socialContent.caption,
      caption: socialContent.caption,
      hashtags: socialContent.hashtags,
      keywords: socialContent.keywords,
      callToAction: socialContent.callToAction,
      imagePrompt: socialContent.imagePrompt,
      videoPrompt: socialContent.videoPrompt,
      platform,
      assetId: savedAsset.id,
      mediaGeneration: mediaQueue,
      brandContext: resolvedBrandContext.provenance,
      message: 'Social post generated successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToContentTextGenerationError(res, error, logger, 'ContentStudioController')) return;
    logger.error({ err: error }, '[ContentStudioController] Error generating social post');
    res.status(500).json({ success: false, code: 'CONTENT_GENERATION_FAILED', error: 'Unable to generate the social post. Please try again.' });
  }
}

/**
 * POST /api/content/studio/social-message
 * Generate a social media direct message with template variables
 */
export async function generateSocialMessage(req: Request, res: Response) {
  try {
    const { prompt, icpId, platform = 'linkedin', threadId, persist = true } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const generationTemplate = await resolveGenerationTemplate(
      res,
      Number(userId),
      req.body.templateId,
      resolvedBrandContext,
      ['social_message', 'social_dm', 'instagram_dm', 'facebook_dm', 'linkedin_dm', 'twitter_dm'],
    );
    if (req.body.templateId && !generationTemplate) return;
    const ownedThreadId = threadId ? Number(threadId) : null;
    if (ownedThreadId) {
      const thread = await getChatThreadById(ownedThreadId);
      if (!thread || thread.userId !== Number(userId)) return res.status(404).json({ error: 'Chat thread not found' });
    }

    const businessContext = formatContentBrandContext(resolvedBrandContext);

    // Fetch ICP if provided
    let icpContext = '';
    if (icpId) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const icp = icpResult.rows[0] as any;
        icpContext = `Target Audience: ${icp.target_audience || ''}\nIndustry: ${icp.industry || ''}\nPain Points: ${icp.pain_points || ''}`;
      }
    }

    // Fetch Knowledge Base context using embedding-based semantic search
    let kbContext = '';
    if (userId) {
      const semanticResult = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'content_draft', channel: 'internal', audience: 'internal', redactedText: prompt, redactedHistory: [], entities: {}, risk: 'low' });
      if (semanticResult) {
        kbContext = `\nAdditional Context:\n${semanticResult}`;
      }
    }

    // Generate social message using AI
    const platformCharLimits: Record<string, number> = {
      linkedin: LINKEDIN_INMAIL_LIMIT, // InMail character limit
      twitter: TWITTER_DM_LIMIT, // DM limit
      facebook: FACEBOOK_MESSENGER_LIMIT, // Messenger limit
      instagram: INSTAGRAM_DM_LIMIT, // DM limit
      whatsapp: 4096,
    };

    // Sanitize user input to prevent prompt injection
    const sanitizedPrompt = sanitizePromptInput(prompt);
    const sanitizedPlatform = sanitizePromptInput(platform, 50);

    const isMultiPlatform = platform === 'all' || !platform;
    const resolvedPlatformLabel = isMultiPlatform ? 'multi-platform' : sanitizedPlatform;
    const charLimitText = isMultiPlatform
      ? 'Under 300 characters to ensure compatibility across Instagram DM, Facebook Messenger, Twitter DM, and LinkedIn InMail.'
      : `${platformCharLimits[platform] || INSTAGRAM_DM_LIMIT}`;

    const messagePrompt = `Generate a personalized ${resolvedPlatformLabel} direct message (DM) based on:
${sanitizedPrompt}

${businessContext ? `\nYour Business Information:\n${businessContext}` : ''}
${formatGenerationTemplate(generationTemplate)}
${icpContext ? `\nTarget Audience:\n${icpContext}` : ''}
${kbContext}

Character limit: ${charLimitText}

IMPORTANT: 
- Use the business information provided above accurately - do NOT make up or assume company names or details
- If business information is not provided, write in a general way without mentioning specific company names
- Use any relevant company/product info from above to make the message more specific and valuable
- Include personalization template variables where appropriate:
  - {{first_name}} - Recipient's first name
  - {{last_name}} - Recipient's last name
  - {{full_name}} - Recipient's full name
  - {{company_name}} - Recipient's company
  - {{job_title}} - Recipient's job title
  - {{company_industry}} - Recipient's industry
- NEVER use bracket placeholders like [Link], [Insert Link], [Website URL], [Contact Information]
- NEVER use non-standard variables like {{firstname}}, {{company}}, {{role}}, {{jobtitle}})

Return a JSON object with:
- subject: Subject line (optional)
- message: The personalized DM message with template variables
- platform: "${resolvedPlatformLabel}"
- imagePrompt: (optional) A detailed prompt for generating an accompanying image that could be attached to the DM. Describe style, composition, and what makes it engaging.
- videoPrompt: (optional) A detailed prompt for a short video (15-30 sec) that could accompany this message. Describe scenes, tone, and call-to-action.`;

    const dmSystemPrompt = isMultiPlatform
      ? 'You are an expert at writing personalized direct messages for sales and marketing outreach across all major platforms (Instagram, Facebook, Twitter/X, LinkedIn). Create concise, personal messages that feel natural on any platform, are not spammy, and encourage a response. Use template variables for personalization. IMPORTANT: Only use the business/company information provided - never make up company names or details.'
      : `You are an expert at writing personalized ${sanitizedPlatform} direct messages for sales and marketing outreach. Create messages that feel personal, are not spammy, and encourage a response. Use template variables for personalization. Also suggest visual content prompts when appropriate. IMPORTANT: Only use the business/company information provided - never make up company names or details.`;

    const response = await createContentTextCompletion(userId, {
      messages: [
        { role: 'system', content: dmSystemPrompt },
        { role: 'user', content: messagePrompt },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId,
        purpose: 'content_generation',
        service: 'ContentStudioController',
        action: 'generate_social_message',
      },
    });

    let messageContent: z.infer<typeof generatedSocialMessageSchema>;
    try {
      messageContent = generatedSocialMessageSchema.parse(extractJsonContent(response.content || '{}'));
    } catch (parseError) {
      logger.error({ err: parseError }, '[ContentStudioController] Social-message provider response failed validation');
      return res.status(502).json({ error: 'The AI provider returned an invalid direct message. Please generate it again.' });
    }

    const messageCharacterLimit = isMultiPlatform ? 300 : (platformCharLimits[platform] || INSTAGRAM_DM_LIMIT);
    if (messageContent.message.length > messageCharacterLimit) {
      const originalLength = messageContent.message.length;
      const suffix = '…';
      const fittedWords: string[] = [];
      for (const word of messageContent.message.trim().split(/\s+/)) {
        const candidate = [...fittedWords, word].join(' ');
        if (candidate.length + suffix.length > messageCharacterLimit) break;
        fittedWords.push(word);
      }
      messageContent = {
        ...messageContent,
        message: `${fittedWords.join(' ')}${suffix}`,
      };
      logger.warn({ platform, originalLength, limit: messageCharacterLimit }, '[ContentStudioController] Social-message provider exceeded platform limit; fitted response');
    }
    if (!validateGeneratedOrRespond(res, {
      type: 'social_message',
      output: messageContent,
      context: resolvedBrandContext,
      platform: isMultiPlatform ? 'instagram' : platform,
    })) return;

    if (persist === false) {
      return res.json({
        success: true,
        content: messageContent.message,
        message: messageContent.message,
        subject: messageContent.subject,
        imagePrompt: messageContent.imagePrompt,
        videoPrompt: messageContent.videoPrompt,
        platform,
        brandContext: resolvedBrandContext.provenance,
      });
    }

    // Save to content_assets table
    const { ContentAssetModel } = await import('../models/contentAssets/functions');
    const savedAsset = await ContentAssetModel.create({
      type: 'social_dm',
      title: messageContent.subject || `${platform} DM`,
      content: JSON.stringify(messageContent),
      channel: platform,
      status: 'draft',
      userId: userId || null,
      performance: null,
      threadId: ownedThreadId,
      ...generationPolicyPersistence(resolvedBrandContext, 'social_message', platform, generationTemplate),
    });

    const mediaQueue = await enqueueGeneratedAssetMedia({
      userId: Number(userId),
      parentAssetId: savedAsset.id,
      assetType: 'social_dm',
      threadId: savedAsset.threadId,
      imagePrompt: undefined, // DM copy generation must not start unrequested paid media jobs.
      videoPrompt: undefined,
      brandContext: formatContentBrandContext(resolvedBrandContext),
      brandLogoUrl: approvedLogoUrl(resolvedBrandContext),
    });

    res.json({
      success: true,
      content: messageContent.message,
      message: messageContent.message,
      subject: messageContent.subject,
      imagePrompt: messageContent.imagePrompt,
      videoPrompt: messageContent.videoPrompt,
      platform,
      assetId: savedAsset.id,
      mediaGeneration: mediaQueue,
      brandContext: resolvedBrandContext.provenance,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToContentTextGenerationError(res, error, logger, 'ContentStudioController')) return;
    logger.error({ err: error }, '[ContentStudioController] Error generating social message');
    res.status(500).json({ success: false, code: 'CONTENT_GENERATION_FAILED', error: 'Unable to generate the social message. Please try again.' });
  }
}

/**
 * POST /api/content/studio/ad-copy-content
 * Generate ad copy content (different from generate-ad-copy which is for full campaigns)
 */
export async function generateAdCopyContent(req: Request, res: Response) {
  try {
    const { prompt, icpId, platform = 'facebook', persist = true } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const generationTemplate = await resolveGenerationTemplate(
      res,
      Number(userId),
      req.body.templateId,
      resolvedBrandContext,
      ['ad', 'ad_copy'],
    );
    if (req.body.templateId && !generationTemplate) return;
    const ownedThreadId = await resolveGenerationThread(res, Number(userId), req.body.threadId);
    if (ownedThreadId === undefined) return;

    const businessWebsite = resolvedBrandContext.businessProfile.website
      || resolvedBrandContext.brandToolkit.website
      || '';
    const businessContext = formatContentBrandContext(resolvedBrandContext);
    if (!businessWebsite && !resolvedBrandContext.brandToolkit.website) {
      return res.status(409).json({
        error: 'Add an approved website to the business profile or Brand Toolkit before generating ads.',
      });
    }
    const landingPageUrl = req.body.landingPageUrl || businessWebsite;
    try {
      const approved = new URL(/^https?:\/\//i.test(businessWebsite) ? businessWebsite : `https://${businessWebsite}`);
      const destination = new URL(/^https?:\/\//i.test(landingPageUrl) ? landingPageUrl : `https://${landingPageUrl}`);
      if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hostname.replace(/^www\./, '') !== approved.hostname.replace(/^www\./, '')) {
        return res.status(400).json({ error: 'Use an HTTPS landing page on your approved business website.' });
      }
    } catch { return res.status(400).json({ error: 'Enter a valid landing page URL.' }); }

    // Fetch ICP if provided
    let icpContext = '';
    if (icpId) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const icp = icpResult.rows[0] as any;
        icpContext = `Target Audience: ${icp.target_audience || ''}\nPain Points: ${icp.pain_points || ''}`;
      }
    }

    // Fetch Knowledge Base context using embedding-based semantic search
    let kbContext = '';
    if (userId) {
      const semanticResult = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'content_draft', channel: 'internal', audience: 'internal', redactedText: prompt, redactedHistory: [], entities: {}, risk: 'low' });
      if (semanticResult) {
        kbContext = `\nProduct/Service Info from Knowledge Base:\n${semanticResult}`;
      }
    }

    // Generate ad copy using AI with platform-specific formats
    // Platform-specific ad format requirements
    const platformFormats: Record<string, { headline: number; description: number; primaryText: number; formats: string }> = {
      all: {
        headline: 30,
        description: 30,
        primaryText: 125,
        formats: `Cross-platform ads require:
- A headline up to 30 characters
- Primary text up to 125 characters
- A description up to 90 characters
- Neutral formatting that works across Meta, Google, LinkedIn, and Twitter/X`,
      },
      meta: {
        headline: 40,
        description: 30,
        primaryText: 125,
        formats: `Meta (Facebook/Instagram) Ads require:
- Primary Text (up to 125 characters for optimal display, ${META_AD_PRIMARY_TEXT_MAX} max)
- Headline (up to 40 characters)
- Description (up to 30 characters for link ads)
- Call to Action button text`
      },
      facebook: {
        headline: 40,
        description: 30,
        primaryText: 125,
        formats: `Facebook Ads require:
- Primary Text (up to 125 characters for optimal display)
- Headline (up to 40 characters)
- Description (up to 30 characters)
- Call to Action button text`
      },
      linkedin: {
        headline: 70,
        description: 150,
        primaryText: 600,
        formats: `LinkedIn Ads require:
- Headline (up to 70 characters for sponsored content)
- Description/Intro text (up to 150 characters for text ads, 600 for sponsored content)
- Professional tone suitable for B2B audience
- Clear value proposition`
      },
      instagram: {
        headline: 40,
        description: 30,
        primaryText: META_AD_PRIMARY_TEXT_MAX,
        formats: `Instagram Ads require:
- Primary Text (up to ${META_AD_PRIMARY_TEXT_MAX} characters, but first 125 are shown)
- Call to Action button
- Hashtags for discovery
- Visual-first content suggestions`
      },
      google: {
        headline: 30,
        description: 90,
        primaryText: 90,
        formats: `Google responsive display ads require:
- Headlines up to 30 characters
- Descriptions up to 90 characters
- Multiple concise variants without unsupported claims
- A landing-page-aligned call to action`
      },
      twitter: {
        headline: 70,
        description: 200,
        primaryText: TWITTER_CHAR_LIMIT,
        formats: `Twitter/X ads require:
- Primary text up to ${TWITTER_CHAR_LIMIT} characters
- A concise headline and clear call to action
- Direct, conversational copy without unsupported claims`
      }
    };

    const platformFormat = platformFormats[platform.toLowerCase()] || platformFormats.meta;

    // Sanitize user input to prevent prompt injection
    const sanitizedPrompt = sanitizePromptInput(prompt);
    const sanitizedPlatform = sanitizePromptInput(platform, 50);

    const adPrompt = `Generate ${sanitizedPlatform.toUpperCase()} ad copy based on:
${sanitizedPrompt}

${businessContext ? `\nBusiness Context:\n${businessContext}` : ''}
${formatGenerationTemplate(generationTemplate)}
${icpContext ? `\nTarget Audience Context:\n${icpContext}` : ''}
${kbContext}

IMPORTANT: Follow ${platform.toUpperCase()} ad format requirements:
${platformFormat.formats}

Use any relevant product/service information from the Knowledge Base to make the ad copy more accurate and compelling.

Return a JSON object with:
- headline: Attention-grabbing headline (max ${platformFormat.headline} characters)
- headlines: Three distinct headline alternatives, each at most ${platformFormat.headline} characters; keep the primary headline in the headline field too
- descriptions: Two description alternatives, each at most ${platformFormat.description} characters
- primaryText: Main ad copy (max ${platformFormat.primaryText} characters)
- description: Additional description (max ${platformFormat.description} characters)
- callToAction: CTA button text (e.g., "Learn More", "Shop Now", "Sign Up")
- displayUrl: "${landingPageUrl}"
- keywords: Array of target keywords
- imagePrompt: (REQUIRED) A detailed prompt to generate a compelling ad creative image. Always include this. Describe the style, composition, colors, mood, and any text overlays. Make it specific and visually appealing for the target audience.
- videoPrompt: A detailed prompt for a 15-30 second video ad. Describe scenes, transitions, text overlays, and tone. Include this if video content would enhance the ad's effectiveness.
- platform: "${platform}"
${platform === 'google' ? '- headlines: Array of up to 3 alternative headlines (30 chars each)\n- descriptions: Array of 2 descriptions (90 chars each)' : ''}
${platform === 'linkedin' ? '- professionalTone: true (ensure B2B professional language)' : ''}
${platform === 'instagram' ? '- hashtags: Array of relevant hashtags\n- visualFocus: Description of visual style recommended' : ''}`;

    let adContent: z.infer<typeof generatedAdSchema> | undefined;
    let adViolations: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = adViolations.length
        ? `\n\nYour previous response was rejected. Regenerate the complete JSON object and correct every issue:\n- ${adViolations.join('\n- ')}\nUse the exact approved display URL and do not explain the corrections.`
        : '';
      const response = await createContentTextCompletion(userId, {
        messages: [
          { role: 'system', content: `You are an expert ${platform} advertising copywriter. Generate high-converting, policy-safe ad copy that drives clicks and conversions.` },
          { role: 'user', content: `${adPrompt}${correction}` },
        ],
        temperature: attempt === 0 ? 0.7 : 0.35,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'content_generation',
          service: 'ContentStudioController',
          action: attempt === 0 ? 'generate_ad_copy' : 'repair_ad_copy',
        },
      });

      try {
        adContent = generatedAdSchema.parse(extractJsonContent(response.content || '{}'));
        adContent.displayUrl = landingPageUrl;
      } catch (parseError) {
        logger.warn({ err: parseError, attempt: attempt + 1 }, '[ContentStudioController] Ad provider response failed validation');
        adViolations = ['Return valid JSON with every required ad-copy field.'];
        continue;
      }
      adViolations = [];
      const lengthViolations = [
        ['Headline', adContent.headline.length, platformFormat.headline],
        ['Primary text', adContent.primaryText.length, platformFormat.primaryText],
        ['Description', adContent.description.length, platformFormat.description],
      ].filter(([, length, limit]) => Number(length) > Number(limit));
      adViolations.push(...lengthViolations.map(([field, length, limit]) => `${field} must be ${limit} characters or fewer; it was ${length}.`));
      for (const headline of adContent.headlines || []) {
        if (headline.length > platformFormat.headline) adViolations.push(`Each headline alternative must be ${platformFormat.headline} characters or fewer.`);
      }
      for (const description of adContent.descriptions || []) {
        if (description.length > platformFormat.description) adViolations.push(`Each description alternative must be ${platformFormat.description} characters or fewer.`);
      }
      adViolations.push(...generatedContentViolations({
        type: 'ad',
        output: adContent,
        context: resolvedBrandContext,
        platform,
      }));
      if (adViolations.length === 0) break;
    }
    if (!adContent || adViolations.length > 0) {
      return res.status(422).json({
        error: 'The AI provider could not produce compliant ad copy after an automatic correction attempt.',
        violations: adViolations,
      });
    }

    if (persist === false) {
      return res.json({
        success: true,
        content: adContent.primaryText,
        headline: adContent.headline,
        headlines: adContent.headlines,
        descriptions: adContent.descriptions,
        primaryText: adContent.primaryText,
        description: adContent.description,
        callToAction: adContent.callToAction,
        displayUrl: adContent.displayUrl,
        keywords: adContent.keywords,
        imagePrompt: adContent.imagePrompt,
        videoPrompt: adContent.videoPrompt,
        platform,
        brandContext: resolvedBrandContext.provenance,
        message: 'Ad copy generated successfully',
      });
    }

    // Save to content_assets table
    const { ContentAssetModel } = await import('../models/contentAssets/functions');
    const savedAsset = await ContentAssetModel.create({
      type: 'ad_copy',
      title: adContent.headline || 'Ad Copy',
      content: JSON.stringify(adContent),
      channel: platform,
      status: 'draft',
      userId: userId || null,
      performance: null,
      threadId: ownedThreadId,
      ...generationPolicyPersistence(resolvedBrandContext, 'ad', platform, generationTemplate),
    });

    const mediaQueue = await enqueueGeneratedAssetMedia({
      userId: Number(userId),
      parentAssetId: savedAsset.id,
      assetType: 'ad_copy',
      threadId: savedAsset.threadId,
      imagePrompt: req.body.mediaGeneration?.image === true ? adContent.imagePrompt : undefined,
      videoPrompt: req.body.mediaGeneration?.video === true ? adContent.videoPrompt : undefined,
      brandContext: formatContentBrandContext(resolvedBrandContext),
      imageBrand: resolvedBrandContext,
      brandLogoUrl: approvedLogoUrl(resolvedBrandContext),
    });

    res.json({
      success: true,
      content: adContent.primaryText,
      headline: adContent.headline,
      headlines: adContent.headlines,
      descriptions: adContent.descriptions,
      primaryText: adContent.primaryText,
      description: adContent.description,
      callToAction: adContent.callToAction,
      displayUrl: adContent.displayUrl,
      keywords: adContent.keywords,
      imagePrompt: adContent.imagePrompt,
      videoPrompt: adContent.videoPrompt,
      platform,
      assetId: savedAsset.id,
      mediaGeneration: mediaQueue,
      brandContext: resolvedBrandContext.provenance,
      message: 'Ad copy generated successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToContentTextGenerationError(res, error, logger, 'ContentStudioController')) return;
    logger.error({ err: error }, '[ContentStudioController] Error generating ad copy');
    res.status(500).json({ success: false, code: 'CONTENT_GENERATION_FAILED', error: 'Unable to generate ad copy. Please try again.' });
  }
}

/**
 * POST /api/content/studio/enhance-prompt
 * Silently enhance a prompt before content generation (called automatically before generate)
 */
export async function enhancePrompt(req: Request, res: Response) {
  try {
    const { prompt, contentType, icpId, platform, tone } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!prompt) {
      return res.json({ success: true, enhancedPrompt: '' });
    }
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const isMediaPrompt = contentType === 'image' || contentType === 'video';
    const businessContext = isMediaPrompt
      ? formatMediaBrandContext(resolvedBrandContext)
      : formatContentBrandContext(resolvedBrandContext);

    // Fetch ICP if provided
    let icpContext = '';
    if (icpId) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const icp = icpResult.rows[0] as any;
        icpContext = `Target: ${icp.target_audience || 'business professionals'}, Industry: ${icp.industry || ''}, Pain points: ${icp.pain_points || ''}`;
      }
    }

    // Quick enhancement using AI
    const contentGuidelines: Record<string, string> = {
      image: 'visual, detailed scene description, style, lighting, composition',
      video: 'scene description, motion, duration, mood, call-to-action',
      email: 'subject line hook, value proposition, clear CTA, professional tone',
      sms: `concise under ${SMS_CHAR_LIMIT} chars, urgency, clear action, compliance`,
      social: 'hook, engagement, hashtags, platform-specific format',
      ad_copy: 'headline, benefit-focused copy, compelling CTA, urgency',
    };

    // Sanitize user inputs to prevent prompt injection
    const sanitizedContentType = sanitizePromptInput(contentType, 50);
    const sanitizedPlatform = sanitizePromptInput(platform || '', 50);
    const sanitizedTone = sanitizePromptInput(tone || '', 50);
    const sanitizedPrompt = sanitizePromptInput(prompt);

    const enhanceSystemPrompt = `You are a prompt enhancement assistant. Take the user's content request and enhance it to be more specific and effective for ${sanitizedContentType} generation.

Enhancement guidelines for ${sanitizedContentType}: ${contentGuidelines[contentType] || 'clear, specific, actionable'}
${sanitizedPlatform ? `Platform: ${sanitizedPlatform}` : ''}
${sanitizedTone ? `Tone: ${sanitizedTone}` : ''}
${businessContext ? `\n${businessContext}` : ''}
${icpContext ? `\n${icpContext}` : ''}

Return ONLY the enhanced prompt text, no explanation. Keep it concise but more detailed than the original. Incorporate the business, target audience, and brand voice naturally into the prompt.`;
    const mediaLogoRule = isMediaPrompt
      ? '\nThe approved logo is added later by the application. Do not ask the generation model to draw any logo, wordmark, watermark, brand-name text, or placeholder.'
      : '';

    const response = await createContentTextCompletion(userId, {
      messages: [
        { role: 'system', content: `${enhanceSystemPrompt}${mediaLogoRule}` },
        { role: 'user', content: sanitizedPrompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
      loggingContext: {
        userId,
        purpose: 'content_generation',
        service: 'ContentStudioController',
        action: 'enhance_prompt',
      },
    });

    const enhancedPrompt = response.content?.trim() || prompt;

    res.json({
      success: true,
      enhancedPrompt,
      originalPrompt: prompt,
      brandContext: resolvedBrandContext.provenance,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error enhancing prompt');
    // On error, return original prompt so generation can continue
    res.json({ success: true, enhancedPrompt: req.body.prompt || '' });
  }
}

/**
 * POST /api/content/studio/magic-prompt
 * Generate an AI-enhanced prompt based on chat context and ICP
 */
export async function generateMagicPrompt(req: Request, res: Response) {
  try {
    const { currentPrompt, contentType, chatContext, icpId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const isMediaPrompt = contentType === 'image' || contentType === 'video';
    const isImagePrompt = contentType === 'image';
    // Image prompts get visual-only brand facts: no tagline, value proposition
    // or description the enhancer could turn into on-image claims.
    const businessContext = isImagePrompt
      ? formatImageBrandContext(resolvedBrandContext)
      : isMediaPrompt
        ? formatMediaBrandContext(resolvedBrandContext)
        : formatContentBrandContext(resolvedBrandContext);

    // Fetch ICP if provided
    let icpContext = '';
    if (icpId) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const icp = icpResult.rows[0] as any;
        icpContext = `
Target Audience: ${icp.target_audience || 'General business audience'}
Industry: ${icp.industry || 'Technology'}
Pain Points: ${icp.pain_points || 'Growth, efficiency, ROI'}
Goals: ${icp.goals || 'Increase revenue, reduce costs'}`;
      }
    }

    // Generate enhanced prompt using AI
    const contentTypePrompts: Record<string, string> = {
      image: 'Generate a detailed image generation prompt that will create a professional marketing visual',
      video: 'Generate a detailed video generation prompt that will create an engaging marketing video',
      email: 'Generate a detailed email writing prompt that will create a compelling marketing email',
      sms: 'Generate a detailed SMS writing prompt that will create a concise marketing message',
      social: 'Generate a detailed social media post prompt that will create an engaging post',
      ad_copy: 'Generate a detailed ad copywriting prompt that will create high-converting ad content',
    };

    // Sanitize user inputs to prevent prompt injection
    const sanitizedCurrentPrompt = sanitizePromptInput(currentPrompt || '', 2000);
    const sanitizedChatContext = sanitizePromptInput(chatContext || '', 2000);
    const sanitizedContentType = sanitizePromptInput(contentType || 'social', 50);

    const magicPrompt = `You are a marketing content strategist. ${contentTypePrompts[sanitizedContentType] || 'Generate an enhanced content creation prompt'}.

User's current prompt idea: "${sanitizedCurrentPrompt || 'No specific idea yet'}"

${sanitizedChatContext ? `Recent chat context: ${sanitizedChatContext}` : ''}
${businessContext ? `\nBusiness Information: ${businessContext}` : ''}
${icpContext ? `\nTarget Customer Profile: ${icpContext}` : ''}

${isImagePrompt ? `Generate an enhanced, detailed image prompt that:
1. Keeps every explicit requirement from the user's idea unchanged: aspect ratio, colors, background, art style, composition, and any quoted headline or text, copied word for word
2. Adds only visual detail (lighting, materials, camera, layout) that fits those requirements
3. Uses the brand information only for visual guidance where the user left a choice open
4. Adds no on-image text beyond what the user quoted, and no taglines, slogans, product claims, features, statistics, prices or calls to action
5. Does not invent facts about the business or its product
6. If the user asked for no text, says the image must contain no text` : `Generate an enhanced, detailed prompt that:
1. Incorporates the user's idea (if provided)
2. Reflects the business's products/services and value proposition
3. Targets the specific audience from the ICP
4. Aligns with the brand voice and values
5. Is specific and actionable for ${sanitizedContentType} creation
${isMediaPrompt ? '6. Directs the media model to analyze the attached approved logo before generation, use its real visual identity with the business profile and Brand Toolkit, and integrate it naturally without inventing or distorting the mark' : ''}`}

Return a JSON object with:
- enhancedPrompt: The improved, detailed prompt
- suggestions: Array of 2-3 alternative prompt ideas
- tips: A brief tip for better results`;

    const response = await createContentTextCompletion(userId, {
      messages: [
        { role: 'system', content: 'You are an expert prompt engineer for marketing content. Generate highly specific, effective prompts.' },
        { role: 'user', content: magicPrompt },
      ],
      temperature: isImagePrompt ? 0.4 : 0.8,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId,
        purpose: 'content_generation',
        service: 'ContentStudioController',
        action: 'generate_magic_prompt',
      },
    });

    const result = magicPromptResultSchema.parse(extractJsonContent(response.content || '{}'));

    res.json({
      success: true,
      enhanced: true,
      enhancedPrompt: result.enhancedPrompt,
      suggestions: result.suggestions || [],
      tips: result.tips || '',
      brandContext: resolvedBrandContext.provenance,
      message: 'Magic prompt generated successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error generating magic prompt');
    // Return original prompt so generation can continue (matches enhancePrompt behavior)
    res.json({
      success: true,
      enhanced: false,
      enhancedPrompt: req.body?.currentPrompt || '',
      suggestions: [],
      tips: '',
      message: 'Using original prompt (enhancement unavailable)',
    });
  }
}

// In-memory job tracking for async content generation
// In production, use Redis or a database for persistence
const generationJobs = new Map<string, {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}>();

// Cleanup old jobs after 1 hour
const _generationJobsCleanupTimer = setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [jobId, job] of generationJobs.entries()) {
    if (job.createdAt.getTime() < oneHourAgo) {
      generationJobs.delete(jobId);
    }
  }
}, 15 * 60 * 1000); // Run every 15 minutes
// Prevent timer from keeping process alive
if (typeof _generationJobsCleanupTimer === 'object' && 'unref' in _generationJobsCleanupTimer) {
  _generationJobsCleanupTimer.unref();
}

/**
 * GET /api/content/studio/generation-status/:jobId
 * Check the status of an async content generation job
 */
export async function getGenerationStatus(req: Request, res: Response) {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }

    const job = generationJobs.get(businessCacheKey(jobId));

    if (!job) {
      // Job not found - might have been completed synchronously or expired
      return res.status(404).json({ 
        error: 'Job not found',
        message: 'The generation job may have completed or expired. Check your content assets for completed generations.'
      });
    }

    res.json({
      jobId,
      status: job.status,
      progress: job.progress,
      result: job.status === 'completed' ? job.result : undefined,
      error: job.status === 'failed' ? job.error : undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentStudioController] Error getting generation status');
    res.status(500).json({ error: 'Unable to retrieve generation status. Please try again.' });
  }
}

/**
 * Helper function to create a job for async generation
 */
export function createGenerationJob(jobId: string): void {
  generationJobs.set(businessCacheKey(jobId), {
    status: 'pending',
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Helper function to update job status
 */
export function updateGenerationJob(
  jobId: string, 
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updates: Partial<{ status: 'pending' | 'processing' | 'completed' | 'failed'; progress: number; result: any; error: string }>
): void {
  const job = generationJobs.get(businessCacheKey(jobId));
  if (job) {
    Object.assign(job, updates, { updatedAt: new Date() });
  }
}

/**
 * POST /api/content/generate-email-template
 * Generate a full HTML email template from a natural language prompt
 */
export async function generateEmailHtmlTemplate(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const generationTemplate = await resolveGenerationTemplate(
      res,
      Number(userId),
      req.body.templateId,
      resolvedBrandContext,
      ['email', 'email_template'],
    );
    if (req.body.templateId && !generationTemplate) return;

    const sanitizedPrompt = sanitizePromptInput(prompt);

    const systemPrompt = `You are an expert email template designer. Generate a complete, production-ready HTML email template based on the user's description. The HTML must:
- Use inline CSS styles (no <style> blocks)
- Be compatible with all major email clients (Gmail, Outlook, Apple Mail)
- Use table-based layout for maximum compatibility
- Have a max-width of 600px centered container
- Include responsive meta viewport tag
- Use web-safe fonts (Arial, Helvetica, sans-serif)
- Support template variables: {{first_name}}, {{last_name}}, {{company_name}}
- Place {{first_name}} in the greeting only; never place recipient personalization below the sender signature or in the footer
Return ONLY the complete HTML document starting with <!DOCTYPE html>. No explanation or markdown.`;

    const response = await createContentTextCompletion(userId, {
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${sanitizedPrompt}

${formatGenerationTemplate(generationTemplate)}

${formatContentBrandContext(resolvedBrandContext)}`,
        },
      ],
      temperature: 0.7,
      loggingContext: {
        userId,
        purpose: 'content_generation',
        service: 'ContentStudioController',
        action: 'generate_email_html_template',
      },
    });

    if (!response.success) {
      return res.status(500).json({ error: response.error || 'Unable to generate the email template. Please try again.' });
    }

    const html = sanitizeEmailHtml((response.content || '').trim());
    if (!html.toLowerCase().includes('<!doctype') && !html.toLowerCase().includes('<html')) {
      return res.status(500).json({ error: 'Failed to generate a valid HTML template. Please try again.' });
    }

    // Extract subject from the HTML title tag if present
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const subject = titleMatch?.[1] || '';

    res.json({
      content: html,
      subject,
      brandContext: resolvedBrandContext.provenance,
      validation: { sanitized: true, validator: 'sanitizeEmailHtml' },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToContentTextGenerationError(res, error, logger, 'ContentStudioController')) return;
    logger.error({ err: error }, '[ContentStudioController] Error generating email HTML template');
    res.status(500).json({ success: false, code: 'CONTENT_GENERATION_FAILED', error: 'Unable to generate the email template. Please try again.' });
  }
}

/**
 * POST /api/content/studio/blog-post
 * Generate a blog post from a natural language prompt
 */
export async function generateBlogPost(req: Request, res: Response) {
  try {
    const { prompt, icpId, tone = 'professional', wordCount = '1000', persist = true } = req.body;
    const editorial = req.body.editorial || {};
    const outlineOnly = req.body.stage === 'outline';
    if (!outlineOnly && editorial.outline && editorial.outlineApproved !== true) {
      return res.status(400).json({ error: 'Review and approve the outline before generating the article.' });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const resolvedBrandContext = await resolveRequestBrandContext(res, Number(userId), req.body);
    if (!resolvedBrandContext) return;
    const generationTemplate = await resolveGenerationTemplate(
      res,
      Number(userId),
      req.body.templateId,
      resolvedBrandContext,
      ['blog', 'blog_post'],
    );
    if (req.body.templateId && !generationTemplate) return;
    if (editorial.internalLinks?.length) {
      const website = resolvedBrandContext.businessProfile.website || resolvedBrandContext.brandToolkit.website;
      if (!website) return res.status(400).json({ error: 'Add your approved website before supplying internal links.' });
      try {
        const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '');
        if (editorial.internalLinks.some((link: string) => {
          const candidate = new URL(link).hostname.replace(/^www\./, '');
          return candidate !== host && !candidate.endsWith(`.${host}`);
        })) return res.status(400).json({ error: 'Internal links must use your approved website domain. Put external references under Source URLs.' });
      } catch { return res.status(400).json({ error: 'Check the approved website and internal-link URLs.' }); }
    }
    const ownedThreadId = await resolveGenerationThread(res, Number(userId), req.body.threadId);
    if (ownedThreadId === undefined) return;

    // Fetch ICP if provided
    let icpContext = '';
    if (icpId) {
      const icpResult = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpResult.rows.length === 0) return res.status(404).json({ error: 'ICP profile not found' });
      if (icpResult.rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const icp = icpResult.rows[0] as any;
        icpContext = `Target Audience: ${icp.target_audience || ''}\nIndustry: ${icp.industry || ''}\nPain Points: ${icp.pain_points || ''}`;
      }
    }

    const brandContext = formatContentBrandContext(resolvedBrandContext);

    // Fetch Knowledge Base context
    let kbContext = '';
    if (userId) {
      const semanticResult = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'content_draft', channel: 'internal', audience: 'internal', redactedText: prompt, redactedHistory: [], entities: {}, risk: 'low' });
      if (semanticResult) {
        kbContext = `\nKnowledge Base Context:\n${semanticResult}`;
      }
    }

    const sanitizedPrompt = sanitizePromptInput(prompt);
    const sanitizedTone = sanitizePromptInput(tone, 50);

    const blogPrompt = `You are a professional blog writer and SEO specialist. Write a blog post based on this request:

"${sanitizedPrompt}"

Tone: ${sanitizedTone}
Target Length: approximately ${wordCount} words
Editorial brief: ${JSON.stringify(editorial)}
${outlineOnly ? 'OUTLINE STAGE: Return only a proposed outline in the content field: heading hierarchy, brief section notes, and evidence needed. Do not write the article yet.' : 'ARTICLE STAGE: Follow the approved outline when supplied. Respect the supplied SEO title, focus keyword, and internal links.'}
Source URLs are reference candidates supplied by the user, NOT retrieved evidence. Do not invent statistics, quotes or claim to have read them. Cite a source only for evidence present in the provided prompt or knowledge context; flag unsupported claims for human review.
${icpContext ? `\n${icpContext}` : ''}
${brandContext ? `\n${brandContext}` : ''}
${formatGenerationTemplate(generationTemplate)}
${kbContext}

IMPORTANT RULES:
- ${outlineOnly ? 'Write an outline, not a complete article' : 'Write a complete, well-structured blog post'} with proper headings (H1, H2, H3)
- Include an engaging introduction that hooks the reader
- Use bullet points or numbered lists where appropriate
- End with a compelling conclusion and call-to-action
- Do NOT repeat or include the original request in the output
- Use information from the Knowledge Base context to make the blog post more accurate and relevant

Return a valid JSON object with these exact fields:
{
  "title": "Compelling blog post title",
  "content": "Full blog post content in markdown format with proper headings, paragraphs, and formatting",
  "excerpt": "A 2-3 sentence summary/excerpt of the blog post",
  "tags": ["tag1", "tag2", "tag3"],
  "featuredImagePrompt": "Optional prompt for generating a featured image for this blog post"
}`;

    const response = await createContentTextCompletion(userId, {
      messages: [
        { role: 'system', content: 'You are a professional content writer and SEO specialist. Write engaging, well-structured blog posts that provide value to readers. Ensure the content aligns with brand guidelines when provided.' },
        { role: 'user', content: blogPrompt },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId,
        purpose: 'content_generation',
        service: 'ContentStudioController',
        action: 'generate_blog_post',
      },
    });

    let blogPost: z.infer<typeof generatedBlogSchema>;
    try {
      blogPost = generatedBlogSchema.parse(extractJsonContent(response.content || '{}'));
    } catch (parseError) {
      logger.error({ err: parseError }, '[ContentStudioController] Blog provider response failed validation');
      return res.status(502).json({ error: 'The AI provider returned an invalid blog post. Please generate it again.' });
    }
    if (!validateGeneratedOrRespond(res, {
      type: 'blog',
      output: blogPost,
      context: resolvedBrandContext,
      platform: 'blog',
    })) return;

    if (outlineOnly) {
      return res.json({ success: true, stage: 'outline', title: blogPost.title, outline: blogPost.content, persisted: false });
    }
    blogPost.editorial = editorial;

    if (persist === false) {
      return res.json({
        success: true,
        title: blogPost.title,
        content: blogPost.content,
        excerpt: blogPost.excerpt,
        tags: blogPost.tags,
        featuredImagePrompt: blogPost.featuredImagePrompt,
        editorial,
        brandContext: resolvedBrandContext.provenance,
      });
    }

    // Save to content_assets
    const asset = await ContentAssetModel.create({
        type: 'blog_post',
        title: blogPost.title || 'Generated Blog Post',
        content: JSON.stringify(blogPost),
        channel: 'content_studio',
        status: 'draft',
        userId: userId,
        threadId: ownedThreadId,
        performance: { prompt: sanitizedPrompt, tone: sanitizedTone, wordCount },
        ...generationPolicyPersistence(resolvedBrandContext, 'blog', 'blog', generationTemplate),
    });

    res.json({
      success: true,
      title: blogPost.title,
      content: blogPost.content,
      excerpt: blogPost.excerpt,
      tags: blogPost.tags,
      featuredImagePrompt: blogPost.featuredImagePrompt,
      editorial,
      assetId: asset.id,
      brandContext: resolvedBrandContext.provenance,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToContentTextGenerationError(res, error, logger, 'ContentStudioController')) return;
    logger.error({ err: error }, '[ContentStudioController] Error generating blog post');
    res.status(500).json({ success: false, code: 'CONTENT_GENERATION_FAILED', error: 'Unable to generate the blog post. Please try again.' });
  }
}
