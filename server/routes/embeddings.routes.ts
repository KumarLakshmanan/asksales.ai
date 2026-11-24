/**
 * Embeddings Routes Module
 * User-facing embedding endpoints + admin embedding settings
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { authenticateAdminToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import {
  getAvailableModels,
} from '../controllers/embeddingsController.js';
import {
  getEmbeddingSettings,
  updateEmbeddingSettings,
  testEmbeddingProvider,
} from '../controllers/adminEmbeddingsController.js';

const router = Router();

// Raw generation/storage/search/deletion endpoints were intentionally removed.
// Tenant knowledge is indexed only through governed KB workflows.
router.get('/models', authenticateToken, requireModuleAccess('knowledge_base'), getAvailableModels);

// ── Admin endpoints ─────────────────────────────────────────────────────────────
router.get('/admin/settings', authenticateAdminToken, getEmbeddingSettings);
router.put('/admin/settings', authenticateAdminToken, updateEmbeddingSettings);
router.post('/admin/test', authenticateAdminToken, testEmbeddingProvider);

export default router;
