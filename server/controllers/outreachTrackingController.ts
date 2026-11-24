import type { Response } from 'express';
import { ZodError } from 'zod';
import type { AuthenticatedRequest } from '../types/express.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import {
  OutreachTrackingError, exportOutreachRecipients, getDailyActivity, getOutreachBatchSummary, getTemplatePerformance,
  getUpcomingSchedule, listOutreachBatches, listOutreachFailures, listOutreachRecipients, renameOutreachBatch,
  type RecipientExportResult,
} from '../services/outreach/OutreachTrackingService.js';
import { logger } from '../utils/logger.js';

type Read = (userId: number, req: AuthenticatedRequest) => Promise<unknown>;

/** Shared auth, cache and error handling for the tracking endpoints. */
const read = (load: Read) => async (req: AuthenticatedRequest, res: Response) => {
  const userId = businessOwnerUserId(req);
  if (!req.user?.id || !userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(await load(userId, req));
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ error: 'Check the filters and try again.', issues: error.issues });
    if (error instanceof OutreachTrackingError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, '[OutreachTracking] Read failed');
    return res.status(503).json({ error: 'Message tracking could not be loaded. Try again.' });
  }
};

export const outreachBatchList = read((userId, req) => listOutreachBatches(userId, req.query));
export const outreachBatchRename = read((userId, req) => renameOutreachBatch(userId, req.params.id, req.body));
export const outreachBatchSummary = read((userId, req) => getOutreachBatchSummary(userId, req.params.id));
export const outreachBatchRecipients = read((userId, req) => listOutreachRecipients(userId, req.params.id, req.query));
export const outreachBatchFailures = read((userId, req) => listOutreachFailures(userId, req.params.id, req.query));
export const outreachBatchDaily = read((userId, req) => getDailyActivity(userId, req.query, req.params.id));
export const outreachDaily = read((userId, req) => getDailyActivity(userId, req.query));
export const outreachBatchUpcoming = read((userId, req) => getUpcomingSchedule(userId, req.query, req.params.id));
export const outreachUpcoming = read((userId, req) => getUpcomingSchedule(userId, req.query));
export const outreachTemplatePerformance = read((userId, req) => getTemplatePerformance(userId, req.query));

/** Streams the recipient list as a CSV download. Headers are only sent once the outreach is known to exist. */
export async function outreachBatchExport(req: AuthenticatedRequest, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!req.user?.id || !userId) return res.status(401).json({ error: 'Authentication required.' });
  // Recipient lists hold contact details, so every download leaves an audit line, finished or not.
  let exported: RecipientExportResult | null = null, completed = false;
  const audit = () => {
    if (exported) logger.info({ audit: 'outreach_recipient_export', actorUserId: req.user?.id, ownerUserId: userId,
      businessProfileId: exported.businessProfileId, batchId: exported.batchId, status: exported.status, kind: exported.kind,
      rows: exported.rows, completed }, '[OutreachTracking] Recipient list downloaded');
  };
  try {
    exported = await exportOutreachRecipients(userId, req.params.id, req.query, async chunk => {
      if (res.destroyed) throw new Error('Export connection closed');
      await new Promise<void>((resolve, reject) => {
        const closed = () => reject(new Error('Export connection closed'));
        res.once('close', closed);
        res.write(chunk, error => { res.off('close', closed); if (error) reject(error); else resolve(); });
      });
    }, batch => {
      const name = batch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'outreach';
      res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="${name}-recipients-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.setHeader('Cache-Control', 'private, no-store');
    }, progress => { exported = progress; });
    completed = true;
    audit();
    return res.end();
  } catch (error) {
    audit();
    if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
    if (error instanceof ZodError) return res.status(400).json({ error: 'Check the download options and try again.', issues: error.issues });
    if (error instanceof OutreachTrackingError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, '[OutreachTracking] Export failed');
    return res.status(503).json({ error: 'The download could not be prepared. Try again.' });
  }
}
