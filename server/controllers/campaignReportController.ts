import type { Response } from 'express';
import { ZodError } from 'zod';
import type { AuthenticatedRequest } from '../types/express.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { CampaignWorkspaceError } from '../services/CampaignWorkspaceService.js';
import { CampaignReportError, getCampaignReport, getCampaignReportOptions } from '../services/outreach/CampaignReportingService.js';
import { logger } from '../utils/logger.js';

export async function campaignReport(req: AuthenticatedRequest,res: Response) {
  const userId = businessOwnerUserId(req);
  if (!req.user?.id || !userId) return res.status(401).json({error:'Authentication required.'});
  try {
    res.setHeader('Cache-Control','private, no-store');
    return res.json(req.path.endsWith('/options') ? await getCampaignReportOptions(userId) : await getCampaignReport(userId,req.query));
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({error:'Check the report filters.',issues:error.issues});
    if (error instanceof CampaignReportError || error instanceof CampaignWorkspaceError) return res.status(error.status).json({error:error.message});
    logger.error({err:error},'[CampaignReport] Snapshot unavailable');
    return res.status(503).json({error:'The report could not be loaded. Try again.'});
  }
}
