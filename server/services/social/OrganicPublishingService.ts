import crypto from 'node:crypto';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { collectContentManagedReferenceUrls } from '../../utils/contentManagedReferences.js';
import { lockManagedStorageReferences, syncManagedStorageOwners, type ManagedStorageTransaction } from '../managedStorageReferences.js';

import { instagramPublishingOptionsSchema, type InstagramPublishingOptions } from '../../utils/instagramPublishingOptions.js';
import { preflightPublishingImages } from '../media/PublishingImagePreflight.js';
import { youtubePublishingOptionsSchema, type YouTubePublishingOptions } from '../../utils/youtubePublishingOptions.js';
import { validateMediaForPlatform, type MediaProbe } from '../media/MediaTranscodingService.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { channelCredentialsTable } from '../../models/channelCredentials/schema.js';
import { contentAssetsTable, type ContentAssetRecord } from '../../models/contentAssets/schema.js';
import { ContentAssetModel } from '../../models/contentAssets/functions.js';
import {
  SocialPublishAttemptModel,
} from '../../models/socialPublishAttempts/functions.js';
import {
  socialPublishAttemptsTable,
  type OrganicPublishSnapshot,
  type SocialPublishAttempt,
} from '../../models/socialPublishAttempts/schema.js';
import {
  brandContextSnapshot,
  resolveContentBrandContext,
} from '../content/ContentBrandContextService.js';
import {
  ContentComplianceError,
  validateGeneratedContent,
} from '../content/ContentComplianceService.js';
import { findUnresolvedTemplateVariables } from '../../utils/contentTemplateRendering.js';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../utils/timezone.js';
import {
  findPublishedOrganicPostCandidate,
  publishToFacebook,
  publishToInstagram,
  type PublishResult,
} from './SocialPublishingService.js';
import {
  listYouTubePublishingAccounts,
  getYouTubeVideoProcessingStatus,
  classifyYouTubeProcessingState,
  normalizeYouTubePostType,
  publishToYouTube,
  validateYouTubePublishInput,
  generateYouTubeChapterContent,
  setYouTubeThumbnail,
  assignYouTubePlaylist,
  validateYouTubePublishExtras,
  type YouTubeVideoMetadata,
  type YouTubePublishResult,
} from './YouTubePublishingService.js';
import { logger } from '../../utils/logger.js';
import { LinkedInPublishingService } from './LinkedInPublishingService.js';
import { captureOrganicPublishOrigin, authorizeOrganicPublishOrigin } from './OrganicPublishAuthority.js';
import { parseContentObject as parseContent } from '../../utils/contentObject.js';

export type OrganicPublishStorageEntry = Parameters<typeof syncManagedStorageOwners>[1]['entries'][number];

export type OrganicPlatform = 'instagram' | 'facebook' | 'youtube' | 'linkedin';

export interface PublishingAccount {
  credentialId: number;
  platform: OrganicPlatform;
  providerAccountId: string;
  accountName: string;
  expiresAt: string | null;
  expired: boolean;
  isSelected?: boolean;
  readiness?: 'ready' | 'needs_reconnect';
}

export interface PrepareOrganicPublishInput {
  requestFingerprint?: string;
  platform: OrganicPlatform;
  caption?: string;
  postType?: string;
  title?: string;
  tags?: string[];
  privacyStatus?: string;
  youtubeOptions?: YouTubePublishingOptions;
  credentialId?: number;
  timezone?: string;
  scheduledFor?: string;
  idempotencyKey?: string;
  holdForCrossPlatformPreflight?: boolean;
  videoMetadata?: YouTubeVideoMetadata;
  instagramOptions?: InstagramPublishingOptions;
}

export class OrganicPublishingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'OrganicPublishingError';
  }
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function toPublicUrl(value: string): string {
  const url = value.startsWith('http://') || value.startsWith('https://')
    ? value
    : `${(process.env.APP_URL || process.env.NGROK_URL || 'https://asksales.ai').replace(/\/$/, '')}/${value.replace(/^\//, '')}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OrganicPublishingError(`Media URL is invalid: ${value}`, 'INVALID_MEDIA_URL', 422);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new OrganicPublishingError('Media must use an HTTP(S) URL.', 'INVALID_MEDIA_URL', 422);
  }
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname) || parsed.hostname.endsWith('.local')) {
    throw new OrganicPublishingError(
      'Media URL is not publicly reachable by Meta.',
      'MEDIA_NOT_PUBLIC',
      422,
    );
  }
  return parsed.toString();
}

function extension(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.') + 1) : '';
  } catch {
    return '';
  }
}

function assertKnownExtension(urls: string[], allowed: Set<string>, kind: string): void {
  for (const url of urls) {
    const ext = extension(url);
    // Files stored before their MIME type is known use our neutral `.bin`
    // fallback. The asset kind has already been resolved from the trusted
    // content-asset record, and Meta fetches the bytes from the public URL, so
    // do not reject those legacy/generated assets based on the storage suffix.
    // Continue rejecting explicit, unsupported media extensions (for example
    // WEBP on the Meta image path).
    if (ext && ext !== 'bin' && !allowed.has(ext)) {
      throw new OrganicPublishingError(
        `${kind} format .${ext} is not supported for this Meta publishing path.`,
        'UNSUPPORTED_MEDIA_FORMAT',
        422,
      );
    }
  }
}

/**
 * Media a format publishes. Video-only formats (YouTube, Instagram Reel,
 * Facebook video) use the single saved video and leave images on the draft.
 * Mirrors `mediaForSocialFormat` in client/src/lib/socialPublishing.ts.
 */
export function mediaForOrganicFormat(
  platform: OrganicPlatform,
  requestedPostType: string | undefined,
  media: { imageUrls: string[]; videoUrls: string[] },
): { imageUrls: string[]; videoUrls: string[] } {
  const videoOnly = platform === 'youtube'
    || (platform === 'instagram' && requestedPostType === 'reel')
    || (platform === 'facebook' && requestedPostType === 'video');
  return videoOnly && media.videoUrls.length === 1 && media.imageUrls.length > 0
    ? { imageUrls: [], videoUrls: media.videoUrls }
    : media;
}

export function normalizeOrganicPostType(
  platform: OrganicPlatform,
  requested: string | undefined,
  imageUrls: string[],
  videoUrls: string[],
): string {
  if (platform === 'linkedin') {
    if (imageUrls.length || videoUrls.length || (requested && !['post', 'text'].includes(requested))) {
      throw new OrganicPublishingError('LinkedIn native media uploads are not implemented by this publisher. Review a text-only draft; media URLs will not be appended silently.', 'LINKEDIN_MEDIA_UNSUPPORTED', 422);
    }
    return 'text';
  }
  if (platform === 'youtube') {
    if (imageUrls.length) {
      throw new OrganicPublishingError('YouTube publishing accepts one video; image-only and Community posts are not supported.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
    if (videoUrls.length !== 1) {
      throw new OrganicPublishingError('YouTube video and Short publishing require exactly one video.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
    try {
      return normalizeYouTubePostType(requested);
    } catch (error) {
      throw new OrganicPublishingError(
        error instanceof Error ? error.message : 'Unsupported YouTube post type.',
        'UNSUPPORTED_YOUTUBE_POST_TYPE',
        422,
      );
    }
  }
  if (platform === 'instagram') {
    const value = requested === 'feed' ? 'post' : requested || (imageUrls.length + videoUrls.length > 1 ? 'carousel' : videoUrls.length ? 'reel' : 'post');
    if (!['post', 'reel', 'story', 'carousel'].includes(value)) {
      throw new OrganicPublishingError(`Unsupported Instagram post type: ${value}`, 'UNSUPPORTED_POST_TYPE', 422);
    }
    return value;
  }
  const value = requested === 'post' || !requested
    ? (videoUrls.length ? 'video' : imageUrls.length ? 'photo' : 'text')
    : requested;
  if (!['text', 'photo', 'video'].includes(value)) {
    throw new OrganicPublishingError(
      `Facebook ${value} publishing is not supported. Use a text, photo, or video post.`,
      'UNSUPPORTED_POST_TYPE',
      422,
    );
  }
  return value;
}

export function validateOrganicMedia(
  snapshot: Pick<OrganicPublishSnapshot, 'platform' | 'postType' | 'imageUrls' | 'videoUrls'>,
): void {
  const images = snapshot.imageUrls;
  const videos = snapshot.videoUrls;
  if (snapshot.platform === 'linkedin') {
    if (snapshot.postType !== 'text' || images.length || videos.length) throw new OrganicPublishingError('LinkedIn publishing currently supports reviewed text-only drafts.', 'LINKEDIN_MEDIA_UNSUPPORTED', 422);
    return;
  }
  assertKnownExtension(images, new Set(['jpg', 'jpeg', 'png']), 'Image');
  assertKnownExtension(videos, new Set(['mp4', 'mov']), 'Video');

  if (snapshot.platform === 'youtube') {
    if (images.length || videos.length !== 1) {
      throw new OrganicPublishingError('YouTube publishing requires exactly one video and no images.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
    return;
  }

  if (snapshot.platform === 'instagram') {
    if (snapshot.postType === 'post' && (images.length !== 1 || videos.length)) {
      throw new OrganicPublishingError('Instagram feed posts require exactly one image.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
    if (snapshot.postType === 'carousel' && (images.length + videos.length < 2 || images.length + videos.length > 10)) {
      throw new OrganicPublishingError('Instagram carousel requires 2–10 images or videos.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
    if (snapshot.postType === 'reel' && (videos.length !== 1 || images.length)) {
      throw new OrganicPublishingError('Instagram Reels require exactly one video.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
    if (snapshot.postType === 'story' && images.length + videos.length !== 1) {
      throw new OrganicPublishingError('Instagram Stories require exactly one image or video.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
  } else {
    if (snapshot.postType === 'photo' && (!images.length || images.length > 10 || videos.length)) {
      throw new OrganicPublishingError('Facebook photo posts require 1–10 images and no videos.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
    if (snapshot.postType === 'video' && (videos.length !== 1 || images.length)) {
      throw new OrganicPublishingError('Facebook video posts require exactly one video.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
    if (snapshot.postType === 'text' && (images.length || videos.length)) {
      throw new OrganicPublishingError('Choose Photo or Video to include the selected media.', 'MEDIA_REQUIREMENT_FAILED', 422);
    }
  }
}

function normalizedTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return uniqueStrings(values)
    .map(value => value
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '_')
      .replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean);
}

export function buildReviewedCaption(options: {
  platform: OrganicPlatform;
  caption: string;
  tags?: string[];
  callToAction?: string;
  postType: string;
}): string {
  const parts = [options.caption.trim()];
  if (options.callToAction?.trim() && !options.caption.includes(options.callToAction.trim())) {
    parts.push(options.callToAction.trim());
  }
  const missingTags = (options.tags || []).filter(tag => (
    !new RegExp(`(^|\\s)#${tag}(?=\\s|$)`, 'iu').test(options.caption)
  ));
  if (missingTags.length) {
    parts.push(missingTags.map(tag => `#${tag}`).join(' '));
  }
  const caption = parts.filter(Boolean).join('\n\n');
  const hashtagCount = (caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
  if (options.platform === 'instagram' && hashtagCount > 30) {
    throw new OrganicPublishingError(
      'Instagram captions support at most 30 hashtags.',
      'HASHTAG_LIMIT_EXCEEDED',
      422,
    );
  }
  if (options.platform === 'instagram' && options.postType === 'story' && caption.length > 0) {
    throw new OrganicPublishingError(
      'Instagram Story captions are not supported by this publishing integration.',
      'UNSUPPORTED_STORY_CAPTION',
      422,
    );
  }
  if (options.callToAction && options.callToAction.length > 1000) {
    throw new OrganicPublishingError(
      'Call-to-action text must be 1,000 characters or fewer.',
      'CTA_LIMIT_EXCEEDED',
      422,
    );
  }
  return caption;
}

function normalizeTimezone(value: string | undefined): string {
  const timezone = value?.trim() || DEFAULT_BUSINESS_TIMEZONE;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new OrganicPublishingError('timezone must be a valid IANA time zone.', 'INVALID_TIMEZONE', 422);
  }
  return timezone;
}

function reviewedPayloadFingerprint(snapshot: OrganicPublishSnapshot): string {
  return JSON.stringify({
    platform: snapshot.platform,
    caption: snapshot.caption,
    postType: snapshot.postType,
    title: snapshot.title,
    tags: snapshot.tags || [],
    callToAction: snapshot.callToAction,
    privacyStatus: snapshot.privacyStatus,
    youtubeOptions: snapshot.youtubeOptions,
    imageUrls: snapshot.imageUrls,
    videoUrls: snapshot.videoUrls,
    credentialId: snapshot.credentialId,
    providerAccountId: snapshot.providerAccountId,
    videoMetadata: snapshot.videoMetadata,
    instagramOptions: snapshot.instagramOptions,
    timezone: snapshot.timezone,
    scheduledFor: snapshot.scheduledFor,
  }, (_key, value: unknown) => {
    // JSONB preserves values and array order, but not object-property order.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
  });
}

export async function listOrganicPublishingAccounts(
  userId: number,
  platform?: OrganicPlatform,
  queryDb: typeof db = db,
): Promise<PublishingAccount[]> {
  if (platform === 'youtube') return listYouTubePublishingAccounts(userId, queryDb);
  const platforms = platform === 'instagram'
    ? ['instagram_api']
    : platform === 'facebook'
      ? ['facebook_api', 'facebook_page']
      : platform === 'linkedin' ? ['linkedin', 'linkedin_api'] : ['instagram_api', 'facebook_api', 'facebook_page', 'linkedin', 'linkedin_api'];
  const rows = await queryDb
    .select({
      id: channelCredentialsTable.id,
      platform: channelCredentialsTable.platform,
      accountIdentifier: channelCredentialsTable.accountIdentifier,
      accountName: channelCredentialsTable.accountName,
      tokenExpiry: channelCredentialsTable.tokenExpiry,
      isSelected: channelCredentialsTable.isSelected,
    })
    .from(channelCredentialsTable)
    .where(and(
      eq(channelCredentialsTable.userId, userId),
      eq(channelCredentialsTable.isActive, true),
      inArray(channelCredentialsTable.platform, platforms),
    ));
  const metaAccounts = rows
    .filter((row: { accountIdentifier: string | null }) => Boolean(row.accountIdentifier))
    .map((row: {
      id: number;
      platform: string;
      accountIdentifier: string | null;
      accountName: string | null;
      tokenExpiry: Date | null;
      isSelected: boolean;
    }) => ({
      credentialId: row.id,
      platform: row.platform === 'instagram_api' ? 'instagram' as const : row.platform.startsWith('linkedin') ? 'linkedin' as const : 'facebook' as const,
      providerAccountId: row.accountIdentifier!,
      accountName: row.accountName || row.accountIdentifier!,
      expiresAt: row.tokenExpiry?.toISOString() || null,
      expired: Boolean(row.tokenExpiry && row.tokenExpiry.getTime() <= Date.now()) || (row.platform.startsWith('linkedin') && !/^urn:li:(person|organization):[^\s:]+$/.test(row.accountIdentifier!)),
      isSelected: row.isSelected,
    }));
  if (platform) return metaAccounts;
  // The account-picker endpoint without a platform is also used by the
  // cross-network composer, so include all active YouTube channels.
  return [...metaAccounts, ...await listYouTubePublishingAccounts(userId, queryDb)];
}

async function resolveAccount(
  userId: number,
  platform: OrganicPlatform,
  credentialId?: number,
  queryDb: typeof db = db,
): Promise<PublishingAccount> {
  const accounts = await listOrganicPublishingAccounts(userId, platform, queryDb);
  if (credentialId) {
    const selected = accounts.find(account => account.credentialId === credentialId);
    if (!selected || !isPublishingAccountAvailable(selected)) {
      throw new OrganicPublishingError(
        `The selected ${platform} account is unavailable or expired.`,
        'PUBLISHING_ACCOUNT_UNAVAILABLE',
        409,
      );
    }
    return selected;
  }
  if (accounts.length === 0) {
    throw new OrganicPublishingError(
      `${platform === 'instagram' ? 'Instagram Business account' : platform === 'facebook' ? 'Facebook Page' : platform === 'linkedin' ? 'LinkedIn account' : 'YouTube channel'} is not connected.`,
      'PUBLISHING_ACCOUNT_REQUIRED',
      409,
    );
  }
  const selected = accounts.find(account => account.isSelected);
  if (selected) {
    if (!isPublishingAccountAvailable(selected)) {
      throw new OrganicPublishingError(
        `The selected ${platform} account is unavailable or expired. Choose another connected account.`,
        'PUBLISHING_ACCOUNT_UNAVAILABLE',
        409,
      );
    }
    return selected;
  }
  if (accounts.length > 1) {
    throw new OrganicPublishingError(
      `Select the ${platform} account to publish to.`,
      'PUBLISHING_ACCOUNT_SELECTION_REQUIRED',
      409,
    );
  }
  if (!isPublishingAccountAvailable(accounts[0])) {
    throw new OrganicPublishingError(
      `The connected ${platform} account is expired. Reconnect it before publishing.`,
      'PUBLISHING_ACCOUNT_UNAVAILABLE',
      409,
    );
  }
  return accounts[0];
}

export function isPublishingAccountAvailable(account: PublishingAccount): boolean {
  return account.platform === 'youtube'
    ? account.readiness === 'ready' || (!account.expired && account.readiness !== 'needs_reconnect')
    : !account.expired;
}

export async function resolveOrganicPublishingMedia(asset: ContentAssetRecord, queryDb: typeof db = db): Promise<{ imageUrls: string[]; videoUrls: string[] }> {
  const parsed = parseContent(asset.content);
  const metadata = (asset.metadata || {}) as Record<string, unknown>;
  const rootImages = uniqueStrings([
    ...(asset.imageUrls || []),
    asset.imageUrl,
    ...(Array.isArray(parsed.imageUrls) ? parsed.imageUrls : []),
    parsed.imageUrl,
    ...(Array.isArray(metadata.imageUrls) ? metadata.imageUrls : []),
    metadata.imageUrl,
  ]);
  const rootVideos = uniqueStrings([
    ...(asset.videoUrls || []),
    asset.videoUrl,
    ...(Array.isArray(parsed.videoUrls) ? parsed.videoUrls : []),
    parsed.videoUrl,
    ...(Array.isArray(metadata.videoUrls) ? metadata.videoUrls : []),
    metadata.videoUrl,
  ]);
  if (rootImages.length || rootVideos.length) {
    return {
      imageUrls: rootImages.map(toPublicUrl),
      videoUrls: rootVideos.map(toPublicUrl),
    };
  }

  const children = await queryDb
    .select()
    .from(contentAssetsTable)
    .where(and(
      eq(contentAssetsTable.parentAssetId, asset.id),
      eq(contentAssetsTable.userId, asset.userId!),
    ));
  return {
    imageUrls: uniqueStrings(children.flatMap((child: ContentAssetRecord) => [
      child.imageUrl,
      ...(child.imageUrls || []),
      child.type === 'image' && /^https?:|^\//.test(child.content) ? child.content : undefined,
    ])).map(toPublicUrl),
    videoUrls: uniqueStrings(children.flatMap((child: ContentAssetRecord) => [
      child.videoUrl,
      ...(child.videoUrls || []),
      child.type === 'video' && /^https?:|^\//.test(child.content) ? child.content : undefined,
    ])).map(toPublicUrl),
  };
}

/** Compare a displayed source with the source committed for publication. */
export function organicPublishReviewToken(asset: Pick<ContentAssetRecord, 'id' | 'version' | 'title' | 'content'>, media: { imageUrls: string[]; videoUrls: string[] }): string {
  // Bind displayed copy as well as version: internal normalization and child
  // completion can change the source without advancing its version. Accepted
  // request replays use the stored fingerprint instead of the current digest.
  return crypto.createHash('sha256').update(JSON.stringify({ id: asset.id, version: asset.version, title: asset.title, content: asset.content, media })).digest('hex');
}

export async function getOrganicPublishingReview(asset: ContentAssetRecord, queryDb: typeof db = db) {
  const media = await resolveOrganicPublishingMedia(asset, queryDb);
  return { media, token: organicPublishReviewToken(asset, media) };
}

export async function buildOrganicPublishReview(
  userId: number,
  asset: ContentAssetRecord,
  input: PrepareOrganicPublishInput,
  transactionDb?: typeof db,
) {
  if (asset.userId !== userId) {
    throw new OrganicPublishingError('Content asset not found.', 'CONTENT_ASSET_NOT_FOUND', 404);
  }
  if (asset.status === 'published') {
    throw new OrganicPublishingError(
      'Published content cannot be published again. Create a new version first.',
      'CONTENT_ALREADY_PUBLISHED',
      409,
    );
  }
  const queryDb = transactionDb || db;
  const account = await resolveAccount(userId, input.platform, input.credentialId, queryDb);
  const parsed = parseContent(asset.content);
  const rawCaption = input.caption
    ?? String(parsed.caption || parsed.content || parsed.message || parsed.text || asset.content || '');
  const callToAction = input.caption === undefined
    ? String(parsed.callToAction || parsed.call_to_action || parsed.cta || '').trim() || undefined
    : undefined;
  const tags = normalizedTags(
    input.tags ?? (input.caption === undefined ? parsed.hashtags : []),
  );
  const resolvedMedia = await resolveOrganicPublishingMedia(asset, queryDb);
  // Metadata supplied by a client is never trusted. Both chat and HTTP must
  // validate the saved, server-probed bytes at the common publication boundary.
  const videoMetadata = resolvedMedia.videoUrls.length
    ? await validateSavedPublishingVideos(asset, resolvedMedia.videoUrls, input.platform, queryDb)
    : undefined;
  // A post with one video plus images (e.g. generated image + video) can still
  // go out as a Reel / video: those formats publish only the video.
  const media = mediaForOrganicFormat(input.platform, input.postType, resolvedMedia);
  const postType = normalizeOrganicPostType(
    input.platform,
    input.postType,
    media.imageUrls,
    media.videoUrls,
  );
  let caption = buildReviewedCaption({
    platform: input.platform,
    caption: rawCaption,
    tags,
    callToAction,
    postType,
  });
  const unresolved = findUnresolvedTemplateVariables([input.title || asset.title, caption].join('\n'));
  if (unresolved.length) {
    throw new ContentComplianceError([
      `Resolve template variables before publishing: ${unresolved.join(', ')}.`,
    ]);
  }

  const context = await resolveContentBrandContext(userId, {
    businessProfileId: asset.businessProfileId,
    brandToolkitId: asset.brandToolkitId,
  }, queryDb);
  validateGeneratedContent({
    type: 'social',
    output: {
      ...parsed,
      caption,
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    },
    context,
    platform: input.platform,
  });

  const approvedAt = new Date().toISOString();
  const optionsResult = youtubePublishingOptionsSchema.optional().safeParse(input.youtubeOptions);
  if (!optionsResult.success) {
    throw new OrganicPublishingError(optionsResult.error.issues.map(issue => issue.message).join('; '), 'INVALID_YOUTUBE_OPTIONS', 422);
  }
  if (input.youtubeOptions !== undefined && input.platform !== 'youtube') {
    throw new OrganicPublishingError('YouTube options require a YouTube destination.', 'INVALID_YOUTUBE_OPTIONS', 422);
  }
  const instagramResult = instagramPublishingOptionsSchema.optional().safeParse(input.instagramOptions);
  if (!instagramResult.success || (input.instagramOptions && input.platform !== 'instagram')) {
    throw new OrganicPublishingError(instagramResult.success ? 'Instagram options require an Instagram destination.' : instagramResult.error.issues.map(issue => issue.message).join('; '), 'INVALID_INSTAGRAM_OPTIONS', 422);
  }
  const normalizedInstagramOptions = instagramResult.data;
  if (normalizedInstagramOptions?.altText && postType !== 'post') {
    throw new OrganicPublishingError('Alt text is available for an Instagram feed photo. Carousel descriptions must be set per image.', 'INVALID_INSTAGRAM_OPTIONS', 422);
  }
  if (postType === 'story' && normalizedInstagramOptions && Object.values(normalizedInstagramOptions).some(value => value !== undefined)) {
    throw new OrganicPublishingError('Instagram Stories do not support feed, cover, location or collaborator options.', 'INVALID_INSTAGRAM_OPTIONS', 422);
  }
  if (optionsResult.data?.chapters) {
    caption = generateYouTubeChapterContent(caption, optionsResult.data.chapters);
    if (videoMetadata && optionsResult.data.chapters.at(-1)!.startSeconds + 10 > videoMetadata.durationSeconds) {
      throw new OrganicPublishingError('The final chapter must leave at least ten seconds of video.', 'INVALID_YOUTUBE_CHAPTERS', 422);
    }
  }
  if (normalizedInstagramOptions?.coverUrl && !/^https:\/\//i.test(normalizedInstagramOptions.coverUrl)) {
    throw new OrganicPublishingError('Instagram Reel cover URLs must use HTTPS.', 'INSTAGRAM_COVER_URL_INVALID', 422);
  }
  if (normalizedInstagramOptions?.thumbOffset !== undefined && (!Number.isFinite(normalizedInstagramOptions.thumbOffset) || normalizedInstagramOptions.thumbOffset < 0)) {
    throw new OrganicPublishingError('Instagram Reel thumbnail offset must be zero or greater.', 'INSTAGRAM_THUMB_OFFSET_INVALID', 422);
  }
  if (normalizedInstagramOptions?.coverUrl) {
    if (postType !== 'reel') throw new OrganicPublishingError('Cover images apply to Instagram Reels.', 'INVALID_INSTAGRAM_OPTIONS', 422);
    try {
      normalizedInstagramOptions.coverUrl = (await preflightPublishingImages([normalizedInstagramOptions.coverUrl], 'instagram', 'story', userId)).urls[0];
    } catch (error) {
      throw new OrganicPublishingError(error instanceof Error ? error.message : 'Cover image validation failed.', 'IMAGE_PREFLIGHT_FAILED', 422);
    }
  }
  const validationSnapshot = {
    validatedAt: approvedAt,
    stage: 'publish',
    platforms: [input.platform],
    violations: [],
  };
  const snapshot: OrganicPublishSnapshot = {
    publicationOrigin: await captureOrganicPublishOrigin(userId),
    sourceAssetVersion: asset.version,
    sourceReviewToken: organicPublishReviewToken(asset, resolvedMedia),
    ...(input.requestFingerprint ? { requestFingerprint: input.requestFingerprint } : {}),
    platform: input.platform,
    caption,
    postType,
    title: input.title || asset.title,
    tags,
    callToAction,
    privacyStatus: input.privacyStatus || (input.platform === 'youtube' ? 'private' : 'public'),
    ...(optionsResult.data ? { youtubeOptions: optionsResult.data } : {}),
    imageUrls: media.imageUrls,
    videoUrls: media.videoUrls,
    credentialId: account.credentialId,
    providerAccountId: account.providerAccountId,
    ...(videoMetadata ? { videoMetadata } : {}),
    ...(normalizedInstagramOptions && Object.values(normalizedInstagramOptions).some((value) => value !== undefined) ? { instagramOptions: normalizedInstagramOptions } : {}),
    timezone: normalizeTimezone(input.timezone),
    scheduledFor: input.scheduledFor,
    approvedBy: userId,
    approvedAt,
    brandContextSnapshot: brandContextSnapshot(context),
    validationSnapshot,
  };
  snapshot.approvedBy = snapshot.publicationOrigin!.businessActorUserId;
  if (snapshot.platform !== 'youtube' && snapshot.privacyStatus !== 'public') {
    throw new OrganicPublishingError(
      'Instagram, Facebook, and LinkedIn posts are public; non-public privacy is not supported.',
      'UNSUPPORTED_PRIVACY',
      422,
    );
  }
  if (snapshot.platform === 'youtube' && !['public', 'private', 'unlisted'].includes(snapshot.privacyStatus || '')) {
    throw new OrganicPublishingError('YouTube privacy must be public, private, or unlisted.', 'INVALID_PRIVACY', 422);
  }
  validateOrganicMedia(snapshot);
  if (snapshot.platform !== 'linkedin' && snapshot.imageUrls.length) {
    try {
      const checked = await preflightPublishingImages(snapshot.imageUrls, snapshot.platform, snapshot.postType, userId);
      snapshot.imageUrls = checked.urls;
      snapshot.validationSnapshot = { ...snapshot.validationSnapshot, images: checked.probes };
    } catch (error) {
      throw new OrganicPublishingError(error instanceof Error ? error.message : 'Image validation failed.', 'IMAGE_PREFLIGHT_FAILED', 422);
    }
  }
  if (snapshot.platform === 'youtube') {
    try {
      validateYouTubePublishInput({
        ...snapshot.youtubeOptions,
        videoUrl: snapshot.videoUrls[0], title: snapshot.title || '',
        description: snapshot.caption, tags: snapshot.tags,
        privacyStatus: snapshot.privacyStatus as 'public' | 'private' | 'unlisted',
        postType: snapshot.postType as 'video' | 'short', videoMetadata: snapshot.videoMetadata,
      });
      if (snapshot.youtubeOptions?.thumbnailUrl || snapshot.youtubeOptions?.playlistId) {
        await validateYouTubePublishExtras(userId, snapshot.credentialId, snapshot.youtubeOptions);
      }
    } catch (error) {
      throw new OrganicPublishingError(error instanceof Error ? error.message : 'Invalid YouTube publishing input.',
        (error as { code?: string }).code || 'INVALID_YOUTUBE_INPUT', 422);
    }
  }

  if (input.scheduledFor) {
    const date = new Date(input.scheduledFor);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now() + 60_000) {
      throw new OrganicPublishingError('Scheduled time must be at least one minute in the future.', 'INVALID_SCHEDULE', 422);
    }
  }

  const persistedContent = {
    ...parsed,
    caption,
    ...(tags.length ? { tags } : {}),
    ...(callToAction ? { callToAction } : {}),
  };
  return { snapshot, persistedContent, account, context, sourceMedia: resolvedMedia };
}

/** Caller transactions may defer reference entries only until their final
 * domain write; that caller must perform one canonical sync before commit. */
export async function prepareOrganicPublishAttempt(
  userId: number,
  asset: ContentAssetRecord,
  input: PrepareOrganicPublishInput,
  transactionDb?: ManagedStorageTransaction,
  review?: Awaited<ReturnType<typeof buildOrganicPublishReview>>,
  deferredStorageReferences?: OrganicPublishStorageEntry[],
): Promise<{ attempt: SocialPublishAttempt; snapshot: OrganicPublishSnapshot }> {
  if (asset.userId !== userId) throw new OrganicPublishingError('Content asset not found.', 'CONTENT_ASSET_NOT_FOUND', 404);
  if (deferredStorageReferences && !transactionDb) throw new Error('Deferred publication references require the caller transaction');
  if (asset.status === 'published' && input.idempotencyKey) {
    const existing = await SocialPublishAttemptModel.findByKey(userId, input.idempotencyKey);
    if (existing?.assetId === asset.id && existing.platform === input.platform && ['provider_succeeded', 'succeeded'].includes(existing.status)) return { attempt: existing, snapshot: existing.reviewedPayload };
  }
  const { snapshot: reviewedSnapshot, persistedContent, account, context } = review || await buildOrganicPublishReview(userId, asset, input, transactionDb);
  if (review) {
    const currentAccount = await resolveAccount(userId, input.platform, account.credentialId, transactionDb || db);
    if (currentAccount.providerAccountId !== account.providerAccountId) throw new OrganicPublishingError('The connected account changed during review.', 'PUBLISHING_ACCOUNT_CHANGED', 409);
    if (input.scheduledFor && new Date(input.scheduledFor).getTime() <= Date.now() + 60_000) throw new OrganicPublishingError('Choose a scheduled time at least one minute in the future.', 'INVALID_SCHEDULE', 422);
  }
  const snapshot = { ...reviewedSnapshot, ...(input.requestFingerprint ? { requestFingerprint: input.requestFingerprint } : {}) };
  const material = JSON.stringify({ assetId: asset.id, assetVersion: asset.version, snapshot });
  const idempotencyKey = input.idempotencyKey?.trim() || `organic:${crypto.createHash('sha256').update(material).digest('hex')}`;
  const persist = async (transaction: ManagedStorageTransaction) => {
    await lockManagedStorageReferences(transaction, { userId, businessProfileId: requireBusinessScope().businessProfileId });
    const [created] = await transaction
      .insert(socialPublishAttemptsTable)
      .values({
        userId,
        assetId: asset.id,
        platform: input.platform,
        credentialId: account.credentialId,
        providerAccountId: account.providerAccountId,
        idempotencyKey,
        reviewedPayload: snapshot,
        nextAttemptAt: input.scheduledFor
          ? new Date(input.scheduledFor)
          : input.holdForCrossPlatformPreflight
            ? new Date(Date.now() + 5 * 60_000)
            : new Date(),
      })
      .onConflictDoNothing({
        target: [socialPublishAttemptsTable.businessProfileId,
          socialPublishAttemptsTable.userId,
          socialPublishAttemptsTable.idempotencyKey,
        ],
      })
      .returning();
    const [durableAttempt] = created
      ? [created]
      : await transaction
          .select()
          .from(socialPublishAttemptsTable)
          .where(and(
            eq(socialPublishAttemptsTable.userId, userId),
            eq(socialPublishAttemptsTable.idempotencyKey, idempotencyKey),
          ))
          .limit(1);
    if (!durableAttempt) throw new Error('Publish attempt conflict could not be resolved');
    if (
      durableAttempt.assetId !== asset.id
      || durableAttempt.platform !== input.platform
      || reviewedPayloadFingerprint(durableAttempt.reviewedPayload) !== reviewedPayloadFingerprint(snapshot)
    ) {
      throw new OrganicPublishingError(
        'This idempotency key was already used with a different publishing request.',
        'IDEMPOTENCY_KEY_REUSED',
        409,
      );
    }

    const [updatedAsset] = await transaction
      .update(contentAssetsTable)
      .set({
        content: JSON.stringify(persistedContent),
        title: input.title || asset.title,
        publishPlatform: input.platform,
        scheduledPublishAt: input.scheduledFor ? new Date(input.scheduledFor) : null,
        status: created ? (input.scheduledFor ? 'scheduled' : 'processing') : asset.status,
        metadata: {
          ...((asset.metadata || {}) as Record<string, unknown>),
          organicPublishAttemptId: durableAttempt.id,
          reviewedPublishSnapshot: durableAttempt.reviewedPayload,
        },
        businessProfileId: context.businessProfile.id,
        brandToolkitId: context.brandToolkit.id,
        brandContextSnapshot: durableAttempt.reviewedPayload.brandContextSnapshot || {},
        validationSnapshot: durableAttempt.reviewedPayload.validationSnapshot || {},
        retryCount: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(contentAssetsTable.id, asset.id),
        eq(contentAssetsTable.userId, userId),
      ))
      .returning();
    if (!updatedAsset) {
      throw new OrganicPublishingError('Content asset not found.', 'CONTENT_ASSET_NOT_FOUND', 404);
    }
    const references: OrganicPublishStorageEntry[] = [
      { owner: { kind: 'social_publish_attempt', id: String(durableAttempt.id), userId: durableAttempt.userId, businessProfileId: durableAttempt.businessProfileId! },
        urls: collectContentManagedReferenceUrls(durableAttempt.reviewedPayload) },
      { owner: { kind: 'content_asset', id: String(updatedAsset.id), userId, businessProfileId: updatedAsset.businessProfileId! },
        urls: collectContentManagedReferenceUrls(updatedAsset) },
    ];
    // Related destinations must finish ALL domain writes before taking object
    // locks. The batch caller enlists these entries in one final canonical sync.
    if (deferredStorageReferences) deferredStorageReferences.push(...references);
    else await syncManagedStorageOwners(transaction, { entries: references });
    return durableAttempt;
  };
  const attempt = transactionDb ? await persist(transactionDb) : await db.transaction(persist);
  return { attempt, snapshot: attempt.reviewedPayload };
}

async function validateSavedPublishingVideos(asset: ContentAssetRecord, urls: string[], platform: OrganicPlatform, queryDb: typeof db = db): Promise<MediaProbe> {
  if (platform === 'linkedin') throw new OrganicPublishingError('LinkedIn native media uploads are not implemented by this publisher.', 'LINKEDIN_MEDIA_UNSUPPORTED', 422);
  const children: ContentAssetRecord[] = await queryDb.select().from(contentAssetsTable).where(and(eq(contentAssetsTable.parentAssetId, asset.id), eq(contentAssetsTable.userId, asset.userId!)));
  let first: MediaProbe | undefined;
  for (const url of urls) {
    const source = [asset, ...children].find(value => {
      const parsed = parseContent(value.content);
      const metadata = (value.metadata || {}) as Record<string, unknown>;
      return uniqueStrings([value.videoUrl, ...(value.videoUrls || []), parsed.videoUrl,
        ...(Array.isArray(parsed.videoUrls) ? parsed.videoUrls : []), metadata.videoUrl,
        ...(Array.isArray(metadata.videoUrls) ? metadata.videoUrls : [])]).some(value => toPublicUrl(value) === url);
    });
    const metadata = (source?.metadata || {}) as Record<string, unknown>;
    const probes = metadata.mediaProbes && typeof metadata.mediaProbes === 'object' ? metadata.mediaProbes as Record<string, MediaProbe> : {};
    const boundProbe = Object.entries(probes).find(([key]) => toPublicUrl(key) === url)?.[1];
    const sourceVideos = source ? await resolveOrganicPublishingMedia(source, queryDb) : { videoUrls: [] };
    const legacyProbeMatches = metadata.mediaProbeUrl
      ? typeof metadata.mediaProbeUrl === 'string' && toPublicUrl(metadata.mediaProbeUrl) === url
      : sourceVideos.videoUrls.length === 1;
    const probe = boundProbe || (legacyProbeMatches ? metadata.mediaProbe as MediaProbe | undefined : undefined);
    if (!probe) throw new OrganicPublishingError('Video has not completed trusted media probing/transcoding.', 'MEDIA_PROBE_REQUIRED', 422);
    const errors = validateMediaForPlatform(probe, platform);
    if (errors.length) throw new OrganicPublishingError(errors.join(' '), 'MEDIA_PREFLIGHT_FAILED', 422);
    first ||= probe;
  }
  return first!;
}

function classifyFailure(result: PublishResult | YouTubePublishResult): {
  code?: string;
  message: string;
  ambiguous?: boolean;
  retryable?: boolean;
  retryAfterSeconds?: number;
} {
  return {
    code: result.errorCode,
    message: result.error || 'Publishing failed',
    ambiguous: result.ambiguous,
    retryable: result.retryable,
    retryAfterSeconds: 'retryAfterSeconds' in result ? result.retryAfterSeconds : undefined,
  };
}

async function applyYouTubePublishExtras(attempt: SocialPublishAttempt): Promise<{ retry?: string; warning?: string }> {
  const options = attempt.reviewedPayload.youtubeOptions;
  if (!options?.thumbnailUrl && !options?.playlistId) return {};
  // The attempt lease serializes these operations without reserving a database
  // connection while providers or storage services need their own connections.
  const [asset] = await db.select().from(contentAssetsTable).where(and(eq(contentAssetsTable.id, attempt.assetId!), eq(contentAssetsTable.userId, attempt.userId))).limit(1);
  if (!asset) throw new Error('Published asset could not be found.');
  const metadata = (asset.metadata || {}) as Record<string, unknown>;
  const applied = { ...((metadata.youtubePublishExtras || {}) as Record<string, unknown>) };
  const persist = () => db.update(contentAssetsTable).set({
    metadata: sql`jsonb_set(COALESCE(${contentAssetsTable.metadata}, '{}'::jsonb), '{youtubePublishExtras}', ${JSON.stringify(applied)}::jsonb, true)`,
    updatedAt: new Date(),
  }).where(and(eq(contentAssetsTable.id, asset.id), eq(contentAssetsTable.userId, attempt.userId)));
  try {
    if (options.thumbnailUrl && applied.thumbnailUrl !== options.thumbnailUrl) {
      await setYouTubeThumbnail(attempt.userId, attempt.credentialId!, attempt.providerPostId!, options.thumbnailUrl);
      applied.thumbnailUrl = options.thumbnailUrl;
      await persist();
    }
    if (options.playlistId && applied.playlistId !== options.playlistId) {
      await assignYouTubePlaylist(attempt.userId, attempt.credentialId!, attempt.providerPostId!, options.playlistId);
      applied.playlistId = options.playlistId;
      await persist();
    }
    return {};
  } catch (error) {
    const message = `YouTube published the video. Thumbnail or playlist setup needs attention: ${error instanceof Error ? error.message : 'Please reconnect the account.'}`;
    applied.failureCount = Number(applied.failureCount || 0) + 1;
    applied.lastError = message;
    applied.lastFailedAt = new Date().toISOString();
    await persist();
    return Number(applied.failureCount) >= 3 ? { warning: message } : { retry: message };
  }
}

async function finalizeProviderSuccess(attempt: SocialPublishAttempt): Promise<SocialPublishAttempt> {
  const workerId = `organic-finalize-${process.pid}-${crypto.randomUUID()}`;
  if (!await SocialPublishAttemptModel.claimReconciliation(attempt.id, attempt.userId, workerId)) {
    return (await SocialPublishAttemptModel.findByIdForUser(attempt.id, attempt.userId)) || attempt;
  }
  const stopHeartbeat = startPublishLeaseHeartbeat(attempt, workerId);
  try {
    return await finalizeClaimedProviderSuccess(attempt);
  } finally {
    stopHeartbeat();
    await SocialPublishAttemptModel.releaseReconciliation(attempt.id, attempt.userId, workerId);
  }
}

function startPublishLeaseHeartbeat(attempt: SocialPublishAttempt, workerId: string): () => void {
  const timer = setInterval(() => {
    void SocialPublishAttemptModel.renewLease(attempt.id, attempt.userId, workerId).catch(error => {
      logger.warn({ err: error, attemptId: attempt.id }, '[OrganicPublishing] Publish lease renewal failed');
    });
  }, 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function finalizeClaimedProviderSuccess(attempt: SocialPublishAttempt): Promise<SocialPublishAttempt> {
  if (!attempt.assetId || !attempt.providerPostId) {
    throw new Error('Provider-success attempt is missing its asset or provider post ID');
  }
  let publishWarning: { code: string; message: string } | undefined;
  if (attempt.platform === 'youtube') {
    try {
      const processing = await getYouTubeVideoProcessingStatus(
        attempt.userId,
        attempt.credentialId!,
        attempt.providerPostId,
      );
      const outcome = classifyYouTubeProcessingState(
        processing,
        attempt.providerSucceededAt || attempt.updatedAt,
      );
      if (outcome.state === 'failed') {
        const failed = await SocialPublishAttemptModel.markProviderProcessingFailed(
          attempt.id,
          attempt.userId,
          outcome.code,
          outcome.message,
        );
        await ContentAssetModel.updateForUser(attempt.assetId, attempt.userId, {
          status: 'failed',
          lastError: outcome.message,
        });
        return failed || attempt;
      }

      if (outcome.state === 'pending') {
        return (await SocialPublishAttemptModel.deferProviderFinalization(
          attempt.id,
          attempt.userId,
          outcome.message,
        )) || attempt;
      }
      try {
        const extras = await applyYouTubePublishExtras(attempt);
        if (extras.retry) return (await SocialPublishAttemptModel.deferProviderFinalization(attempt.id, attempt.userId, extras.retry, 5 * 60_000, 'YOUTUBE_EXTRAS_PENDING')) || attempt;
        if (extras.warning) publishWarning = { code: 'YOUTUBE_EXTRAS_FAILED', message: extras.warning };
      } catch (error) {
        const message = `YouTube uploaded the video. Thumbnail or playlist setup needs attention: ${error instanceof Error ? error.message : 'Please reconnect the account.'}`;
        return (await SocialPublishAttemptModel.deferProviderFinalization(attempt.id, attempt.userId, message, 5 * 60_000)) || attempt;
      }
    } catch (error) {
      const outcome = classifyYouTubeProcessingState(null, attempt.providerSucceededAt || attempt.updatedAt);
      if (outcome.state === 'failed') {
        const failed = await SocialPublishAttemptModel.markProviderProcessingFailed(attempt.id, attempt.userId, outcome.code, outcome.message);
        await ContentAssetModel.updateForUser(attempt.assetId, attempt.userId, { status: 'failed', lastError: outcome.message });
        return failed || attempt;
      }
      logger.warn(
        { err: error, attemptId: attempt.id, providerPostId: attempt.providerPostId },
        '[OrganicPublishingService] YouTube processing check failed; finalization deferred',
      );
      return (await SocialPublishAttemptModel.deferProviderFinalization(
        attempt.id,
        attempt.userId,
        'YouTube accepted the upload, but processing status could not be checked. The system will retry the status check without uploading again.',
        5 * 60_000,
      )) || attempt;
    }
  }
  const updatedAsset = await ContentAssetModel.markAsPublishedForUser(
    attempt.assetId,
    attempt.userId,
    {
      publishedPostId: attempt.providerPostId,
      publishedUrl: attempt.providerPostUrl || undefined,
      publishPlatform: attempt.platform,
    },
  );
  if (!updatedAsset) throw new Error('Content asset disappeared before provider success could be finalized');
  const completed = await SocialPublishAttemptModel.markSucceeded(attempt.id, attempt.userId, publishWarning);
  if (!completed) throw new Error('Publish attempt could not be finalized');
  return completed;
}

export async function executeOrganicPublishAttempt(
  attemptOrId: SocialPublishAttempt | number,
  userId: number,
  workerId: string,
): Promise<SocialPublishAttempt> {
  let attempt = typeof attemptOrId === 'number'
    ? await SocialPublishAttemptModel.findByIdForUser(attemptOrId, userId)
    : attemptOrId;
  if (!attempt) throw new OrganicPublishingError('Publish attempt not found.', 'ATTEMPT_NOT_FOUND', 404);
  if (attempt.status === 'succeeded' || attempt.status === 'failed' || attempt.status === 'ambiguous') return attempt;
  if (attempt.status === 'provider_succeeded') return finalizeProviderSuccess(attempt);
  if (attempt.status === 'claimed') return attempt;

  await authorizeOrganicPublishOrigin(attempt);

  const claimed = await SocialPublishAttemptModel.claim(attempt.id, userId, workerId);
  if (!claimed) {
    return (await SocialPublishAttemptModel.findByIdForUser(attempt.id, userId)) || attempt;
  }
  attempt = claimed;
  const snapshot = attempt.reviewedPayload;
  const stopHeartbeat = startPublishLeaseHeartbeat(attempt, workerId);

  let result: PublishResult | YouTubePublishResult;
  try {
    result = snapshot.platform === 'instagram'
      ? await publishToInstagram(userId, {
          credentialId: snapshot.credentialId,
          expectedAccountId: snapshot.providerAccountId,
          postType: snapshot.postType as 'post' | 'reel' | 'carousel' | 'story',
          imageUrls: snapshot.imageUrls,
          videoUrl: snapshot.videoUrls[0],
          videoUrls: snapshot.videoUrls,
          caption: snapshot.caption,
          coverUrl: snapshot.instagramOptions?.coverUrl,
          thumbOffset: snapshot.instagramOptions?.thumbOffset,
          altText: snapshot.instagramOptions?.altText,
          locationId: snapshot.instagramOptions?.locationId,
          collaborators: snapshot.instagramOptions?.collaborators,
          shareToFeed: snapshot.instagramOptions?.shareToFeed,
        })
      : snapshot.platform === 'facebook'
        ? await publishToFacebook(userId, {
          credentialId: snapshot.credentialId,
          expectedAccountId: snapshot.providerAccountId,
          postType: snapshot.postType as 'text' | 'photo' | 'video',
          message: snapshot.caption,
          imageUrl: snapshot.imageUrls[0],
          imageUrls: snapshot.imageUrls,
          videoUrl: snapshot.videoUrls[0],
          title: snapshot.title,
          description: snapshot.caption,
        })
        : snapshot.platform === 'linkedin'
          ? await LinkedInPublishingService.publishPost(userId, snapshot.caption, { credentialId: snapshot.credentialId, expectedAccountId: snapshot.providerAccountId })
        : await publishToYouTube(userId, {
          ...snapshot.youtubeOptions,
          credentialId: snapshot.credentialId,
          expectedChannelId: snapshot.providerAccountId,
          postType: snapshot.postType as 'video' | 'short',
          videoUrl: snapshot.videoUrls[0],
          title: snapshot.title || 'Video',
          description: snapshot.caption,
          tags: snapshot.tags,
          privacyStatus: snapshot.privacyStatus as 'public' | 'private' | 'unlisted',
          videoMetadata: snapshot.videoMetadata,
        });
  } catch (error) {
    result = {
      success: false,
      error: error instanceof Error ? error.message : 'Publishing failed',
      ambiguous: true,
      retryable: false,
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
    };
  } finally {
    stopHeartbeat();
  }

  if (!result.success || typeof result.platformPostId !== 'string' || !result.platformPostId.trim()) {
    const failed = await SocialPublishAttemptModel.markFailure(attempt, result.success ? {
      code: 'PROVIDER_RECEIPT_MISSING',
      message: 'The provider accepted publication without a usable receipt. Check provider status before retrying.',
      ambiguous: true,
      retryable: false,
    } : classifyFailure(result));
    if (!failed) throw new Error('Publish failure could not be persisted');
    if (attempt.assetId) {
      await ContentAssetModel.updateForUser(attempt.assetId, userId, {
        status: failed.status === 'retryable_failed' ? 'scheduled' : 'failed',
        retryCount: failed.attemptCount,
        lastError: failed.errorMessage,
        // Preserve the reviewed posting slot; retry timing lives on the attempt.
      });
    }
    return failed;
  }

  const providerSucceeded = await SocialPublishAttemptModel.markProviderSucceeded(
    attempt.id,
    userId,
    {
      providerPostId: result.platformPostId,
      providerPostUrl: result.postUrl,
      providerRequestId: result.providerRequestId,
    },
  );
  if (!providerSucceeded) throw new Error('Provider success could not be recorded');
  try {
    return await finalizeProviderSuccess(providerSucceeded);
  } catch (error) {
    logger.error(
      { err: error, attemptId: attempt.id, providerPostId: result.platformPostId },
      '[OrganicPublishingService] Provider succeeded; database finalization is pending reconciliation',
    );
    return providerSucceeded;
  }
}

export async function reconcileAmbiguousOrganicAttempt(
  attemptOrId: SocialPublishAttempt | number,
  userId: number,
): Promise<SocialPublishAttempt> {
  const attempt = typeof attemptOrId === 'number'
    ? await SocialPublishAttemptModel.findByIdForUser(attemptOrId, userId)
    : attemptOrId;
  if (!attempt) throw new OrganicPublishingError('Publish attempt not found.', 'ATTEMPT_NOT_FOUND', 404);
  if (attempt.status !== 'ambiguous') return attempt;
  const snapshot = attempt.reviewedPayload;
  if (snapshot.platform === 'youtube' || snapshot.platform === 'linkedin') {
    // Without a provider video ID we must never search-and-repost: that could
    // create a duplicate upload. Keep the attempt quarantined for support.
    await SocialPublishAttemptModel.deferAmbiguousReconciliation(
      attempt.id,
      userId,
      `${snapshot.platform} publication outcome could not be verified safely. It will not be retried automatically to avoid duplicate posts.`,
    );
    return (await SocialPublishAttemptModel.findByIdForUser(attempt.id, userId)) || attempt;
  }
  const candidate = await findPublishedOrganicPostCandidate(userId, {
    platform: snapshot.platform,
    credentialId: snapshot.credentialId,
    expectedAccountId: snapshot.providerAccountId,
    caption: snapshot.caption,
    expectedAt: snapshot.scheduledFor || snapshot.approvedAt,
  });
  if (!candidate.matched || !candidate.providerPostId) {
    await SocialPublishAttemptModel.deferAmbiguousReconciliation(
      attempt.id,
      userId,
      candidate.error || 'No unique matching provider post was found; the attempt remains quarantined.',
    );
    return (await SocialPublishAttemptModel.findByIdForUser(attempt.id, userId)) || attempt;
  }
  const reconciled = await SocialPublishAttemptModel.markAmbiguousReconciled(
    attempt.id,
    userId,
    {
      providerPostId: candidate.providerPostId,
      providerPostUrl: candidate.postUrl,
    },
  );
  if (!reconciled) {
    return (await SocialPublishAttemptModel.findByIdForUser(attempt.id, userId)) || attempt;
  }
  return finalizeProviderSuccess(reconciled);
}
