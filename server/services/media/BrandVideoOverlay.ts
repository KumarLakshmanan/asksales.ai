import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { StorageService } from '../StorageService.js';
import { resolveApprovedBrandLogoUrl } from '../content/BrandMediaComposer.js';
import { probeMedia } from './MediaTranscodingService.js';
import { logger } from '../../utils/logger.js';

const run = promisify(execFile);

export interface AppliedVideoBranding {
  logoApplied: true;
  logoUrl: string;
  position: 'bottom-right';
}

/**
 * Video models cannot reproduce a logo or a brand name reliably: they redraw the
 * mark (distorting it) and re-spell words ("Todle" became "Toddle"). The model is
 * therefore told not to draw any logo or brand wordmark, and the approved logo's
 * real pixels are composited onto the finished video here.
 */
export function buildVideoBrandPrompt(prompt: string, options: { logoOverlay: boolean; brandNames?: string[]; imageRole?: 'reference' | 'start_frame' }): string {
  const names = [...new Set((options.brandNames || []).map((name) => name.trim()).filter(Boolean))].slice(0, 4);
  const spelling = names.length
    ? ` If the request explicitly asks for on-screen text, spell brand and product names exactly as written here, letter for letter: ${names.map((name) => `"${name}"`).join(', ')}. Never add, drop or double letters in these names.`
    : '';
  const logoRule = options.logoOverlay
    ? ' Do not draw, recreate or animate any logo, emblem, wordmark or the brand name as text, signage or packaging: the approved logo is added to the finished video afterwards. Keep the bottom-right corner free of important detail.'
    : ' Do not invent a logo or wordmark.';
  const roleRule = options.imageRole ? `${videoImageRoleInstruction(options.imageRole)}\n` : '';
  const instructions = `${roleRule}Brand rules:${logoRule}${spelling}`;
  const limit = 4000;
  const available = Math.max(0, limit - instructions.length - 2);
  return `${prompt.slice(0, available)}\n\n${instructions}`;
}

/**
 * The shared media brand context tells image models that the logo is attached
 * as a reference. For video that is no longer true, so the line is replaced.
 */
export function adaptBrandContextForVideo(prompt: string, logoOverlay: boolean): string {
  const handling = logoOverlay
    ? '- Logo handling: the approved logo is composited onto the finished video after generation. Do not draw, recreate or animate any logo or wordmark.'
    : '- Logo handling: no logo is supplied. Do not invent or synthesize a logo or wordmark.';
  return prompt.replace(/^- Logo handling:[^\n]*$/m, handling);
}

/**
 * Tells the model how to use an uploaded image so the prompt still drives the
 * video instead of the model adding subtle motion to the still.
 */
export function videoImageRoleInstruction(role: 'reference' | 'start_frame'): string {
  return role === 'start_frame'
    ? 'Image use: the supplied image is only the opening frame. After it, show the action, camera movement and scene changes the request describes; do not just add subtle motion to the still image.'
    : 'Image use: the supplied image is a visual reference for the subject, product or style. Build the scene the request describes around it; do not simply animate the reference image.';
}

/** Brand names used for exact-spelling instructions. */
export function brandNamesFromContext(context: string | undefined): string[] {
  if (!context) return [];
  const names: string[] = [];
  for (const label of ['Business', 'Brand']) {
    const match = new RegExp(`^- ${label}: (.+)$`, 'm').exec(context);
    const value = match?.[1]?.trim();
    if (value && !/^(not provided|none|n\/a|unknown)$/i.test(value) && value.length <= 80) names.push(value.replace(/^"|"$/g, ''));
  }
  return names;
}

function ffmpegBinary() {
  return process.env.FFMPEG_PATH || ffmpegPath || 'ffmpeg';
}

async function logoCard(logo: Buffer, videoWidth: number, videoHeight: number): Promise<Buffer> {
  const shortEdge = Math.min(videoWidth, videoHeight);
  const maxWidth = Math.max(96, Math.round(videoWidth * (videoWidth >= videoHeight ? 0.18 : 0.3)));
  const maxHeight = Math.max(28, Math.round(shortEdge * 0.1));
  // Logos are upscaled when needed (a 146×50 source still yields a legible mark).
  const resized = await sharp(logo)
    .rotate()
    .resize({ width: maxWidth, height: maxHeight, fit: 'inside', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer({ resolveWithObject: true });
  const paddingX = Math.max(10, Math.round(resized.info.height * 0.3));
  const paddingY = Math.max(6, Math.round(resized.info.height * 0.22));
  const width = resized.info.width + paddingX * 2;
  const height = resized.info.height + paddingY * 2;
  const radius = Math.max(6, Math.round(height * 0.18));
  const card = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" rx="${radius}" fill="white" fill-opacity="0.92"/></svg>`);
  return sharp(card).composite([{ input: resized.data, left: paddingX, top: paddingY }]).png().toBuffer();
}

/** Composites the approved logo in the bottom-right corner of the video. */
export async function overlayLogoOnVideo(video: Buffer, logo: Buffer): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'brand-video-'));
  const inputPath = join(directory, 'input.mp4');
  const logoPath = join(directory, 'logo.png');
  const outputPath = join(directory, 'branded.mp4');
  try {
    await writeFile(inputPath, video);
    const probe = await probeMedia(inputPath);
    await writeFile(logoPath, await logoCard(logo, probe.width, probe.height));
    const margin = Math.max(16, Math.round(Math.min(probe.width, probe.height) * 0.035));
    await run(ffmpegBinary(), [
      '-nostdin', '-v', 'error', '-y',
      '-i', inputPath, '-loop', '1', '-i', logoPath,
      '-filter_complex', `[0:v][1:v]overlay=W-w-${margin}:H-h-${margin}:shortest=1:format=auto[v]`,
      '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'copy', '-movflags', '+faststart',
      outputPath,
    ], { timeout: 3 * 60_000, maxBuffer: 256 * 1024 });
    const output = await readFile(outputPath);
    if (output.length === 0) throw new Error('Logo overlay produced an empty video');
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Applies the approved Brand Toolkit logo to a generated video. Branding is
 * best-effort: if the logo cannot be loaded or composited, the unbranded video is
 * kept and the failure is logged, so a paid generation is never discarded.
 */
export async function applyBrandLogoToVideo(
  video: Buffer,
  userId: number | undefined,
  requestedLogoUrl?: string | null,
): Promise<{ buffer: Buffer; branding?: AppliedVideoBranding }> {
  const logoUrl = await resolveApprovedBrandLogoUrl(userId, requestedLogoUrl).catch(() => undefined);
  if (!logoUrl || !userId) return { buffer: video };
  try {
    const stored = await StorageService.getInstance().downloadByUrl(logoUrl, userId);
    if (!stored) {
      logger.warn({ logoUrl, userId }, '[BrandVideoOverlay] Approved logo could not be loaded; keeping the unbranded video');
      return { buffer: video };
    }
    const buffer = await overlayLogoOnVideo(video, stored.buffer);
    return { buffer, branding: { logoApplied: true, logoUrl, position: 'bottom-right' } };
  } catch (error) {
    logger.error({ err: error, logoUrl, userId }, '[BrandVideoOverlay] Logo overlay failed; keeping the unbranded video');
    return { buffer: video };
  }
}
