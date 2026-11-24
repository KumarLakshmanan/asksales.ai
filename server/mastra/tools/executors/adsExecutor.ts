/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Ads Tool Executors
 * Handles ad generation and publishing
 */

import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state';
import { logger } from '../../../utils/logger.js';
import { TAB_TYPES, TAB_LABELS } from '../../tabConfig';
import {
  ContentComplianceError,
  validateGeneratedContent,
} from '../../../services/content/ContentComplianceService.js';
import { createCompletionWithProviderFallback } from '../../utils/providerCompletion.js';
import { CampaignPublishPreflightError, publishReviewRevision } from '../../../services/ads/CampaignPublishReview.js';
import { summarizeAdPublication } from '../../../../shared/adPublicationStatus.js';
import { defaultMetaProviderConfig, type MetaPlacement, type MetaProviderConfig } from '../../../services/ads/ProviderCampaignContract.js';
import { campaignCurrencyScale, type CampaignPublishReview } from '../../../../shared/adCampaignReview.js';
import { toNumber, selectedBrandLogoUrl } from './executorValues.js';
import { buildImageGenerationPrompt } from '../../../services/content/ImagePromptBuilder.js';

export interface AdPlatformCopyLimits {
  headline: number;
  description: number;
  primaryText: number;
}

export function getAdPlatformCopyLimits(
  platform: 'meta' | 'google' | 'linkedin'
): AdPlatformCopyLimits {
  if (platform === 'google') {
    return { headline: 30, description: 90, primaryText: 90 };
  }
  if (platform === 'linkedin') {
    return { headline: 70, description: 150, primaryText: 600 };
  }
  return { headline: 40, description: 30, primaryText: 2200 };
}

export function formatAdPlatformCopyConstraints(
  platform: 'meta' | 'google' | 'linkedin'
): string {
  const limits = getAdPlatformCopyLimits(platform);
  return [
    `${platform.toUpperCase()} HARD CHARACTER LIMITS (count every character):`,
    `- headline: ${limits.headline} characters maximum`,
    `- description: ${limits.description} characters maximum`,
    `- primaryText: ${limits.primaryText} characters maximum`,
    '- Never exceed these limits. Shorten the copy before returning JSON.',
  ].join('\n');
}

/** The reviewed media count bounds paid provider calls, independently of how
 * many image prompts a copy model happens to return. Providers emit one image
 * per request; style remains part of the actual image-generation prompt. */
export function reviewedAdImagePrompts(prompts: unknown[], count = 1, style?: string): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('Request between 1 and 4 images.');
  const usable = prompts.filter((prompt): prompt is string => typeof prompt === 'string' && Boolean(prompt.trim()));
  if (!usable.length) return [];
  return Array.from({ length: count }, (_, index) => `${usable[index % usable.length].trim()}${style ? `\nRequested visual style: ${style.replaceAll('-', ' ')}.` : ''}`);
}

function truncateAdCopy(value: unknown, maxLength: number): unknown {
  if (typeof value !== 'string' || value.length <= maxLength) return value;
  const candidate = value.slice(0, maxLength + 1);
  const boundary = candidate.lastIndexOf(' ');
  return (boundary >= Math.floor(maxLength * 0.6)
    ? candidate.slice(0, boundary)
    : value.slice(0, maxLength)).trimEnd();
}

export function enforceAdPlatformCopyLimits(
  ad: Record<string, any>,
  platform: 'meta' | 'google' | 'linkedin',
): Record<string, any> {
  const limits = getAdPlatformCopyLimits(platform);
  return {
    ...ad,
    headline: truncateAdCopy(ad.headline, limits.headline),
    description: truncateAdCopy(ad.description, limits.description),
    primaryText: truncateAdCopy(ad.primaryText, limits.primaryText),
  };
}

export function enforceReviewedAdConstraints(ad: Record<string, any>, input: {
  platform: 'meta' | 'google' | 'linkedin'; cta_text?: string;
  include_image_prompt?: boolean; include_video_prompt?: boolean;
  auto_generate_image?: boolean; auto_generate_video?: boolean;
}): Record<string, any> {
  const result = enforceAdPlatformCopyLimits(ad, input.platform);
  const exact = input.cta_text?.trim();
  if (exact) {
    const max = getAdPlatformCopyLimits(input.platform).primaryText;
    if (exact.length > max) throw new Error('The exact CTA exceeds this platform’s copy limit. Review a shorter CTA.');
    // The reviewed literal owns the last slot. Reserve its space rather than
    // truncating it after generation; remove repeated literal occurrences.
    const body = String(ad.primaryText || '').split(exact).join('').trim();
    const prefix = String(truncateAdCopy(body, Math.max(0, max - exact.length - 2))).trim();
    result.primaryText = prefix ? `${prefix}\n\n${exact}` : exact;
    for (const key of ['headline', 'description']) {
      if (typeof result[key] === 'string') result[key] = result[key].split(exact).join('').trim();
    }
  }
  if (!input.include_image_prompt && !input.auto_generate_image) {
    for (const key of ['imagePrompt', 'imagePrompts', 'image_prompt', 'image_prompts', 'featuredImagePrompt']) delete result[key];
  }
  if (!input.include_video_prompt && !input.auto_generate_video) {
    for (const key of ['videoPrompt', 'videoPrompts', 'video_prompt', 'video_prompts']) delete result[key];
  }
  return result;
}

function policyPersistence(context: ToolContext, contentType: string, platform: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snapshot = context.brandContextSnapshot as any;
  if (!snapshot?.provenance) return {};
  return {
    businessProfileId: snapshot.provenance.businessProfile.id,
    brandToolkitId: snapshot.provenance.brandToolkit.id,
    brandContextSnapshot: snapshot,
    validationSnapshot: {
      schemaVersion: 1,
      validatedAt: new Date().toISOString(),
      validator: 'ContentComplianceService',
      contentType,
      platform,
      passed: true,
    },
  };
}

interface GeneratedAdDefaults {
  headline: string;
  primaryText: string;
  description: string;
  callToAction: string;
  displayUrl: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function generatedAdCandidates(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];

  const directCopyKeys = [
    'headline', 'title', 'primaryText', 'primary_text', 'primaryCopy', 'primary_copy', 'adText',
    'description', 'description_text', 'body', 'callToAction', 'call_to_action',
  ];
  if (directCopyKeys.some(key => value[key] != null)) return [value];

  for (const key of ['ads', 'variations', 'creatives']) {
    if (Array.isArray(value[key])) {
      const candidates = value[key].flatMap(generatedAdCandidates);
      if (candidates.length > 0) return candidates;
    }
  }
  for (const key of ['ad', 'result', 'adCopy', 'ad_copy', 'creative', 'content', 'output', 'response']) {
    const candidates = generatedAdCandidates(value[key]);
    if (candidates.length > 0) return candidates;
  }
  for (const nested of Object.values(value)) {
    const candidates = generatedAdCandidates(nested);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

export function normalizeGeneratedAds(
  parsed: unknown,
  defaults: GeneratedAdDefaults,
): Record<string, any>[] {
  const candidates = generatedAdCandidates(parsed);
  const variations = candidates.length > 0 ? candidates : [{}];

  return variations.map((variation) => {
    const headline = firstString(
      variation.headline,
      variation.title,
      Array.isArray(variation.headlines) ? variation.headlines[0] : undefined,
      defaults.headline,
    )!;
    const primaryText = firstString(
      variation.primaryText,
      variation.primary_text,
      variation.primaryCopy,
      variation.primary_copy,
      variation.adText,
      variation.body,
      variation.copy,
      defaults.primaryText,
    )!;
    const description = firstString(
      variation.description,
      variation.description_text,
      Array.isArray(variation.descriptions) ? variation.descriptions[0] : undefined,
      variation.body,
      defaults.description,
      primaryText,
    )!;

    return {
      ...variation,
      headline,
      primaryText,
      description,
      callToAction: firstString(
        variation.callToAction,
        variation.call_to_action,
        variation.cta,
        defaults.callToAction,
      )!,
      displayUrl: firstString(
        variation.displayUrl,
        variation.display_url,
        variation.landingUrl,
        variation.landing_url,
        defaults.displayUrl,
      )!,
      keywords: Array.isArray(variation.keywords) ? variation.keywords : [],
      tags: Array.isArray(variation.tags) ? variation.tags : [],
      imagePrompts: variation.imagePrompts || variation.image_prompts,
      videoPrompts: variation.videoPrompts || variation.video_prompts,
      imagePrompt: variation.imagePrompt || variation.image_prompt,
      videoPrompt: variation.videoPrompt || variation.video_prompt,
    };
  });
}

export async function executeGenerateAd(
  input: {
    creative_brief_id?: number;
    creative_brief_revision?: number;
    creative_concept_id?: string;
    platform: 'meta' | 'google' | 'linkedin';
    objective?: 'awareness' | 'traffic' | 'engagement' | 'leads' | 'sales' | 'app_installs';
    headline?: string;
    description_text?: string;
    cta_text?: string;
    content_instructions?: string;
    tone?: 'professional' | 'casual' | 'urgent' | 'inspiring' | 'informative' | 'bold';
    language?: string;
    ad_format?: 'image' | 'carousel' | 'video' | 'text';
    cta_type?: string;
    target_audience?: string;
    landing_url?: string;
    budget_range?: string;
    number_of_variations?: number;
    include_image_prompt?: boolean;
    include_video_prompt?: boolean;
    auto_generate_image?: boolean;
    auto_generate_video?: boolean;
    image_provider?: 'google' | 'openrouter';
    image_model?: string;
    video_provider?: 'google' | 'openrouter';
    video_model?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_count?: number;
    image_style?: string;
    video_aspect_ratio?: string;
    video_resolution?: string;
    video_duration_seconds?: number;
    video_count?: number;
  },
  context: ToolContext
): Promise<ToolResult> {
  let creativeBriefProvenance: { creative_brief_id: number; creative_brief_revision: number; creative_concept_id: string } | undefined;
  if (input.creative_brief_id !== undefined || input.creative_brief_revision !== undefined || input.creative_concept_id !== undefined) {
    const { creativeIntelligenceService } = await import('../../../services/ads/creative-intelligence/CreativeIntelligenceService.js');
    await creativeIntelligenceService.generationInputs(Number(context.userId), input);
    creativeBriefProvenance = {
      creative_brief_id: input.creative_brief_id!, creative_brief_revision: input.creative_brief_revision!, creative_concept_id: input.creative_concept_id!,
    };
  }
  const inputPlatform = input.platform || 'meta';
  const inputGoal = input.objective || 'traffic';
  const inputPrimaryText = input.description_text || '';
  const inputTargetAudience = input.target_audience || '';
  const inputCtaType = input.cta_type || 'learn_more';
  const autoGenImage = input.auto_generate_image === true;
  const autoGenVideo = input.auto_generate_video === true;
  const platformCopyConstraints = formatAdPlatformCopyConstraints(inputPlatform);

  const userIdNum = toNumber(context.userId);
  const tone = input.tone || context.brandToolkit?.voiceType || 'professional';
  const language = input.language || 'English';
  const adFormat = input.ad_format || 'image';
  const ctaType = inputCtaType || 'learn_more';
  const numVariations = input.number_of_variations ?? 1;
  const imageCount = input.image_count ?? 1;
  if (autoGenImage && (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 4)) {
    return { success: false, toolName: 'generate_ad', error: 'Request between 1 and 4 images.' };
  }
  if (!Number.isInteger(numVariations) || numVariations < 1 || numVariations > 5) {
    return { success: false, toolName: 'generate_ad', error: 'Request between 1 and 5 ad-copy variations.' };
  }
  
  try {
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');

    // Fetch company website URL
    let websiteUrl = '';
    try {
      const { getCompanySettingsByUserId } = await import('../../../models/companySettings/functions');
      const companySettings = await getCompanySettingsByUserId(userIdNum);
      if (companySettings?.website) {
        websiteUrl = companySettings.website;
      }
    } catch { /* ignore - website is optional */ }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const policySnapshot = context.brandContextSnapshot as any;
    websiteUrl = websiteUrl
      || policySnapshot?.businessProfile?.website
      || policySnapshot?.brandToolkit?.website
      || '';
    if (!websiteUrl) {
      return {
        success: false,
        toolName: 'generate_ad',
        error: 'Add an approved website to the business profile or Brand Toolkit before generating ads.',
      };
    }

    // Use the reviewed destination; compliance still checks its approved domain.
    websiteUrl = input.landing_url?.trim() || websiteUrl;

    // Fetch previous ad copies in the same thread/user to avoid duplication
    let previousAdCopiesContext = '';
    try {
      const { db } = await import('../../../models/db');
      const { contentAssetsTable } = await import('../../../models/contentAssets/schema');
      const { eq, and, desc } = await import('drizzle-orm');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;
      const conditions = [eq(contentAssetsTable.type, 'ad_copy')];
      if (threadIdVal) conditions.push(eq(contentAssetsTable.threadId, threadIdVal));
      else if (userIdVal) conditions.push(eq(contentAssetsTable.userId, userIdVal));
      const previousAds = await db.select({ title: contentAssetsTable.title, content: contentAssetsTable.content })
        .from(contentAssetsTable)
        .where(and(...conditions))
        .orderBy(desc(contentAssetsTable.createdAt))
        .limit(10);
      if (previousAds.length > 0) {
        const summaries = previousAds.map((a: { title: string | null; content: string }) => {
          try { const c = JSON.parse(a.content); return `- Headline: ${c.headline || a.title} | Text: ${(c.primaryText || '').substring(0, 100)}`; } catch { return `- ${a.title}`; }
        });
        previousAdCopiesContext = `\n\nPREVIOUSLY GENERATED AD COPIES (DO NOT repeat or closely resemble these):\n${summaries.join('\n')}`;
      }
    } catch { /* ignore - dedup is best effort */ }

    // Build brand toolkit context
    let brandContext = '';
    if (context.brandToolkit) {
      brandContext = `
Brand Guidelines:
- Brand: ${context.brandToolkit.name}
- Primary Color: ${context.brandToolkit.primaryBrandColor || 'Not specified'}
- Secondary Color: ${context.brandToolkit.secondaryBrandColor || 'Not specified'}
- Voice/Tone: ${context.brandToolkit.voiceType || 'Professional'}
- Brand Values: ${Array.isArray(context.brandToolkit.brandValues) ? context.brandToolkit.brandValues.join(', ') : 'Not specified'}
${context.brandToolkit.defaultCtas?.length ? `- Preferred CTAs: ${context.brandToolkit.defaultCtas.join(', ')}` : ''}
${websiteUrl ? `- Website: ${websiteUrl}` : ''}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
${(context.brandToolkit as any)?.logoUrl ? `- Has Brand Logo: Yes (will be incorporated into generated images)` : ''}`;
    }

    const variationsInstruction = numVariations > 1 ? `Generate exactly ${numVariations} different variations of the ad. Each variation MUST have a unique, descriptive headline (not generic labels like "Variation 1"). Return one JSON object with an "ads" array containing exactly ${numVariations} ad objects.` : '';

    const prompt = `Generate ${inputPlatform} ad creative for goal: "${inputGoal}":
- Ad Format: ${adFormat.replace('_', ' ')}
- Tone: ${tone}
- Language: ${language}
- CTA Type: ${ctaType.replace('_', ' ')}
- Headline: ${input.headline || 'Generate compelling headline'}
- Primary Text: ${inputPrimaryText || 'Generate persuasive copy'}
USER-REVIEWED CONTENT CONSTRAINTS (override brand defaults): ${input.content_instructions || 'Follow the reviewed fields.'}
${input.cta_text ? `The application appends this exact CTA to primaryText: ${input.cta_text}. Write informational statements only in headline, primaryText and description. Do not include or paraphrase any invitation, request, question, or CTA there, even if supplied as example copy or brand defaults.` : ''}
${!input.include_image_prompt && !autoGenImage ? 'Do not return image prompts.' : ''}
${!input.include_video_prompt && !autoGenVideo ? 'Do not return video prompts.' : ''}
${inputTargetAudience ? `- Target Audience: ${inputTargetAudience}` : ''}
${(input.include_image_prompt || autoGenImage) ? '- Include detailed image generation prompt for imagePrompt field' : ''}
${(input.include_video_prompt || autoGenVideo) ? '- Include detailed video generation prompt for videoPrompt field' : ''}
${variationsInstruction}
${context.brandContextPrompt || brandContext}
${previousAdCopiesContext}

${platformCopyConstraints}

ICP: ${JSON.stringify(context.icpProfile, null, 2)}

Return JSON with: headline, primaryText, description, callToAction, displayUrl, keywords[], tags[], imagePrompts[]?, videoPrompts[]?
- headline: A unique, descriptive headline (NOT generic labels like "Variation 1" or "Ad Copy 1")
- displayUrl: The approved destination "${websiteUrl}" (do not invent or substitute a domain)
- keywords: 5-10 relevant targeting keywords for the ad
- tags: 3-5 descriptive tags for categorizing and organizing the ad (e.g., "promotional", "product-launch", "seasonal", "awareness", etc.)`;

    const response = await createCompletionWithProviderFallback(userIdNum, {
      messages: [
        { role: 'system', content: `Generate ad creatives that follow reviewed user constraints before brand defaults.${input.cta_text ? ' Headline, primaryText and description must contain neutral informational statements, with no invitations, requests or questions. The application adds the exact reviewed CTA; never paraphrase it in generated prose.' : ''} Workspace brand names and website URLs are optional defaults. Do not add them when the reviewed brief specifies a different business, fictional campaign, or excludes them. Each ad variation must have a unique, creative headline — never use generic labels like "Variation 1". ${platformCopyConstraints}` },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId: context.userId,
        threadId: context.threadId,
        purpose: 'ad_generation',
        service: 'AdsExecutor',
        action: 'generate_ad',
      },
    });

    if (!response.success) throw new Error(response.error || 'Ad copy generation failed.');
    let ad;
     
    let allVariations: any[] = [];
    try {
      let rawContent = response.content || '{}';
      
      // Strip markdown code fences (```json ... ``` or ``` ... ```)
      rawContent = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      
      // Extract valid JSON from response (LLM may append text after the JSON)
       
      let parsed: any;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        // Find first { or [ and try parsing progressively shorter substrings
        // eslint-disable-next-line no-useless-escape
        const startIdx = rawContent.search(/[\[{]/);
        if (startIdx === -1) throw new Error('No valid JSON found in LLM response');
        const sub = rawContent.slice(startIdx);
        let found = false;
        // Try from the end backwards, trimming trailing non-JSON content
        for (let end = sub.length; end > 0; end--) {
          const ch = sub[end - 1];
          if (ch !== '}' && ch !== ']') continue;
          try {
            parsed = JSON.parse(sub.slice(0, end));
            found = true;
            break;
          } catch { /* continue */ }
        }
        if (!found) throw new Error('No valid JSON found in LLM response');
      }
      
      const generatedAdDefaults: GeneratedAdDefaults = {
        headline: input.headline || `${context.brandToolkit?.name || 'Brand'} ${String(inputGoal).replace(/_/g, ' ')} campaign`,
        primaryText: inputPrimaryText || `Discover ${context.brandToolkit?.name || 'our offer'} and learn more.`,
        description: inputPrimaryText || `Discover ${context.brandToolkit?.name || 'our offer'} and learn more.`,
        callToAction: ctaType.replace(/_/g, ' '),
        displayUrl: websiteUrl,
      };
      allVariations = normalizeGeneratedAds(parsed, generatedAdDefaults)
        .map(variation => enforceReviewedAdConstraints(variation, { ...input, platform: inputPlatform }));

      if (allVariations.length !== numVariations) {
        return { success: false, toolName: 'generate_ad',
          error: `Expected ${numVariations} ad-copy variations, received ${allVariations.length}. No ads were saved.` };
      }
      
      ad = allVariations[0] || {};
    } catch (parseError) {
      logger.error({ err: parseError }, '[Ads Executor] Failed to parse LLM response');
      return { 
        success: false, 
        toolName: 'generate_ad', 
        error: 'Failed to generate ad content. Please try again.' 
      };
    }

    // Validate ad object has required fields
    if (!ad.headline && !ad.primaryText && !ad.description) {
      return {
        success: false,
        toolName: 'generate_ad',
        error: 'Generated ad is missing required fields. Please try again.',
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = context.brandContextSnapshot as any;
    try {
      if (!snapshot?.businessProfile || !snapshot?.brandToolkit) {
        throw new ContentComplianceError(['Approved business and brand context is required.']);
      }
      if (input.include_image_prompt || autoGenImage) {
        allVariations = allVariations.map(variation => ({
          ...variation,
          imagePrompt: variation.imagePrompt || variation.imagePrompts?.[0] || 'Create an on-brand ad visual.',
        }));
      }
      for (const variation of allVariations) {
        validateGeneratedContent({
          type: 'ad',
          output: variation,
          context: {
            businessProfile: snapshot.businessProfile,
            brandToolkit: snapshot.brandToolkit,
            provenance: snapshot.provenance,
          },
          platform: inputPlatform,
        });
      }
      ad = allVariations[0];
    } catch (validationError) {
      const initialViolations = validationError instanceof ContentComplianceError
        ? validationError.violations
        : ['The generated ad failed structured validation.'];

      try {
        const repairResponse = await createCompletionWithProviderFallback(userIdNum, {
          messages: [
            {
              role: 'system',
              content: `Repair the supplied ad JSON so it is policy-safe and satisfies every hard platform limit. Preserve reviewed constraints: ${input.content_instructions || 'Follow the reviewed fields.'} ${input.cta_text ? 'Use neutral informational copy without invitations or questions; the application appends the exact reviewed CTA.' : ''} Return a JSON object with an ads array containing exactly ${numVariations} repaired variations. ${platformCopyConstraints}`,
            },
            {
              role: 'user',
              content: `Violations to fix:\n- ${initialViolations.join('\n- ')}\n\nApproved destination: ${websiteUrl}\n\nAd JSON:\n${JSON.stringify({ ads: allVariations })}`,
            },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
          loggingContext: {
            userId: context.userId,
            threadId: context.threadId,
            purpose: 'ad_generation',
            service: 'AdsExecutor',
            action: 'repair_ad_copy',
          },
        });

        const repairedRaw = (repairResponse.content || '{}')
          .replace(/^```(?:json)?\s*\n?/i, '')
          .replace(/\n?```\s*$/i, '')
          .trim();
        const repairedParsed = JSON.parse(repairedRaw);
        const repairedVariations = normalizeGeneratedAds(repairedParsed, {
          headline: input.headline || ad.headline,
          primaryText: inputPrimaryText || ad.primaryText,
          description: inputPrimaryText || ad.description,
          callToAction: ctaType.replace(/_/g, ' '),
          displayUrl: websiteUrl,
        }).map(variation => enforceReviewedAdConstraints(variation, { ...input, platform: inputPlatform }));
        if (repairedVariations.length !== numVariations) {
          throw new ContentComplianceError([`Expected ${numVariations} repaired ad-copy variations, received ${repairedVariations.length}. No ads were saved.`]);
        }
        for (const repaired of repairedVariations) {
          if (input.include_image_prompt || autoGenImage) {
            repaired.imagePrompt = repaired.imagePrompt || repaired.imagePrompts?.[0] || ad.imagePrompt || 'Create an on-brand ad visual.';
          }
          repaired.displayUrl = websiteUrl;
          validateGeneratedContent({
            type: 'ad',
            output: repaired,
            context: {
              businessProfile: snapshot.businessProfile,
              brandToolkit: snapshot.brandToolkit,
              provenance: snapshot.provenance,
            },
            platform: inputPlatform,
          });
        }
        allVariations = repairedVariations;
        ad = allVariations[0];
      } catch (repairError) {
        const finalViolations = repairError instanceof ContentComplianceError
          ? repairError.violations
          : initialViolations;
        return {
          success: false,
          toolName: 'generate_ad',
          error: `The AI provider could not produce compliant ${inputPlatform} ad copy after an automatic correction attempt. ${finalViolations.join(' ')}`,
        };
      }
    }

    // Auto-generate image if requested
     
    const generatedImages: any[] = [];
    let imageGenerationError = null;
    const imagePrompts = autoGenImage ? reviewedAdImagePrompts(
      Array.isArray(ad.imagePrompts) ? ad.imagePrompts : (ad.imagePrompt ? [ad.imagePrompt] : []), imageCount, input.image_style,
    ) : [];
    
    if (autoGenImage && imagePrompts.length > 0) {
      try {
        const { createImageGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
        const imageGenerationWorker = createImageGenerationWorker(userIdNum, toNumber(context.threadId));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { readLogoAsBase64ForAds } = await import('./contentExecutor');
        
        for (const prompt of imagePrompts) {
          // Same rules as Content Studio: the request first, visual-only brand
          // context, no URL or invented text (the platform shows the display URL).
          const enhancedImagePrompt = buildImageGenerationPrompt({
            userPrompt: prompt,
            brandContext: { brandToolkit: context.brandToolkit, businessProfile: context.companyProfile },
          });

          // Build imageConfig from input params
           
          const imageConfig: Record<string, any> = {};
          imageConfig.brandLogoUrl = selectedBrandLogoUrl(context);
          if (input.image_provider) imageConfig.provider = input.image_provider;
          if (input.image_model) imageConfig.model = input.image_model;
          if (input.image_aspect_ratio) imageConfig.aspectRatio = input.image_aspect_ratio;
          if (input.image_size) imageConfig.imageSize = input.image_size;
          imageConfig.numberOfImages = 1;
          
          const imageResult = await imageGenerationWorker.generateFromText(enhancedImagePrompt, imageConfig);
          
          if (imageResult.success) {
            generatedImages.push({
              imageData: imageResult.imageData,
              imageUrl: imageResult.imageUrl,
              mimeType: imageResult.mimeType,
              fileName: imageResult.fileName,
              provider: imageResult.provider,
              model: imageResult.model,
              fallbackFrom: imageResult.fallbackFrom,
            });
          }
        }
       
      } catch (imgErr: any) {
        logger.warn({ err: imgErr }, '[Ads Executor] Failed to auto-generate ad images');
        const errMsg = imgErr?.message || String(imgErr);
        
        // Determine error type and create appropriate message
        let errorMessage = '';
        if (errMsg.includes('API key is not configured') || errMsg.includes('GEMINI_API_KEY')) {
          imageGenerationError = 'api_key_missing';
          errorMessage = '⚠️ Image generation requires a Gemini API key. Please add your Gemini API key in Settings > Integrations.';
        } else if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('quota')) {
          imageGenerationError = 'rate_limit';
          errorMessage = '⏳ Image generation temporarily unavailable due to rate limits. Please try again in a few minutes.';
        } else {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          imageGenerationError = 'unknown';
          errorMessage = `❌ Image generation failed: ${errMsg}`;
        }
        
        if (context.threadId) {
          const threadIdNum = toNumber(context.threadId);
          webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'warning', errorMessage, 'content');
        }
        
        // Provide placeholder with error message
        generatedImages.push({
          placeholder: true,
          message: errorMessage,
        });
      }
    }

    // Durable video work is queued only once the parent variation has been saved.
    const generatedVideos: any[] = [];
    const videoPrompts = Array.isArray(ad.videoPrompts) ? ad.videoPrompts : (ad.videoPrompt ? [ad.videoPrompt] : []);

    // Save all ad variations to content_assets table
    const assetIds: number[] = [];
    const childAssetIds: number[] = [];
    const persistenceErrors: string[] = [];
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const { withVideoProbeMetadata } = await import('../../../services/media/MediaTranscodingService.js');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;

      for (let i = 0; i < allVariations.length; i++) {
        const variation = allVariations[i];
        const savedAd = await ContentAssetModel.create({
          type: 'ad_copy',
          title: variation.headline || `${inputPlatform} Ad - ${inputGoal.substring(0, 60)}`,
          content: JSON.stringify({
            ...variation,
            autoGenerateImageRequested: autoGenImage,
            autoGenerateVideoRequested: autoGenVideo,
            imageUrl: (i === 0 && generatedImages.length > 0 && !generatedImages[0].placeholder) ? generatedImages[0].imageUrl : undefined,
            imageUrls: (i === 0 && generatedImages.length > 0) ? generatedImages.filter(img => !img.placeholder).map(img => img.imageUrl) : [],
            videoUrl: (i === 0 && generatedVideos.length > 0 && !generatedVideos[0].placeholder) ? generatedVideos[0].videoUrl : undefined,
            videoUrls: (i === 0 && generatedVideos.length > 0) ? generatedVideos.filter(vid => !vid.placeholder).map(vid => vid.videoUrl) : [],
            imagePrompts: (i === 0 && generatedImages.length === 0 && imagePrompts.length > 0) ? imagePrompts : undefined,
            videoPrompts: (i === 0 && generatedVideos.length === 0 && videoPrompts.length > 0) ? videoPrompts : undefined
          }),
          channel: inputPlatform,
          status: 'draft',
          userId: userIdVal,
          threadId: threadIdVal,
          imageUrl: (i === 0 && generatedImages.length > 0 && !generatedImages[0].placeholder) ? generatedImages[0].imageUrl : undefined,
          imageUrls: (i === 0 && generatedImages.length > 0) ? generatedImages.filter(img => !img.placeholder).map(img => img.imageUrl) : [],
          videoUrl: (i === 0 && generatedVideos.length > 0 && !generatedVideos[0].placeholder) ? generatedVideos[0].videoUrl : undefined,
          videoUrls: (i === 0 && generatedVideos.length > 0) ? generatedVideos.filter(vid => !vid.placeholder).map(vid => vid.videoUrl) : [],
          metadata: { ...(i === 0 ? generatedVideos.reduce((metadata, video) => withVideoProbeMetadata(video.videoUrl, video.mediaProbe, metadata), {}) : {}), ...(creativeBriefProvenance ? { creativeBrief: creativeBriefProvenance } : {}) },
          performance: null,
          ...policyPersistence(context, 'ad', inputPlatform),
        });
        if (!savedAd?.id) throw new Error(`Ad variation ${i + 1} was not persisted.`);
        assetIds.push(savedAd.id);
        if (creativeBriefProvenance) {
          const { creativeIntelligenceService } = await import('../../../services/ads/creative-intelligence/CreativeIntelligenceService.js');
          await creativeIntelligenceService.linkAsset(Number(context.userId), creativeBriefProvenance, savedAd.id);
        }

        // Save auto-generated images as children of the first variation
        if (i === 0 && savedAd?.id && generatedImages.length > 0) {
          for (const img of generatedImages) {
            if ((img.imageUrl || img.imageData) && !img.placeholder) {
              try {
                const imageAsset = await ContentAssetModel.create({
                  type: 'image',
                  title: `Image for Ad: ${(variation.headline || inputGoal).substring(0, 80)}`,
                  content: img.imageUrl || img.imageData,
                  imageUrl: img.imageUrl || null,
                  imageUrls: img.imageUrl ? [img.imageUrl] : [],
                  channel: inputPlatform,
                  status: 'draft',
                  userId: userIdVal,
                  threadId: threadIdVal,
                  parentAssetId: savedAd.id,
                  metadata: { provider: img.provider, model: img.model, fallbackFrom: img.fallbackFrom, ...creativeBriefProvenance },
                  performance: null,
                });
                if (imageAsset?.id) childAssetIds.push(imageAsset.id);
               
              } catch (imgSaveErr: any) {
                logger.warn({ err: imgSaveErr }, '[Ads Executor] Failed to save auto-generated ad image');
                persistenceErrors.push(`Image persistence failed: ${imgSaveErr?.message || 'unknown error'}`);
              }
            }
          }
        }

        // Save auto-generated videos as children of the first variation
        if (i === 0 && savedAd?.id && generatedVideos.length > 0) {
          for (const vid of generatedVideos) {
            if ((vid.videoUrl || vid.videoData) && !vid.placeholder) {
              try {
                const videoAsset = await ContentAssetModel.create({
                  type: 'video',
                  title: `Video for Ad: ${(variation.headline || inputGoal).substring(0, 80)}`,
                  content: vid.videoUrl || vid.videoData || '',
                  videoUrl: vid.videoUrl || null,
                  videoUrls: vid.videoUrl ? [vid.videoUrl] : [],
                  metadata: withVideoProbeMetadata(vid.videoUrl, vid.mediaProbe),
                  channel: inputPlatform,
                  status: 'draft',
                  userId: userIdVal,
                  threadId: threadIdVal,
                  parentAssetId: savedAd.id,
                  performance: null,
                });
                if (videoAsset?.id) childAssetIds.push(videoAsset.id);
               
              } catch (vidSaveErr: any) {
                logger.warn({ err: vidSaveErr }, '[Ads Executor] Failed to save auto-generated ad video');
                persistenceErrors.push(`Video persistence failed: ${vidSaveErr?.message || 'unknown error'}`);
              }
            }
          }
        }
      }
      logger.info({ threadId: context.threadId, variations: allVariations.length }, '[Ads Executor] Ad copies saved to content_assets');
     
    } catch (saveError: any) {
      logger.warn({ err: saveError }, '[Ads Executor] Failed to save ad copy to database');
      persistenceErrors.push(saveError?.message || 'Ad copy persistence failed.');
    }

    if (assetIds.length === 0) {
      return {
        success: false,
        toolName: 'generate_ad',
        error: 'The ad copy was generated but could not be saved. No ad was created.',
        output: {
          status: 'failed',
          assetIds: [],
          copyStatus: 'generated_not_persisted',
          imageStatus: autoGenImage ? 'failed' : 'not_requested',
          videoStatus: autoGenVideo ? 'failed' : 'not_requested',
          persistenceStatus: 'failed',
          errors: persistenceErrors,
        },
      };
    }

    const { queueSavedContentVideos } = await import('../../../services/media/SavedContentVideoQueueService.js');
    const queuedVideo = autoGenVideo ? await queueSavedContentVideos({
      userId: userIdNum, threadId: toNumber(context.threadId) || undefined,
      parentAssetId: assetIds[0], assetType: 'ad_copy', prompts: videoPrompts,
      provider: input.video_provider, model: input.video_model,
      brandContext: context.brandContextPrompt, brandLogoUrl: selectedBrandLogoUrl(context),
      videoConfig: {
        aspectRatio: input.video_aspect_ratio, resolution: input.video_resolution,
        durationSeconds: input.video_duration_seconds,
      },
    }) : undefined;

    const imageStatus = !autoGenImage
      ? 'not_requested'
      : generatedImages.filter(image => !image.placeholder && (image.imageUrl || image.imageData)).length === imageCount
        ? 'succeeded'
        : 'failed';
    const videoStatus = queuedVideo?.status || 'not_requested';
    const isPartial = imageStatus === 'failed' || videoStatus === 'failed' || videoStatus === 'partial_success' || persistenceErrors.length > 0;
    const generationStatus = isPartial ? 'partial_success' : videoStatus === 'queued' ? 'pending' : 'succeeded';

    // Only reveal the result tab after at least one durable ad asset exists.
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.CONTENT_STUDIO,
      tabLabel: TAB_LABELS[TAB_TYPES.CONTENT_STUDIO],
      data: {
        initialTab: 'adcopy',
        resourceId: assetIds[0],
        assetIds,
        revision: 1,
        status: generationStatus,
        ad,
        platform: inputPlatform,
        goal: inputGoal,
      },
    });

    const variationMsg = allVariations.length > 1 ? ` with ${allVariations.length} variations` : '';
    return {
      success: true,
      toolName: 'generate_ad',
      output: {
        status: generationStatus,
        assetId: assetIds[0],
        assetIds,
        childAssetIds,
        copyStatus: 'persisted',
        imageStatus,
        videoStatus,
        videoJobIds: queuedVideo?.jobIds || [],
        warnings: queuedVideo?.errors || [],
        persistenceStatus: persistenceErrors.length > 0 ? 'partial' : 'succeeded',
        errors: persistenceErrors,
        platform: inputPlatform,
        goal: inputGoal,
        ad,
        allVariations: allVariations.length > 1 ? allVariations : undefined,
        totalVariations: allVariations.length,
        brandToolkitUsed: context.brandToolkit?.name || null,
        generatedImages,
        generatedVideos,
        message: isPartial
          ? `📢 ${inputPlatform} ad copy was saved${variationMsg}, but one or more requested media assets could not be completed. Review asset #${assetIds[0]} in Content Studio.`
          : videoStatus === 'queued'
            ? `📢 ${inputPlatform} ad copy was saved${variationMsg} as asset #${assetIds[0]}. Video generation is queued; the finished video will attach to this asset.`
            : `📢 ${inputPlatform} ad creative was created and saved${variationMsg} as asset #${assetIds[0]}.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Ads Executor] Generate ad error');
    // Return a clean error message, not the raw error which might contain JSON
    let errorMessage = 'Failed to generate ad. Please try again.';
    if (error.message) {
      // Check if error message contains JSON (don't show raw JSON to users)
      const isJsonError = error.message.includes('{') || error.message.includes('[');
      if (!isJsonError && error.message.length < 200) {
        errorMessage = error.message;
      }
    }
    return { success: false, toolName: 'generate_ad', error: errorMessage };
  }
}

interface PublishCampaignInput {
  campaign_id?: string;
  review_revision?: string;
  asset_ids?: number[];
  platforms?: Array<'meta' | 'google'>;
  campaign_name?: string;
  objective?: 'awareness' | 'traffic' | 'engagement' | 'leads' | 'sales' | 'app_promotion';
  budget_amount_minor?: number;
  /** Backward-compatible major currency amount. */
  budget?: number;
  currency?: string;
  budget_type?: 'lifetime';
  landing_url?: string;
  start_date?: string;
  end_date?: string;
  placements?: string[];
  locations?: Array<{
    countryCode: string;
    region?: string;
    city?: string;
    googleGeoTargetId?: string;
    metaLocationKey?: string;
  }>;
  provider_account_ids?: { meta?: string; google?: string };
  creative_revision?: number;
  special_ad_categories?: string[];
}

async function resolvePublishCampaign(
  input: PublishCampaignInput,
  context: ToolContext,
  platforms: Array<'meta' | 'google'>,
): Promise<{ campaignId: number; createdFromAssets: boolean; validationErrors: string[] }> {
  const existingId = Number(input.campaign_id);
  if (input.campaign_id !== undefined && (!Number.isSafeInteger(existingId) || existingId <= 0)) {
    throw new Error('Select a valid saved campaign ID before preparing its review.');
  }
  if (Number.isSafeInteger(existingId) && existingId > 0) {
    return { campaignId: existingId, createdFromAssets: false, validationErrors: [] };
  }

  const assetIds = [...new Set(input.asset_ids || [])];
  if (assetIds.length === 0) throw new Error('Select at least one saved ad creative before publishing.');
  const { ContentAssetModel } = await import('../../../models/contentAssets/functions.js');
  const assets = await Promise.all(assetIds.map(id => ContentAssetModel.findByIdForUser(id, toNumber(context.userId))));
  if (assets.some(asset => !asset)) throw new Error('One or more selected ad assets do not exist or are not owned by this account.');
  const supportedAssetTypes = new Set(['ad_copy', 'image', 'video']);
  if (assets.some(asset => !supportedAssetTypes.has(asset!.type))) {
    throw new Error('Paid campaigns accept only saved ad copy, image, and video assets.');
  }
  const copyAssets = assets.filter(asset => asset!.type === 'ad_copy');
  if (copyAssets.length === 0) throw new Error('Select at least one saved ad-copy asset before publishing.');

  const mediaImageUrls = assets
    .filter(asset => asset!.type === 'image')
    .flatMap(asset => [asset!.imageUrl, ...(asset!.imageUrls || [])])
    .filter((url): url is string => Boolean(url));
  const mediaVideoUrls = assets
    .filter(asset => asset!.type === 'video')
    .flatMap(asset => [asset!.videoUrl, ...(asset!.videoUrls || [])])
    .filter((url): url is string => Boolean(url));
  const copyCreatives = copyAssets.map(asset => {
    let content: Record<string, unknown> = {};
    try { content = JSON.parse(asset!.content) as Record<string, unknown>; } catch { content = { primaryText: asset!.content }; }
    return {
      ...content,
      assetId: asset!.id,
      sourceChannel: asset!.channel,
      title: asset!.title,
      imageUrl: asset!.imageUrl || mediaImageUrls[0],
      imageUrls: [...new Set([...(asset!.imageUrls || []), ...mediaImageUrls])],
      videoUrl: asset!.videoUrl || mediaVideoUrls[0],
      videoUrls: [...new Set([...(asset!.videoUrls || []), ...mediaVideoUrls])],
      selectedAssetIds: assetIds,
      creativeRevision: input.creative_revision || 1,
    };
  });
  const landingPageUrl = input.landing_url
    || copyCreatives.map((creative) => {
      const fields = creative as unknown as Record<string, unknown>;
      return fields.displayUrl || fields.landingUrl;
    }).find(Boolean)?.toString();
  if (!landingPageUrl) throw new Error('A verified landing page URL is required before publishing.');

  const lifetimeBudget = input.budget_amount_minor !== undefined
    ? input.budget_amount_minor / campaignCurrencyScale(input.currency || 'USD')
    : Number(input.budget || 0);
  if (!Number.isFinite(lifetimeBudget) || lifetimeBudget <= 0) {
    throw new Error('A positive lifetime budget is required before publishing.');
  }
  const startDate = input.start_date ? new Date(input.start_date) : new Date(Date.now() + 10 * 60 * 1000);
  const endDate = input.end_date ? new Date(input.end_date) : null;
  if (Number.isNaN(startDate.getTime()) || (endDate && Number.isNaN(endDate.getTime()))) {
    throw new Error('Campaign start or end date is invalid.');
  }

  const { autonomousAdsService } = await import('../../../services/ads/AutonomousAdsService.js');
  const uniquePlatforms = [...new Set(platforms)];
  const placements = input.placements || ['Automatic'];
  const metaPlacements = placements.length === 1 && placements[0] === 'Automatic' ? [] : placements;
  const supportedPlacements = new Set(['facebook_feed', 'facebook_marketplace', 'facebook_video_feeds', 'instagram_stream', 'instagram_story', 'instagram_reels', 'audience_network', 'messenger_inbox']);
  if (uniquePlatforms.includes('meta') && metaPlacements.some(value => !supportedPlacements.has(value))) {
    throw new Error('Select Automatic placements or supported Meta placement names before preparing the review.');
  }
  const creativesByPlatform = Object.fromEntries(uniquePlatforms.map(platform => {
    const matching = copyCreatives.filter(creative => {
      const sourceChannel = String(creative.sourceChannel || '').toLowerCase();
      return sourceChannel === platform
        || (platform === 'meta' && ['facebook', 'instagram'].includes(sourceChannel));
    });
    return [platform, matching.length > 0 ? matching : copyCreatives];
  }));
  const campaign = await autonomousAdsService.createCampaign(toNumber(context.userId), {
    name: input.campaign_name || `${uniquePlatforms.map(platform => platform === 'meta' ? 'Meta' : 'Google').join(' + ')} Campaign`,
    brief: `Launch approved Content Studio assets: ${assetIds.join(', ')}`,
    contentStudioContext: JSON.stringify({ assetIds }),
    conversationContext: `Approved in conversation thread ${context.threadId}`,
    objective: input.objective || 'traffic',
    platforms: uniquePlatforms,
    lifetimeBudget,
    currency: input.currency || 'USD',
    locations: input.locations,
    landingPageUrl,
    startDate,
    endDate,
    creatives: creativesByPlatform,
    providerConfig: uniquePlatforms.includes('meta') ? {
      meta: {
        ...defaultMetaProviderConfig(input.objective || 'traffic'),
        placements: metaPlacements as MetaPlacement[],
        specialAdCategories: (input.special_ad_categories || []) as MetaProviderConfig['specialAdCategories'],
      },
    } : undefined,
    context: {
      threadId: toNumber(context.threadId),
      providerAccountIds: input.provider_account_ids,
      creativeRevision: input.creative_revision || 1,
      creativeSources: assets.map(asset => ({
        sourceType: 'content_asset' as const,
        sourceId: asset!.id,
        sourceVersion: Number(asset!.version || 1),
        updatedAt: asset!.updatedAt?.toISOString(),
      })),
      placements: input.placements?.length ? input.placements : ['Automatic'],
    },
    idempotencyKey: `review-draft:${context.threadId}:${context.widgetId || 'legacy'}:${publishReviewRevision({ input, platforms: uniquePlatforms, copyCreatives, assets })}`,
    autoActivate: false,
    publish: false,
  });
  const campaignId = Number(campaign.id);
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) throw new Error('The performance campaign draft was not persisted.');
  return {
    campaignId,
    createdFromAssets: true,
    validationErrors: Array.isArray(campaign.validationErrors) ? campaign.validationErrors.map(String) : [],
  };
}

/** Persist effective defaults and selected creative versions BEFORE approval. */
export async function prepareAdCampaignReview(
  input: PublishCampaignInput & { platforms: Array<'meta' | 'google'> },
  context: ToolContext,
): Promise<CampaignPublishReview> {
  const resolved = await resolvePublishCampaign(input, context, input.platforms);
  const { autonomousAdsService } = await import('../../../services/ads/AutonomousAdsService.js');
  const review = await autonomousAdsService.getPublishReview(toNumber(context.userId), resolved.campaignId);
  if (review.campaignId !== resolved.campaignId || review.snapshot.campaignId !== resolved.campaignId) {
    throw new Error('The saved review does not match the requested campaign. Reload its review before approval.');
  }
  if (input.platforms.some(platform => !review.snapshot.platforms.includes(platform))) {
    throw new Error('A selected platform is not present in this saved campaign. Prepare a campaign with those platforms first.');
  }
  return review;
}

export async function executePublishAds(
  input: PublishCampaignInput & { platforms: Array<'meta' | 'google'> },
  context: ToolContext,
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const platforms = [...new Set(input.platforms || [])];
  if (platforms.length === 0) {
    return { success: false, toolName: 'publish_ads', error: 'Select at least one ad platform.' };
  }

  try {
    const { autonomousAdsService } = await import('../../../services/ads/AutonomousAdsService.js');
    const campaignId = Number(input.campaign_id);
    if (!Number.isSafeInteger(campaignId) || campaignId <= 0 || !input.review_revision) {
      throw new Error('Prepare the saved campaign review and approve its current revision before publishing.');
    }
    // The queue service resolves existing receipts before applying current
    // gates. A replay is a read of what happened, not authorization to launch.
    const platformResults = await Promise.all(platforms.map(async platform => {
      try {
        const queued = await autonomousAdsService.queueExistingCampaignPlatform(
          userIdNum,
          campaignId,
          platform,
          `agent:${context.threadId || 'none'}:widget:${context.widgetId || context.runContext?.actionId || 'legacy'}:campaign:${campaignId}:${platform}`,
          input.review_revision,
        );
        return [platform, queued] as const;
      } catch (error) {
        return [platform, {
          status: error instanceof CampaignPublishPreflightError ? error.status : 'failed',
          error: error instanceof Error ? error.message : 'Unable to queue provider campaign.',
        }] as const;
      }
    }));
    const summary = summarizeAdPublication(platformResults.map(([, result]) => result));
    return {
      success: summary.success,
      toolName: 'publish_ads',
      ...(!summary.success ? { error: summary.message } : {}),
      output: {
        status: summary.status,
        pending: summary.pending,
        campaignId,
        reviewRevision: input.review_revision,
        platforms: Object.fromEntries(platformResults),
        message: summary.message,
      },
    };
  } catch (error) {
    return {
      success: false,
      toolName: 'publish_ads',
      error: error instanceof Error ? error.message : 'Unable to prepare the ad campaign.',
    };
  }
}

export async function executePublishMetaAds(input: PublishCampaignInput, context: ToolContext): Promise<ToolResult> {
  return { ...await executePublishAds({ ...input, platforms: ['meta'] }, context), toolName: 'publish_meta_ads' };
}

export async function executePublishGoogleAds(input: PublishCampaignInput, context: ToolContext): Promise<ToolResult> {
  return { ...await executePublishAds({ ...input, platforms: ['google'] }, context), toolName: 'publish_google_ads' };
}
