import type { Request, Response } from 'express';
import { fetchPublicHttpUrl, readResponseBuffer } from '../utils/safeRemoteFetch.js';

const limits: Record<string, { bytes: number; mimes: string[] }> = {
  IMAGE: { bytes: 5 * 1024 * 1024, mimes: ['image/jpeg', 'image/png'] },
  VIDEO: { bytes: 16 * 1024 * 1024, mimes: ['video/mp4'] },
  DOCUMENT: { bytes: 100 * 1024 * 1024, mimes: ['application/pdf'] },
};

export function templateMediaSignatureMatches(bytes: Buffer, mime: string) {
  if (bytes.length < 8) return false;
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'video/mp4') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mime === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  return false;
}

/** Read-only provider preflight: no template save, Meta upload or submission. */
export async function preflightTemplateMedia(req: Request, res: Response) {
  if (!(req as Request & { user?: { id?: number } }).user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const { url, headerType } = req.body || {};
  const rule = typeof headerType === 'string' ? limits[headerType] : undefined;
  if (!rule || typeof url !== 'string' || url.length > 8192) return res.status(400).json({ error: 'Choose an image, video or document and supply its public HTTPS URL.' });
  try {
    if (new URL(url).protocol !== 'https:') throw new Error('A public HTTPS URL is required.');
    // Shared fetch validates DNS/private IPs and every redirect, with no credentials.
    const { response, finalUrl } = await fetchPublicHttpUrl(url, { signal: AbortSignal.timeout(20_000) }, 3);
    if (new URL(finalUrl).protocol !== 'https:') { await response.body?.cancel(); throw new Error('The media URL must not redirect to insecure HTTP.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Media could not be read (HTTP ${response.status}). Use a direct file link without a login.`); }
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
    if (!rule.mimes.includes(mimeType)) { await response.body?.cancel(); throw new Error(`Expected ${rule.mimes.join(' or ')}, but the link returned ${mimeType || 'no content type'}.`); }
    const buffer = await readResponseBuffer(response, rule.bytes);
    if (!templateMediaSignatureMatches(buffer, mimeType)) throw new Error('The file contents do not match the declared media type.');
    return res.json({ success: true, mimeType, sizeBytes: buffer.length, checkedAt: new Date().toISOString(), note: 'Reachable now. Meta approval and future availability are not guaranteed.' });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Media could not be checked. Upload a file instead.' });
  }
}
