/**
 * Gemini Media Pricing Constants
 *
 * Official Google pricing for image and video generation models.
 * Prices vary by model AND resolution tier.
 * These are the BASE costs (what Google charges). Admin margin is applied on top.
 *
 * Source: Google Cloud pricing (as of June 2025)
 */

// ── Resolution Types ─────────────────────────────────────────────────────────

export type ImageResolutionTier = '512px' | '1K' | '2K' | '4K';
export type VideoResolutionTier = '720p_1080p' | '1080p' | '4K';

export interface ResolutionTier<T extends string> {
  resolution: T;
  label: string;
  priceUSD: number;
}

// ── Video Models ─────────────────────────────────────────────────────────────

export interface VideoModelPricing {
  modelId: string;
  name: string;
  billingUnit: 'per_second';
  resolutionTiers: ResolutionTier<VideoResolutionTier>[];
}

export const GEMINI_VIDEO_PRICING: VideoModelPricing[] = [
  {
    modelId: 'veo-3.1-fast-generate-001',
    name: 'Veo 3.1 Fast',
    billingUnit: 'per_second',
    resolutionTiers: [
      { resolution: '720p_1080p', label: '720p', priceUSD: 0.15 },
      { resolution: '1080p', label: '1080p', priceUSD: 0.15 },
      { resolution: '4K', label: '4K (Ultra HD)', priceUSD: 0.30 },
    ],
  },
  {
    modelId: 'veo-3.1-generate-001',
    name: 'Veo 3.1',
    billingUnit: 'per_second',
    resolutionTiers: [
      { resolution: '720p_1080p', label: '720p', priceUSD: 0.40 },
      { resolution: '1080p', label: '1080p (HD)', priceUSD: 0.40 },
      { resolution: '4K', label: '4K (Ultra HD)', priceUSD: 0.75 },
    ],
  },
  {
    modelId: 'veo-2.0-generate-001',
    name: 'Veo 2.0',
    billingUnit: 'per_second',
    resolutionTiers: [
      { resolution: '720p_1080p', label: '720p', priceUSD: 0.35 },
    ],
  },
];

/** Default video price per second when model not found in the list */
export const DEFAULT_VIDEO_PRICE_PER_SECOND_USD = 0.40;

/** Default video duration in seconds (Veo typically generates ~8s videos) */
export const DEFAULT_VIDEO_DURATION_SECONDS = 8;

// ── Image Models ─────────────────────────────────────────────────────────────

export interface ImageModelPricing {
  modelId: string;
  name: string;
  billingUnit: 'per_image';
  resolutionTiers: ResolutionTier<ImageResolutionTier>[];
}

export const GEMINI_IMAGE_PRICING: ImageModelPricing[] = [
  {
    modelId: 'imagen-4-fast-001',
    name: 'Imagen 4 Fast',
    billingUnit: 'per_image',
    resolutionTiers: [
      { resolution: '1K', label: 'up to 1K (1024px)', priceUSD: 0.02 },
    ],
  },
  {
    modelId: 'imagen-4-standard-001',
    name: 'Imagen 4 Standard',
    billingUnit: 'per_image',
    resolutionTiers: [
      { resolution: '1K', label: 'up to 1K (1024px)', priceUSD: 0.04 },
    ],
  },
  {
    modelId: 'imagen-4-ultra-001',
    name: 'Imagen 4 Ultra',
    billingUnit: 'per_image',
    resolutionTiers: [
      { resolution: '4K', label: '2K / 4K Native', priceUSD: 0.06 },
    ],
  },
  {
    modelId: 'gemini-3-flash-image-001',
    name: 'Gemini 3 Flash Image',
    billingUnit: 'per_image',
    resolutionTiers: [
      { resolution: '512px', label: '512px (0.25MP)', priceUSD: 0.045 },
      { resolution: '1K', label: '1K (1MP)', priceUSD: 0.067 },
      { resolution: '2K', label: '2K (4MP)', priceUSD: 0.101 },
      { resolution: '4K', label: '4K (16MP)', priceUSD: 0.151 },
    ],
  },
  {
    modelId: 'gemini-3-pro-image-001',
    name: 'Gemini 3 Pro Image',
    billingUnit: 'per_image',
    resolutionTiers: [
      { resolution: '1K', label: '1K / 2K', priceUSD: 0.134 },
      { resolution: '4K', label: '4K (16MP)', priceUSD: 0.240 },
    ],
  },
];

/** Default image price when model not found in the list */
export const DEFAULT_IMAGE_PRICE_PER_IMAGE_USD = 0.04;

// ── Resolution Detection ─────────────────────────────────────────────────────

/**
 * Determine the image resolution tier from pixel dimensions.
 * Uses the longest side to classify into tiers.
 */
export function getImageResolutionTier(width: number, height: number): ImageResolutionTier {
  const longestSide = Math.max(width, height);
  if (longestSide <= 512) return '512px';
  if (longestSide <= 1024) return '1K';
  if (longestSide <= 2048) return '2K';
  return '4K';
}

/**
 * Extract image dimensions from base64-encoded image data.
 * Supports PNG and JPEG formats by reading file headers.
 * Returns null if dimensions cannot be determined.
 */
export function getImageDimensionsFromBase64(base64Data: string, mimeType: string): { width: number; height: number } | null {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    if (mimeType === 'image/png' || (buffer[0] === 0x89 && buffer[1] === 0x50)) {
      // PNG: width at bytes 16-19, height at bytes 20-23 (big-endian uint32)
      if (buffer.length < 24) return null;
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg' || (buffer[0] === 0xFF && buffer[1] === 0xD8)) {
      // JPEG: find SOF0 marker (0xFF 0xC0) — height at offset +5, width at offset +7
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xFF) { offset++; continue; }
        const marker = buffer[offset + 1];
        // SOF markers: 0xC0-0xC3 (baseline, progressive, etc.)
        if (marker >= 0xC0 && marker <= 0xC3) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        // Skip to next marker (length is at offset+2, big-endian)
        const segLen = buffer.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
    if (mimeType === 'image/webp' || (buffer[0] === 0x52 && buffer[1] === 0x49)) {
      // WebP: VP8 chunk starts at byte 12
      if (buffer.length < 30) return null;
      const chunk = buffer.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') {
        // Lossy: width at 26-27, height at 28-29 (little-endian)
        const width = buffer.readUInt16LE(26) & 0x3FFF;
        const height = buffer.readUInt16LE(28) & 0x3FFF;
        return { width, height };
      }
      if (chunk === 'VP8L') {
        // Lossless: packed in 4 bytes starting at byte 21
        if (buffer.length < 25) return null;
        const bits = buffer.readUInt32LE(21);
        const width = (bits & 0x3FFF) + 1;
        const height = ((bits >> 14) & 0x3FFF) + 1;
        return { width, height };
      }
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

// ── Lookup Helpers ───────────────────────────────────────────────────────────

/**
 * Find video model by ID. Supports partial/prefix matching.
 */
export function findVideoModel(modelId: string): VideoModelPricing | undefined {
  const exact = GEMINI_VIDEO_PRICING.find(m => m.modelId === modelId);
  if (exact) return exact;

  const normalized = modelId.toLowerCase();
  for (const m of GEMINI_VIDEO_PRICING) {
    const prefix = m.modelId.replace(/-\d{3}$/, '');
    if (normalized.startsWith(prefix)) return m;
  }
  return undefined;
}

/**
 * Find image model by ID. Supports partial/prefix matching.
 */
export function findImageModel(modelId: string): ImageModelPricing | undefined {
  const exact = GEMINI_IMAGE_PRICING.find(m => m.modelId === modelId);
  if (exact) return exact;

  const normalized = modelId.toLowerCase();
  for (const m of GEMINI_IMAGE_PRICING) {
    const prefix = m.modelId.replace(/-\d{3}$/, '');
    if (normalized.startsWith(prefix)) return m;
  }

  // For gemini-2.x-flash-image models, map to gemini-3-flash-image pricing
  if (normalized.includes('flash') && normalized.includes('image')) {
    return GEMINI_IMAGE_PRICING.find(m => m.modelId === 'gemini-3-flash-image-001');
  }
  if (normalized.includes('pro') && normalized.includes('image')) {
    return GEMINI_IMAGE_PRICING.find(m => m.modelId === 'gemini-3-pro-image-001');
  }
  return undefined;
}

/**
 * Get the per-second video price for a model at a given resolution tier.
 * If resolution not specified, returns the first (default/lowest) tier.
 */
export function getVideoPricePerSecond(modelId: string, resolution?: VideoResolutionTier): number {
  const model = findVideoModel(modelId);
  if (!model) return DEFAULT_VIDEO_PRICE_PER_SECOND_USD;
  if (resolution) {
    const tier = model.resolutionTiers.find(t => t.resolution === resolution);
    if (tier) return tier.priceUSD;
  }
  return model.resolutionTiers[0].priceUSD;
}

/**
 * Get the per-image price for a model at a given resolution tier.
 * If resolution not specified, returns the first (default) tier.
 * If image dimensions are provided, auto-detects the tier.
 */
export function getImagePricePerImage(
  modelId: string,
  opts?: { resolution?: ImageResolutionTier; width?: number; height?: number }
): number {
  const model = findImageModel(modelId);
  if (!model) return DEFAULT_IMAGE_PRICE_PER_IMAGE_USD;

  // If dimensions provided, auto-detect resolution tier
  let resolution = opts?.resolution;
  if (!resolution && opts?.width && opts?.height) {
    resolution = getImageResolutionTier(opts.width, opts.height);
  }

  if (resolution) {
    // Find exact tier match, or fall back to nearest higher tier
    const tier = model.resolutionTiers.find(t => t.resolution === resolution);
    if (tier) return tier.priceUSD;
    // If the resolution tier doesn't exist for this model, use the last (highest) tier
    return model.resolutionTiers[model.resolutionTiers.length - 1].priceUSD;
  }
  // Default: first tier (lowest resolution)
  return model.resolutionTiers[0].priceUSD;
}

/**
 * Get the base cost in USD for generating one image with the given model.
 * @param modelId - The image model ID
 * @param opts - Optional resolution or dimensions for tier-based pricing
 */
export function getImageBaseCostUSD(
  modelId: string,
  opts?: { resolution?: ImageResolutionTier; width?: number; height?: number }
): number {
  return getImagePricePerImage(modelId, opts);
}

/**
 * Get the base cost in USD for generating video with the given model.
 * @param modelId - The video model ID
 * @param durationSeconds - Duration of the generated video in seconds
 * @param resolution - Optional resolution tier for tier-based pricing
 */
export function getVideoBaseCostUSD(modelId: string, durationSeconds?: number, resolution?: VideoResolutionTier): number {
  const pricePerSecond = getVideoPricePerSecond(modelId, resolution);
  const duration = durationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS;
  return pricePerSecond * duration;
}
