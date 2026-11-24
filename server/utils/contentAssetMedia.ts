const SINGLE_MEDIA_KEYS = new Set([
  'imageUrl',
  'videoUrl',
  'generatedImage',
  'generatedVideo',
  'url',
]);

const MEDIA_ARRAY_KEYS = new Set(['imageUrls', 'videoUrls']);

export interface ContentAssetMediaSource {
  content?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  imageUrls?: string[] | null;
  videoUrls?: string[] | null;
}

export function canonicalMediaUrl(value: string): string {
  return value.trim().split(/[?#]/, 1)[0];
}

function isMediaReference(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed);
}

function addUrl(target: Set<string>, value: unknown) {
  if (isMediaReference(value)) target.add(canonicalMediaUrl(value));
}

function collectFromObject(target: Set<string>, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SINGLE_MEDIA_KEYS.has(key)) addUrl(target, nested);
    if (MEDIA_ARRAY_KEYS.has(key) && Array.isArray(nested)) {
      for (const item of nested) addUrl(target, item);
    }
  }
}

export function collectContentAssetMediaUrls(asset: ContentAssetMediaSource): Set<string> {
  const urls = new Set<string>();
  addUrl(urls, asset.imageUrl);
  addUrl(urls, asset.videoUrl);
  for (const value of asset.imageUrls ?? []) addUrl(urls, value);
  for (const value of asset.videoUrls ?? []) addUrl(urls, value);

  if (asset.content) {
    addUrl(urls, asset.content);
    try {
      collectFromObject(urls, JSON.parse(asset.content));
    } catch {
      // Plain text content is expected for most asset types.
    }
  }
  return urls;
}

export function findRemovedContentAssetMediaUrls(
  before: ContentAssetMediaSource,
  after: ContentAssetMediaSource,
): Set<string> {
  const previous = collectContentAssetMediaUrls(before);
  const current = collectContentAssetMediaUrls(after);
  return new Set([...previous].filter((url) => !current.has(url)));
}
