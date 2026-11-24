import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { fetchPublicHttpUrl, readResponseBuffer } from '../../utils/safeRemoteFetch.js';
import { db } from '../../models/db.js';
import { storageFilesTable } from '../../models/storageFiles/schema.js';
import { StorageService } from '../StorageService.js';

export type PublishingImageProbe = { width: number; height: number; bytes: number; format: string };

export function validatePublishingImage(probe: PublishingImageProbe, platform: string, postType: string): void {
  if (!['jpeg', 'png'].includes(probe.format)) throw new Error('Publishing images must be JPEG or PNG.');
  if (probe.bytes > (platform === 'instagram' ? 8 : 30) * 1024 * 1024) throw new Error(`${platform === 'instagram' ? 'Instagram' : 'Facebook'} image exceeds the file size limit.`);
  if (probe.width < 1 || probe.height < 1 || probe.width * probe.height > 40_000_000) throw new Error('Image dimensions are invalid or exceed 40 megapixels.');
  if (platform === 'instagram' && postType !== 'story' && (probe.width / probe.height < 0.8 || probe.width / probe.height > 1.91)) {
    throw new Error('Instagram feed images need an aspect ratio between 4:5 and 1.91:1. Crop the image before publishing.');
  }
}

/** Validate actual bytes before any provider call, with bounded downloads and redirect checks. */
export async function preflightPublishingImages(urls: string[], platform: string, postType: string, userId: number) {
  const normalized: string[] = [];
  const probes: PublishingImageProbe[] = [];
  for (const url of urls) {
    const { response } = await fetchPublicHttpUrl(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'image/jpeg,image/png' } });
    if (!response.ok) throw new Error(`Image could not be downloaded (HTTP ${response.status}).`);
    const bytes = await readResponseBuffer(response, (platform === 'instagram' ? 8 : 30) * 1024 * 1024);
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if ((metadata.pages || 1) > 1) throw new Error('Animated images cannot be published as feed photos.');
    const rotated = [5, 6, 7, 8].includes(metadata.orientation || 1);
    const probe = { width: (rotated ? metadata.height : metadata.width) || 0, height: (rotated ? metadata.width : metadata.height) || 0, bytes: bytes.length, format: metadata.format || '' };
    validatePublishingImage(probe, platform, postType);
    let finalUrl = url;
    // Meta's Instagram image containers require JPEG. Keep orientation and
    // composition, flatten transparency, and retain the normalized asset.
    if (platform === 'instagram' && (metadata.format !== 'jpeg' || metadata.space !== 'srgb' || (metadata.orientation || 1) !== 1)) {
      const jpeg = await sharp(bytes).rotate().flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 92 }).toBuffer();
      const output = await sharp(jpeg).metadata();
      validatePublishingImage({ width: output.width || 0, height: output.height || 0, bytes: jpeg.length, format: output.format || '' }, platform, postType);
      const digest = createHash('sha256').update(jpeg).digest('hex');
      const [existing] = await db.select().from(storageFilesTable).where(and(eq(storageFilesTable.userId, userId), eq(storageFilesTable.isDeleted, false), sql`${storageFilesTable.metadata}->>'publishingImageHash' = ${digest}`)).limit(1);
      const stored = existing || await StorageService.getInstance().upload(jpeg, { userId, category: 'image', originalName: `publish-${digest.slice(0, 20)}.jpg`, mimeType: 'image/jpeg', metadata: { publishingImageHash: digest } });
      finalUrl = stored.url || '';
      if (!finalUrl) throw new Error('The normalized image could not be stored.');
      if (finalUrl.startsWith('/')) finalUrl = `${(process.env.APP_URL || 'https://asksales.ai').replace(/\/$/, '')}${finalUrl}`;
    }
    normalized.push(finalUrl);
    probes.push(probe);
  }
  return { urls: normalized, probes };
}
