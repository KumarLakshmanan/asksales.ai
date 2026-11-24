import type { Request, Response } from 'express';
import { recordEmailImageLoad } from '../services/EmailOpenTrackingService.js';
import { logger } from '../utils/logger.js';
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export async function emailOpenPixel(req: Request, res: Response) {
  // HEAD/preview probes do not count. Unknown, expired and valid tokens look identical.
  if (req.method === 'GET') {
    try { await recordEmailImageLoad(String(req.params.id || '')); }
    catch { logger.warn('[EmailTracking] Image-load receipt could not be recorded'); }
  }
  res.set({ 'Cache-Control': 'no-store, private, max-age=0', 'Content-Type': 'image/gif', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  return res.status(200).send(PIXEL);
}
