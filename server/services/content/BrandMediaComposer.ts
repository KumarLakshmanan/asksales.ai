import sharp from 'sharp';
import { StorageService } from '../StorageService.js';
import { logger } from '../../utils/logger.js';
import { BrandToolkitModel } from '../../models/brandToolkits/functions.js';

export interface ApprovedBrandLogoReference {
  logoUrl: string;
  base64Data: string;
  mimeType: 'image/png';
}

export function primaryBrandLogoUrl(toolkit: {
  logoUrl?: string | null;
  logoUrls?: Array<string | null | undefined> | null;
}): string | undefined {
  const primary = toolkit.logoUrl?.trim();
  if (primary) return primary;
  return toolkit.logoUrls?.find((url): url is string => Boolean(url?.trim()))?.trim();
}

export async function resolveApprovedBrandLogoUrl(
  userId: number | undefined,
  requestedLogoUrl?: string | null,
): Promise<string | undefined> {
  if (!userId) return undefined;
  if (requestedLogoUrl === null) return undefined;
  if (requestedLogoUrl?.trim()) return requestedLogoUrl.trim();
  const toolkit = await BrandToolkitModel.findDefault(userId);
  if (!toolkit || toolkit.isActive === false || toolkit.isApproved !== true || toolkit.logoVisibility === false) return undefined;
  return primaryBrandLogoUrl(toolkit);
}

/**
 * Loads the tenant-owned approved logo and normalizes it to a compact PNG that
 * can be sent to the media provider as a real visual reference. A URL in prompt
 * text is not enough: the provider must receive the image bytes to analyze it.
 */
export async function loadApprovedBrandLogoReference(
  userId: number | undefined,
  requestedLogoUrl?: string | null,
): Promise<ApprovedBrandLogoReference | undefined> {
  const logoUrl = await resolveApprovedBrandLogoUrl(userId, requestedLogoUrl);
  if (!logoUrl || !userId) return undefined;
  const stored = await StorageService.getInstance().downloadByUrl(logoUrl, userId);
  if (!stored) {
    logger.warn({ logoUrl, userId }, '[BrandMediaComposer] Approved logo could not be loaded as a model reference');
    return undefined;
  }
  const sample = await sharp(stored.buffer)
    .rotate()
    .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let weightedLuminance = 0;
  let visibleWeight = 0;
  for (let offset = 0; offset < sample.data.length; offset += sample.info.channels) {
    const alpha = sample.info.channels >= 4 ? sample.data[offset + 3] / 255 : 1;
    const luminance = (0.2126 * sample.data[offset])
      + (0.7152 * sample.data[offset + 1])
      + (0.0722 * sample.data[offset + 2]);
    weightedLuminance += luminance * alpha;
    visibleWeight += alpha;
  }
  const averageLuminance = visibleWeight > 0 ? weightedLuminance / visibleWeight : 0;
  const referenceBackground = averageLuminance < 145
    ? { r: 248, g: 250, b: 252, alpha: 1 }
    : { r: 15, g: 23, b: 42, alpha: 1 };

  // Flatten transparency only in the model-input copy so dark or light logo
  // pixels remain visible to the provider. The generated artifact is never
  // composited or overlaid after generation.
  const normalized = await sharp(stored.buffer)
    .rotate()
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: referenceBackground })
    .png()
    .toBuffer();
  return {
    logoUrl,
    base64Data: normalized.toString('base64'),
    mimeType: 'image/png',
  };
}

export function buildBrandReferencePrompt(prompt: string, mediaType: 'image' | 'video'): string {
  const instruction = mediaType === 'image'
    ? 'The final attached input image is the approved brand logo asset.'
    : 'The attached visual reference is the approved brand logo asset.';
  const brandReferenceInstructions = `${instruction} Analyze the supplied logo before generating. Use its real colors, geometry, typography, and visual character together with the approved business profile and Brand Toolkit to guide the generated ${mediaType}. When logo visibility is enabled, integrate the approved logo naturally and legibly into the scene or composition, preserving its identity and proportions. Preserve the exact spelling and wording in the supplied mark; do not prepend or append initials, descriptors, taglines, or other text unless the original request explicitly asks for them. Do not invent, substitute, recolor, distort, crop, or add a competing logo or wordmark. The returned ${mediaType} is the final artifact; no logo overlay or post-generation compositor will be applied.`;
  const imagePriority = mediaType === 'image'
    ? ' The written request above sets the colors, background and art style; the logo guides brand accents only and must not replace them.'
    : '';
  const separator = '\n\n';
  const providerPromptLimit = 4_000;
  const availablePromptLength = Math.max(
    0,
    providerPromptLimit - separator.length - brandReferenceInstructions.length - imagePriority.length,
  );

  return `${prompt.slice(0, availablePromptLength)}${separator}${brandReferenceInstructions}${imagePriority}`;
}
