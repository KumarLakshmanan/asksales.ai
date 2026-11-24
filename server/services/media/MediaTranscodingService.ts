import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 15 * 60;
export const MAX_PIXELS = 4096 * 4096;

export type MediaProbe = { durationSeconds: number; width: number; height: number; codec: string; container: string };
/** Only pass probes returned by the server's normalized-media storage path. */
export function withVideoProbeMetadata(videoUrl: string | undefined, mediaProbe: MediaProbe | undefined, existing: Record<string, unknown> = {}): Record<string, unknown> {
  if (!videoUrl || !mediaProbe) return existing;
  return { ...existing, mediaProbe, mediaProbeUrl: videoUrl, mediaProbes: { ...((existing.mediaProbes || {}) as Record<string, unknown>), [videoUrl]: mediaProbe } };
}
export type MediaProfile = 'instagram' | 'facebook' | 'youtube' | 'whatsapp';
const PROFILES: Record<MediaProfile, string[]> = {
  instagram: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', '-r', '30'],
  facebook: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k'],
  youtube: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k'],
  whatsapp: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '96k'],
};

function toolPath(name: 'ffmpeg' | 'ffprobe') {
  if (name === 'ffmpeg') return process.env.FFMPEG_PATH || ffmpegPath || 'ffmpeg';
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function assertProbe(probe: MediaProbe) {
  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0 || probe.durationSeconds > MAX_DURATION_SECONDS) throw new Error('Media duration is outside the permitted range');
  if (!Number.isInteger(probe.width) || !Number.isInteger(probe.height) || probe.width < 1 || probe.height < 1 || probe.width * probe.height > MAX_PIXELS) throw new Error('Media dimensions are outside the permitted range');
  if (!probe.codec) throw new Error('Media video codec could not be identified');
}

/** Uses argv execution only: URLs and file names are never evaluated by a shell. */
export async function probeMedia(inputPath: string): Promise<MediaProbe> {
  const { stdout } = await run(toolPath('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_name,width,height', '-of', 'json', inputPath], { timeout: 20_000, maxBuffer: 128 * 1024 });
  const parsed = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_name?: string; width?: number; height?: number }> };
  const video = parsed.streams?.find(stream => stream.width && stream.height);
  const probe = { durationSeconds: Number(parsed.format?.duration), width: Number(video?.width), height: Number(video?.height), codec: String(video?.codec_name || ''), container: String(parsed.format?.format_name || '') };
  assertProbe(probe);
  return probe;
}

export async function transcodeMedia(input: Buffer, profile: MediaProfile): Promise<{ output: Buffer; probe: MediaProbe }> {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > MAX_MEDIA_BYTES) throw new Error('Media input exceeds the permitted size');
  const directory = await mkdtemp(join(tmpdir(), 'salesmarketing-media-'));
  const source = join(directory, 'input');
  const destination = join(directory, 'output.mp4');
  try {
    await writeFile(source, input, { mode: 0o600 });
    await probeMedia(source);
    await run(toolPath('ffmpeg'), ['-nostdin', '-v', 'error', '-y', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(min(1920\\,iw)/2)*2:trunc(min(1920\\,ih)/2)*2:force_original_aspect_ratio=decrease', ...PROFILES[profile], destination], { timeout: 5 * 60_000, maxBuffer: 256 * 1024 });
    const outputStat = await stat(destination);
    if (outputStat.size <= 0 || outputStat.size > MAX_MEDIA_BYTES) throw new Error('Transcoded media exceeds the permitted size');
    // The only trusted metadata is metadata read from the exact bytes that
    // will be delivered to a provider, not from the source supplied by a
    // browser. This also catches an encoder unexpectedly changing geometry.
    const outputProbe = await probeMedia(destination);
    const output = await import('node:fs/promises').then(fs => fs.readFile(destination));
    return { output, probe: outputProbe };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function validateMediaForPlatform(probe: MediaProbe, platform: MediaProfile): string[] {
  const errors: string[] = [];
  try { assertProbe(probe); } catch (error) { errors.push(error instanceof Error ? error.message : 'Invalid media'); }
  if (platform === 'instagram' && probe.width / probe.height > 1.91) errors.push('Instagram videos cannot be wider than 1.91:1.');
  if (platform === 'whatsapp' && probe.durationSeconds > 90) errors.push('WhatsApp video is limited to 90 seconds by this publishing profile.');
  return errors;
}
