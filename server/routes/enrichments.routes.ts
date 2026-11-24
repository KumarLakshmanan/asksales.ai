/**
 * Enrichment activity routes.
 *
 * This router is the authoritative API surface for enrichment history and
 * handle-based enrichment. Lead-linked enrichment lives under /api/leads.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { validateBody, validateParams } from '../middleware/validation.js';
import {
  getEnrichmentRunDetail,
  getEnrichmentRunsForLead,
  listEnrichmentRuns,
  startEnrichmentByHandle,
} from '../controllers/enrichmentController.js';

const router = Router();

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() }).strict();
const leadIdParamsSchema = z.object({ leadId: z.coerce.number().int().positive() }).strict();
const handleEnrichmentSchema = z.object({
  platform: z.enum(['instagram', 'facebook', 'twitter', 'linkedin', 'website']),
  identifier: z.string().trim().min(2).max(2048),
}).strict();

router.use(authenticateToken, requireModuleAccess('lead_generation'));
router.get('/', listEnrichmentRuns);
router.get('/lead/:leadId', validateParams(leadIdParamsSchema), getEnrichmentRunsForLead);
// The start service atomically reserves its priced fee; paid receipt replays
// must remain readable even when the first request exhausted the wallet.
router.post('/by-handle', validateBody(handleEnrichmentSchema), startEnrichmentByHandle);
router.get('/:id', validateParams(idParamsSchema), getEnrichmentRunDetail);

export default router;
