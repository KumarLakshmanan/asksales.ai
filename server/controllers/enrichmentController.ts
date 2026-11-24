import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import {
  getEnrichmentRunsByUser,
  getEnrichmentRunsByLead,
  getEnrichmentRunWithSteps,
} from '../models/enrichmentRuns/functions.js';
import { enrichByHandle, type EnrichmentPlatform } from '../services/enrichment/index.js';
import { logger } from '../utils/logger.js';
import { cleanEnrichmentRun } from '../../shared/enrichmentContactValidation.js';
import { EnrichmentBillingError } from '../services/enrichment/billing.js';

function publicRun<T extends { executionResult?: unknown; removalIntents?: unknown }>(run: T) {
  const { executionResult: _internal, removalIntents: _removalIntents, ...visible } = run;
  return cleanEnrichmentRun(visible);
}

/**
 * GET /api/enrichments
 * List all enrichment runs for the authenticated user
 */
export async function listEnrichmentRuns(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const values = [req.query.limit, req.query.offset];
    if (values.some(value => value !== undefined
      && (typeof value !== 'string' || !Number.isSafeInteger(Number(value))))) {
      return res.status(400).json({ error: 'limit and offset must be finite integers' });
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const runs = await getEnrichmentRunsByUser(userId, limit, offset);
    return res.json({ success: true, data: runs.map(publicRun) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, userId }, '[listEnrichmentRuns] Failed');
    return res.status(500).json({ error: 'Failed to fetch enrichment runs' });
  }
}

/**
 * GET /api/enrichments/lead/:leadId
 * List enrichment runs for a specific lead
 */
export async function getEnrichmentRunsForLead(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const leadId = Number(req.params.leadId);
  if (!leadId) return res.status(400).json({ error: 'Invalid lead ID' });

  try {
    const runs = await getEnrichmentRunsByLead(userId, leadId);
    return res.json({ success: true, data: runs.map(publicRun) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, userId, leadId }, '[getEnrichmentRunsForLead] Failed');
    return res.status(500).json({ error: 'Failed to fetch enrichment runs' });
  }
}

/**
 * GET /api/enrichments/:id
 * Get a single enrichment run with all its steps
 */
export async function getEnrichmentRunDetail(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid enrichment run ID' });

  try {
    const run = await getEnrichmentRunWithSteps(id);
    if (!run) return res.status(404).json({ error: 'Enrichment run not found' });
    if (run.userId !== userId) return res.status(404).json({ error: 'Enrichment run not found' });

    return res.json({ success: true, data: publicRun(run) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, userId, id }, '[getEnrichmentRunDetail] Failed');
    return res.status(500).json({ error: 'Failed to fetch enrichment run details' });
  }
}

const VALID_PLATFORMS: EnrichmentPlatform[] = ['instagram', 'facebook', 'twitter', 'linkedin', 'website'];

/**
 * POST /api/enrichments/by-handle
 * Start enrichment from a platform handle/URL without requiring a lead.
 * Body: { platform: EnrichmentPlatform, identifier: string }
 */
export async function startEnrichmentByHandle(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { platform, identifier } = req.body;

  if (!platform || !identifier) {
    return res.status(400).json({ error: 'platform and identifier are required' });
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` });
  }
  if (typeof identifier !== 'string' || identifier.trim().length < 2) {
    return res.status(400).json({ error: 'identifier must be at least 2 characters' });
  }

  try {
    const result = await enrichByHandle(userId, platform, identifier.trim(), { requestKey: req.get('Idempotency-Key') });
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof EnrichmentBillingError) return res.status(error.status).json({ error: error.message, code: error.code });
    logger.error({ err: error, userId, platform }, '[startEnrichmentByHandle] Failed');
    return res.status(500).json({ error: 'Failed to start enrichment' });
  }
}
