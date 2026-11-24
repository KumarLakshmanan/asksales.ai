import { businessOwnerUserId, currentBusinessScope } from '../tenancy/businessContext.js';
import { Request, Response } from "express";
import { ContentAssetModel } from "../models/contentAssets/functions";
import { withoutGenerationKey } from "../utils/contentGenerationKey.js";
import { InsertContentAsset } from "../models/contentAssets/schema";
import { getChatThreadById } from "../models/chatThreads/functions";
import multer from "multer";
import { logger } from '../utils/logger.js';
import { StorageService } from '../services/StorageService.js';
import { canonicalMediaUrl, findRemovedContentAssetMediaUrls } from '../utils/contentAssetMedia.js';
import {
  brandContextSnapshot,
  ContentBrandContextError,
  resolveContentBrandContext,
  type ResolvedContentBrandContext,
} from '../services/content/ContentBrandContextService.js';
import {
  ContentComplianceError,
  validateGeneratedContent,
  type ContentOutputType,
} from '../services/content/ContentComplianceService.js';
import { findUnresolvedTemplateVariables } from '../utils/contentTemplateRendering.js';
import { OrganicPublishingError } from '../services/social/OrganicPublishingService.js';
import { BillingOrganizationError } from '../services/billing/organizations.js';
import { updateEditableContentAsset } from '../services/social/OrganicPublishLifecycleService.js';
import { randomUUID } from 'node:crypto';
import { transcodeMedia, validateMediaForPlatform, type MediaProfile } from '../services/media/MediaTranscodingService.js';
import { contentAssetManagedStorageEntry, lockContentManagedStorage, syncContentManagedStorage } from '../services/content/ContentManagedStorageService.js';
import { ManagedStorageReferenceError, type StorageReferenceScope } from '../services/storageReferenceLocks.js';
import { parseContentObject as parseAssetContent } from '../utils/contentObject.js';

// Configure multer with memory storage (files go to S3/MinIO via StorageService)
const mediaFileFilter = (
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedMimeTypes = [
    // Images
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    // Videos
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
  ];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only image and video files are allowed"));
  }
};

export const uploadMediaMiddleware = multer({
  storage: multer.memoryStorage(),
  fileFilter: mediaFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
}).single('file');

function hasValidMediaSignature(file: Express.Multer.File): boolean {
  const bytes = file.buffer;
  if (bytes.length < 12) return false;
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('ascii');
  switch (file.mimetype) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'video/mp4':
    case 'video/quicktime':
      return ascii(4, 8) === 'ftyp';
    case 'video/webm':
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case 'video/x-msvideo':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ';
    default:
      return false;
  }
}

function parsePositiveQueryInteger(value: unknown, field: string, max?: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`Invalid ${field}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (max !== undefined && parsed > max)) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed;
}

function parseNonNegativeQueryInteger(value: unknown, field: string, max?: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`Invalid ${field}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || (max !== undefined && parsed > max)) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed;
}

function compliancePayload(asset: {
  type: string;
  title: string;
  content: string;
  channel: string;
  metadata?: Record<string, unknown> | null;
}): { type: ContentOutputType; output: Record<string, unknown>; platform?: string } | null {
  const parsed = parseAssetContent(asset.content);
  const type = asset.type.toLowerCase();
  const platform = String(parsed.platform || asset.channel || '').toLowerCase();
  if (type.includes('image') || type.includes('video')) return null;
  if (type.includes('email')) {
    return {
      type: 'email',
      output: {
        ...parsed,
        subject: parsed.subject || asset.title,
        body: parsed.body || parsed.content || asset.content,
      },
      platform,
    };
  }
  if (type.includes('sms')) {
    return { type: 'sms', output: { ...parsed, message: parsed.message || parsed.content || asset.content }, platform: 'sms' };
  }
  if (type.includes('message') || type.includes('dm')) {
    return {
      type: 'social_message',
      output: { ...parsed, message: parsed.message || parsed.content || asset.content },
      platform,
    };
  }
  if (type.includes('ad')) {
    return {
      type: 'ad',
      output: {
        ...parsed,
        headline: parsed.headline || asset.title,
        primaryText: parsed.primaryText || parsed.primary_text || parsed.content || asset.content,
        // An explicitly blank optional description must not inherit primary copy:
        // primary text has a different (longer) channel limit.
        description: parsed.description ?? parsed.primaryText ?? parsed.content ?? asset.content,
        callToAction: parsed.callToAction || parsed.call_to_action || parsed.cta || asset.metadata?.callToAction || '',
        imagePrompt: parsed.imagePrompt || parsed.image_prompt || 'Use the approved Brand Toolkit visual identity.',
      },
      platform,
    };
  }
  if (type.includes('blog')) {
    return {
      type: 'blog',
      output: {
        ...parsed,
        title: parsed.title || asset.title,
        content: parsed.content || asset.content,
        excerpt: parsed.excerpt || String(parsed.content || asset.content).slice(0, 500),
        tags: parsed.tags || [],
      },
      platform,
    };
  }
  return {
    type: 'social',
    output: {
      ...parsed,
      caption: parsed.caption || parsed.content || asset.content,
      hashtags: parsed.hashtags || [],
      keywords: parsed.keywords || [],
    },
    platform,
  };
}

function validateAssetForPreviewOrPublish(
  asset: {
    type: string;
    title: string;
    content: string;
    channel: string;
    metadata?: Record<string, unknown> | null;
  },
  context: ResolvedContentBrandContext,
  platforms?: string[],
  requireResolvedVariables = false,
): void {
  if (requireResolvedVariables) {
    const unresolved = findUnresolvedTemplateVariables(
      [asset.title, asset.content].filter(Boolean).join('\n'),
    );
    if (unresolved.length > 0) {
      throw new ContentComplianceError([
        `Resolve template variables before previewing or publishing: ${unresolved.join(', ')}.`,
      ]);
    }
  }
  const payload = compliancePayload(asset);
  if (!payload) return;
  const targets = platforms?.length ? platforms : [payload.platform || ''];
  for (const platform of targets) {
    validateGeneratedContent({
      type: payload.type,
      output: payload.output,
      context,
      platform,
      // Saved SMS drafts may deliberately span multiple transport segments.
      // The stricter selected limit belongs to generation, not later editing.
      smsMaxCharacters: payload.type === 'sms' ? 320 : undefined,
    });
  }
}

function handleContentGovernanceError(error: unknown, res: Response): boolean {
  if (error instanceof OrganicPublishingError || error instanceof BillingOrganizationError || error instanceof ManagedStorageReferenceError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof ContentBrandContextError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof ContentComplianceError) {
    res.status(422).json({
      error: 'Content failed brand or channel validation.',
      code: 'CONTENT_VALIDATION_FAILED',
      violations: error.violations,
    });
    return true;
  }
  return false;
}

async function cleanupRemovedContentAssetMedia(
  assetId: number,
  userId: number,
  before: Parameters<typeof findRemovedContentAssetMediaUrls>[0],
  after: Parameters<typeof findRemovedContentAssetMediaUrls>[1],
) {
  const removedUrls = findRemovedContentAssetMediaUrls(before, after);
  if (removedUrls.size === 0) return;

  const { db } = await import('../models/db.js');
  const { storageFilesTable } = await import('../models/storageFiles/schema.js');
  const { and, eq } = await import('drizzle-orm');
  const files = await db
    .select()
    .from(storageFilesTable)
    .where(and(
      eq(storageFilesTable.referenceType, 'content_asset'),
      eq(storageFilesTable.referenceId, String(assetId)),
      eq(storageFilesTable.userId, userId),
      eq(storageFilesTable.isDeleted, false),
    ));

  const storageService = StorageService.getInstance();
  for (const file of files) {
    if (!file.url || !removedUrls.has(canonicalMediaUrl(file.url))) continue;
    try {
      const replacementOwnerId = await ContentAssetModel.findOtherAssetReferencingMediaUrl(
        userId,
        assetId,
        file.url,
      );
      if (replacementOwnerId) {
        await storageService.reassignFileReference(
          file.id,
          userId,
          'content_asset',
          String(replacementOwnerId),
        );
        continue;
      }
      await storageService.deleteFile(file.id, userId);
    } catch (cleanupError) {
      logger.warn(
        { err: cleanupError, assetId, fileId: file.id, userId },
        '[ContentAssetController] Failed to clean up detached content media',
      );
    }
  }
}

export const getContentAssets = async (req: Request, res: Response) => {
  try {
    const { type, channel, status, threadId, includeThread, limit, offset, paginated, search } = req.query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const threadIdNum = parsePositiveQueryInteger(threadId, 'threadId');
    if (paginated !== undefined && paginated !== 'true' && paginated !== 'false') {
      return res.status(400).json({ error: 'Invalid paginated' });
    }
    if (search !== undefined && (typeof search !== 'string' || search.trim().length > 200)) {
      return res.status(400).json({ error: 'Invalid search' });
    }
    const isPaginated = paginated === 'true';
    const limitNum = parsePositiveQueryInteger(limit, 'limit', 200) ?? (isPaginated ? 24 : undefined);
    const offsetNum = parseNonNegativeQueryInteger(offset, 'offset', 1_000_000);
    const filters = {
      type: typeof type === 'string' ? type : undefined,
      channel: typeof channel === 'string' ? channel : undefined,
      status: typeof status === 'string' ? status : undefined,
      threadId: threadIdNum,
      limit: limitNum,
      offset: offsetNum ?? (isPaginated ? 0 : undefined),
      search: typeof search === 'string' ? search.trim() || undefined : undefined,
    };
    const [assets, total] = await Promise.all([
      ContentAssetModel.findByUser(Number(userId), filters),
      isPaginated ? ContentAssetModel.countForUser(Number(userId), filters) : Promise.resolve(undefined),
    ]);
    
    // If includeThread is requested, fetch thread names for grouping
    if (includeThread === 'true') {
      const uniqueThreadIds = [...new Set(assets.filter(a => a.threadId).map(a => a.threadId as number))];
      const threadNames = new Map<number, string>();
      
      for (const tid of uniqueThreadIds) {
        try {
          const thread = await getChatThreadById(tid);
          if (thread?.userId === Number(userId)) {
            threadNames.set(tid, thread.title || `Chat ${tid}`);
          }
        } catch {
          // If thread not found, use fallback name
          threadNames.set(tid, `Chat ${tid}`);
        }
      }
      
      // Add threadName to each asset
      const assetsWithThreadName = assets.map(asset => ({
        ...asset,
        threadName: asset.threadId ? threadNames.get(asset.threadId) || `Chat ${asset.threadId}` : undefined,
      }));
      
      return res.json(isPaginated ? { assets: assetsWithThreadName, total } : assetsWithThreadName);
    }
    
    res.json(isPaginated ? { assets, total } : assets);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, '[ContentAssetController] Error fetching assets');
    res.status(500).json({ error: "Unable to retrieve content assets. Please try again." });
  }
};

export const getContentAsset = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = Number(businessOwnerUserId(req));
    const assetId = Number(req.params.assetId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: 'Invalid content asset ID' });
    const asset = await ContentAssetModel.findByIdForUser(assetId, userId);
    if (!asset) return res.status(404).json({ error: 'Content asset not found' });
    const { getOrganicPublishingReview } = await import('../services/social/OrganicPublishingService.js');
    const review = await getOrganicPublishingReview(asset);
    return res.json({ ...asset, imageUrls: review.media.imageUrls, videoUrls: review.media.videoUrls, publishingReviewToken: review.token });
  } catch (error) {
    logger.error({ err: error }, '[ContentAssetController] Failed to load content asset');
    return res.status(500).json({ error: 'Unable to load content asset' });
  }
};

/**
 * Get content asset counts by type for the current user
 */
export const getContentAssetCounts = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const threadId = parsePositiveQueryInteger(req.query.threadId, 'threadId');
    const counts = await ContentAssetModel.countByTypeForUser(Number(userId), threadId);
    
    res.json(counts);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, '[ContentAssetController] Error fetching asset counts');
    res.status(500).json({ error: "Unable to retrieve content asset counts." });
  }
};

export const createContentAsset = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (req.body.status && !['draft', 'ready', 'archived'].includes(req.body.status)) {
      return res.status(400).json({ error: 'Use the publish action to publish or schedule content' });
    }
    if (['scheduledPublishAt', 'publishedAt', 'publishedPostId', 'publishedUrl', 'retryCount', 'lastError'].some(field => req.body[field] !== undefined && req.body[field] !== null)) {
      return res.status(400).json({ error: 'Publishing state is managed by the publishing workflow' });
    }
    if (req.body.metadata && ['mediaProbe', 'mediaProbeUrl', 'mediaProbes', 'mediaTranscodeJobId', 'organicPublishAttemptId', 'reviewedPublishSnapshot'].some(field => req.body.metadata[field] !== undefined)) {
      return res.status(400).json({ error: 'Publication receipts and trusted media metadata cannot be supplied manually' });
    }
    if (req.body.threadId) {
      const thread = await getChatThreadById(Number(req.body.threadId));
      if (!thread || thread.userId !== Number(userId)) return res.status(404).json({ error: 'Chat thread not found' });
    }
    if (req.body.parentAssetId) {
      const parent = await ContentAssetModel.findByIdForUser(Number(req.body.parentAssetId), Number(userId));
      if (!parent) return res.status(404).json({ error: 'Parent content asset not found' });
    }
    const scheduledPublishAt = req.body.scheduledPublishAt
      ? new Date(req.body.scheduledPublishAt)
      : undefined;
    if (scheduledPublishAt && Number.isNaN(scheduledPublishAt.getTime())) {
      return res.status(400).json({ error: "Invalid scheduled publish date" });
    }
    if (req.body.status === 'scheduled') {
      if (!scheduledPublishAt || scheduledPublishAt.getTime() <= Date.now() + 60_000) {
        return res.status(400).json({ error: 'Scheduled publish time must be at least one minute in the future' });
      }
      if (!req.body.publishPlatform) return res.status(400).json({ error: 'A publishing platform is required for scheduled content' });
    }
    const context = await resolveContentBrandContext(Number(userId), {
      businessProfileId: req.body.businessProfileId,
      brandToolkitId: req.body.brandToolkitId,
    });
    validateAssetForPreviewOrPublish(req.body, context);
    const assetData: InsertContentAsset = {
      ...req.body,
      userId,
      businessProfileId: context.businessProfile.id,
      brandToolkitId: context.brandToolkit.id,
      brandContextSnapshot: brandContextSnapshot(context),
      validationSnapshot: {
        validatedAt: new Date().toISOString(),
        stage: 'preview',
        violations: [],
      },
      approvalStatus: 'draft',
      ...(scheduledPublishAt && { scheduledPublishAt }),
    };
    let asset;
    if (req.body.sourceTemplateId !== undefined && req.body.sourceTemplateId !== null) {
      const sourceTemplateId = Number(req.body.sourceTemplateId);
      const sourceTemplateVersion = Number(req.body.sourceTemplateVersion);
      if (!Number.isSafeInteger(sourceTemplateId) || sourceTemplateId <= 0 || !Number.isSafeInteger(sourceTemplateVersion) || sourceTemplateVersion <= 0) return res.status(400).json({ error: 'A valid source template ID and version are required' });
      const { db } = await import('../models/db.js');
      const { contentTemplatesTable } = await import('../models/contentTemplates/schema.js');
      const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
      const { eq } = await import('drizzle-orm');
      asset = await db.transaction(async (tx: typeof db) => {
        await lockContentManagedStorage(tx, assetData);
        const [template] = await tx.select().from(contentTemplatesTable).where(eq(contentTemplatesTable.id, sourceTemplateId)).for('share');
        if (!template || (template.userId !== Number(userId) && !(template.isPredefined && template.isApproved))) throw new OrganicPublishingError('Source template not found.', 'SOURCE_TEMPLATE_NOT_FOUND', 404);
        if (template.version !== sourceTemplateVersion) throw new OrganicPublishingError('Source template changed. Reload and review the latest version.', 'SOURCE_TEMPLATE_VERSION_CONFLICT', 409);
        const [saved] = await tx.insert(contentAssetsTable).values({ ...assetData, sourceTemplateId, sourceTemplateVersion }).returning();
        await syncContentManagedStorage(tx, [contentAssetManagedStorageEntry(saved)]);
        return saved;
      });
      await ContentAssetModel.attachTrackedMedia(asset);
    } else {
      if (req.body.sourceTemplateVersion !== undefined && req.body.sourceTemplateVersion !== null) return res.status(400).json({ error: 'sourceTemplateVersion requires a sourceTemplateId' });
      asset = await ContentAssetModel.create(assetData);
    }
    res.status(201).json(asset);
  } catch (error) {
    if (handleContentGovernanceError(error, res)) return;
    logger.error({ err: error }, '[ContentAssetController] Error creating asset');
    res.status(500).json({ error: "Unable to create the content asset. Please try again." });
  }
};

export const updateContentAsset = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid content asset ID' });
    const existingAsset = await ContentAssetModel.findByIdForUser(id, Number(userId));
    if (!existingAsset) return res.status(404).json({ error: "Content asset not found" });
    const { userId: _ignoredUserId, id: _ignoredId, ...assetData } = req.body;
    if (['sourceTemplateId', 'sourceTemplateVersion'].some(field => assetData[field] !== undefined && assetData[field] !== existingAsset[field as 'sourceTemplateId' | 'sourceTemplateVersion'])) return res.status(400).json({ error: 'Template provenance cannot be changed after content creation' });
    if (['published', 'scheduled', 'processing'].includes(existingAsset.status)) {
      return res.status(409).json({ error: 'Cancel scheduled publishing or unpublish this content before editing.' });
    }
    if (assetData.status && !['draft', 'ready', 'archived'].includes(assetData.status)) {
      return res.status(400).json({ error: 'Use the publish action to publish or schedule content' });
    }
    if (['scheduledPublishAt', 'publishedAt', 'publishedPostId', 'publishedUrl', 'retryCount', 'lastError'].some(field => Object.prototype.hasOwnProperty.call(assetData, field))) {
      return res.status(400).json({ error: 'Use the publishing workflow to change publication state or timing' });
    }
    if (assetData.metadata) {
      const saved = (existingAsset.metadata || {}) as Record<string, unknown>;
      for (const field of ['mediaProbe', 'mediaProbeUrl', 'mediaProbes', 'mediaTranscodeJobId', 'organicPublishAttemptId', 'reviewedPublishSnapshot']) {
        if (JSON.stringify(assetData.metadata[field]) !== JSON.stringify(saved[field]) && assetData.metadata[field] !== undefined) return res.status(400).json({ error: 'Trusted publication metadata cannot be changed manually' });
        if (saved[field] !== undefined) assetData.metadata[field] = saved[field];
      }
    }
    const videoReferences = (value: { videoUrl?: unknown; videoUrls?: unknown; content?: string; metadata?: unknown }) => {
      const parsed = parseAssetContent(value.content || '');
      const metadata = (value.metadata || {}) as Record<string, unknown>;
      return JSON.stringify([value.videoUrl, value.videoUrls, parsed.videoUrl, parsed.videoUrls, parsed.generatedVideo, metadata.videoUrl, metadata.videoUrls]);
    };
    if (videoReferences(existingAsset) !== videoReferences({ ...existingAsset, ...assetData })) {
      assetData.metadata = { ...(assetData.metadata || existingAsset.metadata || {}) };
      for (const key of ['mediaProbe', 'mediaProbeUrl', 'mediaProbes', 'mediaTranscodeJobId']) delete assetData.metadata[key];
    }
    if (assetData.threadId) {
      const thread = await getChatThreadById(Number(assetData.threadId));
      if (!thread || thread.userId !== Number(userId)) return res.status(404).json({ error: 'Chat thread not found' });
    }
    if (assetData.parentAssetId) {
      const parent = await ContentAssetModel.findByIdForUser(Number(assetData.parentAssetId), Number(userId));
      if (!parent) return res.status(404).json({ error: 'Parent content asset not found' });
    }
    if (assetData.scheduledPublishAt) {
      assetData.scheduledPublishAt = new Date(assetData.scheduledPublishAt);
      if (Number.isNaN(assetData.scheduledPublishAt.getTime())) {
        return res.status(400).json({ error: "Invalid scheduled publish date" });
      }
    }
    if (assetData.status === 'scheduled') {
      const scheduledAt = assetData.scheduledPublishAt || existingAsset.scheduledPublishAt;
      if (!scheduledAt || scheduledAt.getTime() <= Date.now() + 60_000) {
        return res.status(400).json({ error: 'Scheduled publish time must be at least one minute in the future' });
      }
      if (!assetData.publishPlatform && !existingAsset.publishPlatform) {
        return res.status(400).json({ error: 'A publishing platform is required for scheduled content' });
      }
      assetData.retryCount = 0;
      assetData.lastError = null;
    }
    const context = await resolveContentBrandContext(Number(userId), {
      businessProfileId: assetData.businessProfileId ?? existingAsset.businessProfileId,
      brandToolkitId: assetData.brandToolkitId ?? existingAsset.brandToolkitId,
    });
    validateAssetForPreviewOrPublish({
      ...existingAsset,
      ...assetData,
      title: assetData.title ?? existingAsset.title,
      type: assetData.type ?? existingAsset.type,
      content: assetData.content ?? existingAsset.content,
      channel: assetData.channel ?? existingAsset.channel,
      metadata: (assetData.metadata ?? existingAsset.metadata) as Record<string, unknown> | null,
    }, context);
    assetData.businessProfileId = context.businessProfile.id;
    assetData.brandToolkitId = context.brandToolkit.id;
    assetData.brandContextSnapshot = brandContextSnapshot(context);
    assetData.validationSnapshot = {
      validatedAt: new Date().toISOString(),
      stage: 'preview',
      violations: [],
    };
    assetData.approvalStatus = 'draft';
    assetData.approvedBy = null;
    assetData.approvedAt = null;
    assetData.version = existingAsset.version + 1;
    const asset = await updateEditableContentAsset(Number(userId), id, assetData);
    if (!asset) {
      return res.status(404).json({ error: "Content asset not found" });
    }
    const includesMediaUpdate = ['content', 'imageUrl', 'videoUrl', 'imageUrls', 'videoUrls']
      .some((field) => Object.prototype.hasOwnProperty.call(assetData, field));
    if (includesMediaUpdate) {
      try {
        await cleanupRemovedContentAssetMedia(id, Number(userId), existingAsset, asset);
      } catch (cleanupError) {
        logger.warn(
          { err: cleanupError, assetId: id, userId: Number(userId) },
          '[ContentAssetController] Unable to inspect detached content media',
        );
      }
    }
    res.json(asset);
  } catch (error) {
    if (handleContentGovernanceError(error, res)) return;
    logger.error({ err: error }, '[ContentAssetController] Error updating asset');
    res.status(500).json({ error: "Unable to update the content asset. Please try again." });
  }
};

export const deleteContentAsset = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    // First check if the asset exists and belongs to the user
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid content asset ID' });
    const existingAsset = await ContentAssetModel.findByIdForUser(id, Number(userId));
    if (!existingAsset) {
      return res.status(404).json({ error: "Content asset not found" });
    }
    if (['published', 'scheduled', 'processing'].includes(existingAsset.status)) {
      return res.status(409).json({ error: 'Cancel scheduled publishing or unpublish this content before deleting it' });
    }

    // Delete linked files from StorageService
    const storageService = StorageService.getInstance();
    const { db } = await import("../models/db");
    const { storageFilesTable } = await import("../models/storageFiles/schema");
    const { eq, and } = await import("drizzle-orm");
    
    const files = await db
      .select()
      .from(storageFilesTable)
      .where(
        and(
          eq(storageFilesTable.referenceType, 'content_asset'),
          eq(storageFilesTable.referenceId, String(id)),
          eq(storageFilesTable.userId, Number(userId)),
          eq(storageFilesTable.isDeleted, false)
        )
      );

    const { deleteEditableContentAsset } = await import('../services/social/OrganicPublishLifecycleService.js');
    await deleteEditableContentAsset(Number(userId), id);

    // The database is authoritative. Clean up objects only after the record is
    // gone so a transient storage failure cannot leave a live asset with broken
    // media references. Failed object cleanup remains discoverable as an orphan.
    for (const f of files) {
      try {
        if (f.url) {
          const replacementOwnerId = await ContentAssetModel.findOtherAssetReferencingMediaUrl(
            Number(userId),
            id,
            f.url,
          );
          if (replacementOwnerId) {
            await storageService.reassignFileReference(
              f.id,
              Number(userId),
              'content_asset',
              String(replacementOwnerId),
            );
            continue;
          }
        }
        await storageService.deleteFile(f.id, Number(userId));
      } catch (delErr) {
        logger.warn({ err: delErr, fileId: f.id }, '[ContentAssetController] Failed to delete content asset file');
      }
    }

    res.json({ success: true, message: "Content asset deleted successfully" });
  } catch (error) {
    if (handleContentGovernanceError(error, res)) return;
    logger.error({ err: error }, '[ContentAssetController] Error deleting asset');
    res.status(500).json({ error: "Unable to delete the content asset. Please try again." });
  }
};

/**
 * Upload media (image or video) for a content asset
 * Updates an existing content asset with the uploaded media URL
 */
export const uploadContentMedia = async (req: Request, res: Response) => {
  let uploadedUrl: string | undefined;
  let uploadUserId: number | undefined;
  let uploadedFileId: number | undefined;
  let uploadedScope: StorageReferenceScope | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { assetId, mediaType } = req.body; // mediaType: 'image' or 'video'
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    if (!hasValidMediaSignature(file)) {
      return res.status(400).json({ error: 'The uploaded file content does not match its media type' });
    }
    
    const parsedAssetId = Number(assetId);
    if (!Number.isSafeInteger(parsedAssetId) || parsedAssetId <= 0) {
      return res.status(400).json({ error: "Asset ID is required" });
    }
    
    if (!mediaType || !['image', 'video'].includes(mediaType)) {
      return res.status(400).json({ error: "Media type must be 'image' or 'video'" });
    }
    
    // Check if asset exists and belongs to user
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    uploadUserId = Number(userId);
    const existingAsset = await ContentAssetModel.findByIdForUser(parsedAssetId, uploadUserId);
    if (!existingAsset) {
      return res.status(404).json({ error: "Content asset not found" });
    }
    if (['published', 'scheduled', 'processing'].includes(existingAsset.status)) {
      return res.status(409).json({ error: 'Cancel scheduled publishing or unpublish this content before adding media.' });
    }
    
    // Video bytes are probed and normalized before storage. Provider publishing
    // consumes this trusted probe snapshot, never a browser-supplied duration.
    let uploadBuffer = file.buffer;
    let uploadOriginalName = file.originalname;
    let uploadMimeType = file.mimetype;
    let mediaProbe: Record<string, unknown> | undefined;
    let mediaJobId: string | undefined;
    if (mediaType === 'video') {
      const profile = ['instagram', 'facebook', 'youtube', 'whatsapp'].includes(existingAsset.publishPlatform || '')
        ? existingAsset.publishPlatform as MediaProfile
        : 'instagram';
      mediaJobId = randomUUID();
      const { db } = await import('../models/db.js');
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`INSERT INTO media_transcode_jobs (id, user_id, asset_id, source_url, platform, status) VALUES (${mediaJobId}, ${uploadUserId}, ${parsedAssetId}, ${file.originalname}, ${profile}, 'processing')`);
      try {
        const transcoded = await transcodeMedia(file.buffer, profile);
        const preflightErrors = validateMediaForPlatform(transcoded.probe, profile);
        if (preflightErrors.length) throw new Error(preflightErrors.join(' '));
        uploadBuffer = transcoded.output;
        // The processor emits a normalized MP4. Persist matching storage
        // metadata so consumers never infer the original container/type.
        uploadOriginalName = `${file.originalname.replace(/\.[^.]+$/, '') || 'video'}.mp4`;
        uploadMimeType = 'video/mp4';
        mediaProbe = { ...transcoded.probe, profile, transcodedAt: new Date().toISOString() };
        await db.execute(sql`UPDATE media_transcode_jobs SET status='completed', probe=${JSON.stringify(mediaProbe)}::jsonb, updated_at=NOW() WHERE id=${mediaJobId} AND user_id=${uploadUserId}`);
      } catch (error) {
        await db.execute(sql`UPDATE media_transcode_jobs SET status='failed', error_code='TRANSCODE_FAILED', error_message=${error instanceof Error ? error.message : 'Media processing failed'}, updated_at=NOW() WHERE id=${mediaJobId} AND user_id=${uploadUserId}`);
        return res.status(422).json({ error: error instanceof Error ? error.message : 'Video could not be transcoded safely', code: 'MEDIA_TRANSCODE_FAILED', jobId: mediaJobId });
      }
    }
    // Upload file through StorageService (handles quota, tracking, backend)
    const storageService = StorageService.getInstance();
    const uploadResult = await storageService.upload(uploadBuffer, {
      userId,
      category: mediaType === 'image' ? 'content_asset' : 'content_asset',
      originalName: uploadOriginalName,
      mimeType: uploadMimeType,
      referenceType: 'content_asset',
      referenceId: String(parsedAssetId),
    });

    const publicUrl = uploadResult.url;
    uploadedUrl = publicUrl;
    uploadedFileId = uploadResult.fileId;
    uploadedScope = currentBusinessScope();
    if (mediaJobId) {
      const { db } = await import('../models/db.js');
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`UPDATE media_transcode_jobs SET output_url=${publicUrl}, updated_at=NOW() WHERE id=${mediaJobId} AND user_id=${uploadUserId}`);
    }
    
    // Update the asset with the new media URL
    let contentJson: Record<string, unknown> = {};
    try {
      const parsed = existingAsset.content ? JSON.parse(existingAsset.content) : {};
      contentJson = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { content: existingAsset.content };
    } catch {
      contentJson = { content: existingAsset.content };
    }
    
    if (mediaType === 'image') {
      const primaryImageUrl = existingAsset.imageUrl || publicUrl;
      contentJson.imageUrl = primaryImageUrl;
      contentJson.generatedImage = primaryImageUrl;
      if (Array.isArray(contentJson.imageUrls)) {
        if (!contentJson.imageUrls.includes(publicUrl)) contentJson.imageUrls.push(publicUrl);
      } else {
        contentJson.imageUrls = [publicUrl];
      }
    } else {
      const primaryVideoUrl = existingAsset.videoUrl || publicUrl;
      contentJson.videoUrl = primaryVideoUrl;
      contentJson.generatedVideo = primaryVideoUrl;
      if (Array.isArray(contentJson.videoUrls)) {
        if (!contentJson.videoUrls.includes(publicUrl)) contentJson.videoUrls.push(publicUrl);
      } else {
        contentJson.videoUrls = [publicUrl];
      }
    }
    
    const imageUrls = Array.isArray(existingAsset.imageUrls) ? [...existingAsset.imageUrls] : [];
    const videoUrls = Array.isArray(existingAsset.videoUrls) ? [...existingAsset.videoUrls] : [];
    if (mediaType === 'image' && !imageUrls.includes(publicUrl)) imageUrls.push(publicUrl);
    if (mediaType === 'video' && !videoUrls.includes(publicUrl)) videoUrls.push(publicUrl);

    const updatedAsset = await updateEditableContentAsset(uploadUserId, parsedAssetId, {
      content: JSON.stringify(contentJson),
      imageUrl: mediaType === 'image' ? (existingAsset.imageUrl || imageUrls[0] || publicUrl) : existingAsset.imageUrl,
      videoUrl: mediaType === 'video' ? (existingAsset.videoUrl || videoUrls[0] || publicUrl) : existingAsset.videoUrl,
      imageUrls,
      videoUrls,
      approvalStatus: 'draft',
      approvedBy: null,
      approvedAt: null,
      version: existingAsset.version + 1,
      metadata: mediaProbe ? { ...(existingAsset.metadata || {}), mediaProbe, mediaProbeUrl: publicUrl,
        mediaProbes: { ...((existingAsset.metadata?.mediaProbes || {}) as Record<string, unknown>), [publicUrl]: mediaProbe },
        mediaTranscodeJobId: mediaJobId } : existingAsset.metadata,
    });
    if (!updatedAsset) throw new Error('Content asset changed before media could be attached');
    
    res.json({ 
      success: true, 
      url: publicUrl,
      asset: updatedAsset, mediaJobId, mediaProbe,
    });
  } catch (error) {
    if (uploadedUrl && uploadUserId) {
      try {
        // The failed editable-asset transaction has rolled back. Compensate
        // only this tracked upload; a concurrent committed holder wins safely.
        if (uploadedFileId && uploadedScope) await StorageService.getInstance().compensateFailedUpload(uploadedScope, uploadedFileId);
        else await StorageService.getInstance().deleteByUrl(uploadedUrl, uploadUserId);
      } catch (cleanupError) {
        logger.warn({ err: cleanupError, uploadedUrl, uploadUserId }, '[ContentAssetController] Failed to clean up unattached content media');
      }
    }
    if (handleContentGovernanceError(error, res)) return;
    logger.error({ err: error }, '[ContentAssetController] Error uploading media');
    res.status(500).json({ error: "Unable to upload the media. Please try again." });
  }
};

export const publishContentAsset = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const assetId = parseInt(req.params.assetId);
    const {
      platform,
      platforms,
      caption,
      postType,
      scheduledFor,
      title,
      tags,
      privacyStatus,
      credentialIds,
      credentialId,
      timezone,
      youtubeOptions,
      targets,
      expectedVersion,
      expectedReviewToken,
    } = req.body;

    // Input Validation
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid content asset ID' });
    }
    if (postType && !['post', 'feed', 'story', 'reel', 'carousel', 'video', 'short', 'shorts', 'photo', 'text', 'image'].includes(postType)) {
      return res.status(400).json({ error: "Invalid postType" });
    }

    if (scheduledFor) {
      if (typeof scheduledFor !== 'string') return res.status(400).json({ error: 'scheduledFor must be an ISO timestamp string' });
      const schedDate = new Date(scheduledFor);
      if (isNaN(schedDate.getTime())) {
        return res.status(400).json({ error: "Invalid scheduledFor date format" });
      }
    }

    type PublishTarget = {
      platform: string;
      credentialId?: number;
      caption?: string;
      postType?: string;
      title?: string;
      tags?: string[];
      privacyStatus?: string;
      youtubeOptions?: import('../utils/youtubePublishingOptions.js').YouTubePublishingOptions;
      instagramOptions?: import('../utils/instagramPublishingOptions.js').InstagramPublishingOptions;
    };
    let normalizedTargets: PublishTarget[];
    if (targets !== undefined) {
      if (!Array.isArray(targets) || targets.length === 0 || targets.length > 5) {
        return res.status(400).json({ error: 'targets must contain 1–5 publishing destinations' });
      }
      if (targets.some((value: unknown) => !value || typeof value !== 'object' || Array.isArray(value))) {
        return res.status(400).json({ error: 'Each publish target must be an object' });
      }
      if (targets.some((value: Record<string, unknown>) => value.credentialId !== undefined && (!Number.isSafeInteger(Number(value.credentialId)) || Number(value.credentialId) <= 0))) return res.status(400).json({ error: 'Each selected credentialId must be a positive integer' });
      normalizedTargets = targets.map((value: unknown) => {
        const target = value as Record<string, unknown>;
        return {
          platform: String(target.platform || '').toLowerCase(),
          credentialId: Number.isSafeInteger(Number(target.credentialId)) && Number(target.credentialId) > 0 ? Number(target.credentialId) : undefined,
          caption: typeof target.caption === 'string' ? target.caption : undefined,
          postType: typeof target.postType === 'string' ? target.postType : undefined,
          title: typeof target.title === 'string' ? target.title : undefined,
          tags: Array.isArray(target.tags) ? target.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
          privacyStatus: typeof target.privacyStatus === 'string' ? target.privacyStatus : undefined,
          youtubeOptions: target.youtubeOptions as PublishTarget['youtubeOptions'],
          instagramOptions: target.instagramOptions && typeof target.instagramOptions === 'object' && !Array.isArray(target.instagramOptions)
            ? target.instagramOptions as PublishTarget['instagramOptions']
            : undefined,
        };
      });
    } else {
      const targetPlatforms: string[] = [];
      if (platforms && Array.isArray(platforms)) targetPlatforms.push(...platforms);
      else if (platform) targetPlatforms.push(platform);
      normalizedTargets = [...new Set(targetPlatforms)].map((targetPlatform) => ({
        platform: String(targetPlatform).toLowerCase(),
        credentialId: Number((credentialIds as Record<string, unknown> | undefined)?.[targetPlatform]
          ?? (targetPlatforms.length === 1 ? credentialId : undefined)) || undefined,
        caption,
        postType,
        title,
        tags,
        privacyStatus,
        youtubeOptions,
      }));
    }

    const uniqueTargetPlatforms = normalizedTargets.map((target) => target.platform);
    if (uniqueTargetPlatforms.length === 0) {
      return res.status(400).json({ error: 'platform or platforms is required' });
    }
    if (uniqueTargetPlatforms.length > 5) return res.status(400).json({ error: 'A maximum of 5 platforms is allowed' });
    if (new Set(uniqueTargetPlatforms).size !== uniqueTargetPlatforms.length) {
      return res.status(400).json({ error: 'Each platform may appear only once in targets' });
    }

    const allowedPlatforms = ['facebook', 'instagram', 'youtube', 'linkedin', 'twitter'];
    for (const p of uniqueTargetPlatforms) {
      if (!allowedPlatforms.includes(p)) {
        return res.status(400).json({ error: `platform must be one of: ${allowedPlatforms.join(', ')}` });
      }
    }
    if (targets !== undefined && uniqueTargetPlatforms.some((value) => !['facebook', 'instagram', 'youtube', 'linkedin'].includes(value))) {
      return res.status(422).json({
        error: 'The targets contract supports durable Facebook, Instagram, YouTube, and LinkedIn publishing only.',
        code: 'TARGET_PLATFORM_UNSUPPORTED',
      });
    }
    const invalidYouTubeTarget = normalizedTargets.find((target) => target.platform === 'youtube' && target.postType && !['video', 'short', 'shorts'].includes(target.postType));
    if (invalidYouTubeTarget) {
      return res.status(422).json({ error: 'YouTube postType must be video or short.', code: 'UNSUPPORTED_YOUTUBE_POST_TYPE' });
    }

    const asset = await ContentAssetModel.findByIdForUser(assetId, Number(userId));
    if (!asset) {
      return res.status(404).json({ error: 'Content asset not found' });
    }
    const durablePlatforms = uniqueTargetPlatforms.filter(
      (value): value is 'instagram' | 'facebook' | 'youtube' | 'linkedin' => value === 'instagram' || value === 'facebook' || value === 'youtube' || value === 'linkedin',
    );
    if (durablePlatforms.length > 0 && durablePlatforms.length !== uniqueTargetPlatforms.length) {
      return res.status(422).json({
        error: 'Durable publication destinations must be submitted separately from Twitter.',
        code: 'MIXED_PUBLISHING_PIPELINES_UNSUPPORTED',
      });
    }
    if (durablePlatforms.length === uniqueTargetPlatforms.length) {
      const {
        executeOrganicPublishAttempt,
      } = await import('../services/social/OrganicPublishingService.js');
      const { SocialPublishAttemptModel } = await import('../models/socialPublishAttempts/functions.js');

      if (credentialIds !== undefined && (
        !credentialIds
        || typeof credentialIds !== 'object'
        || Array.isArray(credentialIds)
      )) {
        return res.status(400).json({ error: 'credentialIds must be an object keyed by platform' });
      }
      if (timezone !== undefined && (typeof timezone !== 'string' || timezone.length > 100)) {
        return res.status(400).json({ error: 'Invalid timezone' });
      }

      const requestKey = typeof req.get('Idempotency-Key') === 'string'
        ? req.get('Idempotency-Key')!.trim()
        : undefined;
      const replayAttempts = requestKey
        ? await Promise.all(durablePlatforms.map(targetPlatform =>
            SocialPublishAttemptModel.findByKey(
              Number(userId),
              `${requestKey}:${targetPlatform}`,
            )))
        : [];
      const isIdempotentReplay = Boolean(
        requestKey
        && replayAttempts.length === durablePlatforms.length
        && replayAttempts.every(Boolean),
      );
      if (asset.status === 'published' && !isIdempotentReplay) {
        return res.status(409).json({
          error: 'Published content cannot be published again. Create a new content version first.',
          code: 'CONTENT_ALREADY_PUBLISHED',
        });
      }
      const results: Record<string, {
        success: boolean;
        scheduled?: boolean;
        terminal: boolean;
        status: string;
        attemptId?: number;
        assetId?: number;
        postUrl?: string;
        postId?: string;
        error?: string;
        errorCode?: string;
      }> = {};
      const { prepareOrganicPublishBatch } = await import('../services/social/OrganicPublishLifecycleService.js');
      const entries = await prepareOrganicPublishBatch(Number(userId), assetId, normalizedTargets.map(target => ({
        platform: target.platform as 'instagram' | 'facebook' | 'youtube' | 'linkedin',
        caption: target.caption,
        postType: target.platform === 'youtube' && target.postType === 'shorts' ? 'short' : target.postType,
        title: target.title, tags: target.tags, privacyStatus: target.privacyStatus,
        youtubeOptions: target.youtubeOptions,
        credentialId: target.credentialId, timezone, scheduledFor,
        instagramOptions: target.instagramOptions,
      })), requestKey, { expectedVersion, expectedReviewToken, required: true });
      for (const entry of entries) {
        const completed = scheduledFor ? entry.attempt : await executeOrganicPublishAttempt(entry.attempt, Number(userId), `http:${process.pid}`);
        const pendingSchedule = Boolean(scheduledFor) && ['pending', 'claimed', 'retryable_failed'].includes(completed.status);
        results[entry.platform] = {
          success: completed.status === 'succeeded' || pendingSchedule,
          scheduled: pendingSchedule,
          terminal: ['succeeded', 'failed', 'ambiguous', 'cancelled', 'remote_deleted'].includes(completed.status),
          status: completed.status, attemptId: completed.id, assetId: entry.assetId,
          postUrl: completed.providerPostUrl || undefined, postId: completed.providerPostId || undefined,
          error: completed.errorMessage || undefined, errorCode: completed.errorCode || undefined,
        };
      }

      const values = Object.values(results);
      const allSucceeded = values.every(result => result.success);
      const anySucceeded = values.some(result => result.success);
      const anyPending = values.some(result => !result.terminal);
      const hasFailure = values.some(result => result.terminal && !result.success);
      const allScheduled = Boolean(scheduledFor) && values.every(result => result.scheduled);
      const responseBody = {
        success: allSucceeded,
        partialSuccess: anySucceeded && hasFailure,
        accepted: anyPending && !allScheduled,
        scheduled: allScheduled,
        scheduledFor,
        platform: durablePlatforms[0],
        platforms: durablePlatforms,
        postUrl: results[durablePlatforms[0]]?.postUrl,
        results,
      };
      if (allSucceeded) return res.json(responseBody);
      if (anyPending && !hasFailure) return res.status(202).json(responseBody);
      if (anySucceeded) return res.status(207).json(responseBody);
      if (anyPending) return res.status(202).json(responseBody);
      const firstFailure = values.find(result => result.error);
      return res.status(422).json({
        ...responseBody,
        error: firstFailure?.error || 'Publishing failed',
        code: firstFailure?.errorCode,
      });
    }

    if (scheduledFor && new Date(scheduledFor).getTime() <= Date.now()) return res.status(400).json({ error: 'scheduledFor date must be in the future' });
    if (asset.status === 'published') return res.status(409).json({ error: 'Published content cannot be published again. Create a new content version first.' });
    const brandContext = await resolveContentBrandContext(Number(userId), {
      businessProfileId: asset.businessProfileId,
      brandToolkitId: asset.brandToolkitId,
    });
    const publishContent = parseAssetContent(asset.content);
    if (caption !== undefined) {
      publishContent.caption = caption;
      publishContent.message = caption;
      publishContent.primaryText = caption;
    }
    if (title !== undefined) publishContent.title = title;
    if (tags !== undefined) publishContent.tags = tags;
    validateAssetForPreviewOrPublish({
      ...asset,
      title: title || asset.title,
      content: JSON.stringify(publishContent),
    }, brandContext, uniqueTargetPlatforms, true);

    const { db } = await import('../models/db.js');
    const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
    const { and, eq } = await import('drizzle-orm');

    if (scheduledFor) {
      const scheduledPublishDate = new Date(scheduledFor);
      const firstPlatform = uniqueTargetPlatforms[0];
      const sharedMetadata = { ...(asset.metadata || {}), platforms: uniqueTargetPlatforms };
      await db.transaction(async (tx: typeof db) => {
        await lockContentManagedStorage(tx, asset);
        // Rescheduling replaces any still-pending cross-post copies instead of
        // multiplying them on every edit/retry.
        const removed = await tx.delete(contentAssetsTable).where(and(
          eq(contentAssetsTable.userId, userId),
          eq(contentAssetsTable.parentAssetId, assetId),
          eq(contentAssetsTable.status, 'scheduled'),
        )).returning();
        const current = await tx.update(contentAssetsTable).set({
          scheduledPublishAt: scheduledPublishDate,
          publishPlatform: firstPlatform,
          status: 'scheduled',
          metadata: sharedMetadata,
          retryCount: 0,
          lastError: null,
          businessProfileId: brandContext.businessProfile.id,
          brandToolkitId: brandContext.brandToolkit.id,
          brandContextSnapshot: brandContextSnapshot(brandContext),
          validationSnapshot: {
            validatedAt: new Date().toISOString(),
            stage: 'publish',
            platforms: uniqueTargetPlatforms,
            violations: [],
          },
          updatedAt: new Date(),
        }).where(and(eq(contentAssetsTable.id, assetId), eq(contentAssetsTable.userId, userId))).returning();

        let copies: typeof current = [];
        if (uniqueTargetPlatforms.length > 1) {
          copies = await tx.insert(contentAssetsTable).values(uniqueTargetPlatforms.slice(1).map((publishPlatform) => ({
            userId,
            threadId: asset.threadId,
            parentAssetId: assetId,
            type: asset.type,
            title: asset.title,
            content: asset.content,
            channel: asset.channel,
            status: 'scheduled',
            imageUrl: asset.imageUrl,
            videoUrl: asset.videoUrl,
            imageUrls: asset.imageUrls,
            videoUrls: asset.videoUrls,
            publishPlatform,
            scheduledPublishAt: scheduledPublishDate,
            metadata: withoutGenerationKey(sharedMetadata),
            businessProfileId: brandContext.businessProfile.id,
            brandToolkitId: brandContext.brandToolkit.id,
            brandContextSnapshot: brandContextSnapshot(brandContext),
            validationSnapshot: {
              validatedAt: new Date().toISOString(),
              stage: 'publish',
              platforms: uniqueTargetPlatforms,
              violations: [],
            },
          }))).returning();
        }
        // Finish all domain writes before one complete old/new owner batch.
        await syncContentManagedStorage(tx, [
          ...[...current, ...copies].map(contentAssetManagedStorageEntry),
          ...removed.map((row: Parameters<typeof contentAssetManagedStorageEntry>[0]) => {
            const entry = contentAssetManagedStorageEntry(row);
            return entry ? { ...entry, urls: [] } : undefined;
          }),
        ]);
      });
      return res.json({ success: true, scheduled: true, scheduledFor, platform: firstPlatform, platforms: uniqueTargetPlatforms });
    }

    await ContentAssetModel.updateForUser(assetId, Number(userId), {
      businessProfileId: brandContext.businessProfile.id,
      brandToolkitId: brandContext.brandToolkit.id,
      brandContextSnapshot: brandContextSnapshot(brandContext),
      validationSnapshot: {
        validatedAt: new Date().toISOString(),
        stage: 'publish',
        platforms: uniqueTargetPlatforms,
        violations: [],
      },
      updatedAt: new Date(),
    });

    const context = { userId };
    const { executePublishSocialPost } = await import('../mastra/tools/executors/contentExecutor.js');

    // Immediate publish
    const results: Record<string, { success: boolean; postUrl?: string; error?: string }> = {};
    let mainPostUrl: string | undefined;

    // 1. Publish to the first platform on the main asset ID
    const firstPlatform = uniqueTargetPlatforms[0];
    try {
      const result = await executePublishSocialPost(
        { platform: firstPlatform, content_asset_id: assetId, caption, post_type: postType, title, tags, privacy_status: privacyStatus },
        // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
        context
      );
      results[firstPlatform] = {
        success: result.success,
        postUrl: result.output?.postUrl,
        error: result.error,
      };
      if (result.success) {
        mainPostUrl = result.output?.postUrl;
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      results[firstPlatform] = { success: false, error: err.message };
    }

    // 2. Publish to additional platforms on duplicate asset IDs
    for (let i = 1; i < uniqueTargetPlatforms.length; i++) {
      const p = uniqueTargetPlatforms[i];
      try {
        // Create a duplicate draft asset for the additional platform
        const dupAsset = await ContentAssetModel.create({
          userId,
          threadId: asset.threadId,
          parentAssetId: assetId,
          type: asset.type,
          title: asset.title,
          content: asset.content,
          channel: asset.channel,
          status: 'draft',
          imageUrl: asset.imageUrl,
          videoUrl: asset.videoUrl,
          imageUrls: asset.imageUrls,
          videoUrls: asset.videoUrls,
          publishPlatform: p,
          metadata: withoutGenerationKey(asset.metadata),
        });

        const result = await executePublishSocialPost(
          { platform: p, content_asset_id: dupAsset.id, caption, post_type: postType, title, tags, privacy_status: privacyStatus },
          // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
          context
        );

        results[p] = {
          success: result.success,
          postUrl: result.output?.postUrl,
          error: result.error,
        };

        if (!result.success) {
          // If publishing failed, delete the duplicate asset so we don't clog the database
          await ContentAssetModel.delete(dupAsset.id);
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        results[p] = { success: false, error: err.message };
      }
    }

    // Check if at least one platform succeeded
    const anySuccess = Object.values(results).some(r => r.success);
    if (!anySuccess) {
      // Find the first error message to return
      const firstError = Object.values(results).find(r => r.error)?.error || 'Publishing failed';
      return res.status(500).json({ error: firstError, results });
    }

    res.json({
      success: true,
      platform: firstPlatform, // for backward compatibility
      postUrl: mainPostUrl,     // for backward compatibility
      results,
    });
  } catch (error) {
    if (handleContentGovernanceError(error, res)) return;
    logger.error({ err: error }, '[ContentAssetController] Error publishing asset');
    res.status(500).json({ error: 'Failed to publish content asset' });
  }
};

export const getOrganicPublishingAccounts = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = Number(businessOwnerUserId(req));
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const platform = req.query.platform;
    if (platform !== undefined && platform !== 'instagram' && platform !== 'facebook' && platform !== 'youtube' && platform !== 'linkedin') {
      return res.status(400).json({ error: 'platform must be instagram, facebook, youtube, or linkedin' });
    }
    const { listOrganicPublishingAccounts } = await import('../services/social/OrganicPublishingService.js');
    const accounts = await listOrganicPublishingAccounts(
      userId,
      platform as 'instagram' | 'facebook' | 'youtube' | 'linkedin' | undefined,
    );
    return res.json({ accounts });
  } catch (error) {
    logger.error({ err: error }, '[ContentAssetController] Failed to list organic publishing accounts');
    return res.status(500).json({ error: 'Unable to load publishing accounts' });
  }
};

/**
 * Move a pending durable publish without allowing calendar edits to revive a
 * claimed, remotely accepted, or terminal publish attempt.
 */
export const rescheduleContentAsset = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = Number(businessOwnerUserId(req));
    const assetId = Number(req.params.assetId);
    const scheduledFor = typeof req.body?.scheduledFor === 'string' ? new Date(req.body.scheduledFor) : null;
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: 'Invalid content asset ID' });
    if (!scheduledFor || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now() + 60_000) {
      return res.status(400).json({ error: 'scheduledFor must be at least one minute in the future' });
    }
    const { changeOrganicPublishSchedule } = await import('../services/social/OrganicPublishLifecycleService.js');
    const { attempts } = await changeOrganicPublishSchedule(userId, [assetId], scheduledFor, scheduleMutationOptions(req.body, assetId));
    return res.json({ success: true, assetId, scheduledFor: scheduledFor.toISOString(), attempts });
  } catch (error) {
    if (error instanceof OrganicPublishingError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logger.error({ err: error }, '[ContentAssetController] Failed to reschedule durable publishing attempts');
    return res.status(500).json({ error: 'Unable to reschedule publishing' });
  }
};

function scheduleMutationOptions(body: Record<string, unknown> | undefined, assetId: number) {
  if (body?.scope !== undefined && body.scope !== 'single' && body.scope !== 'group') throw new OrganicPublishingError('scope must be single or group.', 'INVALID_SCOPE', 400);
  if (body?.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) throw new OrganicPublishingError('expectedVersion must be a positive integer.', 'INVALID_VERSION', 400);
  if (body?.expectedScheduledFor !== undefined && (typeof body.expectedScheduledFor !== 'string' || !Number.isFinite(Date.parse(body.expectedScheduledFor)))) throw new OrganicPublishingError('expectedScheduledFor must be a valid timestamp.', 'INVALID_SCHEDULE', 400);
  return { exactAssetOnly: body?.scope !== 'group',
    expectedVersions: body?.expectedVersion !== undefined ? { [assetId]: Number(body.expectedVersion) } : undefined,
    expectedScheduledFor: typeof body?.expectedScheduledFor === 'string' ? { [assetId]: body.expectedScheduledFor } : undefined };
}

export const cancelContentAssetSchedule = async (req: Request, res: Response) => {
  try {
    const userId = Number(businessOwnerUserId(req));
    const assetId = Number(req.params.assetId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: 'Invalid content asset ID' });
    const { changeOrganicPublishSchedule } = await import('../services/social/OrganicPublishLifecycleService.js');
    const result = await changeOrganicPublishSchedule(userId, [assetId], undefined, scheduleMutationOptions(req.body, assetId));
    return res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof OrganicPublishingError) return res.status(error.status).json({ error: error.message, code: error.code });
    logger.error({ err: error }, '[ContentAssetController] Cancel schedule failed');
    return res.status(500).json({ error: 'Unable to cancel the schedule' });
  }
};

export const recoverContentAssetPublishAttempt = async (req: Request, res: Response) => {
  try {
    const userId = Number(businessOwnerUserId(req));
    const assetId = Number(req.params.assetId), attemptId = Number(req.params.attemptId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Unauthorized' });
    if (![assetId, attemptId].every(id => Number.isSafeInteger(id) && id > 0)) return res.status(400).json({ error: 'Invalid publishing identifiers' });
    const action = req.body?.action;
    if (!['retry', 'reconcile', 'publish_now'].includes(action)) return res.status(400).json({ error: 'action must be retry, reconcile, or publish_now' });
    scheduleMutationOptions(req.body, assetId);
    const { recoverOrganicPublishAttempt, publishAttemptCapabilities } = await import('../services/social/OrganicPublishLifecycleService.js');
    const attempt = await recoverOrganicPublishAttempt(userId, assetId, attemptId, action, req.body?.expectedVersion);
    // If dispatch is temporarily unavailable, the durable due-attempt sweep recovers it.
    const { enqueueOrganicPublishAttempt } = await import('../services/social/OrganicPublishQueue.js');
    await enqueueOrganicPublishAttempt(attempt).catch(error => logger.warn({ err: error, attemptId }, '[ContentAssetController] Publish recovery awaits scheduler dispatch'));
    return res.status(202).json({ success: true, accepted: true, attempt: { ...attempt, capabilities: publishAttemptCapabilities(attempt) }, asset: await ContentAssetModel.findByIdForUser(assetId, userId) });
  } catch (error) {
    if (error instanceof OrganicPublishingError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof BillingOrganizationError) return res.status(error.status).json({ error: error.message, code: error.code });
    logger.error({ err: error }, '[ContentAssetController] Publish recovery failed');
    return res.status(500).json({ error: 'Unable to recover publishing' });
  }
};

export const getContentAssetPublishAttempts = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = Number(businessOwnerUserId(req));
    const assetId = Number(req.params.assetId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid content asset ID' });
    }
    const asset = await ContentAssetModel.findByIdForUser(assetId, userId);
    if (!asset) return res.status(404).json({ error: 'Content asset not found' });
    const { SocialPublishAttemptModel } = await import('../models/socialPublishAttempts/functions.js');
    let attempts = await SocialPublishAttemptModel.listForAsset(userId, assetId);
    if (req.query?.requestKey !== undefined) {
      const suppliedKey = req.query.requestKey;
      if (typeof suppliedKey !== 'string' || !suppliedKey.trim() || suppliedKey.trim().length > 96) return res.status(400).json({ error: 'A valid publication request key is required.' });
      const requestKey = suppliedKey.trim();
      const candidates = await Promise.all(['facebook','instagram','youtube','linkedin'].map(platform => SocialPublishAttemptModel.findByKey(userId, `${requestKey}:${platform}`)));
      // A multi-destination request can have child assets. Never acknowledge a
      // key belonging to another root, even inside the same owned business.
      const related = await Promise.all(candidates.map(async attempt => {
        if (!attempt?.assetId) return null;
        if (attempt.assetId === assetId) return attempt;
        const child = await ContentAssetModel.findByIdForUser(attempt.assetId, userId);
        return child?.parentAssetId === assetId ? attempt : null;
      }));
      attempts = related.filter((attempt): attempt is NonNullable<typeof attempt> => Boolean(attempt));
    }
    const { publishAttemptCapabilities } = await import('../services/social/OrganicPublishLifecycleService.js');
    return res.json({ attempts: attempts.map(attempt => ({ ...attempt, capabilities: publishAttemptCapabilities(attempt) })), asset });
  } catch (error) {
    logger.error({ err: error }, '[ContentAssetController] Failed to list publish attempts');
    return res.status(500).json({ error: 'Unable to load publish attempts' });
  }
};

export const unpublishContentAsset = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const assetId = parseInt(req.params.assetId);

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isInteger(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid content asset ID' });
    }

    const asset = await ContentAssetModel.findByIdForUser(assetId, Number(userId));
    if (!asset) {
      return res.status(404).json({ error: 'Content asset not found' });
    }

    if (asset.status !== 'published') {
      return res.status(409).json({ error: 'Only published content can be unpublished' });
    }

    const platform = asset.publishPlatform;
    const postId = asset.publishedPostId;

    if (!postId) {
      return res.status(409).json({
        error: 'This post has no remote post ID, so its published state cannot be changed safely.',
      });
    }

    if (platform === 'youtube') {
      const { SocialPublishAttemptModel } = await import('../models/socialPublishAttempts/functions.js');
      const attempts = await SocialPublishAttemptModel.listForAsset(Number(userId), assetId);
      const attempt = [...attempts].reverse().find(value => (
        value.platform === 'youtube'
        && value.providerPostId === postId
        && ['succeeded', 'provider_succeeded'].includes(value.status)
        && value.credentialId
      ));
      if (!attempt?.credentialId) {
        return res.status(409).json({
          error: 'This YouTube upload has no credential-bound attempt record and cannot be reconciled safely.',
          code: 'PUBLISH_ATTEMPT_REQUIRED',
        });
      }

      const mode = req.body?.mode === 'delete' ? 'delete' : 'reconcile';
      const {
        deleteYouTubeVideo,
        reconcileYouTubeVideo,
      } = await import('../services/social/YouTubePublishingService.js');
      const remoteResult = mode === 'delete'
        ? await deleteYouTubeVideo(Number(userId), attempt.credentialId, postId)
        : await reconcileYouTubeVideo(Number(userId), attempt.credentialId, postId);

      if (!remoteResult.success) {
        return res.status(remoteResult.ambiguous ? 502 : 409).json({
          error: remoteResult.error || `YouTube ${mode} failed`,
          code: remoteResult.errorCode,
          ambiguous: remoteResult.ambiguous,
        });
      }
      if (mode === 'reconcile' && remoteResult.exists) {
        await SocialPublishAttemptModel.markReconciled(
          attempt.id,
          Number(userId),
          remoteResult.postUrl,
        );
        return res.status(409).json({
          error: 'The video still exists on YouTube. Delete it remotely first or request supported remote deletion.',
          code: 'REMOTE_POST_STILL_EXISTS',
          postUrl: remoteResult.postUrl,
        });
      }

      await SocialPublishAttemptModel.markRemoteDeleted(attempt.id, Number(userId));
      await ContentAssetModel.updateForUser(assetId, Number(userId), {
        status: 'draft',
        publishedPostId: null,
        publishedAt: null,
        publishedUrl: null,
        publishPlatform: null,
        scheduledPublishAt: null,
      });
      return res.json({
        success: true,
        message: mode === 'delete'
          ? 'Video deleted from YouTube and reconciled locally.'
          : 'Remote deletion confirmed and local publishing state cleared.',
      });
    }

    if (platform === 'instagram' || platform === 'facebook') {
      const { SocialPublishAttemptModel } = await import('../models/socialPublishAttempts/functions.js');
      const attempts = await SocialPublishAttemptModel.listForAsset(Number(userId), assetId);
      const attempt = [...attempts].reverse().find(value => (
        value.platform === platform
        && value.providerPostId === postId
        && ['succeeded', 'provider_succeeded'].includes(value.status)
        && value.credentialId
      ));
      if (!attempt?.credentialId) {
        return res.status(409).json({
          error: 'This published post has no credential-bound attempt record and cannot be reconciled safely.',
          code: 'PUBLISH_ATTEMPT_REQUIRED',
        });
      }
      const mode = req.body?.mode === 'delete' ? 'delete' : 'reconcile';
      const {
        deletePublishedOrganicPost,
        reconcilePublishedOrganicPost,
      } = await import('../services/social/SocialPublishingService.js');

      if (mode === 'delete') {
        const deleted = await deletePublishedOrganicPost(Number(userId), {
          platform,
          credentialId: attempt.credentialId,
          providerPostId: postId,
        });
        if (!deleted.success) {
          return res.status(deleted.ambiguous ? 502 : 409).json({
            error: deleted.error || 'Remote deletion failed',
            code: deleted.errorCode,
            ambiguous: deleted.ambiguous,
          });
        }
      } else {
        const reconciled = await reconcilePublishedOrganicPost(Number(userId), {
          platform,
          credentialId: attempt.credentialId,
          providerPostId: postId,
        });
        if (reconciled.error) {
          return res.status(502).json({
            error: reconciled.error,
            code: 'REMOTE_RECONCILIATION_FAILED',
            ambiguous: reconciled.ambiguous,
          });
        }
        if (reconciled.exists) {
          await SocialPublishAttemptModel.markReconciled(
            attempt.id,
            Number(userId),
            reconciled.postUrl,
          );
          return res.status(409).json({
            error: `The post still exists on ${platform}. Delete it remotely first or request supported remote deletion.`,
            code: 'REMOTE_POST_STILL_EXISTS',
            postUrl: reconciled.postUrl,
          });
        }
      }

      await SocialPublishAttemptModel.markRemoteDeleted(attempt.id, Number(userId));
      await ContentAssetModel.updateForUser(assetId, Number(userId), {
        status: 'draft',
        publishedPostId: null,
        publishedAt: null,
        publishedUrl: null,
        publishPlatform: null,
        scheduledPublishAt: null,
      });
      return res.json({
        success: true,
        message: mode === 'delete'
          ? 'Post deleted from Facebook and reconciled locally.'
          : 'Remote deletion confirmed and local publishing state cleared.',
      });
    }

    if (platform !== 'linkedin' && platform !== 'twitter') {
      return res.status(409).json({
        error: `Remote unpublishing is not supported for ${platform || 'this platform'}. Delete the post on the platform first.`,
      });
    }

    if (platform === 'linkedin') {
      const { SocialPublishAttemptModel } = await import('../models/socialPublishAttempts/functions.js');
      const attempts = await SocialPublishAttemptModel.listForAsset(Number(userId), assetId);
      const attempt = [...attempts].reverse().find(value => value.platform === 'linkedin' && value.providerPostId === postId && value.credentialId && ['succeeded', 'provider_succeeded'].includes(value.status));
      if (!attempt?.credentialId) return res.status(409).json({ error: 'This legacy LinkedIn post has no credential-bound receipt. Inspect the channel before changing its state.', code: 'PUBLISH_ATTEMPT_REQUIRED' });
      const { LinkedInPublishingService } = await import('../services/social/LinkedInPublishingService.js');
      const binding = { credentialId: attempt.credentialId, expectedAccountId: attempt.providerAccountId };
      const mode = req.body?.mode === 'delete' ? 'delete' : 'reconcile';
      if (mode === 'delete') {
        const result = await LinkedInPublishingService.deletePost(Number(userId), postId, binding);
        if (!result.success) return res.status(result.ambiguous ? 502 : 409).json(result);
      } else {
        const result = await LinkedInPublishingService.reconcilePost(Number(userId), postId, binding);
        if (!result.success) return res.status(502).json(result);
        if (result.exists) return res.status(409).json({ code: 'REMOTE_POST_STILL_EXISTS', error: 'The LinkedIn post still exists. Delete it remotely first or request remote deletion.', postUrl: result.postUrl });
      }
      await SocialPublishAttemptModel.markRemoteDeleted(attempt.id, Number(userId));
    } else {
      const { TwitterApiService } = await import('../services/TwitterApiService.js');
      const twitterApi = new TwitterApiService(); await twitterApi.initializeForUser(userId);
      const result = await twitterApi.deleteTweet(postId);
      if (!result.success) return res.status(500).json({ error: result.error || 'Failed to delete tweet from Twitter/X' });
    }

    // Update asset state back to draft/unpublished in database
    await ContentAssetModel.updateForUser(assetId, Number(userId), {
      status: 'draft',
      ...(platform === 'linkedin' ? { version: asset.version + 1, updatedAt: new Date(), lastError: null } : {}),
      publishedPostId: null,
      publishedAt: null,
      publishedUrl: null,
      publishPlatform: null,
      scheduledPublishAt: null,
    });

    res.json({ success: true, message: 'Content asset unpublished successfully' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ContentAssetController] Error unpublishing asset');
    res.status(500).json({ error: 'Unable to unpublish this content. Check the channel before trying again.' });
  }
};
