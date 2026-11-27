/* eslint-disable @typescript-eslint/no-explicit-any, no-constant-condition */
/**
 * Content Studio Tool Executors
 * Handles content generation tools (images, videos, social posts)
 */

import { mediaBrandingPolicy } from '../../../../shared/mediaBranding.js';
import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state';
import { logger } from '../../../utils/logger.js';
import { z } from 'zod';
import { TAB_TYPES, TAB_LABELS } from '../../tabConfig';
import { dispatchAndWait } from '../queueBridge.js';
import { TWITTER_CHAR_LIMIT, INSTAGRAM_CAPTION_LIMIT } from '../../../utils/channelConstants';
import { IMAGE_GENERATION_TIMEOUT_MS, VIDEO_GENERATION_TIMEOUT_MS } from '../../../utils/timingConstants';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { textDraftMessages, parseTextDraft, persistTextDraft, contentGenerationPolicy, explicitlyRequestedMedia, reviewedContentOptions } from '../../../services/content/TextContentGenerationService.js';
import { withExactCallToAction } from '../../../utils/exactCallToAction.js';
import { buildImageGenerationPrompt } from '../../../services/content/ImagePromptBuilder.js';
import {
  ContentComplianceError,
  extractJsonObject,
  parseStructuredContent,
  validateGeneratedContent,
} from '../../../services/content/ContentComplianceService.js';
import { socialCharacterLimit } from '../../../services/content/ContentComplianceService.js';
import { generateSocialPostSeries, seriesPostCount, validatedSocialPost, type SocialPost } from '../../../services/content/SocialPostSeries.js';
import { toUserFacingError } from '../../../../shared/userFacingError.js';
import { createCompletionWithProviderFallback as completeWithProviders } from '../../utils/providerCompletion.js';
import type { LLMChatOptions } from '../../../services/agents/LLMProvider.js';

// Omit loses explicit keys on an interface with a provider-option index
// signature. Restore the required message contract at this call boundary.
function createCompletionWithProviderFallback(
  userId: Parameters<typeof completeWithProviders>[0],
  options: Parameters<typeof completeWithProviders>[1] & Pick<LLMChatOptions, 'messages'>,
  validateResponse?: Parameters<typeof completeWithProviders>[2],
) {
  return completeWithProviders(userId, reviewedContentOptions(options), validateResponse);
}
import { withVideoProbeMetadata } from '../../../services/media/MediaTranscodingService.js';
import { reviewedMediaPrompts } from '../../../services/media/ReviewedMediaBudget.js';
import { toNumber, selectedBrandLogoUrl } from './executorValues.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function applyReviewedMediaExclusions(output: Record<string, unknown>, input: {
  include_image_prompt?: boolean; auto_generate_image?: boolean;
  include_video_prompt?: boolean; auto_generate_video?: boolean;
}): void {
  if (input.include_image_prompt === false && input.auto_generate_image !== true) {
    for (const key of ['imagePrompt', 'imagePrompts', 'featuredImagePrompt']) delete output[key];
  }
  if (input.include_video_prompt === false && input.auto_generate_video !== true) {
    for (const key of ['videoPrompt', 'videoPrompts']) delete output[key];
  }
}

function unsavedGeneratedContent(toolName: string, preview: Record<string, unknown>): ToolResult {
  return {
    success: false, toolName,
    error: 'Content was generated for preview, but saving the durable content asset was not confirmed. Check the library before retrying.',
    output: { status: 'partial_success', persistenceStatus: 'failed', retrySafe: false, ...preview },
  };
}

async function queueExecutorVideos(parentAssetId: number, assetType: string, prompts: string[], input: {
  video_provider?: 'google' | 'openrouter'; video_model?: string;
  video_aspect_ratio?: string; video_resolution?: string; video_duration_seconds?: number;
  video_count?: number;
}, context: ToolContext) {
  const { queueSavedContentVideos } = await import('../../../services/media/SavedContentVideoQueueService.js');
  return queueSavedContentVideos({
    userId: toNumber(context.userId), threadId: toNumber(context.threadId) || undefined,
    parentAssetId, assetType, prompts: reviewedMediaPrompts(prompts, input.video_count), maxVideos: input.video_count ?? 1,
    provider: input.video_provider, model: input.video_model,
    brandContext: context.brandContextPrompt, brandLogoUrl: selectedBrandLogoUrl(context),
    videoConfig: {
      aspectRatio: input.video_aspect_ratio, resolution: input.video_resolution,
      durationSeconds: input.video_duration_seconds,
    },
  });
}

async function persistPendingVideo(toolName: string, prompt: string, result: {
  operationName?: string; provider?: 'google' | 'openrouter'; model?: string;
}, videoConfig: Record<string, unknown> | undefined, context: ToolContext, forContentType?: string): Promise<ToolResult> {
  if (!result.operationName) return {
    success: false, toolName,
    error: 'The video provider is still processing but did not return a recoverable operation ID. Check the provider before starting another generation.',
    output: { retrySafe: false, status: 'unknown' },
  };
  let assetId: number | undefined;
  try {
    const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
    const asset = await ContentAssetModel.create({
      type: 'video', title: toolName === 'generate_video_from_image' ? 'Animated Video (processing)' : 'Generated Video (processing)',
      content: JSON.stringify({ videoUrl: '', operationName: result.operationName }),
      channel: forContentType && forContentType !== 'general' ? forContentType : 'content_studio',
      status: 'pending', userId: toNumber(context.userId), threadId: toNumber(context.threadId) || null,
      performance: { prompt, operationName: result.operationName, provider: result.provider, model: result.model },
      ...policyPersistence(context, 'video', forContentType || 'content_studio'),
    });
    assetId = asset?.id;
    if (!assetId) throw new Error('Pending video asset was not saved.');
  } catch (error) {
    logger.warn({ err: error, operationName: result.operationName }, '[Content Executor] Failed to persist pending video operation');
    return { success: false, toolName, error: 'Video generation started, but its operation could not be saved. Do not start a new generation; reconcile this operation first.', output: { retrySafe: false, operationName: result.operationName, provider: result.provider, model: result.model, persistenceStatus: 'failed' } };
  }
  const { queueSavedContentVideos } = await import('../../../services/media/SavedContentVideoQueueService.js');
  const queued = await queueSavedContentVideos({
    userId: toNumber(context.userId), threadId: toNumber(context.threadId) || undefined,
    parentAssetId: assetId, assetType: 'video', prompts: [prompt], operationName: result.operationName,
    provider: result.provider, model: result.model, videoConfig, brandLogoUrl: videoConfig?.brandLogoUrl === null ? null : selectedBrandLogoUrl(context),
  });
  return {
    success: true, toolName,
    output: {
      assetId, status: 'pending', videoStatus: 'pending', persistenceStatus: 'succeeded', retrySafe: false,
      operationName: result.operationName, provider: result.provider, model: result.model,
      videoJobIds: queued.jobIds, warnings: queued.errors,
      message: queued.jobIds.length
        ? 'Video generation is still processing. Its saved operation will resume automatically and attach the finished video to this asset.'
        : 'Video generation is still processing and its operation was saved. Automatic polling could not be queued; check this saved video’s status instead of starting another generation.',
    },
  };
}

function policyPersistence(context: ToolContext, contentType: string, platform: string) {
  const snapshot = context.brandContextSnapshot as any;
  if (!snapshot?.provenance) return {};
  return contentGenerationPolicy(resolvedPolicyContext(context), contentType, platform, undefined, snapshot);
}

function resolvedPolicyContext(context: ToolContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snapshot = context.brandContextSnapshot as any;
  if (!snapshot?.businessProfile || !snapshot?.brandToolkit || !snapshot?.provenance) {
    throw new ContentComplianceError(['Approved business and brand context is required.']);
  }
  return {
    businessProfile: snapshot.businessProfile,
    brandToolkit: snapshot.brandToolkit,
    provenance: snapshot.provenance,
  };
}

/**
 * Read a brand toolkit logo from disk as base64.
 * Handles both local paths (/uploads/logos/...) and /api/uploads/logos/... paths.
 * Returns null if the logo file does not exist or cannot be read.
 */
async function readLogoAsBase64(logoUrl: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    // Handle HTTP/HTTPS URLs by fetching them
    if (logoUrl.startsWith('http://') || logoUrl.startsWith('https://')) {
      try {
        const { fetchPublicHttpUrl, readResponseBuffer } = await import('../../../utils/safeRemoteFetch.js');
        const { response } = await fetchPublicHttpUrl(logoUrl, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
          logger.warn({ logoUrl, status: response.status }, '[Content Executor] HTTP fetch failed for logo');
          return null;
        }
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('svg')) return null; // Skip SVG
        const buffer = await readResponseBuffer(response, 10 * 1024 * 1024);
        const extMatch = logoUrl.match(/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i);
        const mimeType = contentType.startsWith('image/') ? contentType.split(';')[0] 
          : extMatch ? (`image/${extMatch[1].replace('jpg', 'jpeg')}`) : 'image/png';
        return { base64: buffer.toString('base64'), mimeType };
      } catch (fetchErr) {
        logger.warn({ logoUrl, err: fetchErr }, '[Content Executor] Failed to fetch remote logo');
        return null;
      }
    }
    
    // Resolve the path: /uploads/logos/file.png or /api/uploads/logos/file.png
    let relativePath = logoUrl.split(/[?#]/, 1)[0];
    if (relativePath.startsWith('/api/uploads/')) {
      relativePath = relativePath.replace('/api/uploads/', '/uploads/');
    }
    
    // Resolve from server root
    const isDistBuild = __dirname.includes('/dist/') || __dirname.includes('\\dist\\');
    const serverRoot = isDistBuild
      ? path.resolve(__dirname, '..', '..', '..', '..')
      : path.resolve(__dirname, '..', '..', '..');
    if (!relativePath.startsWith('/uploads/')) return null;
    const uploadsRoot = path.resolve(serverRoot, 'uploads');
    const filePath = path.resolve(serverRoot, `.${relativePath}`);
    if (!filePath.startsWith(`${uploadsRoot}${path.sep}`)) return null;
    const realPath = await fs.realpath(filePath);
    if (!realPath.startsWith(`${await fs.realpath(uploadsRoot)}${path.sep}`)) return null;
    if ((await fs.stat(realPath)).size > 10 * 1024 * 1024) return null;
    
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    };
    const mimeType = mimeMap[ext] || 'image/png';
    
    // Skip SVG files - they can't be used as reference images
    if (mimeType === 'image/svg+xml') return null;
    
    return { base64: buffer.toString('base64'), mimeType };
  } catch (err) {
    logger.warn({ logoUrl, err }, '[Content Executor] Could not read logo file');
    return null;
  }
}

/** Exported alias of readLogoAsBase64 for use by other executors (e.g. adsExecutor) */
export const readLogoAsBase64ForAds = readLogoAsBase64;

/**
 * Resolve source image base64 data from a content asset ID.
 * Falls back to local file read if the content field stores a file path/URL.
 * If no source_image_id is provided, falls back to the most recent image
 * asset in the given thread.
 */
async function resolveSourceImageBase64(
  sourceImageId: string | undefined,
  userId: number,
  threadId: number
): Promise<{ base64: string; mimeType: string } | null> {
  const { db } = await import('../../../models/db');
  const { contentAssetsTable } = await import('../../../models/contentAssets/schema');
  const { eq, and, desc } = await import('drizzle-orm');

   
  let asset: any = null;

  if (sourceImageId) {
    const assetId = Number(sourceImageId);
    if (Number.isSafeInteger(assetId) && assetId > 0) {
      const rows = await db
        .select()
        .from(contentAssetsTable)
        .where(and(
          eq(contentAssetsTable.id, assetId),
          eq(contentAssetsTable.userId, userId),
        ))
        .limit(1);
      asset = rows[0] ?? null;
    }
    // An explicit selection must never silently substitute another image.
    if (!asset) return null;
  }

  // Fallback: get most recent image from the same thread
  if (!asset && threadId) {
    const rows = await db
      .select()
      .from(contentAssetsTable)
      .where(
        and(
          eq(contentAssetsTable.threadId, threadId),
          eq(contentAssetsTable.type, 'image'),
          eq(contentAssetsTable.userId, userId)
        )
      )
      .orderBy(desc(contentAssetsTable.createdAt))
      .limit(1);
    asset = rows[0] ?? null;
    if (asset) {
      logger.info({ assetId: asset.id, threadId }, '[Content Executor] Using most recent thread image as source');
    }
  }

  if (!asset) return null;

  // Try to extract base64 from the content field
  let content = asset.imageUrl || asset.imageUrls?.[0] || asset.content || '';
  if (content.startsWith('{')) {
    try { const parsed = JSON.parse(content); content = parsed.imageUrl || parsed.imageData || parsed.generatedImage || ''; } catch { return null; }
  }
  const dataUri = content.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (dataUri) {
    if (dataUri[2].length > 14 * 1024 * 1024) return null;
    return { base64: dataUri[2], mimeType: dataUri[1] };
  }
  if (/^https?:\/\//.test(content) || content.startsWith('/uploads/') || content.startsWith('/api/uploads/')) {
    const data = await readLogoAsBase64(content);
    return data && ['image/png', 'image/jpeg', 'image/webp'].includes(data.mimeType) ? data : null;
  }
  // Legacy raw base64 needs a real image signature, not a URL/path passed to a provider.
  if (content.length > 100 && content.length <= 14 * 1024 * 1024 && /^[A-Za-z0-9+/=\s]+$/.test(content)) {
    const bytes = Buffer.from(content, 'base64');
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    if (mimeType) return { base64: content, mimeType };
  }
  return null;
}

export async function executeSelectBrandToolkit(
  input: { action: 'list' | 'select' | 'create' | 'skip'; toolkit_id?: number; toolkit_name?: string; toolkitId?: number },
  context: ToolContext
): Promise<ToolResult> {
  const { userId, threadId } = context;
  const userIdNum = toNumber(userId);
  const threadIdNum = toNumber(threadId);
  
  // Default action to 'list' if not provided
  const action = input.action || 'list';
  
  // Support both toolkit_id and toolkitId parameter names
  const toolkitId = input.toolkit_id || input.toolkitId;
  
  try {
    const { BrandToolkitModel } = await import('../../../models/brandToolkits/functions');
    const { db } = await import('../../../models/db');
    const { sql } = await import('drizzle-orm');
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');

    switch (action) {
      case 'list': {
        const toolkits = await BrandToolkitModel.findAllByUser(userIdNum);
        
        if (toolkits.length === 0) {
          return {
            success: true,
            toolName: 'select_brand_toolkit',
            output: {
              hasToolkits: false,
              message: "You don't have any brand toolkits yet. Would you like to:\n1. **Create a new brand toolkit** - Set up your brand colors, fonts, voice, and style\n2. **Skip for now** - Generate content without brand guidelines\n\nPlease let me know your preference.",
              options: ['create', 'skip'],
            },
          };
        }

        const toolkitList = toolkits.map((t) => ({
          id: t.id,
          name: t.name,
          primaryBrandColor: t.primaryBrandColor,
          voiceType: t.voiceType,
          isDefault: t.isDefault,
        }));

        const defaultToolkit = toolkits.find(t => t.isDefault);
        
        return {
          success: true,
          toolName: 'select_brand_toolkit',
          output: {
            hasToolkits: true,
            toolkits: toolkitList,
            defaultToolkit: defaultToolkit ? { id: defaultToolkit.id, name: defaultToolkit.name } : null,
            message: `I found ${toolkits.length} brand toolkit(s). Would you like to:\n\n${toolkitList.map((t, i) => `${i + 1}. **${t.name}** (ID: ${t.id})${t.isDefault ? ' (default)' : ''}`).join('\n')}\n\nOr you can:\n- **Create a new toolkit**\n- **Skip** and generate content without brand guidelines`,
          },
        };
      }

      case 'select': {
        // Support both toolkit_id and toolkit_name for selection
        let toolkit;
        
        if (toolkitId) {
          toolkit = await BrandToolkitModel.findByIdAndUser(toolkitId, userIdNum);
        } else if (input.toolkit_name) {
          // Find by name (case-insensitive partial match)
          const allToolkits = await BrandToolkitModel.findAllByUser(userIdNum);
          const searchName = input.toolkit_name.toLowerCase();
          toolkit = allToolkits.find(t => 
            t.name.toLowerCase() === searchName ||
            t.name.toLowerCase().includes(searchName) ||
            searchName.includes(t.name.toLowerCase())
          );
        }
        
        if (!toolkit && !toolkitId && !input.toolkit_name) {
          return {
            success: false,
            toolName: 'select_brand_toolkit',
            error: 'Please specify which brand toolkit you want to use by providing toolkit_id or toolkit_name.',
          };
        }
        
        if (!toolkit) {
          return {
            success: false,
            toolName: 'select_brand_toolkit',
            error: "Brand toolkit not found or you don't have access to it.",
          };
        }

        // Store selected toolkit in thread metadata
        const toolkitIdInt = Number(toolkit.id);
        await db.execute(sql`
          UPDATE chat_threads 
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('selectedBrandToolkitId', ${toolkitIdInt}::integer)
          WHERE id = ${threadIdNum} AND user_id = ${userIdNum}
        `);

        return {
          success: true,
          toolName: 'select_brand_toolkit',
          output: {
            selected: true,
            toolkit: {
              id: toolkit.id,
              name: toolkit.name,
              primaryBrandColor: toolkit.primaryBrandColor,
              secondaryBrandColor: toolkit.secondaryBrandColor,
              fontFamily: toolkit.fontFamily,
              voiceType: toolkit.voiceType,
              brandValues: toolkit.brandValues,
            },
            message: `Great! I'll use the **${toolkit.name}** brand toolkit for your content. This includes:\n- Brand colors: ${toolkit.primaryBrandColor || 'Not set'}${toolkit.secondaryBrandColor ? `, ${toolkit.secondaryBrandColor}` : ''}\n- Font: ${toolkit.fontFamily || 'Default'}\n- Voice: ${toolkit.voiceType || 'Professional'}\n\nNow, what would you like me to create?`,
          },
        };
      }

      case 'create': {
        // Open brand toolkit tab
        webSocketEmitter.emit(userIdNum, 'open_tab', {
          thread_id: toNumber(context.threadId),
          tabType: TAB_TYPES.BRAND_TOOLKIT,
          tabLabel: TAB_LABELS[TAB_TYPES.BRAND_TOOLKIT],
        });
        
        return {
          success: true,
          toolName: 'select_brand_toolkit',
          output: {
            action: 'create',
            message: "I've opened the Brand Toolkit page for you. There you can set up your brand colors, fonts, voice, and style. Once you're done, come back and we can create brand-consistent content!",
          },
        };
      }

      case 'skip': {
        await db.execute(sql`
          UPDATE chat_threads 
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('skippedBrandToolkit', true)
          WHERE id = ${threadIdNum} AND user_id = ${userIdNum}
        `);

        return {
          success: true,
          toolName: 'select_brand_toolkit',
          output: {
            skipped: true,
            message: "No problem! I'll generate content without specific brand guidelines. The content will still be high-quality and professional.\n\nWhat would you like me to create?",
          },
        };
      }

      default:
        return {
          success: false,
          toolName: 'select_brand_toolkit',
          error: `Unknown action: ${action}. Valid actions are: list, select, create, skip`,
        };
    }
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Brand toolkit error');
    return {
      success: false,
      toolName: 'select_brand_toolkit',
      error: error.message,
    };
  }
}

/**
 * Get all brand toolkits for the user
 */
export async function executeGetBrandToolkits(
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  
  try {
    const { BrandToolkitModel } = await import('../../../models/brandToolkits/functions');
    const toolkits = await BrandToolkitModel.findAllByUser(userIdNum);
    
    if (toolkits.length === 0) {
      return {
        success: true,
        toolName: 'get_brandtoolkits',
        output: {
          count: 0,
          toolkits: [],
          message: "No brand toolkits found. The user hasn't created any brand toolkits yet.",
        },
      };
    }
    
    const toolkitList = toolkits.map((t) => ({
      id: t.id,
      name: t.name,
      primaryBrandColor: t.primaryBrandColor,
      secondaryBrandColor: t.secondaryBrandColor,
      voiceType: t.voiceType,
      isDefault: t.isDefault,
    }));
    
    return {
      success: true,
      toolName: 'get_brandtoolkits',
      output: {
        count: toolkits.length,
        toolkits: toolkitList,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Get brand toolkits error');
    return {
      success: false,
      toolName: 'get_brandtoolkits',
      error: error.message,
    };
  }
}

/**
 * Get a specific brand toolkit by ID
 */
export async function executeGetBrandToolkit(
  input: { toolkit_id: number },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  
  try {
    const { BrandToolkitModel } = await import('../../../models/brandToolkits/functions');
    const toolkit = await BrandToolkitModel.findByIdAndUser(input.toolkit_id, userIdNum);
    
    if (!toolkit) {
      return {
        success: false,
        toolName: 'get_brandtoolkit',
        error: `Brand toolkit with ID ${input.toolkit_id} not found or you don't have access to it.`,
      };
    }
    
    return {
      success: true,
      toolName: 'get_brandtoolkit',
      output: {
        id: toolkit.id,
        name: toolkit.name,
        primaryBrandColor: toolkit.primaryBrandColor,
        secondaryBrandColor: toolkit.secondaryBrandColor,
        fontFamily: toolkit.fontFamily,
        voiceType: toolkit.voiceType,
        brandValues: toolkit.brandValues,
        defaultCtas: toolkit.defaultCtas,
        defaultHashtags: toolkit.defaultHashtags,
        isDefault: toolkit.isDefault,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Get brand toolkit error');
    return {
      success: false,
      toolName: 'get_brandtoolkit',
      error: error.message,
    };
  }
}

/**
 * Get all business profiles for the user
 */
export async function executeGetBusinessProfiles(
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  
  try {
    const { db } = await import('../../../models/db');
    const { companySettings } = await import('../../../models/companySettings/schema');
    const { eq, and } = await import('drizzle-orm');
    
    const profiles = await db.select().from(companySettings).where(and(eq(companySettings.userId, userIdNum),eq(companySettings.id,requireBusinessScope().businessProfileId)));
    
    if (profiles.length === 0) {
      return {
        success: true,
        toolName: 'get_businessprofiles',
        output: {
          count: 0,
          profiles: [],
          message: "No business profiles found. The user hasn't created any business profiles yet.",
        },
      };
    }
    
     
    const profileList = profiles.map((p: any) => ({
      id: p.id,
      name: p.name || p.companyName || 'Unnamed Profile',
      companyName: p.companyName,
      industry: p.industry,
      profileType: p.profileType,
      isDefault: p.isDefault,
    }));
    
    return {
      success: true,
      toolName: 'get_businessprofiles',
      output: {
        count: profiles.length,
        profiles: profileList,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Get business profiles error');
    return {
      success: false,
      toolName: 'get_businessprofiles',
      error: error.message,
    };
  }
}

/**
 * Get a specific business profile by ID
 */
export async function executeGetBusinessProfile(
  input: { profile_id: number },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  
  try {
    const { db } = await import('../../../models/db');
    const { companySettings } = await import('../../../models/companySettings/schema');
    const { eq, and } = await import('drizzle-orm');
    
    const [profile] = await db.select().from(companySettings).where(
      and(eq(companySettings.id, input.profile_id), eq(companySettings.userId, userIdNum),eq(companySettings.id,requireBusinessScope().businessProfileId))
    );
    
    if (!profile) {
      return {
        success: false,
        toolName: 'get_businessprofile',
        error: `Business profile with ID ${input.profile_id} not found or you don't have access to it.`,
      };
    }
    
    // Parse JSON fields safely
     
    const parseJson = (val: any) => {
      if (!val) return undefined;
      if (Array.isArray(val)) return val;
      try { return JSON.parse(val); } catch { return val; }
    };
    
    return {
      success: true,
      toolName: 'get_businessprofile',
      output: {
        id: profile.id,
        name: profile.name || profile.companyName || 'Unnamed Profile',
        profileType: profile.profileType,
        companyName: profile.companyName,
        industry: profile.industry,
        subIndustry: profile.subIndustry,
        companySize: profile.companySize,
        website: profile.website,
        description: profile.description,
        targetMarket: profile.targetMarket,
        valueProposition: profile.valueProposition,
        businessGoals: parseJson(profile.businessGoals),
        targetRegions: parseJson(profile.targetRegions),
        customerType: profile.customerType,
        keyBuyerRoles: parseJson(profile.keyBuyerRoles),
        preferredChannels: parseJson(profile.preferredChannels),
        brandTone: profile.brandTone,
        platforms: parseJson(profile.platforms),
        isDefault: profile.isDefault,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Get business profile error');
    return {
      success: false,
      toolName: 'get_businessprofile',
      error: error.message,
    };
  }
}

/** Image prompt for chat-generated images: same rules as Content Studio. */
export function toolImagePrompt(
  prompt: string,
  context: Pick<ToolContext, 'brandToolkit' | 'companyProfile'>,
  branding: { includeLogo: boolean; includeText: boolean } = { includeLogo: true, includeText: true },
): string {
  return buildImageGenerationPrompt({
    userPrompt: prompt,
    // A request that excludes text gets no brand reference at all, not even the brand name.
    brandContext: branding.includeText ? { brandToolkit: context.brandToolkit, businessProfile: context.companyProfile } : undefined,
    includeLogo: branding.includeLogo,
  });
}

export async function executeGenerateImage(
  input: { 
    prompt: string;
    provider?: 'google' | 'openrouter';
    model?: string;
    aspect_ratio?: string;
    image_size?: string;
    negative_prompt?: string;
    include_brand_logo?: boolean;
    seed?: number;
    for_content_type?: string;
    number_of_images?: number;
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const branding = mediaBrandingPolicy(input);
  
  // The request goes first and whole; brand data is visual-only. No tagline,
  // website or model-drawn logo: the approved logo is supplied as a reference.
  const enhancedPrompt = toolImagePrompt(input.prompt, context, branding);

  // Build image config from input params
   
  const imageConfig: Record<string, any> = {};
  imageConfig.brandLogoUrl = branding.includeLogo ? selectedBrandLogoUrl(context) : null;
  if (input.provider) imageConfig.provider = input.provider;
  if (input.model) imageConfig.model = input.model;
  if (input.aspect_ratio) imageConfig.aspectRatio = input.aspect_ratio;
  if (input.image_size) imageConfig.imageSize = input.image_size;
  if (input.negative_prompt) imageConfig.negativePrompt = input.negative_prompt;
  if (input.seed !== undefined) imageConfig.seed = input.seed;

  const numberOfImages = Math.min(Math.max(input.number_of_images || 1, 1), 4);

  // Generate multiple images if requested
  if (numberOfImages > 1) {
    const results: ToolResult[] = [];
    for (let i = 0; i < numberOfImages; i++) {
      const result = await executeGenerateImageDirect(enhancedPrompt, context, imageConfig, input.for_content_type);
      results.push(result);
    }
    const successCount = results.filter(r => r.success).length;
    return {
      success: successCount > 0,
      toolName: 'generate_image',
      output: {
        images: results.filter(r => r.success).map(r => r.output),
        totalGenerated: successCount,
        totalRequested: numberOfImages,
        message: `🖼️ Generated ${successCount}/${numberOfImages} images successfully.`,
      },
    };
  }

  // Use queue bridge for image generation when queues are available
  const directExecutor = async (): Promise<ToolResult> => {
    return executeGenerateImageDirect(enhancedPrompt, context, imageConfig, input.for_content_type);
  };

  const result = await dispatchAndWait(
    'generate_image',
    { prompt: enhancedPrompt, brandToolkit: context.brandToolkit, imageConfig, forContentType: input.for_content_type },
    context,
    directExecutor,
    { timeout: IMAGE_GENERATION_TIMEOUT_MS }
  );

  // When result came from queue worker (not direct path), save to content_assets
  // Direct path sets 'message' in output; queue path returns raw ImageGenerationResult without it
  if (result.success && result.output && !result.output.message) {
    const imageData = result.output.imageData;
    const imageUrl = result.output.imageUrl;
    let savedAssetId: number | undefined;
    let savedAssetCreatedAt: string | undefined;
    let persistenceError: string | undefined;
    try {
      const { createGeneratedAsset } = await import('../../../services/media/GeneratedMediaGallery');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;

      // Idempotent per stored file: a replayed tool call returns the same asset.
      const savedAsset = await createGeneratedAsset('image', imageUrl, {
        type: 'image',
        title: input.for_content_type && input.for_content_type !== 'general' ? `Image for ${input.for_content_type.replace('_', ' ')}` : 'Generated Image',
        // Store the durable URL. Raw JPEG base64 starts with "/9j/", so saving it
        // as content made it look like a storage path and failed the save.
        content: imageUrl || imageData || '',
        imageUrl: imageUrl || undefined,
        channel: input.for_content_type && input.for_content_type !== 'general' ? input.for_content_type : 'content_studio',
        status: 'draft',
        userId: userIdVal,
        threadId: threadIdVal,
        performance: { provider: result.output.provider, model: result.output.model, prompt: enhancedPrompt },
      });
      savedAssetId = savedAsset.id;
      savedAssetCreatedAt = savedAsset.createdAt.toISOString();
      logger.info({ threadId: context.threadId, assetId: savedAssetId }, '[Content Executor] Image saved to content_assets (via queue path)');
     
    } catch (saveErr: any) {
      persistenceError = saveErr?.message || 'Unknown persistence error';
      logger.warn({ err: saveErr }, '[Content Executor] Failed to save image from queue path');
    }

    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.CONTENT_PREVIEW,
      tabLabel: 'Generated Image',
      data: {
        type: 'image',
        imageData,
        assetId: savedAssetId,
        createdAt: savedAssetCreatedAt,
        persistenceStatus: savedAssetId ? 'succeeded' : 'failed',
      },
    });

    if (!savedAssetId) {
      return {
        success: false,
        toolName: 'generate_image',
        error: 'The image was generated but could not be saved as a durable asset.',
        output: {
          status: 'failed',
          imageStatus: 'succeeded',
          persistenceStatus: 'failed',
          persistenceError,
          provider: result.output.provider,
          model: result.output.model,
          message: '⚠️ The image was generated for preview, but persistence failed. No durable asset was created.',
        },
      };
    }

    // Return formatted ToolResult
    return {
      success: true,
      toolName: 'generate_image',
      output: {
        imageData,
        imageUrl,
        provider: result.output.provider,
        model: result.output.model,
        status: 'succeeded',
        persistenceStatus: 'succeeded',
        assetId: savedAssetId,
        assetIds: [savedAssetId],
        createdAt: savedAssetCreatedAt,
        message: `🖼️ Image generated and saved as asset #${savedAssetId}. You can view it in the Content Preview tab.`,
      },
    };
  }

  return result;
}

/**
 * Direct (inline) image generation — used as fallback when queues are unavailable
 */
async function executeGenerateImageDirect(
  enhancedPrompt: string,
  context: ToolContext,
   
  imageConfig?: Record<string, any>,
  forContentType?: string
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  
  try {
    const { createImageGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
    const imageGenerationWorker = createImageGenerationWorker(userIdNum, toNumber(context.threadId));
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    
    webSocketEmitter.emit(userIdNum, 'tool_status', {
      toolName: 'generate_image',
      status: 'processing',
      message: 'Generating image...',
    });
    
    const result = await imageGenerationWorker.generateFromText(enhancedPrompt, imageConfig);
    
    if (!result.success) {
      // Use a placeholder image when generation fails (e.g., rate limit)
      const isRateLimitError = result.error?.includes('429') || result.error?.includes('quota') || result.error?.includes('rate');
      const placeholderImageData = 'data:image/svg+xml;base64,' + Buffer.from(`
        <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#f0f0f0"/>
          <text x="50%" y="45%" font-family="Arial" font-size="16" text-anchor="middle" fill="#666">
            ${isRateLimitError ? '⏳ Image generation temporarily unavailable' : '⚠️ Image generation failed'}
          </text>
          <text x="50%" y="55%" font-family="Arial" font-size="12" text-anchor="middle" fill="#888">
            ${isRateLimitError ? 'API rate limit reached - please try again later' : 'Please try again'}
          </text>
        </svg>
      `).toString('base64');
      
      // Still open the content preview tab with a placeholder
      webSocketEmitter.emit(userIdNum, 'open_tab', {
        thread_id: toNumber(context.threadId),
        tabType: TAB_TYPES.CONTENT_PREVIEW,
        tabLabel: 'Image Placeholder',
        data: { 
          type: 'image', 
          imageData: placeholderImageData,
          isPlaceholder: true,
          error: result.error,
        },
      });
      
      return {
        success: false,
        toolName: 'generate_image',
        error: result.error || 'Image generation failed',
        output: {
          isPlaceholder: true,
          message: isRateLimitError 
            ? '⏳ Image generation is temporarily unavailable due to API rate limits. A placeholder has been added. Please try again in a few minutes.'
            : `⚠️ Image generation encountered an issue: ${result.error}. A placeholder has been added.`,
        },
      };
    }

    // Save to content_assets table
    let savedAssetId: number | undefined;
    let savedAssetCreatedAt: string | undefined;
    let persistenceError: string | undefined;
    try {
      const { createGeneratedAsset } = await import('../../../services/media/GeneratedMediaGallery');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;
      const imageUrl = result.imageUrl || undefined;

      const savedAsset = await createGeneratedAsset('image', imageUrl, {
        type: 'image',
        title: forContentType && forContentType !== 'general' ? `Image for ${forContentType.replace('_', ' ')}` : 'Generated Image',
        content: imageUrl || result.imageData || '',
        imageUrl: imageUrl,
        channel: forContentType && forContentType !== 'general' ? forContentType : 'content_studio',
        status: 'draft',
        userId: userIdVal,
        threadId: threadIdVal,
        performance: { provider: result.provider, model: result.model, prompt: enhancedPrompt },
      });
      savedAssetId = savedAsset.id;
      savedAssetCreatedAt = savedAsset.createdAt.toISOString();
      logger.info({ threadId: context.threadId, assetId: savedAssetId }, '[Content Executor] Image saved to content_assets');
     
    } catch (saveError: any) {
      persistenceError = saveError?.message || 'Unknown persistence error';
      logger.warn({ err: saveError }, '[Content Executor] Failed to save image to database');
    }

    // Open the preview after persistence so the visual card and chat result
    // carry the exact same durable resource identity and timestamp.
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.CONTENT_PREVIEW,
      tabLabel: 'Generated Image',
      data: {
        type: 'image',
        imageData: result.imageData,
        assetId: savedAssetId,
        createdAt: savedAssetCreatedAt,
        persistenceStatus: savedAssetId ? 'succeeded' : 'failed',
      },
    });

    if (!savedAssetId) {
      return {
        success: false,
        toolName: 'generate_image',
        error: 'The image was generated but could not be saved as a durable asset.',
        output: {
          status: 'failed',
          imageStatus: 'succeeded',
          persistenceStatus: 'failed',
          persistenceError,
          provider: result.provider,
          model: result.model,
          message: '⚠️ The image was generated for preview, but persistence failed. No durable asset was created.',
        },
      };
    }

    return {
      success: true,
      toolName: 'generate_image',
      output: {
        imageData: result.imageData,
        mimeType: result.mimeType,
        fileName: result.fileName,
        provider: result.provider,
        model: result.model,
        status: 'succeeded',
        persistenceStatus: 'succeeded',
        assetId: savedAssetId,
        assetIds: [savedAssetId],
        createdAt: savedAssetCreatedAt,
        brandToolkitUsed: context.brandToolkit?.name || null,
        forContentType: forContentType || 'general',
        message: `🖼️ Image generated and saved as asset #${savedAssetId}. You can view it in the Content Preview tab.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Image generation error');
    return {
      success: false,
      toolName: 'generate_image',
      error: error.message,
    };
  }
}

/**
 * Brand guidance for chat video prompts. Only visual direction (colours, mood)
 * goes to the model: taglines, intro/outro text, website and the logo are never
 * requested from it, because video models redraw logos (distorted) and re-spell
 * words ("Todle" became "Toddle"). The media factory adds exact-spelling rules
 * for the "- Brand:" names below and overlays the real logo after generation.
 */
export function chatVideoBrandPrompt(prompt: string, context: Pick<ToolContext, 'brandToolkit'>): string {
  const toolkit = context.brandToolkit as (ToolContext['brandToolkit'] & { name?: string; primaryBrandColor?: string; secondaryBrandColor?: string; voiceType?: string }) | undefined;
  if (!toolkit) return prompt;
  const guidance: string[] = [];
  if (toolkit.name) guidance.push(`- Brand: ${toolkit.name}`);
  if (toolkit.primaryBrandColor) guidance.push(`- Primary colour theme: ${toolkit.primaryBrandColor}`);
  if (toolkit.secondaryBrandColor) guidance.push(`- Accent colour: ${toolkit.secondaryBrandColor}`);
  if (toolkit.voiceType) guidance.push(`- Visual mood: ${toolkit.voiceType}`);
  return guidance.length ? `${prompt}\n\nBrand guidelines for the video (visual direction only):\n${guidance.join('\n')}` : prompt;
}

export async function executeGenerateVideo(
  input: { 
    prompt: string;
    provider?: 'google' | 'openrouter';
    model?: string;
    aspect_ratio?: string;
    resolution?: string;
    duration_seconds?: number;
    number_of_videos?: number;
    person_generation?: string;
    negative_prompt?: string;
    include_brand_logo?: boolean;
    generate_audio?: boolean;
    seed?: number;
    for_content_type?: string;
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const branding = mediaBrandingPolicy(input);
  // Build enhanced prompt with brand toolkit
  let enhancedPrompt = input.prompt;
  if (context.brandToolkit) {
    enhancedPrompt = chatVideoBrandPrompt(input.prompt, context);
  }

  // Build video config — only Veo-supported params
   
  const videoConfig: Record<string, any> = {};
  videoConfig.brandLogoUrl = branding.includeLogo ? selectedBrandLogoUrl(context) : null;
  if (input.provider) videoConfig.provider = input.provider;
  if (input.model) videoConfig.model = input.model;
  if (input.aspect_ratio) videoConfig.aspectRatio = input.aspect_ratio;
  if (input.resolution) videoConfig.resolution = input.resolution;
  if (input.duration_seconds !== undefined) videoConfig.durationSeconds = input.duration_seconds;
  if (input.number_of_videos !== undefined) videoConfig.numberOfVideos = input.number_of_videos;
  if (input.person_generation) videoConfig.personGeneration = input.person_generation;
  if (input.negative_prompt) videoConfig.negativePrompt = input.negative_prompt;
  if (input.generate_audio !== undefined) videoConfig.generateAudio = input.generate_audio;
  if (input.seed !== undefined) videoConfig.seed = input.seed;
  // Note: resolution, fps, enhancePrompt, generateAudio are NOT supported by Veo API

  // Use queue bridge for video generation (long-running operation)
  const directExecutor = async (): Promise<ToolResult> => {
    return executeGenerateVideoDirect(enhancedPrompt, context, videoConfig, input.for_content_type);
  };

  const result = await dispatchAndWait(
    'generate_video',
    { prompt: enhancedPrompt, brandToolkit: context.brandToolkit, videoConfig, forContentType: input.for_content_type },
    context,
    directExecutor,
    { timeout: VIDEO_GENERATION_TIMEOUT_MS }
  );

  // When result came from queue worker (not direct path), save to content_assets
  // Direct path sets 'message' in output; queue path returns raw VideoGenerationResult without it
  if (result.success && result.output && !result.output.message) {
    const videoUrl = result.output.videoUrl;
    if (!videoUrl) {
      return {
        success: false,
        toolName: 'generate_video',
        error: 'The video provider completed without returning a durable media URL.',
        output: { status: 'failed', provider: result.output.provider, model: result.output.model },
      };
    }
    let savedVideoId: number | undefined;
    try {
      const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
      webSocketEmitter.emit(userIdNum, 'open_tab', {
        thread_id: toNumber(context.threadId),
        tabType: TAB_TYPES.CONTENT_PREVIEW,
        tabLabel: 'Generated Video',
        data: { type: 'video', videoUrl },
      });

      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;

      const savedVideo = await ContentAssetModel.create({
        type: 'video',
        title: input.for_content_type && input.for_content_type !== 'general' ? `Video for ${input.for_content_type.replace('_', ' ')}` : 'Generated Video',
        content: videoUrl || '',
        videoUrl: videoUrl || undefined,
        metadata: withVideoProbeMetadata(videoUrl, result.output.mediaProbe),
        channel: input.for_content_type && input.for_content_type !== 'general' ? input.for_content_type : 'content_studio',
        status: 'draft',
        userId: userIdVal,
        threadId: threadIdVal,
        performance: { provider: result.output.provider, model: result.output.model, prompt: enhancedPrompt },
      });
      savedVideoId = savedVideo?.id;
      logger.info({ threadId: context.threadId }, '[Content Executor] Video saved to content_assets (via queue path)');
     
    } catch (saveErr: any) {
      logger.warn({ err: saveErr }, '[Content Executor] Failed to save video from queue path');
    }

    if (!savedVideoId) {
      return {
        success: false,
        toolName: 'generate_video',
        error: 'The video was generated but could not be saved as a durable content asset.',
        output: { status: 'partial_success', videoUrl, provider: result.output.provider, model: result.output.model },
      };
    }

    // Return formatted ToolResult
    return {
      success: true,
      toolName: 'generate_video',
      output: {
        videoUrl: result.output.videoUrl,
        mimeType: result.output.mimeType,
        fileName: result.output.fileName,
        provider: result.output.provider,
        model: result.output.model,
        assetId: savedVideoId,
        message: '🎬 Video generated successfully! You can view it in the Content Preview tab.',
      },
    };
  }

  return result;
}

/**
 * Direct (inline) video generation — used as fallback when queues are unavailable
 */
async function executeGenerateVideoDirect(
  enhancedPrompt: string,
  context: ToolContext,
   
  videoConfig?: Record<string, any>,
  forContentType?: string
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  
  try {
    const { createVideoGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
    const videoGenerationWorker = createVideoGenerationWorker(userIdNum, toNumber(context.threadId));
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    
    // Emit status for long-running operation
    webSocketEmitter.emit(userIdNum, 'tool_status', {
      toolName: 'generate_video',
      status: 'processing',
      message: 'Video generation started. This may take several minutes...',
    });

    const result = await videoGenerationWorker.generateFromText(enhancedPrompt, videoConfig);
    if (!result.success) {
      return {
        success: false,
        toolName: 'generate_video',
        error: result.error || 'Video generation failed',
      };
    }
    if (result.status === 'pending') {
      return persistPendingVideo('generate_video', enhancedPrompt, result, videoConfig, context, forContentType);
    }

    if (!result.videoUrl) {
      return {
        success: false,
        toolName: 'generate_video',
        error: 'The video provider completed without returning a durable media URL.',
        output: { status: 'failed', provider: result.provider, model: result.model },
      };
    }

    // Open video preview tab
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.CONTENT_PREVIEW,
      tabLabel: 'Generated Video',
      data: { type: 'video', videoUrl: result.videoUrl },
    });

    // Save to content_assets table
    let savedVideoId: number | undefined;
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;
      const videoUrl = result.videoUrl || undefined;
      
      const savedVideo = await ContentAssetModel.create({
        type: 'video',
        title: forContentType && forContentType !== 'general' ? `Video for ${forContentType.replace('_', ' ')}` : 'Generated Video',
        content: videoUrl || result.videoData || '',
        videoUrl: videoUrl,
        metadata: withVideoProbeMetadata(videoUrl, result.mediaProbe),
        channel: forContentType && forContentType !== 'general' ? forContentType : 'content_studio',
        status: 'draft',
        userId: userIdVal,
        threadId: threadIdVal,
        performance: { provider: result.provider, model: result.model, prompt: enhancedPrompt },
      });
      savedVideoId = savedVideo?.id;
      logger.info({ threadId: context.threadId }, '[Content Executor] Video saved to content_assets');
     
    } catch (saveError: any) {
      logger.warn({ err: saveError }, '[Content Executor] Failed to save video to database');
    }


    if (!savedVideoId) {
      return {
        success: false,
        toolName: 'generate_video',
        error: 'The video was generated but could not be saved as a durable content asset.',
        output: { status: 'partial_success', videoUrl: result.videoUrl, provider: result.provider, model: result.model },
      };
    }

    return {
      success: true,
      toolName: 'generate_video',
      output: {
        videoData: result.videoData,
        videoUrl: result.videoUrl,
        mimeType: result.mimeType,
        fileName: result.fileName,
        provider: result.provider,
        model: result.model,
        assetId: savedVideoId,
        brandToolkitUsed: context.brandToolkit?.name || null,
        forContentType: forContentType || 'general',
        message: '🎬 Video generated successfully! You can view it in the Content Preview tab.',
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Video generation error');
    return {
      success: false,
      toolName: 'generate_video',
      error: error.message,
    };
  }
}

export async function executeGenerateImageFromImage(
  input: { 
    prompt: string; 
    provider?: 'google' | 'openrouter';
    model?: string;
    source_image_id?: string;
    aspect_ratio?: string;
    image_size?: string;
    number_of_images?: number;
    negative_prompt?: string;
    include_brand_logo?: boolean;
    seed?: number;
    for_content_type?: string;
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const branding = mediaBrandingPolicy(input);
  
  try {
    const { createImageGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
    const imageGenerationWorker = createImageGenerationWorker(userIdNum, toNumber(context.threadId), {
      provider: input.provider,
      model: input.model,
    });
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    
    // Retrieve source image from content assets (with thread fallback)
    const threadIdNum = toNumber(context.threadId);
    const sourceImageBase64 = await resolveSourceImageBase64(input.source_image_id, userIdNum, threadIdNum);
    
    if (!sourceImageBase64) {
      return {
        success: false,
        toolName: 'generate_image_from_image',
        error: 'Source image not found. Please provide a valid source_image_id or generate an image first in this thread.',
      };
    }
    
    // Emit status
    webSocketEmitter.emit(userIdNum, 'tool_status', {
      toolName: 'generate_image_from_image',
      status: 'processing',
      message: 'Transforming image...',
    });
    
    const enhancedPrompt = toolImagePrompt(input.prompt, context, branding);
    
    // Build image config from input params
     
    const imageConfig: Record<string, any> = {};
    imageConfig.brandLogoUrl = branding.includeLogo ? selectedBrandLogoUrl(context) : null;
    if (input.provider) imageConfig.provider = input.provider;
    if (input.model) imageConfig.model = input.model;
    if (input.aspect_ratio) imageConfig.aspectRatio = input.aspect_ratio;
    if (input.image_size) imageConfig.imageSize = input.image_size;
    if (input.negative_prompt) imageConfig.negativePrompt = input.negative_prompt;
    if (input.seed !== undefined) imageConfig.seed = input.seed;
    
    const result = await imageGenerationWorker.generateFromImage(enhancedPrompt, sourceImageBase64.base64, sourceImageBase64.mimeType, imageConfig);

    if (!result.success) {
      return {
        success: false,
        toolName: 'generate_image_from_image',
        error: result.error || 'Image transformation failed',
      };
    }
    
    // Open content preview tab
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.CONTENT_PREVIEW,
      tabLabel: 'Transformed Image',
      data: { type: 'image', imageData: result.imageData, imageUrl: result.imageUrl, persistenceStatus: 'pending' },
    });

    // Save the transformed image before reporting a durable result.
    let transformedAssetId: number | undefined;
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;
      const imageUrl = result.imageUrl || undefined;
      
      const transformedAsset = await ContentAssetModel.create({
        type: 'image',
        title: input.for_content_type && input.for_content_type !== 'general' ? `Transformed Image for ${input.for_content_type.replace('_', ' ')}` : 'Transformed Image',
        content: imageUrl || result.imageData || '',
        imageUrl: imageUrl,
        channel: input.for_content_type && input.for_content_type !== 'general' ? input.for_content_type : 'content_studio',
        status: 'draft',
        userId: userIdVal,
        threadId: threadIdVal,
        performance: { provider: result.provider, model: result.model, prompt: enhancedPrompt },
      });
      transformedAssetId = transformedAsset.id;
      logger.info({ threadId: context.threadId }, '[Content Executor] Transformed image saved to content_assets');
     
    } catch (saveError: any) {
      logger.error({ err: saveError }, '[Content Executor] Failed to save transformed image to content_assets');
    }

    if (!transformedAssetId) return unsavedGeneratedContent('generate_image_from_image', { imageData: result.imageData, imageUrl: result.imageUrl });

    return {
      success: true,
      toolName: 'generate_image_from_image',
      output: {
        assetId: transformedAssetId,
        persistenceStatus: 'succeeded',
        imageUrl: result.imageUrl,
        imageData: result.imageData,
        mimeType: result.mimeType,
        fileName: result.fileName,
        provider: result.provider,
        model: result.model,
        brandToolkitUsed: context.brandToolkit?.name || null,
        message: '🖼️ Image transformed successfully! Check the Content Preview tab.',
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Image from image error');
    return {
      success: false,
      toolName: 'generate_image_from_image',
      error: error.message,
    };
  }
}

export async function executeGenerateVideoFromImage(
  input: { 
    prompt: string; 
    provider?: 'google' | 'openrouter';
    model?: string;
    source_image_id?: string;
    image_role?: 'reference' | 'start_frame';
    aspect_ratio?: string;
    resolution?: string;
    duration_seconds?: number;
    fps?: number;
    number_of_videos?: number;
    person_generation?: string;
    negative_prompt?: string;
    include_brand_logo?: boolean;
    enhance_prompt?: boolean;
    generate_audio?: boolean;
    seed?: number;
    for_content_type?: string;
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const branding = mediaBrandingPolicy(input);
  
  try {
    const { createVideoGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
    const videoGenerationWorker = createVideoGenerationWorker(userIdNum, toNumber(context.threadId), {
      provider: input.provider,
      model: input.model,
    });
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    
    // Retrieve source image from content assets (with thread fallback)
    const threadIdNum = toNumber(context.threadId);
    const sourceImageBase64 = await resolveSourceImageBase64(input.source_image_id, userIdNum, threadIdNum);
    
    if (!sourceImageBase64) {
      return {
        success: false,
        toolName: 'generate_video_from_image',
        error: 'Source image not found. Please provide a valid source_image_id or generate an image first in this thread.',
      };
    }
    
    // Emit status for long-running operation
    webSocketEmitter.emit(userIdNum, 'tool_status', {
      toolName: 'generate_video_from_image',
      status: 'processing',
      message: 'Animating image into video... This may take a few minutes.',
    });
    
    // Visual brand direction only; logo and brand text are handled by the factory.
    const enhancedPrompt = chatVideoBrandPrompt(input.prompt, context);

    // Build video config from input params
     
    const videoConfig: Record<string, any> = {};
    videoConfig.brandLogoUrl = branding.includeLogo ? selectedBrandLogoUrl(context) : null;
    if (input.provider) videoConfig.provider = input.provider;
    if (input.model) videoConfig.model = input.model;
    if (input.aspect_ratio) videoConfig.aspectRatio = input.aspect_ratio;
    if (input.resolution) videoConfig.resolution = input.resolution;
    if (input.duration_seconds !== undefined) videoConfig.durationSeconds = input.duration_seconds;
    if (input.fps !== undefined) videoConfig.fps = input.fps;
    if (input.number_of_videos !== undefined) videoConfig.numberOfVideos = input.number_of_videos;
    if (input.person_generation) videoConfig.personGeneration = input.person_generation;
    if (input.negative_prompt) videoConfig.negativePrompt = input.negative_prompt;
    if (input.enhance_prompt !== undefined) videoConfig.enhancePrompt = input.enhance_prompt;
    if (input.generate_audio !== undefined) videoConfig.generateAudio = input.generate_audio;
    if (input.seed !== undefined) videoConfig.seed = input.seed;
    // Reference (default): the prompt directs the scene. start_frame: the video opens on the exact image.
    videoConfig.imageRole = input.image_role === 'start_frame' ? 'start_frame' : 'reference';

    const result = await videoGenerationWorker.generateFromImage(enhancedPrompt, sourceImageBase64.base64, sourceImageBase64.mimeType, videoConfig);
    if (!result.success) {
      return {
        success: false,
        toolName: 'generate_video_from_image',
        error: result.error || 'Video generation from image failed',
      };
    }
    if (result.status === 'pending') {
      return persistPendingVideo('generate_video_from_image', enhancedPrompt, result, videoConfig, context, input.for_content_type);
    }
    
    if (!result.videoUrl) return { success: false, toolName: 'generate_video_from_image', error: 'The video provider completed without returning a durable media URL.' };

    // Open video preview tab
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.CONTENT_PREVIEW,
      tabLabel: 'Animated Video',
      data: { type: 'video', videoUrl: result.videoUrl, videoData: result.videoData },
    });

    // Save the animation before reporting a durable result.
    let animatedAssetId: number | undefined;
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;
      
      const animatedAsset = await ContentAssetModel.create({
        type: 'video',
        title: input.for_content_type && input.for_content_type !== 'general' ? `Video for ${input.for_content_type.replace('_', ' ')}` : 'Generated Video',
        content: JSON.stringify({ 
          videoUrl: result.videoUrl, 
          videoData: result.videoData,
          mimeType: result.mimeType,
          fileName: result.fileName 
        }),
        videoUrl: result.videoUrl || null,
        videoUrls: result.videoUrl ? [result.videoUrl] : [],
        metadata: withVideoProbeMetadata(result.videoUrl, result.mediaProbe),
        channel: input.for_content_type && input.for_content_type !== 'general' ? input.for_content_type : 'content_studio',
        status: 'draft',
        userId: userIdVal,
        threadId: threadIdVal,
        performance: { provider: result.provider, model: result.model, prompt: enhancedPrompt },
      });
      animatedAssetId = animatedAsset.id;
      logger.info({ threadId: context.threadId }, '[Content Executor] Generated video saved to content_assets');
     
    } catch (saveError: any) {
      logger.error({ err: saveError }, '[Content Executor] Failed to save generated video to content_assets');
    }

    if (!animatedAssetId) return unsavedGeneratedContent('generate_video_from_image', { videoUrl: result.videoUrl });

    return {
      success: true,
      toolName: 'generate_video_from_image',
      output: {
        assetId: animatedAssetId,
        persistenceStatus: 'succeeded',
        videoData: result.videoData,
        videoUrl: result.videoUrl,
        mimeType: result.mimeType,
        fileName: result.fileName,
        provider: result.provider,
        model: result.model,
        brandToolkitUsed: context.brandToolkit?.name || null,
        message: '🎬 Video created from image! Check the Content Preview tab.',
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Video from image error');
    return {
      success: false,
      toolName: 'generate_video_from_image',
      error: error.message,
    };
  }
}

type SocialPostInput = Parameters<typeof executeGenerateSocialMediaPost>[0];

/** Reviewed rules applied to every generated social post, plus one targeted
 * provider rewrite for a post that breaks them (usually length). */
const SOCIAL_PLATFORM_NAMES: Record<string, string> = {
  linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', twitter: 'X', x: 'X',
  tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads',
};

/** "linkedin" -> "LinkedIn", for titles the user reads. */
export function socialPlatformName(platform: string): string {
  const key = String(platform || '').trim().toLowerCase();
  return SOCIAL_PLATFORM_NAMES[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Social');
}

function socialPostRules(input: SocialPostInput, context: ToolContext, userId: number, validationPlatform: string) {
  const includeCta = input.include_cta !== false;
  const limit = socialCharacterLimit('social', validationPlatform);
  return {
    finalize: (post: SocialPost): SocialPost => {
      applyReviewedMediaExclusions(post, input);
      if (includeCta) {
        post.caption = withExactCallToAction(post.caption, input.cta_text);
        if (input.cta_text?.trim()) post.callToAction = input.cta_text.trim();
      }
      return post;
    },
    validate: (post: SocialPost) => validateGeneratedContent({
      type: 'social', output: post, context: resolvedPolicyContext(context), platform: validationPlatform,
    }),
    repairPost: async (post: SocialPost, problems: string[]): Promise<unknown> => {
      const response = await createCompletionWithProviderFallback(userId, {
        messages: [
          { role: 'system', content: 'Correct one social media post. Return only the corrected JSON object with the same fields. Reviewed requirements take priority over brand defaults.' },
          { role: 'user', content: `Rewrite this post so it fixes every problem below. Keep its topic, language and tone.${limit ? ` The caption, call to action and hashtags combined must be at most ${limit} characters; use fewer hashtags if needed.` : ''}${includeCta && input.cta_text ? ' Do not add another call to action; the application appends the reviewed one.' : ''}\nProblems:\n- ${problems.join('\n- ')}\nPost JSON:\n${JSON.stringify(post).slice(0, 20_000)}` },
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' },
        loggingContext: { userId: context.userId, threadId: context.threadId, purpose: 'content_generation', service: 'ContentExecutor', action: 'repair_social_post' },
      });
      if (!response.success) throw new ContentComplianceError([...problems, 'Automatic shortening was unavailable.']);
      const repaired = extractJsonObject(response.content || '{}');
      // Keep the reviewed title when the rewrite drops it.
      return repaired && typeof repaired === 'object' && !Array.isArray(repaired)
        ? { title: post.title, ...(repaired as Record<string, unknown>) } : repaired;
    },
  };
}

/** A content plan / calendar / series: N separate posts, each validated
 * against the per-post limit and saved as its own draft asset. */
async function executeGenerateSocialPostSeries(input: SocialPostInput, context: ToolContext): Promise<ToolResult> {
  const toolName = 'generate_social_media_post';
  const userIdNum = toNumber(context.userId);
  const threadIdNum = toNumber(context.threadId);
  const platform = input.platform || 'all';
  const isUniversal = platform === 'all';
  const validationPlatform = isUniversal ? 'twitter' : platform;
  const total = seriesPostCount(input.number_of_posts);
  const limit = socialCharacterLimit('social', validationPlatform);
  const includeCta = input.include_cta !== false;
  const includeHashtags = input.hashtags !== false;
  const numHashtags = input.number_of_hashtags || 5;
  const lengthInstruction = input.length === 'short' ? '1-2 lines' : input.length === 'long' ? '6+ lines' : '3-5 lines';
  const platformLabel = isUniversal ? 'universal (LinkedIn, X, Facebook and Instagram)' : platform;
  const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
  const progress = (done: number, message: string) => {
    if (!context.widgetId) return;
    webSocketEmitter.emit(userIdNum, 'widget_update', {
      thread_id: threadIdNum,
      widget: { id: context.widgetId, status: 'running', progress: { completed: done, total, message } },
    });
  };
  progress(0, `Writing ${total} ${platform === 'all' ? '' : `${platform} `}posts…`);

  const requirements = `- Tone: ${input.tone || context.brandToolkit?.voiceType || 'professional'}
- Length of each post: ${lengthInstruction}${limit ? `\n- Each post's caption, call to action and hashtags combined must be at most ${limit} characters.` : ''}
- Language: ${input.language || 'English'}
- Format: ${input.post_format || 'text'}
${input.include_emojis !== false ? '- Include relevant emojis' : '- Do NOT use any emojis'}
${includeCta ? input.cta_text ? '- Do not invent a CTA; the application appends the exact reviewed CTA separately.' : '- End each post with a short call to action' : '- No call to action'}
${includeHashtags ? `- Include exactly ${numHashtags} relevant hashtags per post in the hashtags array` : '- No hashtags'}
${(input.include_image_prompt || input.auto_generate_image) ? '- Include an imagePrompts array with one detailed image prompt per post' : ''}
${context.brandContextPrompt || (context.brandToolkit ? `Brand: ${context.brandToolkit.name}; voice: ${context.brandToolkit.voiceType || 'Professional'}` : '')}

ICP: ${JSON.stringify(context.icpProfile ?? null).slice(0, 4000)}

USER-REVIEWED CONTENT CONSTRAINTS (override brand defaults): ${input.content_instructions || 'Follow the reviewed fields above.'}`;

  const rules = socialPostRules(input, context, userIdNum, validationPlatform);
  const results = await generateSocialPostSeries(total, {
    ...rules,
    requestBatch: async (start, size, earlierTitles) => {
      const response = await createCompletionWithProviderFallback(userIdNum, {
        messages: [
          { role: 'system', content: 'Generate a series of separate social media posts as the requested JSON. Each post is complete and publishable on its own. Reviewed requirements take priority over brand defaults.' },
          { role: 'user', content: `Write posts ${start + 1} to ${start + size} of a ${total}-post ${platformLabel} content plan about "${input.topic}".
${requirements}
${earlierTitles.length ? `Earlier posts in this plan (do not repeat their angle): ${earlierTitles.join(' | ')}` : ''}

Return raw JSON only: {"posts":[{"day":number,"title":"max 50 chars","caption":string,"hashtags":string[],"keywords":string[],"imagePrompts"?:string[]}]} with exactly ${size} posts, numbered from day ${start + 1}.` },
        ],
        temperature: 0.8,
        response_format: { type: 'json_object' },
        loggingContext: { userId: context.userId, threadId: context.threadId, purpose: 'content_generation', service: 'ContentExecutor', action: 'generate_social_post_series' },
      });
      if (!response.success) throw new Error(response.error || 'provider_failed');
      return extractJsonObject(response.content || '{}');
    },
    onProgress: (done, count) => progress(done, `Wrote ${done} of ${count} posts…`),
  });

  const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
  const saved: Array<{ number: number; assetId: number; title: string }> = [];
  const failed: Array<{ number: number; reason: string }> = [];
  for (const result of results) {
    if (!result.post) { failed.push({ number: result.number, reason: toUserFacingError(result.error || '', 'This post could not be generated.') }); continue; }
    const post = result.post;
    const title = `Day ${result.number}: ${String(post.title || input.topic).slice(0, 120)}`;
    try {
      const asset = await ContentAssetModel.create({
        type: 'social_post', title: title.slice(0, 150), content: JSON.stringify({ ...post, seriesPosition: result.number, seriesTotal: total }),
        imageUrl: null, imageUrls: [], videoUrl: null, videoUrls: [], metadata: { series: { position: result.number, total, topic: input.topic.slice(0, 200) } },
        channel: isUniversal ? 'all' : platform, status: 'draft', userId: userIdNum || null, threadId: threadIdNum || null, performance: null,
        ...policyPersistence(context, 'social', isUniversal ? 'all' : platform),
      });
      saved.push({ number: result.number, assetId: asset.id, title });
    } catch (error) {
      logger.warn({ err: error, position: result.number }, '[Content Executor] Failed to save series post');
      failed.push({ number: result.number, reason: 'The post was written but could not be saved. Check the content library before generating it again.' });
    }
  }
  progress(results.length, `Saved ${saved.length} of ${total} posts.`);

  const mediaRequested = explicitlyRequestedMedia(input);
  const warnings = [
    ...((mediaRequested.image || mediaRequested.video) ? ['Images and videos are not generated automatically for a multi-post plan. Open a saved post to generate its media.'] : []),
    ...failed.map(item => `Post ${item.number}: ${item.reason}`),
  ];
  if (!saved.length) {
    return {
      success: false, toolName,
      error: `None of the ${total} posts could be generated. ${failed[0] ? failed[0].reason : ''} Nothing was saved. Adjust the review settings and run it again.`.replace(/\s+/g, ' ').trim(),
      output: { status: 'failed', retrySafe: true, reason: 'content_validation_failed', postCount: total, savedCount: 0, failedPosts: failed },
    };
  }
  const first = results.find(result => result.post)?.post;
  if (first) {
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: threadIdNum, tabType: TAB_TYPES.SOCIAL_POST_PREVIEW,
      tabLabel: `${isUniversal ? 'Universal' : socialPlatformName(platform)} plan (${saved.length} ${saved.length === 1 ? 'post' : 'posts'})`,
      data: { post: first, platform, generatedImages: [], generatedVideos: [], isUniversal, posts: saved },
    });
  }
  return {
    success: true, toolName,
    output: {
      assetId: saved[0].assetId,
      assetIds: saved.map(item => item.assetId),
      ...(failed.length ? { status: 'partial_success', retrySafe: false } : {}),
      platform, isUniversal, postCount: total, savedCount: saved.length, posts: saved, failedPosts: failed, warnings,
      imageStatus: 'not_requested', videoStatus: 'not_requested',
      message: `${saved.length} of ${total} ${isUniversal ? 'universal' : platform} posts saved as separate drafts${limit ? `, each within the ${limit.toLocaleString('en-US')}-character limit` : ''}.${failed.length ? ` ${failed.length} could not be generated; see the warnings.` : ''} Review them in the content library before scheduling or publishing.`,
    },
  };
}

export async function executeGenerateSocialMediaPost(
  input: {
    platform: 'linkedin' | 'twitter' | 'facebook' | 'instagram' | 'all';
    topic: string;
    tone?: 'professional' | 'casual' | 'funny' | 'inspirational' | 'informative' | 'provocative';
    length?: 'short' | 'medium' | 'long';
    language?: string;
    include_emojis?: boolean;
    include_cta?: boolean;
    cta_text?: string;
    content_instructions?: string;
    post_format?: 'text' | 'carousel' | 'story' | 'reel';
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
    video_aspect_ratio?: string;
    video_resolution?: string;
    video_duration_seconds?: number;
    video_count?: number;
    hashtags?: boolean;
    number_of_hashtags?: number;
    brand_toolkit_id?: number;
    number_of_posts?: number;
  },
  context: ToolContext
): Promise<ToolResult> {
  if (seriesPostCount(input.number_of_posts) > 1) return executeGenerateSocialPostSeries(input, context);
  const userIdNum = toNumber(context.userId);
  const platform = input.platform || 'all';
  const isUniversal = platform === 'all';
  const tone = input.tone || context.brandToolkit?.voiceType || 'professional';
  const language = input.language || 'English';
  const length = input.length || 'medium';
  const includeEmojis = input.include_emojis !== false;
  const includeCta = input.include_cta !== false;
  const includeHashtags = input.hashtags !== false;
  const numHashtags = input.number_of_hashtags || 5;
  const postFormat = input.post_format || 'text';
  
  try {
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');

    // Build brand toolkit context
    let brandContext = '';
    if (context.brandToolkit) {
      brandContext = `
Brand Guidelines:
- Brand: ${context.brandToolkit.name}
- Voice/Tone: ${context.brandToolkit.voiceType || 'Professional'}
- Brand Values: ${Array.isArray(context.brandToolkit.brandValues) ? context.brandToolkit.brandValues.join(', ') : 'Not specified'}
${context.brandToolkit.defaultHashtags?.length ? `- Default Hashtags: ${context.brandToolkit.defaultHashtags.join(', ')}` : ''}
${context.brandToolkit.defaultCtas?.length ? `- Preferred CTAs: ${context.brandToolkit.defaultCtas.join(', ')}` : ''}`;
    }

    const lengthInstruction = length === 'short' ? '1-2 lines maximum' : length === 'long' ? '6+ lines, detailed and comprehensive' : '3-5 lines';
    const characterLimit = socialCharacterLimit('social', isUniversal ? 'twitter' : platform);

    const platformInstruction = isUniversal
      ? 'Generate a UNIVERSAL social media post that works across LinkedIn, Twitter, Facebook, and Instagram. Keep it professional yet engaging, under 280 characters for Twitter compatibility, and include hashtags that work on all platforms.'
      : `Generate a ${platform} post`;

    const prompt = `${platformInstruction} about "${input.topic}":
- Tone: ${tone}
- Length: ${lengthInstruction}
${characterLimit ? `- Character limit: ${characterLimit} characters for the caption, call to action and hashtags combined. This is ONE post; never put several posts or a multi-day plan into one caption.\n` : ''}- Language: ${language}
- Format: ${postFormat}
${includeEmojis ? '- Include relevant emojis throughout the post' : '- Do NOT use any emojis'}
${includeCta ? input.cta_text ? '- Do not invent a CTA or closing invitation in the caption. The application appends the exact reviewed CTA separately.' : '- Include a compelling call-to-action' : '- No call-to-action needed'}
${(input.include_image_prompt || input.auto_generate_image) ? '- Include detailed image generation prompt for imagePrompt field' : ''}
${(input.include_video_prompt || input.auto_generate_video) ? '- Include detailed video generation prompt for videoPrompt field' : ''}
${includeHashtags ? `- Include exactly ${numHashtags} relevant hashtags` : '- No hashtags'}
${context.brandContextPrompt || brandContext}

ICP: ${JSON.stringify(context.icpProfile, null, 2)}

USER-REVIEWED CONTENT CONSTRAINTS (override brand defaults): ${input.content_instructions || 'Follow the reviewed fields above.'}

Format your response as a valid JSON object matching this schema. NO markdown wrapping, just the raw JSON:

Return JSON with: title (short, catchy, max 50 chars), caption, keywords[], imagePrompts? (array of string prompts), videoPrompts? (array of string prompts), hashtags[]?
- imagePrompts: Array of 1-4 strings. Decide how many images are appropriate for this post and provide a detailed generation prompt for each.
- videoPrompts: Array of 1-2 strings. Decide how many videos are appropriate for this post and provide a detailed generation prompt for each.`;

    const response = await createCompletionWithProviderFallback(userIdNum, {
      messages: [
        { role: 'system', content: 'Generate social media content as the requested JSON. Reviewed requirements take priority over brand defaults.' + (includeCta && input.cta_text ? ' The caption must be informational statements only, with no request, invitation, question or call to action. Never ask readers to contact, request, book, learn more, or take any action. The application adds the user-authored CTA after your caption. Do not include or paraphrase it yourself, even when it appears in the user or brand context.' : '') },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId: context.userId,
        threadId: context.threadId,
        purpose: 'content_generation',
        service: 'ContentExecutor',
        action: 'generate_social_media_post',
      },
    });

    if (!response.success) {
      throw new Error(response.error || 'The content provider could not generate this social post.');
    }

    // An over-limit or otherwise invalid post gets one targeted rewrite
    // instead of failing the whole request.
    const checked = await validatedSocialPost(extractJsonObject(response.content || '{}'), socialPostRules(input, context, userIdNum, isUniversal ? 'twitter' : platform));
    if (!checked.post) {
      return {
        success: false,
        toolName: 'generate_social_media_post',
        error: `The post could not be generated within the platform rules: ${(checked.problems || []).join(' ')} Nothing was saved. Edit the review settings (for example a shorter length, or more posts for a multi-day plan) and run it again.`,
        output: { status: 'failed', retrySafe: true, reason: 'content_validation_failed', violations: checked.problems || [] },
      };
    }
    const post: any = checked.post;

    // Auto-generate image if requested
     
    const generatedImages: any[] = [];
    const imageErrors: string[] = [];
    const autoGenerateImage = explicitlyRequestedMedia(input).image;
    // Extract array of prompts or fallback to single prompt
    const imagePrompts = reviewedMediaPrompts(Array.isArray(post.imagePrompts) ? post.imagePrompts : (post.imagePrompt ? [post.imagePrompt] : []), input.image_count);
    const videoPrompts = reviewedMediaPrompts(Array.isArray(post.videoPrompts) ? post.videoPrompts : (post.videoPrompt ? [post.videoPrompt] : []), input.video_count);
    if (autoGenerateImage && imagePrompts.length === 0) imageErrors.push('No image prompt was generated for the requested image.');
    
    if (autoGenerateImage && imagePrompts.length > 0) {
      try {
        const { createImageGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
        const imageGenerationWorker = createImageGenerationWorker(userIdNum, toNumber(context.threadId));
        
        for (const prompt of imagePrompts) {
          const enhancedImagePrompt = toolImagePrompt(prompt, context);

          // Build imageConfig from input params
           
          const imageConfig: Record<string, any> = {};
          imageConfig.brandLogoUrl = selectedBrandLogoUrl(context);
          if (input.image_provider) imageConfig.provider = input.image_provider;
          if (input.image_model) imageConfig.model = input.image_model;
          if (input.image_aspect_ratio) imageConfig.aspectRatio = input.image_aspect_ratio;
          if (input.image_size) imageConfig.imageSize = input.image_size;
          
          const imageResult = await imageGenerationWorker.generateFromText(enhancedImagePrompt, imageConfig);
          
          if (imageResult.success && imageResult.imageUrl) {
            generatedImages.push({
              imageData: imageResult.imageData,
              imageUrl: imageResult.imageUrl,
              mimeType: imageResult.mimeType,
              fileName: imageResult.fileName,
            });
          } else imageErrors.push('A requested image could not be generated. Review the saved post before retrying its image work.');
        }
      } catch (imgErr) {
        logger.warn({ err: imgErr }, '[Content Executor] Failed to auto-generate images');
        imageErrors.push('Requested image generation was interrupted. Check its recorded operation before retrying.');
      }
    }

    // Video work starts only after the durable parent is saved below.
    const generatedVideos: any[] = [];
    const autoGenerateVideo = explicitlyRequestedMedia(input).video;

    // Open social post preview
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.SOCIAL_POST_PREVIEW,
      tabLabel: isUniversal ? 'Universal Post' : `${platform} Post`,
      data: { 
        post, 
        platform, 
        generatedImages, 
        generatedVideos, 
        isUniversal,
        imagePrompts: generatedImages.length === 0 ? imagePrompts : undefined,
        videoPrompts: generatedVideos.length === 0 ? videoPrompts : undefined
      },
    });

    // Save to content_assets table
    let savedPostId: number | undefined;
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;
      
      const updatedPostContent = {
        ...post,
        ...(generatedImages.length > 0 && { imageUrls: generatedImages.map(img => img.imageUrl).filter(Boolean) }),
        ...(generatedVideos.length > 0 && { videoUrls: generatedVideos.map(vid => vid.videoUrl).filter(Boolean) }),
        ...(generatedImages.length === 0 && imagePrompts.length > 0 && { imagePrompts }),
        ...(generatedVideos.length === 0 && videoPrompts.length > 0 && { videoPrompts })
      };

      const savedPost = await ContentAssetModel.create({
        type: 'social_post',
        title: post.title ? post.title.substring(0, 150) : input.topic.substring(0, 80) + '...',
        content: JSON.stringify(updatedPostContent),
        imageUrl: generatedImages.length > 0 ? generatedImages[0].imageUrl : null,
        imageUrls: generatedImages.length > 0 ? generatedImages.map(i => i.imageUrl).filter(Boolean) : [],
        videoUrl: generatedVideos.length > 0 ? generatedVideos[0].videoUrl : null,
        videoUrls: generatedVideos.length > 0 ? generatedVideos.map(v => v.videoUrl).filter(Boolean) : [],
        metadata: generatedVideos.reduce((metadata, video) => withVideoProbeMetadata(video.videoUrl, video.mediaProbe, metadata), {}),
        channel: isUniversal ? 'all' : platform,
        status: 'draft',
        userId: userIdVal,
        threadId: threadIdVal,
        performance: null,
        ...policyPersistence(context, 'social', isUniversal ? 'all' : platform),
      });
      savedPostId = savedPost.id;
      logger.info({ threadId: context.threadId }, '[Content Executor] Social post saved to content_assets');

      // Save auto-generated images as linked child assets
      if (savedPost?.id && generatedImages.length > 0) {
        for (const img of generatedImages) {
          if (img.imageUrl && !img.placeholder) {
            try {
              await ContentAssetModel.create({
                type: 'image',
                title: `Image for: ${(post.title || input.topic).substring(0, 100)}`,
                content: img.imageUrl,
                imageUrl: img.imageUrl,
                imageUrls: [img.imageUrl],
                channel: isUniversal ? 'all' : platform,
                status: 'draft',
                userId: userIdVal,
                threadId: threadIdVal,
                parentAssetId: savedPost.id,
                performance: null,
              });
              logger.info({ parentAssetId: savedPost.id }, '[Content Executor] Auto-generated image saved as child asset');
             
            } catch (imgSaveErr: any) {
              logger.warn({ err: imgSaveErr }, '[Content Executor] Failed to save auto-generated image');
            }
          }
        }
      }

      // Save auto-generated videos as linked child assets
      if (savedPost?.id && generatedVideos.length > 0) {
        for (const vid of generatedVideos) {
          if (vid.videoUrl && !vid.placeholder) {
            try {
              await ContentAssetModel.create({
                type: 'video',
                title: `Video for: ${(post.title || input.topic).substring(0, 100)}`,
                content: vid.videoUrl,
                videoUrl: vid.videoUrl,
                videoUrls: [vid.videoUrl],
                metadata: withVideoProbeMetadata(vid.videoUrl, vid.mediaProbe),
                channel: isUniversal ? 'all' : platform,
                status: 'draft',
                userId: userIdVal,
                threadId: threadIdVal,
                parentAssetId: savedPost.id,
                performance: null,
              });
              logger.info({ parentAssetId: savedPost.id }, '[Content Executor] Auto-generated video saved as child asset');
             
            } catch (vidSaveErr: any) {
              logger.warn({ err: vidSaveErr }, '[Content Executor] Failed to save auto-generated video');
            }
          }
        }
      }
     
    } catch (saveError: any) {
      logger.warn({ err: saveError }, '[Content Executor] Failed to save social post to database');
    }

    if (!savedPostId) return unsavedGeneratedContent('generate_social_media_post', { post });
    const queuedVideo = autoGenerateVideo
      ? await queueExecutorVideos(savedPostId, 'social_post', videoPrompts, input, context)
      : undefined;

    // Build detailed success message
    const platformName = isUniversal ? 'Universal (All Platforms)' : platform.charAt(0).toUpperCase() + platform.slice(1);
    const hasImage = generatedImages.length > 0;
    const hasVideo = generatedVideos.length > 0 || (post.videoPrompts && post.videoPrompts.length > 0);
    const hasHashtags = post.hashtags?.length > 0;
    
    const detailParts = [];
    if (hasImage) detailParts.push(`🖼️ ${generatedImages.length} image(s)`);
    if (hasVideo) detailParts.push(queuedVideo?.jobIds.length ? `🎬 ${queuedVideo.jobIds.length} video(s) queued` : `🎬 ${videoPrompts.length} video prompt(s)`);
    if (hasHashtags) detailParts.push(`#️⃣ ${post.hashtags.length} hashtags`);
    if (context.brandToolkit?.name) detailParts.push(`🎨 ${context.brandToolkit.name} branding`);
    
    const detailsStr = detailParts.length > 0 ? ` Includes ${detailParts.join(', ')}.` : '';
    const platformInfo = isUniversal ? ' This post is optimized to work on LinkedIn, Twitter, Facebook, and Instagram.' : '';

    return {
      success: true,
      toolName: 'generate_social_media_post',
      output: {
        assetId: savedPostId,
        ...(imageErrors.length ? { status: 'partial_success', retrySafe: false } : {}),
        imageStatus: imageErrors.length ? generatedImages.length ? 'partial_success' : 'failed' : autoGenerateImage ? 'succeeded' : 'not_requested',
        imageRequestedCount: autoGenerateImage ? input.image_count ?? 1 : 0,
        imageSucceededCount: generatedImages.length,
        videoStatus: queuedVideo?.status || 'not_requested',
        videoJobIds: queuedVideo?.jobIds || [],
        warnings: [...imageErrors, ...(queuedVideo?.errors || [])],
        platform,
        post,
        brandToolkitUsed: context.brandToolkit?.name || null,
        generatedImages,
        generatedVideos,
        isUniversal,
        message: `📱 ${platformName} post saved.${detailsStr}${platformInfo}${imageErrors.length ? ' Some requested image work did not complete; review the warnings before retrying.' : ''}${queuedVideo?.errors.length ? ' Some requested video work could not be queued; review the warnings.' : ''} You can preview and edit it in the Social Post tab.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Social post error');
    const errorMessage = error?.message || 'Social post generation failed';
    const isRetryableProviderFailure =
      error?.name === 'TimeoutError' ||
      error?.name === 'AbortError' ||
      /timed?\s*out|timeout|temporar|rate limit|429|503|network|fetch/i.test(errorMessage);
    return {
      success: false,
      toolName: 'generate_social_media_post',
      error: isRetryableProviderFailure
        ? 'Content generation timed out or is temporarily unavailable. Please retry from the review widget.'
        : errorMessage,
      ...(isRetryableProviderFailure
        ? { output: { retrySafe: true, reason: 'provider_temporarily_unavailable' } }
        : {}),
    };
  }
}

export async function executeGenerateSocialChatTemplate(
  input: {
    platform: 'linkedin' | 'instagram' | 'twitter' | 'messenger';
    objective: string;
    cta_text?: string;
    content_instructions?: string;
    message_style?: 'introduction' | 'follow_up' | 'pitch' | 'thank_you' | 'cold_outreach' | 'networking' | 'partnership';
    tone?: 'professional' | 'friendly' | 'casual' | 'persuasive' | 'witty' | 'empathetic';
    language?: string;
    recipient_context?: string;
    include_personalization?: boolean;
    urgency?: 'low' | 'medium' | 'high';
    include_follow_ups?: boolean;
    number_of_follow_ups?: number;
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
    video_aspect_ratio?: string;
    video_resolution?: string;
    video_duration_seconds?: number;
    video_count?: number;
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const messageStyle = input.message_style || 'introduction';
  const tone = input.tone || context.brandToolkit?.voiceType || 'professional';
  const language = input.language || 'English';
  const includePersonalization = input.include_personalization !== false;
  const urgency = input.urgency || 'low';
  const numFollowUps = input.number_of_follow_ups || 2;
  
  try {
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');

    // Platform-specific character limits and styles
    const platformConfig: Record<string, { maxLength: number; style: string }> = {
      linkedin: { maxLength: 2000, style: 'Professional networking' },
      instagram: { maxLength: INSTAGRAM_CAPTION_LIMIT, style: 'Casual and visual-focused' },
      twitter: { maxLength: TWITTER_CHAR_LIMIT, style: 'Concise and punchy' },
      messenger: { maxLength: 2000, style: 'Conversational and friendly' },
    };

    const config = platformConfig[input.platform] || platformConfig.linkedin;

    // Build brand toolkit context
    let brandContext = '';
    if (context.brandToolkit) {
      brandContext = `
Brand Guidelines:
- Brand: ${context.brandToolkit.name}
- Voice/Tone: ${context.brandToolkit.voiceType || 'Professional'}
- Brand Values: ${Array.isArray(context.brandToolkit.brandValues) ? context.brandToolkit.brandValues.join(', ') : 'Not specified'}
${context.brandToolkit.defaultCtas?.length ? `- Preferred CTAs: ${context.brandToolkit.defaultCtas.join(', ')}` : ''}`;
    }

    const urgencyInstruction = urgency === 'high' ? 'Use time-sensitive, urgent language. Create sense of immediacy.' : urgency === 'medium' ? 'Moderately urgent tone.' : 'Relaxed, no pressure tone.';

    const prompt = `Generate a ${input.platform} direct message template:
- Platform: ${input.platform} (${config.style})
- Message Style: ${messageStyle}
- Objective: ${input.objective}
USER-REVIEWED CONTENT CONSTRAINTS (override brand defaults): ${input.content_instructions || "Follow the reviewed fields."}
${input.cta_text ? "The application appends the exact reviewed CTA. Return informational opening and body only, without an invitation, question or paraphrased CTA." : ""}
- Tone: ${tone}
- Language: ${language}
- Urgency: ${urgency} — ${urgencyInstruction}
- Max Length: ${config.maxLength} characters
${input.recipient_context ? `- Recipient Context: ${input.recipient_context}` : ''}
${includePersonalization ? '- Include {{first_name}} and {{company_name}} template variables where appropriate. NEVER use [bracket] placeholders or non-standard vars like {{firstname}}, {{company}}.' : '- Do NOT use template variables'}
${context.brandContextPrompt || brandContext}

ICP Context: ${JSON.stringify(context.icpProfile, null, 2)}

Return JSON with:
- opening: The greeting/hook
- body: Main message content
- cta: Call to action
- fullMessage: Complete message ready to send
${input.include_follow_ups ? `- followUps: Array of ${numFollowUps} follow-up message variations` : ''}
${(input.include_image_prompt || input.auto_generate_image) ? '- imagePrompt: Detailed prompt for generating an image to accompany the DM' : ''}
${input.include_video_prompt ? '- videoPrompt: Detailed prompt for generating a short video to accompany the DM' : ''}`;

    const response = await createCompletionWithProviderFallback(userIdNum, {
      messages: [
        { role: 'system', content: `Generate engaging direct messages for ${input.platform}. Messages should feel natural and personalized, not like templates. Reviewed message identity and constraints override workspace brand defaults. ${input.cta_text ? "Do not include an invitation or CTA; the application adds the reviewed CTA." : ""}` },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId: context.userId,
        threadId: context.threadId,
        purpose: 'content_generation',
        service: 'ContentExecutor',
        action: 'generate_social_chat_template',
      },
    });

    const dmRaw = extractJsonObject(response.content || '{}') as Record<string, unknown>;
    const dmMessage = withExactCallToAction(String(
      dmRaw.message
      || dmRaw.fullMessage
      || [dmRaw.opening, dmRaw.body, input.cta_text ? undefined : dmRaw.cta].filter(Boolean).join('\n'),
    ), input.cta_text);
    const template: any = parseStructuredContent('social_message', {
      ...dmRaw,
      message: dmMessage,
      fullMessage: dmMessage,
      ...(input.cta_text?.trim() ? { cta: input.cta_text.trim() } : {}),
      platform: input.platform,
    });
    applyReviewedMediaExclusions(template, input);
    validateGeneratedContent({
      type: 'social_message',
      output: template,
      context: resolvedPolicyContext(context),
      platform: input.platform,
    });

    // Auto-generate image if requested
    let generatedImage = null;
    const autoGenerateImage = explicitlyRequestedMedia(input).image;
    if (autoGenerateImage && template.imagePrompt) {
      try {
        const { createImageGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
        const imageGenerationWorker = createImageGenerationWorker(userIdNum, toNumber(context.threadId));
        const enhancedImagePrompt = toolImagePrompt(template.imagePrompt, context);

        // Build imageConfig from input params
         
        const imageConfig: Record<string, any> = {};
        imageConfig.brandLogoUrl = selectedBrandLogoUrl(context);
        if (input.image_provider) imageConfig.provider = input.image_provider;
        if (input.image_model) imageConfig.model = input.image_model;
        if (input.image_aspect_ratio) imageConfig.aspectRatio = input.image_aspect_ratio;
        if (input.image_size) imageConfig.imageSize = input.image_size;
        
        const imageResult = await imageGenerationWorker.generateFromText(enhancedImagePrompt, imageConfig);
        
        if (imageResult.success) {
          generatedImage = {
            imageData: imageResult.imageData,
            imageUrl: imageResult.imageUrl,
            mimeType: imageResult.mimeType,
            fileName: imageResult.fileName,
          };
        }
       
      } catch (imgErr: any) {
        logger.warn({ err: imgErr }, '[Content Executor] Failed to auto-generate DM image');
        const errMsg = imgErr?.message || String(imgErr);
        
        // Determine error type and create appropriate message
        let errorMessage = '';
        if (errMsg.includes('API key is not configured') || errMsg.includes('GEMINI_API_KEY')) {
          errorMessage = '⚠️ Image generation requires a Gemini API key. Please add your Gemini API key in Settings > Integrations.';
        } else if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('quota')) {
          errorMessage = '⏳ Image generation temporarily unavailable due to rate limits. Please try again in a few minutes.';
        } else {
          errorMessage = `❌ Image generation failed: ${errMsg}`;
        }
        
        // Emit the error to chat so user can see it
        if (context.threadId) {
          const threadIdNum = toNumber(context.threadId);
          webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'warning', errorMessage, 'content');
        }
        
        generatedImage = {
          placeholder: true,
          message: errorMessage,
        };
      }
    }

    // The worker owns provider submission and durable polling after persistence.
    const generatedVideo: any = null;
    const autoGenerateVideo = explicitlyRequestedMedia(input).video;

    // Open social chat template preview tab
    const platform = input.platform || 'linkedin';
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.SOCIAL_CHAT_TEMPLATE,
      tabLabel: `${platform.charAt(0).toUpperCase() + platform.slice(1)} DM`,
      data: { 
        template, 
        platform,
        objective: input.objective,
        characterLimit: config.maxLength,
        generatedImage,
        generatedVideo,
      },
    });

    // Save to content_assets table
    let savedDmId: number | undefined;
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;
      const savedDm = await ContentAssetModel.create({
        type: 'social_dm',
        title: input.objective.substring(0, 200),
        content: JSON.stringify({
          ...template,
          imageUrl: generatedImage?.imageUrl || undefined,
          videoUrl: generatedVideo?.videoUrl || undefined,
        }),
        imageUrl: generatedImage?.imageUrl || null,
        imageUrls: generatedImage?.imageUrl ? [generatedImage.imageUrl] : [],
        videoUrl: generatedVideo?.videoUrl || null,
        videoUrls: generatedVideo?.videoUrl ? [generatedVideo.videoUrl] : [],
        metadata: withVideoProbeMetadata(generatedVideo?.videoUrl, generatedVideo?.mediaProbe),
        channel: platform,
        status: 'draft',
        userId: userIdVal,
        threadId: threadIdVal,
        performance: null,
        ...policyPersistence(context, 'social_message', platform),
      });
      savedDmId = savedDm.id;
      logger.info({ threadId: context.threadId }, '[Content Executor] Social DM template saved to content_assets');

      // Save auto-generated image as a linked child asset
      if (generatedImage?.imageUrl && !generatedImage.placeholder && savedDm?.id) {
        try {
          await ContentAssetModel.create({
            type: 'image',
            title: `Image for DM: ${input.objective.substring(0, 80)}`,
            content: generatedImage.imageUrl,
            imageUrl: generatedImage.imageUrl,
            imageUrls: [generatedImage.imageUrl],
            channel: platform,
            status: 'draft',
            userId: userIdVal,
            threadId: threadIdVal,
            parentAssetId: savedDm.id,
            performance: null,
          });
          logger.info({ parentAssetId: savedDm.id }, '[Content Executor] Auto-generated DM image saved as child asset');
         
        } catch (imgSaveErr: any) {
          logger.warn({ err: imgSaveErr }, '[Content Executor] Failed to save auto-generated DM image');
        }
      }

      // Save auto-generated video as a linked child asset
      if (generatedVideo?.videoUrl && !generatedVideo.placeholder && savedDm?.id) {
        try {
          await ContentAssetModel.create({
            type: 'video',
            title: `Video for DM: ${input.objective.substring(0, 80)}`,
            content: generatedVideo.videoUrl,
            videoUrl: generatedVideo.videoUrl,
            videoUrls: [generatedVideo.videoUrl],
            metadata: withVideoProbeMetadata(generatedVideo.videoUrl, generatedVideo.mediaProbe),
            channel: platform,
            status: 'draft',
            userId: userIdVal,
            threadId: threadIdVal,
            parentAssetId: savedDm.id,
            performance: null,
          });
          logger.info({ parentAssetId: savedDm.id }, '[Content Executor] Auto-generated DM video saved as child asset');
         
        } catch (vidSaveErr: any) {
          logger.warn({ err: vidSaveErr }, '[Content Executor] Failed to save auto-generated DM video');
        }
      }
     
    } catch (saveError: any) {
      logger.warn({ err: saveError }, '[Content Executor] Failed to save social DM to database');
    }

    if (!savedDmId) return unsavedGeneratedContent('generate_social_chat_template', { template });
    const queuedVideo = autoGenerateVideo
      ? await queueExecutorVideos(savedDmId, 'social_dm', template.videoPrompt ? [template.videoPrompt] : [], input, context)
      : undefined;

    return {
      success: true,
      toolName: 'generate_social_chat_template',
      output: {
        assetId: savedDmId,
        videoStatus: queuedVideo?.status || 'not_requested',
        videoJobIds: queuedVideo?.jobIds || [],
        warnings: queuedVideo?.errors || [],
        platform,
        template,
        characterLimit: config.maxLength,
        brandToolkitUsed: context.brandToolkit?.name || null,
        message: `💬 ${platform} DM template saved.${queuedVideo?.jobIds.length ? ' Video generation is queued.' : ''}${queuedVideo?.errors.length ? ' Requested video work could not be fully queued; review the warnings.' : ''} Check the ${platform} DM tab to preview and edit.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Social chat template error');
    return {
      success: false,
      toolName: 'generate_social_chat_template',
      error: error.message,
    };
  }
}

// ── Blog Post Generation ─────────────────────────────────────────────────────

export async function executeGenerateBlogPost(
  input: {
    topic: string;
    cta_text?: string;
    content_instructions?: string;
    tone?: 'professional' | 'casual' | 'informative' | 'inspirational' | 'conversational' | 'authoritative';
    length?: 'short' | 'medium' | 'long';
    target_audience?: string;
    seo_keywords?: string[];
    outline?: string[];
    language?: string;
    include_meta_description?: boolean;
    include_image_prompt?: boolean;
    auto_generate_image?: boolean;
    image_provider?: 'google' | 'openrouter';
    image_model?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_count?: number;
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const tone = input.tone || context.brandToolkit?.voiceType || 'professional';
  const language = input.language || 'English';
  const length = input.length || 'medium';
  const includeMetaDescription = input.include_meta_description !== false;
  const includeImagePrompt = input.include_image_prompt !== false;

  try {
    const { templateMap } = await import('../../../services/promptTemplates');
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');

    // Build brand toolkit context
    let brandContext = '';
    if (context.brandToolkit) {
      brandContext = `
Brand Guidelines:
- Brand: ${context.brandToolkit.name}
- Voice/Tone: ${context.brandToolkit.voiceType || 'Professional'}
- Brand Values: ${Array.isArray(context.brandToolkit.brandValues) ? context.brandToolkit.brandValues.join(', ') : 'Not specified'}
${context.brandToolkit.defaultCtas?.length ? `- Preferred CTAs: ${context.brandToolkit.defaultCtas.join(', ')}` : ''}`;
    }

    const lengthInstruction = length === 'short' ? '500-800 words, concise blog post' : length === 'long' ? '2000-3000 words, comprehensive in-depth article' : '1000-1500 words, well-structured blog post';

    const prompt = `Generate a high-quality blog post with the following requirements:
- Topic: ${input.topic}
USER-REVIEWED CONTENT CONSTRAINTS (override brand defaults): ${input.content_instructions || 'Follow the reviewed fields.'}
${input.cta_text ? `Do not write a closing invitation or CTA. The application appends the exact reviewed CTA: ${input.cta_text}` : ''}
- Tone: ${tone}
- Language: ${language}
- Length: ${lengthInstruction}
${input.target_audience ? `- Target Audience: ${input.target_audience}` : ''}
${input.seo_keywords?.length ? `- SEO Keywords (incorporate naturally): ${input.seo_keywords.join(', ')}` : ''}
${input.outline?.length ? `- Follow this outline:\n${input.outline.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '- Create a logical outline with 3-5 sections'}
${context.brandContextPrompt || brandContext}

${context.icpProfile ? `ICP Context: ${JSON.stringify(context.icpProfile, null, 2)}` : ''}

Return JSON with this canonical Content Studio contract:
{
  "title": "Blog post title (SEO-optimized)",
  "content": "The complete blog post in Markdown, including headings, introduction, sections, and conclusion",
  "excerpt": "${includeMetaDescription ? 'A concise 150-160 character summary suitable for search previews' : 'A concise 2-3 sentence summary'}",
  "tags": ["keyword1", "keyword2"],
  ${includeImagePrompt ? '"featuredImagePrompt": "Detailed prompt for generating a featured blog image"' : '"featuredImagePrompt": ""'}
}`;

    const response = await createCompletionWithProviderFallback(userIdNum, {
      messages: [
        { role: 'system', content: templateMap.contentAgent || 'You are a professional content writer and SEO specialist. Write engaging, well-structured blog posts that provide value to readers. Ensure the content aligns with brand guidelines when provided.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId: context.userId,
        threadId: context.threadId,
        purpose: 'content_generation',
        service: 'ContentExecutor',
        action: 'generate_blog_post',
      },
    });

    if (!response.success) {
      return { success: false, toolName: 'generate_blog_post', error: 'LLM error' };
    }

    const blogPost = parseStructuredContent('blog', response.content || '{}');
    if (input.cta_text) blogPost.content = withExactCallToAction(String(blogPost.content || ''), input.cta_text);
    applyReviewedMediaExclusions(blogPost, input);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = context.brandContextSnapshot as any;
    if (!snapshot?.businessProfile || !snapshot?.brandToolkit) {
      throw new ContentComplianceError(['Approved business and brand context is required.']);
    }
    validateGeneratedContent({
      type: 'blog',
      output: blogPost,
      context: {
        businessProfile: snapshot.businessProfile,
        brandToolkit: snapshot.brandToolkit,
        provenance: snapshot.provenance,
      },
      platform: 'blog',
    });

    // Open blog post preview tab
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.BLOG_POST,
      tabLabel: TAB_LABELS[TAB_TYPES.BLOG_POST],
      data: { template: blogPost },
    });

    // Save to content_assets
     
    let savedBlogPost: any = null;
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      savedBlogPost = await ContentAssetModel.create({
        type: 'blog_post',
        title: blogPost.title || 'Blog Post',
        content: JSON.stringify(blogPost),
        channel: 'blog',
        status: 'draft',
        userId: typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null,
        threadId: typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null,
        performance: null,
        ...policyPersistence(context, 'blog', 'blog'),
      });
      logger.info({ threadId: context.threadId }, '[Content Executor] Blog post saved to content_assets');
     
    } catch (saveError: any) {
      logger.warn({ err: saveError }, '[Content Executor] Failed to save blog post to database');
    }

    if (!savedBlogPost?.id) return unsavedGeneratedContent('generate_blog_post', { blogPost });

    // Auto-generate featured image if requested
    let featuredImageUrl: string | null = null;
    if (input.auto_generate_image && blogPost.featuredImagePrompt) {
      try {
         
        const blogImageConfig: Record<string, any> = {};
        if (input.image_provider) blogImageConfig.provider = input.image_provider;
        if (input.image_model) blogImageConfig.model = input.image_model;
        if (input.image_aspect_ratio) blogImageConfig.aspectRatio = input.image_aspect_ratio;
        else blogImageConfig.aspectRatio = '16:9'; // sensible default for blog headers
        if (input.image_size) blogImageConfig.imageSize = input.image_size;

        const imageResult = await executeGenerateImageDirect(
          toolImagePrompt(blogPost.featuredImagePrompt, context),
          context,
          blogImageConfig,
        );
        if (imageResult.success && imageResult.output?.imageUrl) {
          featuredImageUrl = imageResult.output.imageUrl;
          // Save image as child of blog post
          if (savedBlogPost?.id) {
            const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
            await ContentAssetModel.create({
              type: 'image',
              title: `Featured image for: ${blogPost.title || 'Blog Post'}`,
              content: blogPost.featuredImagePrompt,
              channel: 'blog',
              status: 'draft',
              userId: typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null,
              threadId: typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null,
              imageUrl: featuredImageUrl,
              parentAssetId: savedBlogPost.id,
              performance: null,
            });
          }
        }
       
      } catch (imgErr: any) {
        logger.warn({ err: imgErr }, '[Content Executor] Failed to auto-generate blog featured image');
      }
    }

    return {
      success: true,
      toolName: 'generate_blog_post',
      output: {
        assetId: savedBlogPost.id,
        blogPost,
        featuredImageUrl,
        brandToolkitUsed: context.brandToolkit?.name || null,
        message: `📝 Blog post "${blogPost.title}" generated successfully! Check the Blog Post tab to preview and edit.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Blog post generation error');
    return { success: false, toolName: 'generate_blog_post', error: error.message };
  }
}

const EMAIL_GENERATION_UNAVAILABLE = 'email_generation_unavailable';
const EMAIL_DRAFT_INCOMPLETE = 'The AI returned an incomplete email draft (no subject or body). Nothing was saved. Run it again; for a multi-email sequence, set the number of sequence steps instead of describing several emails in the instructions.';
const MAX_EMAIL_SEQUENCE_STEPS = 5;
const DEFAULT_FOLLOW_UP_DELAY_DAYS = 3;

/** Number of emails and the delay before each follow-up (days after the previous email). */
export function emailSequencePlan(sequenceSteps?: unknown, stepDelayDays?: unknown): { steps: number; delays: number[] } {
  const requested = Number(sequenceSteps);
  const steps = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), MAX_EMAIL_SEQUENCE_STEPS) : 1;
  const supplied = Array.isArray(stepDelayDays) ? stepDelayDays.map(Number) : [];
  const delays = Array.from({ length: steps - 1 }, (_, index) => {
    const value = supplied[index];
    return Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), 90) : DEFAULT_FOLLOW_UP_DELAY_DAYS;
  });
  return { steps, delays };
}

export function emailSequenceStepInstruction(step: number, steps: number, sendAfterDays: number, earlierSubjects: string[]): string {
  if (step === 1) return `SEQUENCE STEP 1 OF ${steps}: write only this first email. The follow-up emails are generated separately; do not include them.`;
  return `SEQUENCE STEP ${step} OF ${steps}: write only this follow-up email, sent ${sendAfterDays} days after the previous email to a recipient who has not replied. Earlier subject lines: ${earlierSubjects.filter(Boolean).join(' | ') || 'none'}. Use a new subject, refer briefly to the earlier email, add one new reason to reply, and keep it shorter than the first email.${step === steps ? ' This is the final email in the sequence; close politely.' : ''}`;
}

function emailSequenceTitle(step: number, steps: number, subject: unknown): string {
  const text = typeof subject === 'string' && subject.trim() ? subject.trim() : 'Email';
  return `Step ${step} of ${steps}: ${text}`.slice(0, 200);
}

export async function executeGenerateEmailTemplate(
  input: {
    subject_line?: string;
    sender_business_name?: string;
    sender_name?: string;
    recipient_role: string;
    email_body_points?: string[];
    content_instructions?: string;
    tone?: 'professional' | 'friendly' | 'urgent' | 'persuasive' | 'formal' | 'conversational';
    language?: string;
    length?: 'short' | 'medium' | 'long';
    email_type?: 'cold_outreach' | 'follow_up' | 'newsletter' | 'promotional' | 'introduction' | 'thank_you' | 'invitation' | 'announcement';
    include_personalization?: boolean;
    include_unsubscribe?: boolean;
    cta_text?: string;
    include_image_prompt?: boolean;
    auto_generate_image?: boolean;
    image_aspect_ratio?: string;
    image_size?: string;
    image_count?: number;
    sequence_steps?: number;
    step_delay_days?: number[];
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const { steps, delays } = emailSequencePlan(input.sequence_steps, input.step_delay_days);
  const tone = input.tone || context.brandToolkit?.voiceType || 'professional';
  const language = input.language || 'English';
  const length = input.length || 'medium';
  const emailType = input.email_type || 'cold_outreach';
  const includePersonalization = input.include_personalization !== false;
  const includeUnsubscribe = input.include_unsubscribe !== false;
  const includeImagePrompt = input.include_image_prompt === true || explicitlyRequestedMedia(input).image;
  const autoGenerateImage = explicitlyRequestedMedia(input).image;
  
  try {
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');

    // Build brand toolkit context
    let brandContext = '';
    if (context.brandToolkit) {
      brandContext = `
Brand Guidelines:
- Brand: ${context.brandToolkit.name}
- Voice/Tone: ${context.brandToolkit.voiceType || 'Professional'}
- Brand Values: ${Array.isArray(context.brandToolkit.brandValues) ? context.brandToolkit.brandValues.join(', ') : 'Not specified'}
${context.brandToolkit.defaultCtas?.length ? `- Preferred CTAs: ${context.brandToolkit.defaultCtas.join(', ')}` : ''}`;
    }

    const lengthInstruction = length === 'short' ? '2-3 sentences, very concise' : length === 'long' ? '3+ paragraphs, detailed and comprehensive' : '1-2 paragraphs';

    const baseRequest = (type: string, subject: string) => `Email type: ${type}. Recipient role: ${input.recipient_role}. Sender business: ${input.sender_business_name || "Use {{your_company_name}} when no campaign sender was supplied."}. Subject: ${subject}. Key points: ${(input.email_body_points || []).join(', ')}. Language: ${language}. Length: ${lengthInstruction}. ${input.content_instructions || ''}`;
    const firstRequest = baseRequest(emailType, input.subject_line || 'Generate an appropriate subject');
    const request = steps > 1 ? `${firstRequest} ${emailSequenceStepInstruction(1, steps, 0, [])}` : firstRequest;
    const draftRequest = { request, tone, brandContext: context.brandContextPrompt || brandContext, audienceContext: JSON.stringify(context.icpProfile || {}), includePersonalization, includeUnsubscribe, includeImagePrompt, reviewedCta: input.cta_text };
    // One completion produces exactly one email; a sequence calls it per step.
    const draftEmail = async (stepRequest: typeof draftRequest) => {
      const response = await createCompletionWithProviderFallback(userIdNum, {
        messages: textDraftMessages('email', stepRequest),
        temperature: 0.7,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId: context.userId,
          threadId: context.threadId,
          purpose: 'content_generation',
          service: 'ContentExecutor',
          action: 'generate_email_template',
        },
      });
      if (!response.success) throw new Error(EMAIL_GENERATION_UNAVAILABLE);
      let drafted: any;
      try {
        drafted = parseTextDraft('email', response.content || '{}', stepRequest);
      } catch (parseError) {
        if (parseError instanceof z.ZodError) throw new Error(EMAIL_DRAFT_INCOMPLETE);
        throw parseError;
      }
      drafted.signature = [input.sender_name?.trim(), input.sender_business_name?.trim() || "{{your_company_name}}"].filter(Boolean).join("\n");
      applyReviewedMediaExclusions(drafted, input);
      validateGeneratedContent({
        type: 'email',
        output: drafted,
        context: resolvedPolicyContext(context),
        platform: 'email',
      });
      return drafted;
    };

    let template: any;
    try {
      template = await draftEmail(draftRequest);
    } catch (draftError: any) {
      if (draftError?.message === EMAIL_GENERATION_UNAVAILABLE) return { success: false, toolName: 'generate_email_template', error: 'LLM error' };
      throw draftError;
    }

    // Auto-generate banner image if requested
    let generatedImage = null;
    if (autoGenerateImage && template.imagePrompt) {
      try {
        const { createImageGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
        const imageGenerationWorker = createImageGenerationWorker(userIdNum, toNumber(context.threadId));
        const enhancedImagePrompt = toolImagePrompt(template.imagePrompt, context);
        
        webSocketEmitter.emit(userIdNum, 'tool_status', {
          toolName: 'generate_email_template',
          status: 'processing',
          message: 'Generating email banner image...',
        });

        // Build imageConfig from input params
         
        const imageConfig: Record<string, any> = {};
        imageConfig.brandLogoUrl = selectedBrandLogoUrl(context);
        if (input.image_aspect_ratio) imageConfig.aspectRatio = input.image_aspect_ratio;
        else imageConfig.aspectRatio = '16:9'; // sensible default for email banners
        if (input.image_size) imageConfig.imageSize = input.image_size;

        const imageResult = await imageGenerationWorker.generateFromText(enhancedImagePrompt, imageConfig);
        
        if (imageResult.success) {
          generatedImage = {
            imageData: imageResult.imageData,
            imageUrl: imageResult.imageUrl,
            mimeType: imageResult.mimeType,
            fileName: imageResult.fileName,
          };
        }
       
      } catch (imgErr: any) {
        logger.warn({ err: imgErr }, '[Content Executor] Failed to auto-generate email image');
        const errMsg = imgErr?.message || String(imgErr);
        let errorMessage = '';
        if (errMsg.includes('API key is not configured') || errMsg.includes('GEMINI_API_KEY')) {
          errorMessage = '⚠️ Image generation requires a Gemini API key. Please add your Gemini API key in Settings > Integrations.';
        } else if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('quota')) {
          errorMessage = '⏳ Image generation temporarily unavailable due to rate limits. Please try again in a few minutes.';
        } else {
          errorMessage = `❌ Image generation failed: ${errMsg}`;
        }
        if (context.threadId) {
          const threadIdNum = toNumber(context.threadId);
          webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'warning', errorMessage, 'content');
        }
        generatedImage = { placeholder: true, message: errorMessage };
      }
    }
    
    // Embed image reference into the template
    if (generatedImage?.imageUrl && !generatedImage.placeholder) {
      template.imageUrl = generatedImage.imageUrl;
    } else if (generatedImage?.imageData && !generatedImage.placeholder) {
      template.imageUrl = `data:${generatedImage.mimeType || 'image/png'};base64,${generatedImage.imageData}`;
    }

    // Open email template preview


    // Save to content_assets table
     
    let savedEmail: any = null;
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const userIdVal = typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null;
      const threadIdVal = typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null;
      savedEmail = await persistTextDraft({ type: 'email', output: template, userId: toNumber(context.userId), threadId: toNumber(context.threadId), context: resolvedPolicyContext(context), imageUrl: template.imageUrl, ...(steps > 1 ? { title: emailSequenceTitle(1, steps, template.subject) } : {}), });
      logger.info({ threadId: context.threadId }, '[Content Executor] Email template saved to content_assets');

      // Save auto-generated image as a linked child asset
      if ((generatedImage?.imageUrl || generatedImage?.imageData) && !generatedImage.placeholder && savedEmail?.id) {
        try {
          await ContentAssetModel.create({
            type: 'image',
            title: `Banner for: ${(template.subject || 'Email').substring(0, 80)}`,
            // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
            content: generatedImage.imageUrl || generatedImage.imageData,
            imageUrl: generatedImage.imageUrl || null,
            channel: 'email',
            status: 'draft',
            userId: userIdVal,
            threadId: threadIdVal,
            parentAssetId: savedEmail.id,
            performance: null,
          });
          logger.info({ parentAssetId: savedEmail.id }, '[Content Executor] Auto-generated email image saved as child asset');
         
        } catch (imgSaveErr: any) {
          logger.warn({ err: imgSaveErr }, '[Content Executor] Failed to save auto-generated email image');
        }
      }
     
    } catch (saveError: any) {
      logger.warn({ err: saveError }, '[Content Executor] Failed to save email template to database');
    }

    if (!savedEmail?.id) return unsavedGeneratedContent('generate_email_template', { template });

    // Follow-up steps: each is its own completion and its own saved draft, so
    // one bad step never discards the emails that did generate.
    const sequence: Array<{ step: number; sendAfterDays: number; assetId: number; subject: string; template: any }> = [
      { step: 1, sendAfterDays: 0, assetId: savedEmail.id, subject: String(template.subject || ''), template },
    ];
    const failedPosts: Array<{ step: number; error: string }> = [];
    for (let step = 2; step <= steps; step++) {
      const sendAfterDays = delays[step - 2];
      try {
        const followUp = await draftEmail({
          ...draftRequest,
          request: `${baseRequest('follow_up', 'Generate a new follow-up subject')} ${emailSequenceStepInstruction(step, steps, sendAfterDays, sequence.map(entry => entry.subject))}`,
          includeImagePrompt: false,
        });
        const saved = await persistTextDraft({ type: 'email', output: followUp, userId: toNumber(context.userId), threadId: toNumber(context.threadId), context: resolvedPolicyContext(context), title: emailSequenceTitle(step, steps, followUp.subject) });
        if (!saved?.id) throw new Error('The follow-up draft could not be saved.');
        sequence.push({ step, sendAfterDays, assetId: saved.id, subject: String(followUp.subject || ''), template: followUp });
      } catch (stepError: any) {
        logger.warn({ err: stepError, step }, '[Content Executor] Email sequence step failed');
        failedPosts.push({ step, error: toUserFacingError(stepError?.message === EMAIL_GENERATION_UNAVAILABLE ? '' : stepError, 'This step did not generate. Run the sequence again for the missing step.') });
      }
    }

    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.EMAIL_TEMPLATE,
      tabLabel: TAB_LABELS[TAB_TYPES.EMAIL_TEMPLATE],
      data: { template, generatedImage, ...(steps > 1 ? { sequence } : {}) },
    });


    const hasImage = generatedImage?.imageData && !generatedImage.placeholder;
    const sequenceMessage = steps > 1
      ? `📧 ${sequence.length} of ${steps} sequence emails saved as drafts (${sequence.map(entry => entry.step === 1 ? 'step 1: day 0' : `step ${entry.step}: +${entry.sendAfterDays} days`).join(', ')}).${failedPosts.length ? ` Step${failedPosts.length > 1 ? 's' : ''} ${failedPosts.map(entry => entry.step).join(', ')} did not generate.` : ''} Review them in the content library before using them in outreach.`
      : null;
    return {
      success: true,
      toolName: 'generate_email_template',
      output: {
        assetId: savedEmail.id,
        ...(steps > 1 ? {
          assetIds: sequence.map(entry => entry.assetId),
          postCount: steps,
          savedCount: sequence.length,
          sequence,
          ...(failedPosts.length ? { failedPosts } : {}),
        } : {}),
        template,
        generatedImage: hasImage ? generatedImage : undefined,
        brandToolkitUsed: context.brandToolkit?.name || null,
        message: sequenceMessage || `📧 Email template generated successfully!${hasImage ? ' 🖼️ Includes auto-generated banner image.' : ''} You can preview and edit it in the Email Template tab.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Email template error');
    return { success: false, toolName: 'generate_email_template', error: error.message };
  }
}

export async function executeGenerateSmsTemplate(
  input: {
    campaign_name?: string;
    target_audience?: string;
    key_message: string;
    call_to_action?: string;
    tone?: 'professional' | 'casual' | 'urgent' | 'friendly' | 'promotional';
    language?: string;
    urgency?: 'low' | 'medium' | 'high';
    include_link?: boolean;
    include_personalization?: boolean;
    sms_type?: 'promotional' | 'transactional' | 'reminder' | 'follow_up' | 'announcement';
    include_image_prompt?: boolean;
    auto_generate_image?: boolean;
    image_aspect_ratio?: string;
    image_size?: string;
    image_count?: number;
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const tone = input.tone || context.brandToolkit?.voiceType || 'professional';
  const language = input.language || 'English';
  const urgency = input.urgency || 'medium';
  const smsType = input.sms_type || 'promotional';
  const includeLink = input.include_link || false;
  const includePersonalization = input.include_personalization || false;
  const includeImagePrompt = input.include_image_prompt === true || explicitlyRequestedMedia(input).image;
  const autoGenerateImage = explicitlyRequestedMedia(input).image;
  
  try {
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');

    // Build brand toolkit context
    let brandContext = '';
    if (context.brandToolkit) {
      brandContext = `
Brand: ${context.brandToolkit.name}
Voice: ${context.brandToolkit.voiceType || 'Professional'}`;
      if (context.brandToolkit.defaultCtas?.length) {
        brandContext += `\nPreferred CTAs: ${context.brandToolkit.defaultCtas.join(', ')}`;
      }
    }

    const urgencyInstruction = urgency === 'high' ? 'Use urgent, time-sensitive language (e.g., "Limited time!", "Act now!")' : urgency === 'medium' ? 'Moderate urgency' : 'Relaxed, no pressure';

    const request = `SMS type: ${smsType}. Key message: ${input.key_message}. CTA: ${input.call_to_action || context.brandToolkit?.defaultCtas?.[0] || 'Learn more'}. Language: ${language}. Urgency: ${urgencyInstruction}. Campaign: ${input.campaign_name || 'Marketing'}. ${includeLink ? 'Include {{link}}.' : ''} ${includePersonalization ? 'Begin with Hi {{first_name}},.' : 'Do not include recipient placeholders.'}`;
    const draftRequest = { request, tone, brandContext: context.brandContextPrompt || brandContext, audienceContext: JSON.stringify(context.icpProfile || {}), includePersonalization, includeImagePrompt, reviewedCta: input.call_to_action, maxCharacters: 160, includeOptOut: smsType === 'promotional' };
    const response = await createCompletionWithProviderFallback(userIdNum, {
      messages: textDraftMessages('sms', draftRequest),
      temperature: 0.7,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId: context.userId,
        threadId: context.threadId,
        purpose: 'content_generation',
        service: 'ContentExecutor',
        action: 'generate_sms_template',
      },
    });

    if (!response.success) return { success: false, toolName: 'generate_sms_template', error: response.error || 'LLM error' };

    const { normalizeSmsMessage } = await import('../../../services/content/SmsContentNormalizer.js');
    const rawTemplate = extractJsonObject(response.content || '{}') as Record<string, unknown>;
    rawTemplate.message = normalizeSmsMessage(
      rawTemplate.message || `${input.key_message} ${input.call_to_action || ''}`,
      { requireOptOut: smsType === 'promotional', exactCta: input.call_to_action },
    );
    const template: any = parseTextDraft('sms', JSON.stringify(rawTemplate), draftRequest);
    applyReviewedMediaExclusions(template, input);
    validateGeneratedContent({
      type: 'sms',
      output: template,
      context: resolvedPolicyContext(context),
      platform: 'sms',
    });

    // Auto-generate promotional image for MMS
    let generatedImage: { imageData?: string; mimeType?: string; placeholder?: boolean } = {};
    if (autoGenerateImage && template.imagePrompt) {
      try {
        const { createImageGenerationWorker } = await import('../../../services/media/MediaGenerationWorkerFactory');
        const imageGenerationWorker = createImageGenerationWorker(userIdNum, toNumber(context.threadId));
        const enhancedPrompt = toolImagePrompt(template.imagePrompt, context);
        webSocketEmitter.emit(userIdNum, 'agent_progress', { message: '🎨 Generating promotional image for SMS/MMS...', stage: 'image_generation' });

        // Build imageConfig from input params
         
        const imageConfig: Record<string, any> = {};
        imageConfig.brandLogoUrl = selectedBrandLogoUrl(context);
        if (input.image_aspect_ratio) imageConfig.aspectRatio = input.image_aspect_ratio;
        else imageConfig.aspectRatio = '1:1'; // sensible default for SMS promotional images
        if (input.image_size) imageConfig.imageSize = input.image_size;
        
        const imageResult = await imageGenerationWorker.generateFromText(enhancedPrompt, imageConfig);
        
        if (imageResult?.imageData) {
          generatedImage = { imageData: imageResult.imageData, mimeType: imageResult.mimeType || 'image/png' };
          template.imageUrl = `data:${generatedImage.mimeType};base64,${imageResult.imageData}`;
          logger.info({ threadId: context.threadId }, '[Content Executor] Auto-generated SMS promotional image');
        }
       
      } catch (imgErr: any) {
        if (imgErr.message?.includes('rate limit') || imgErr.message?.includes('429')) {
          logger.warn({ err: imgErr }, '[Content Executor] SMS image generation rate limited');
          generatedImage = { placeholder: true };
        } else {
          logger.warn({ err: imgErr }, '[Content Executor] SMS image generation failed');
        }
      }
    }
    
    // Open SMS template preview
    const hasImage = generatedImage?.imageData && !generatedImage.placeholder;


    // Save to content_assets table
    let savedSmsId: number | undefined;
    try {
      const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
      const savedSms = await persistTextDraft({ type: 'sms', output: template, userId: toNumber(context.userId), threadId: toNumber(context.threadId), context: resolvedPolicyContext(context), imageUrl: template.imageUrl, title: input.campaign_name || 'SMS Template', performance: { maxCharacters: 160, includeOptOut: smsType === 'promotional' }, });
      savedSmsId = savedSms?.id;
      logger.info({ threadId: context.threadId }, '[Content Executor] SMS template saved to content_assets');

      // Save auto-generated image as child asset
      if (hasImage && savedSms?.id) {
        try {
          await ContentAssetModel.create({
            type: 'image',
            title: `SMS Image - ${input.campaign_name || 'Promotional'}`,
            content: template.imageUrl || template.imagePrompt || 'Auto-generated SMS image',
            imageUrl: template.imageUrl || null,
            channel: 'sms',
            status: 'draft',
            userId: typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null,
            threadId: typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null,
            parentAssetId: savedSms.id,
            performance: null,
          });
          logger.info({ parentAssetId: savedSms.id }, '[Content Executor] Auto-generated SMS image saved as child asset');
         
        } catch (imgSaveErr: any) {
          logger.warn({ err: imgSaveErr }, '[Content Executor] Failed to save auto-generated SMS image');
        }
      }
     
    } catch (saveError: any) {
      logger.error({ err: saveError }, '[Content Executor] Failed to save SMS template to database');
    }

    if (!savedSmsId) {
      return {
        success: false,
        toolName: 'generate_sms_template',
        error: 'The SMS copy was generated but could not be saved as a durable content asset.',
        output: { status: 'partial_success', template },
      };
    }


    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.SMS_TEMPLATE,
      tabLabel: TAB_LABELS[TAB_TYPES.SMS_TEMPLATE],
      data: { template, generatedImage: hasImage ? { imageData: generatedImage.imageData, mimeType: generatedImage.mimeType } : undefined },
    });
    return {
      success: true,
      toolName: 'generate_sms_template',
      output: {
        template,
        assetId: savedSmsId,
        generatedImage: hasImage ? generatedImage : undefined,
        brandToolkitUsed: context.brandToolkit?.name || null,
        message: `💬 SMS template generated successfully!${hasImage ? ' 🖼️ Includes auto-generated promotional image.' : ''} You can preview it in the SMS Template tab.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] SMS template error');
    return { success: false, toolName: 'generate_sms_template', error: error.message };
  }
}

 
export async function executePublishSocialPost(input: any, context: ToolContext): Promise<ToolResult> {
  try {
    const userId = typeof context.userId === 'string' ? parseInt(context.userId, 10) : context.userId;

    const { ContentAssetModel } = await import('../../../models/contentAssets/functions');
    const { db } = await import('../../../models/db');
    const { contentAssetsTable } = await import('../../../models/contentAssets/schema');
    const { eq, and } = await import('drizzle-orm');

    // Load the content asset and verify ownership
    const [asset] = await db
      .select()
      .from(contentAssetsTable)
      .where(and(eq(contentAssetsTable.id, input.content_asset_id), eq(contentAssetsTable.userId, userId)))
      .limit(1);

    if (!asset) {
      return { success: false, toolName: 'publish_social_post', error: `Content asset #${input.content_asset_id} not found.` };
    }

     
    const assetData = asset as any;

    // Extract caption — prefer explicit input, then parsed JSON content, then raw content
    const rawCaption = assetData.content || '';
     
    let parsedContent: Record<string, any> = {};
    try { parsedContent = JSON.parse(rawCaption); } catch { /* not JSON */ }
    const captionFromContent = parsedContent.caption || parsedContent.content || parsedContent.message || parsedContent.text || rawCaption;
    const caption = input.caption ?? captionFromContent ?? '';

    type DurablePublishTarget = {
      platform: 'facebook' | 'instagram' | 'youtube' | 'linkedin';
      credentialId?: number;
      caption?: string;
      postType?: string;
      title?: string;
      tags?: string[];
      privacyStatus?: string;
      youtubeOptions?: import('../../../utils/youtubePublishingOptions.js').YouTubePublishingOptions;
      instagramOptions?: import('../../../utils/instagramPublishingOptions.js').InstagramPublishingOptions;
    };
    const reviewedTargets: DurablePublishTarget[] = Array.isArray(input.targets) ? input.targets : ['instagram', 'facebook', 'youtube', 'linkedin'].includes(input.platform) ? [{
      platform: input.platform, credentialId: input.credential_id, caption: input.caption,
      postType: input.post_type, title: input.title, tags: input.tags, privacyStatus: input.privacy_status,
      instagramOptions: input.instagram_options,
      youtubeOptions: input.youtube_options,
    }] : [];
    if (reviewedTargets.length > 0) {
      const platformNames = reviewedTargets.map((target) => target.platform);
      if (new Set(platformNames).size !== platformNames.length) {
        return { success: false, toolName: 'publish_social_post', error: 'Each reviewed publishing platform may appear only once.' };
      }

      const {
        executeOrganicPublishAttempt,
      } = await import('../../../services/social/OrganicPublishingService.js');
      const baseIdempotencyKey = input.idempotency_key
        || `widget:${context.widgetId || context.threadId || 'unknown'}:${input.content_asset_id}`;
      const results: Record<string, {
        success: boolean;
        status: string;
        attemptId?: number;
        assetId?: number;
        postId?: string;
        postUrl?: string;
        error?: string;
        errorCode?: string;
      }> = {};
      const { prepareOrganicPublishBatch } = await import('../../../services/social/OrganicPublishLifecycleService.js');
      const entries = await prepareOrganicPublishBatch(userId, input.content_asset_id, reviewedTargets.map(target => ({
        platform: target.platform, caption: target.caption, postType: target.postType,
        title: target.title, tags: target.tags, privacyStatus: target.privacyStatus,
        youtubeOptions: target.youtubeOptions,
        credentialId: target.credentialId, timezone: input.timezone, scheduledFor: input.scheduled_for || undefined,
        instagramOptions: target.instagramOptions,
      })), baseIdempotencyKey, { expectedVersion: input.expected_version, expectedReviewToken: input.expected_review_token, required: true });
      for (const entry of entries) {
        const completed = input.scheduled_for ? entry.attempt : await executeOrganicPublishAttempt(
          entry.attempt, userId, `widget:${context.widgetId || context.threadId || 'unknown'}:${process.pid}`);
        results[entry.platform] = {
          success: completed.status === 'succeeded' || Boolean(input.scheduled_for && ['pending', 'claimed', 'retryable_failed'].includes(completed.status)),
          status: completed.status, attemptId: completed.id, assetId: entry.assetId,
          postId: completed.providerPostId || undefined, postUrl: completed.providerPostUrl || undefined,
          error: completed.errorMessage || undefined, errorCode: completed.errorCode || undefined,
        };
      }

      const resultValues = Object.values(results);
      const allSucceeded = resultValues.length === reviewedTargets.length && resultValues.every((result) => result.success);
      const anySucceeded = resultValues.some((result) => result.success);
      const providerFinalizationPending = !input.scheduled_for
        && resultValues.length === reviewedTargets.length
        && resultValues.every((result) => result.status === 'succeeded' || result.status === 'provider_succeeded')
        && resultValues.some((result) => result.status === 'provider_succeeded');
      const anyPending = resultValues.some(result => ['pending', 'claimed', 'provider_succeeded', 'retryable_failed'].includes(result.status));
      const allScheduled = Boolean(input.scheduled_for) && resultValues.every(result => ['pending', 'claimed', 'retryable_failed'].includes(result.status));
      const firstError = resultValues.find((result) => result.error)?.error;
      return {
        success: allSucceeded || anyPending || anySucceeded,
        toolName: 'publish_social_post',
        output: {
          assetId: input.content_asset_id,
          platform: platformNames[0],
          platforms: platformNames,
          results,
          partialSuccess: anySucceeded && !allSucceeded,
          scheduled: allScheduled,
          accepted: anyPending && !allScheduled,
          status: allScheduled ? 'scheduled' : providerFinalizationPending ? 'provider_succeeded' : allSucceeded ? 'succeeded' : anySucceeded ? 'partial_success' : anyPending ? 'pending' : 'failed',
          scheduledFor: input.scheduled_for || undefined,
          message: allScheduled
            ? `📅 Content asset #${input.content_asset_id} is scheduled for ${platformNames.join(', ')}.`
            : allSucceeded
              ? `✅ Published to **${platformNames.join(', ')}**.`
              : providerFinalizationPending
                ? 'The providers accepted the posts. Local finalization is pending reconciliation.'
                : anyPending
                  ? 'Publishing was accepted. Pending destinations will finish or retry in the background; review the per-platform results.'
                : anySucceeded
                  ? `Published to some destinations; review the per-platform results for ${platformNames.join(', ')}.`
                  : firstError || 'Publishing failed for every selected destination.',
        },
        ...(!allSucceeded && !anyPending && !anySucceeded ? { error: firstError || 'Publishing failed' } : {}),
      };
    }

    const platform = input.platform as 'facebook' | 'instagram' | 'youtube' | 'linkedin' | 'twitter';

    // If scheduled, update the asset and return
    if (input.scheduled_for) {
      await db
        .update(contentAssetsTable)
        .set({
          scheduledPublishAt: new Date(input.scheduled_for),
          publishPlatform: platform,
          status: 'scheduled',
        })
        .where(and(
          eq(contentAssetsTable.id, input.content_asset_id),
          eq(contentAssetsTable.userId, userId),
        ));

      return {
        success: true,
        toolName: 'publish_social_post',
        output: {
          assetId: input.content_asset_id,
          platform,
          scheduledFor: input.scheduled_for,
          message: `📅 Content asset #${input.content_asset_id} scheduled to publish to **${platform}** at ${new Date(input.scheduled_for).toLocaleString()}.`,
        },
      };
    }

    // Immediate publish
     
    let publishResult: any;

    // Helper: resolve local upload paths to public URLs required by Meta/YouTube APIs
    const toPublicUrl = (url?: string): string | undefined => {
      if (!url) return undefined;
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      const baseUrl = (process.env.APP_URL || process.env.NGROK_URL || 'https://asksales.ai').replace(/\/$/, '');
      return `${baseUrl}${url.startsWith('/') ? url : `/${url}`}`;
    };

    if ((platform as string) === 'instagram' || (platform as string) === 'facebook') {
      const { publishToInstagram, publishToFacebook } = await import('../../../services/social/SocialPublishingService');

      const imageUrl = toPublicUrl(assetData.imageUrl || parsedContent.imageUrl || assetData.metadata?.imageUrl || (assetData.type === 'image' ? assetData.content : undefined));
      const imageUrls = (assetData.imageUrls || parsedContent.imageUrls || assetData.metadata?.imageUrls || []).map(toPublicUrl).filter(Boolean) as string[];
      const videoUrl = toPublicUrl(assetData.videoUrl || parsedContent.videoUrl || assetData.metadata?.videoUrl);

      let resolvedImageUrl = imageUrl;
      const resolvedImageUrls = [...imageUrls];
      let resolvedVideoUrl = videoUrl;

      if (resolvedImageUrls.length === 0 && !resolvedImageUrl && !resolvedVideoUrl) {
        const childAssets = await db
          .select()
          .from(contentAssetsTable)
          .where(and(
            eq(contentAssetsTable.parentAssetId, input.content_asset_id),
            eq(contentAssetsTable.userId, userId),
          ));

        for (const child of childAssets) {
          if (child.type === 'image') {
            let childImg = child.imageUrl || (child.imageUrls && child.imageUrls[0]);
            if (!childImg && child.content) {
              if (child.content.startsWith('http') || child.content.startsWith('/')) {
                childImg = child.content;
              } else if (child.content.length > 100) {
                try {
                  const { saveBase64File } = await import('../../../utils/fileStorage.js');
                  const base64Data = child.content.includes('base64,') 
                    ? child.content.split('base64,')[1] 
                    : child.content;
                  const mimeType = child.content.includes('data:image/')
                    ? child.content.split(';')[0].split('data:')[1]
                    : 'image/png';
                  
                  const saved = await saveBase64File(base64Data, mimeType, 'images', 'converted', userId);
                  childImg = saved.url;
                  await db
                    .update(contentAssetsTable)
                    .set({ imageUrl: saved.url })
                    .where(and(
                      eq(contentAssetsTable.id, child.id),
                      eq(contentAssetsTable.userId, userId),
                    ));
                } catch (convErr) {
                  logger.warn({ err: convErr }, '[Content Executor] Failed to convert base64 child image to file');
                }
              }
            }
            if (childImg) {
              resolvedImageUrls.push(toPublicUrl(childImg) as string);
            }
          } else if (child.type === 'video') {
            const childVid = child.videoUrl || (child.videoUrls && child.videoUrls[0]) || child.content;
            if (childVid && (childVid.startsWith('http') || childVid.startsWith('/'))) {
              resolvedVideoUrl = toPublicUrl(childVid);
            }
          }
        }
        if (resolvedImageUrls.length > 0) {
          resolvedImageUrl = resolvedImageUrls[0];
        }
      }

      if ((platform as string) === 'instagram') {
        publishResult = await publishToInstagram(userId, {
          postType: input.post_type || 'post',
          imageUrls: resolvedImageUrls.length > 0 ? resolvedImageUrls : (resolvedImageUrl ? [resolvedImageUrl] : undefined),
          videoUrl: resolvedVideoUrl,
          caption,
        });
      } else {
        // Auto-detect post type based on available media
        const facebookPostType = input.post_type
          || (resolvedVideoUrl ? 'video' : (resolvedImageUrl || resolvedImageUrls.length > 0) ? 'photo' : 'text');
        publishResult = await publishToFacebook(userId, {
          postType: facebookPostType,
          message: caption,
          imageUrl: resolvedImageUrl || resolvedImageUrls[0],
          videoUrl: resolvedVideoUrl,
          title: input.title,
          description: input.title,
        });
      }
    } else if (platform === 'twitter') {
      const { TwitterApiService } = await import('../../../services/TwitterApiService');
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      const twitterApi = new TwitterApiService(userId);
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      await twitterApi.initialize();
      const imageUrl = toPublicUrl(assetData.imageUrl || parsedContent.imageUrl || assetData.metadata?.imageUrl || (assetData.type === 'image' ? assetData.content : undefined));
      const imageUrls = (assetData.imageUrls || parsedContent.imageUrls || assetData.metadata?.imageUrls || []).map(toPublicUrl).filter(Boolean) as string[];
      const mediaUrls = imageUrls.length > 0 ? imageUrls : (imageUrl ? [imageUrl] : undefined);

      publishResult = await twitterApi.publishTweet(caption, mediaUrls);
    } else {
      return { success: false, toolName: 'publish_social_post', error: `Unsupported platform: ${platform}` };
    }

    if (!publishResult?.success) {
      return { success: false, toolName: 'publish_social_post', error: publishResult?.error || 'Publishing failed' };
    }

    // Mark asset as published
    await ContentAssetModel.markAsPublished(input.content_asset_id, {
      publishedPostId: publishResult.platformPostId,
      publishedUrl: publishResult.postUrl,
      publishPlatform: platform,
    });

    return {
      success: true,
      toolName: 'publish_social_post',
      output: {
        assetId: input.content_asset_id,
        platform,
        postId: publishResult.platformPostId,
        postUrl: publishResult.postUrl,
        message: `✅ Successfully published to **${platform}**!${publishResult.postUrl ? ` [View post](${publishResult.postUrl})` : ''}`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Publish social post error');
    return { success: false, toolName: 'publish_social_post', error: error.message };
  }
}

export async function executeGenerateWhatsappTemplate(
  input: {
    template_name: string;
    category?: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
    language?: string;
    header_text?: string;
    body_text: string;
    footer_text?: string;
    cta_button_label?: string;
    cta_button_url?: string;
    quick_reply_buttons?: string[];
  },
  context: ToolContext
): Promise<ToolResult> {
  const category = input.category || 'MARKETING';
  const language = input.language || 'en_US';

  try {
    const templateStructure = {
      name: input.template_name,
      category,
      language,
      header: input.header_text || null,
      body: input.body_text,
      footer: input.footer_text || null,
      cta_button: input.cta_button_label ? {
        label: input.cta_button_label,
        url: input.cta_button_url || '',
      } : null,
      quick_reply_buttons: input.quick_reply_buttons || null,
    };

    // Save to content_assets table
    const { ContentAssetModel } = await import('../../../models/contentAssets/functions.js');
    const savedAsset = await ContentAssetModel.create({
      type: 'whatsapp_template',
      title: input.template_name,
      content: JSON.stringify(templateStructure),
      channel: 'whatsapp',
      status: 'draft',
      userId: typeof context.userId === 'string' ? parseInt(context.userId, 10) || null : context.userId || null,
      threadId: typeof context.threadId === 'string' ? parseInt(context.threadId, 10) || null : context.threadId || null,
      performance: null,
    });

    if (!savedAsset?.id) return unsavedGeneratedContent('generate_whatsapp_template', { structure: templateStructure });
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter.js');
    webSocketEmitter.emit(toNumber(context.userId), 'open_tab', {
      thread_id: toNumber(context.threadId), tabType: 'content-whatsapp', tabLabel: 'WhatsApp',
      data: { type: 'whatsapp', assetId: savedAsset.id },
    });
    return {
      success: true,
      toolName: 'generate_whatsapp_template',
      output: {
        assetId: savedAsset?.id,
        type: 'whatsapp',
        persistenceStatus: 'succeeded',
        templateName: input.template_name,
        category,
        language,
        structure: templateStructure,
        message: `✅ Generated WhatsApp Template "${input.template_name}" successfully and saved to drafts.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Content Executor] Generate WhatsApp template error');
    return {
      success: false,
      toolName: 'generate_whatsapp_template',
      error: error.message || 'Failed to generate WhatsApp template',
    };
  }
}
import { requireBusinessScope } from '../../../tenancy/businessContext.js';
