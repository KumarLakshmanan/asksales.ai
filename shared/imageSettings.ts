export interface ImageCapabilities {
  aspectRatios?: string[];
  resolutions?: string[];
}

/** Ratios documented for Gemini generateContent ImageConfig (@google/genai). */
export const GOOGLE_IMAGE_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];

/** Every ratio the creator UI knows how to label, in display order. */
export const KNOWN_IMAGE_ASPECT_RATIOS = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '21:9'];

/** Resolutions ordered from smallest to largest. */
export const KNOWN_IMAGE_RESOLUTIONS = ['512', '1K', '1.5K', '2K', '4K'];

export const AUTO_IMAGE_SETTING = 'auto';

const RATIO_PATTERN = /(?<![\d.:])(\d{1,2})\s*:\s*(\d{1,2})(?![\d:])/g;

function ratioValue(ratio: string): number | undefined {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(ratio.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : undefined;
}

/**
 * Finds an aspect ratio the user wrote in the prompt ("4:5 portrait").
 * Only well-known ratios count, so times such as "10:30" are ignored.
 */
export function detectPromptAspectRatio(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  for (const match of prompt.matchAll(RATIO_PATTERN)) {
    const ratio = `${Number(match[1])}:${Number(match[2])}`;
    if (KNOWN_IMAGE_ASPECT_RATIOS.includes(ratio)) return ratio;
  }
  return undefined;
}

/** Closest supported ratio by shape (log distance, so 4:5 → 3:4 rather than 1:1). */
export function nearestAspectRatio(requested: string, allowed: string[] | undefined): string {
  if (!allowed?.length || allowed.includes(requested)) return requested;
  const target = ratioValue(requested);
  if (target === undefined) return allowed.includes('1:1') ? '1:1' : allowed[0];
  let best = allowed[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const value = ratioValue(candidate);
    if (value === undefined) continue;
    const distance = Math.abs(Math.log(value / target));
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

/** Closest supported resolution; ties go to the larger one, never above what the model offers. */
export function nearestResolution(requested: string, allowed: string[] | undefined): string | undefined {
  if (!allowed?.length) return undefined;
  if (allowed.includes(requested)) return requested;
  const rank = (value: string) => KNOWN_IMAGE_RESOLUTIONS.indexOf(value);
  const target = rank(requested);
  const ranked = allowed.filter((value) => rank(value) >= 0);
  if (target < 0 || ranked.length === 0) return allowed.includes('1K') ? '1K' : allowed[0];
  return ranked.reduce((best, candidate) => {
    const diff = Math.abs(rank(candidate) - target);
    const bestDiff = Math.abs(rank(best) - target);
    return diff < bestDiff || (diff === bestDiff && rank(candidate) > rank(best)) ? candidate : best;
  });
}

export interface PreparedImageSettings {
  /** Omitted when nothing was requested, so the provider keeps its own default (e.g. the source image's shape). */
  aspectRatio?: string;
  /** Omitted when the model does not accept a resolution parameter. */
  imageSize?: string;
  /** Plain-language notes when a requested value was replaced. */
  adjustments: string[];
}

/**
 * Turns the requested settings into values the selected model accepts.
 * "auto" (or nothing) takes the ratio written in the prompt; with neither,
 * no ratio is sent and the provider decides.
 */
export function prepareImageSettings(
  requested: { aspectRatio?: unknown; imageSize?: unknown; prompt?: string },
  capabilities: ImageCapabilities,
): PreparedImageSettings {
  const adjustments: string[] = [];
  const rawRatio = typeof requested.aspectRatio === 'string' ? requested.aspectRatio.trim() : '';
  const wanted = rawRatio && rawRatio !== AUTO_IMAGE_SETTING
    ? rawRatio
    : detectPromptAspectRatio(requested.prompt);
  const aspectRatio = wanted ? nearestAspectRatio(wanted, capabilities.aspectRatios) : undefined;
  if (wanted && aspectRatio !== wanted) adjustments.push(`Aspect ratio ${wanted} is not supported by this model; using ${aspectRatio}.`);

  const rawSize = typeof requested.imageSize === 'string' ? requested.imageSize.trim() : '';
  let imageSize: string | undefined;
  if (rawSize && rawSize !== AUTO_IMAGE_SETTING) {
    imageSize = nearestResolution(rawSize, capabilities.resolutions);
    if (imageSize && imageSize !== rawSize) adjustments.push(`${rawSize} is not supported by this model; using ${imageSize}.`);
    if (!imageSize && capabilities.resolutions !== undefined) adjustments.push(`This model does not accept a resolution setting; ${rawSize} was ignored.`);
  }
  return { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}), adjustments };
}
