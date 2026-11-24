/**
 * Leads Routes Module
 * Handles lead management, scoring, enrichment, and bulk operations
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { requireCredits } from '../middleware/creditCheck.js';
import { validateBody, validateParams } from '../middleware/validation.js';
import { z } from 'zod';
import {
  createLeadSchema,
  updateLeadSchema,
  bulkDeleteSchema,
  bulkUpdateSchema,
  verifyLeadsSchema,
  enrichLeadsSchema,
  idParamSchema,
} from '../middleware/schemas.js';
import {
  getLeads,
  getLead,
  createLead,
  updateLead,
  deleteLead,
  getLeadsByThread,
  getLeadsByExecution,
  exportLeads,
  verifyLeads,
  enrichLeads,
  scoreLeadById,
  enrichLeadById,
  validateEmailById,
  bulkDeleteLeads,
  bulkUpdateLeads,
  getLeadStats,
  getLeadConversations,
  deepEnrichLeadById,
} from '../controllers/leadController.js';

const router = Router();

// All routes require authentication
router.use(authenticateToken, requireModuleAccess('lead_generation'));

// CRUD operations
router.get('/', getLeads);
router.get('/stats', getLeadStats);
router.get('/export', exportLeads);
router.post('/export', exportLeads);
router.get('/thread/:threadId', getLeadsByThread);
router.get('/execution/:executionId', getLeadsByExecution);
router.get('/:id/conversations', validateParams(idParamSchema), getLeadConversations);
router.get('/:id', validateParams(idParamSchema), getLead);
router.post('/', validateBody(createLeadSchema), createLead);
router.put('/:id', validateParams(idParamSchema), validateBody(updateLeadSchema), updateLead);
router.patch('/:id', validateParams(idParamSchema), validateBody(updateLeadSchema), updateLead);
router.delete('/:id', validateParams(idParamSchema), deleteLead);

// Bulk operations
router.post('/bulk-delete', validateBody(bulkDeleteSchema), bulkDeleteLeads);
router.post('/bulk-update', validateBody(bulkUpdateSchema), bulkUpdateLeads);
router.post('/verify', validateBody(verifyLeadsSchema), verifyLeads);
router.post('/enrich', requireCredits, validateBody(enrichLeadsSchema), enrichLeads);

// Individual lead operations
router.post('/:id/score', validateParams(idParamSchema), requireCredits, scoreLeadById);
router.post('/:id/enrich', validateParams(idParamSchema), requireCredits, enrichLeadById);
router.post(
  '/:id/deep-enrich',
  validateParams(idParamSchema),
  validateBody(z.object({
    async: z.boolean().optional(),
    threadId: z.number().int().positive().optional(),
  }).strict()),
  // The deep start atomically reserves its configured fee; replays may have balance0.
  deepEnrichLeadById,
);
router.post('/:id/validate-email', validateParams(idParamSchema), requireCredits, validateEmailById);

export default router;
