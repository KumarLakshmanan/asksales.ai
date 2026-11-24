import { canonicalMediaUrl, collectContentAssetMediaUrls } from './contentAssetMedia.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function addUrl(urls: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed)) urls.add(canonicalMediaUrl(trimmed));
}

function addBrandSnapshot(urls: Set<string>, snapshot: unknown): void {
  const toolkit = record(record(snapshot)?.brandToolkit);
  if (!toolkit) return;
  addUrl(urls, toolkit.logoUrl);
  for (const url of strings(toolkit.logoUrls)) addUrl(urls, url);
  if (Array.isArray(toolkit.imageAssets)) {
    for (const image of toolkit.imageAssets) {
      const asset = record(image);
      addUrl(urls, asset?.url);
      addUrl(urls, asset?.originalUrl);
      addUrl(urls, asset?.thumbnailUrl);
    }
  }
  addUrl(urls, toolkit.websiteScreenshotUrl);
}

function addSavedMedia(urls: Set<string>, source: Record<string, unknown>): void {
  const ordinary = collectContentAssetMediaUrls({
    content: typeof source.content === 'string' ? source.content : undefined,
    imageUrl: typeof source.imageUrl === 'string' ? source.imageUrl : undefined,
    videoUrl: typeof source.videoUrl === 'string' ? source.videoUrl : undefined,
    imageUrls: strings(source.imageUrls),
    videoUrls: strings(source.videoUrls),
  });
  for (const url of ordinary) urls.add(url);
  addUrl(urls, source.thumbnailUrl);
  addUrl(urls, record(source.youtubeOptions)?.thumbnailUrl);
  addUrl(urls, record(source.instagramOptions)?.coverUrl);
  addBrandSnapshot(urls, source.brandContextSnapshot);
}

/**
 * Projects URL candidates from a complete saved asset/template, a template-version
 * `snapshot`, or an Organic attempt's stored `reviewedPayload`. An asset's stored
 * metadata.reviewedPublishSnapshot is included independently of its current media.
 *
 * This is pure projection, not registration or authority validation. Callers must
 * register the result with canonical Storage inside the domain transaction. Only
 * known media fields are read; arbitrary business URLs/copy/metadata are excluded.
 */
export function collectContentManagedReferenceUrls(source: unknown): string[] {
  const saved = record(source);
  if (!saved) return [];
  const urls = new Set<string>();
  addSavedMedia(urls, saved);
  const reviewed = record(saved.reviewedPublishSnapshot);
  if (reviewed) addSavedMedia(urls, reviewed);
  const reviewedMetadata = record(record(saved.metadata)?.reviewedPublishSnapshot);
  if (reviewedMetadata) addSavedMedia(urls, reviewedMetadata);
  return [...urls];
}
