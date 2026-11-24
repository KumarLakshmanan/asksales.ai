import { createHash } from 'node:crypto';
import type { ContentAssetRecord, InsertContentAsset } from '../../models/contentAssets/schema.js';
import type { MediaProbe } from './MediaTranscodingService.js';

export type GeneratedMediaKind = 'image' | 'video';

/** Strip cache-busting query/hash so one stored file always maps to one key. */
export function canonicalMediaUrl(url: string): string {
  return url.trim().split(/[?#]/, 1)[0];
}

/**
 * Idempotency key for a generated media file. Every generated file has a unique
 * storage URL, so (user, type, URL) identifies one generation regardless of
 * which path saves it (HTTP route, queue worker, status poll, chat tool replay).
 */
export function generatedMediaKey(kind: GeneratedMediaKind, url: string): string {
  return `${kind}:${createHash('sha256').update(canonicalMediaUrl(url)).digest('hex')}`;
}

/** Only durable URLs belong in the gallery; inline base64 previews do not. */
export function isDurableMediaUrl(url: unknown): url is string {
  return typeof url === 'string' && (url.startsWith('/uploads/') || url.startsWith('/api/uploads/') || /^https:\/\//i.test(url));
}

export interface GalleryMediaInput {
  userId: number;
  kind: GeneratedMediaKind;
  url: string;
  /** The post/email/ad the media was generated for. */
  parent?: Pick<ContentAssetRecord, 'id' | 'type' | 'title' | 'channel' | 'threadId' | 'businessProfileId' | 'brandToolkitId'> | null;
  threadId?: number | null;
  title?: string;
  channel?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mimeType?: string;
  mediaProbe?: MediaProbe;
  extraPerformance?: Record<string, unknown>;
}

/**
 * Build the gallery row for generated media. Kept pure so the mapping is tested
 * without a database.
 */
export function buildGalleryMediaRow(input: GalleryMediaInput): InsertContentAsset {
  const { parent, kind, url } = input;
  const noun = kind === 'image' ? 'Image' : 'Video';
  const parentTitle = parent?.title?.trim();
  const title = (input.title || (parentTitle ? `${noun} for: ${parentTitle}` : `Generated ${noun}`)).slice(0, 255);
  const performance: Record<string, unknown> = { ...(input.extraPerformance || {}) };
  if (input.prompt) performance.prompt = input.prompt;
  if (input.provider) performance.provider = input.provider;
  if (input.model) performance.model = input.model;
  if (parent) performance.sourceAssetId = parent.id;
  return {
    type: kind,
    title,
    content: kind === 'image' ? url : JSON.stringify({ videoUrl: url, mimeType: input.mimeType || 'video/mp4' }),
    imageUrl: kind === 'image' ? url : null,
    imageUrls: kind === 'image' ? [url] : [],
    videoUrl: kind === 'video' ? url : null,
    videoUrls: kind === 'video' ? [url] : [],
    channel: (input.channel || parent?.channel || 'content_studio').slice(0, 50),
    status: 'draft',
    userId: input.userId,
    threadId: input.threadId ?? parent?.threadId ?? null,
    // A different-type child stays visible in its own gallery (see buildUserConditions).
    parentAssetId: parent && parent.type !== kind ? parent.id : null,
    businessProfileId: parent?.businessProfileId ?? null,
    brandToolkitId: parent?.brandToolkitId ?? null,
    performance,
  };
}

/**
 * Insert a generated image/video row; when it has a durable URL the insert is
 * idempotent, so a replayed tool call or completion returns the existing row.
 */
export async function createGeneratedAsset(kind: GeneratedMediaKind, url: unknown, row: InsertContentAsset): Promise<ContentAssetRecord> {
  const { ContentAssetModel } = await import('../../models/contentAssets/functions.js');
  if (!isDurableMediaUrl(url) || !row.userId) return ContentAssetModel.create(row);
  return (await ContentAssetModel.createOnce(row, generatedMediaKey(kind, url))).asset;
}

/**
 * Make generated media visible in the Image/Video gallery exactly once.
 * When the parent already is the gallery item (a standalone image/video draft),
 * nothing is created.
 */
export async function saveGeneratedMediaToGallery(input: GalleryMediaInput): Promise<{ assetId: number; created: boolean } | null> {
  if (!isDurableMediaUrl(input.url)) return null;
  if (input.parent && input.parent.type === input.kind) return { assetId: input.parent.id, created: false };
  const row = buildGalleryMediaRow(input);
  if (input.kind === 'video') {
    const { withVideoProbeMetadata } = await import('./MediaTranscodingService.js');
    row.metadata = withVideoProbeMetadata(input.url, input.mediaProbe, {});
  }
  const { ContentAssetModel } = await import('../../models/contentAssets/functions.js');
  const { asset, created } = await ContentAssetModel.createOnce(row, generatedMediaKey(input.kind, input.url));
  return { assetId: asset.id, created };
}
