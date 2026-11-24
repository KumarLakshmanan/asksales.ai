import sharp from 'sharp';

/**
 * How an uploaded image is used by a video model.
 * - `reference`: the image is a subject/style reference; the prompt directs the scene.
 * - `start_frame`: the image is the exact opening frame (classic image-to-video).
 */
export type VideoImageRole = 'reference' | 'start_frame';

export interface VideoInputImage {
  base64Data: string;
  mimeType: string;
}

export interface PreparedVideoInputImage extends VideoInputImage {
  width: number;
  height: number;
  /** True when the source was enlarged or padded to meet provider minimums. */
  adjusted: boolean;
  original: { width: number; height: number };
}

/** Smallest edge accepted from the user. Below this nothing useful survives upscaling. */
export const MIN_SOURCE_IMAGE_EDGE = 16;
/** Providers reject small inputs (Veo, Seedance and Kling need roughly 300–720 px). */
export const MIN_PROVIDER_IMAGE_EDGE = 720;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export class VideoInputImageError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'VideoInputImageError';
  }
}

export function normalizeVideoImageRole(value: unknown): VideoImageRole {
  return value === 'start_frame' ? 'start_frame' : 'reference';
}

/** Frame size every provider accepts for the requested aspect ratio. */
export function frameSizeForAspectRatio(aspectRatio?: string, shortEdge = 720): { width: number; height: number } {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(aspectRatio || '').trim());
  const ratioWidth = match ? Number(match[1]) : 16;
  const ratioHeight = match ? Number(match[2]) : 9;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  if (!ratioWidth || !ratioHeight) return { width: even((shortEdge * 16) / 9), height: shortEdge };
  // Dimensions are rounded to even numbers for video encoders.
  return ratioWidth >= ratioHeight
    ? { width: even((shortEdge * ratioWidth) / ratioHeight), height: shortEdge }
    : { width: shortEdge, height: even((shortEdge * ratioHeight) / ratioWidth) };
}

async function backgroundFor(buffer: Buffer): Promise<{ r: number; g: number; b: number; alpha: number }> {
  // Sample the outer border so logos sit on their own background colour rather
  // than a contrasting band. Transparent borders fall back to a neutral light tone.
  const { data, info } = await sharp(buffer).ensureAlpha().resize(32, 32, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let r = 0; let g = 0; let b = 0; let weight = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (x !== 0 && y !== 0 && x !== info.width - 1 && y !== info.height - 1) continue;
      const offset = (y * info.width + x) * info.channels;
      const alpha = data[offset + 3] / 255;
      r += data[offset] * alpha; g += data[offset + 1] * alpha; b += data[offset + 2] * alpha; weight += alpha;
    }
  }
  if (weight < 1) return { r: 248, g: 250, b: 252, alpha: 1 };
  return { r: Math.round(r / weight), g: Math.round(g / weight), b: Math.round(b / weight), alpha: 1 };
}

/**
 * Validates an uploaded image and returns a copy every video provider accepts.
 * Small images such as a 146×50 logo are enlarged and padded onto a canvas of at
 * least {@link MIN_PROVIDER_IMAGE_EDGE} px instead of reaching the provider and
 * failing with a raw HTTP 400.
 */
export async function prepareVideoInputImage(
  image: VideoInputImage,
  options: { role: VideoImageRole; aspectRatio?: string },
): Promise<PreparedVideoInputImage> {
  const base64 = String(image.base64Data || '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) throw new VideoInputImageError('The reference image is empty. Upload the image again.');
  const source = Buffer.from(base64, 'base64');
  if (source.length === 0) throw new VideoInputImageError('The reference image is empty. Upload the image again.');
  if (source.length > MAX_SOURCE_BYTES) throw new VideoInputImageError('The reference image is larger than 20 MB. Upload a smaller image.');

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(source).metadata();
  } catch {
    throw new VideoInputImageError('The reference image could not be read. Upload a PNG, JPEG or WebP image.');
  }
  const rotated = (metadata.orientation ?? 1) >= 5;
  const width = (rotated ? metadata.height : metadata.width) ?? 0;
  const height = (rotated ? metadata.width : metadata.height) ?? 0;
  if (!width || !height) throw new VideoInputImageError('The reference image could not be read. Upload a PNG, JPEG or WebP image.');
  if (Math.min(width, height) < MIN_SOURCE_IMAGE_EDGE) {
    throw new VideoInputImageError(`The reference image is only ${width}×${height} px. Upload an image at least ${MIN_SOURCE_IMAGE_EDGE} px on each side (720 px or larger works best).`);
  }

  const upright = await sharp(source).rotate().png().toBuffer();
  const canvas = options.role === 'start_frame'
    ? frameSizeForAspectRatio(options.aspectRatio, Math.min(width, height) >= 1080 ? 1080 : MIN_PROVIDER_IMAGE_EDGE)
    : (() => {
      // Reference images keep their own shape but never fall below the minimum.
      const scale = Math.max(1, MIN_PROVIDER_IMAGE_EDGE / Math.min(width, height));
      const scaledLong = Math.max(width, height) * scale;
      return scaledLong > 2048
        // Very wide/tall images (banners, logos) are padded to a square canvas.
        ? { width: 1024, height: 1024 }
        : { width: Math.round((width * scale) / 2) * 2, height: Math.round((height * scale) / 2) * 2 };
    })();

  const alreadyFits = width === canvas.width && height === canvas.height;
  const small = Math.max(width, height) < MIN_PROVIDER_IMAGE_EDGE;
  if (alreadyFits && image.mimeType && /^image\/(png|jpe?g|webp)$/i.test(image.mimeType)) {
    return { base64Data: base64, mimeType: image.mimeType, width, height, adjusted: false, original: { width, height } };
  }

  // Tiny artwork (logos) is enlarged only to ~60% of the canvas so it stays crisp
  // and leaves room around it; full-size photos fill the frame with `contain`.
  const fitBox = small
    ? { width: Math.round(canvas.width * 0.6), height: Math.round(canvas.height * 0.6) }
    : canvas;
  const background = await backgroundFor(upright);
  const fitted = await sharp(upright)
    .resize({ width: fitBox.width, height: fitBox.height, fit: 'inside', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer({ resolveWithObject: true });
  const output = await sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background } })
    .composite([{
      input: fitted.data,
      left: Math.round((canvas.width - fitted.info.width) / 2),
      top: Math.round((canvas.height - fitted.info.height) / 2),
    }])
    .flatten({ background })
    .png()
    .toBuffer();
  return {
    base64Data: output.toString('base64'),
    mimeType: 'image/png',
    width: canvas.width,
    height: canvas.height,
    adjusted: true,
    original: { width, height },
  };
}

/**
 * Converts raw provider rejections (HTTP 400 "image too small", invalid argument …)
 * into a message a user can act on. Returns the original text when nothing matches.
 */
export function friendlyVideoProviderError(message: string | undefined): string | undefined {
  if (!message) return message;
  if (/(resolution|dimension|too small|minimum|at least \d+|width|height).*(image|frame)|(image|frame).*(resolution|dimension|too small|minimum|width|height)/i.test(message)) {
    return 'The reference image does not meet this video model’s size requirements. Upload an image at least 720 px on its shorter side, or choose another model.';
  }
  if (/aspect.?ratio/i.test(message) && /(image|frame)/i.test(message)) {
    return 'The reference image shape is not supported by this video model. Choose a 16:9 or 9:16 aspect ratio, or upload an image with that shape.';
  }
  if (/(400|invalid.?argument|bad request)/i.test(message) && /(image|frame|reference)/i.test(message)) {
    return 'The video model rejected the reference image. Try a larger PNG or JPEG image, or generate without an image.';
  }
  return message;
}
