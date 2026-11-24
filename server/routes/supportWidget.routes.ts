import { widgetBusinessScope, widgetEmailBusinessScope } from '../middleware/publicBusinessScope.js';
/**
 * Support Widget Routes
 * Public endpoints for embeddable support chat widget.
 * No user auth required — uses widget_token for authentication.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { publicWidgetRateLimiter, publicWidgetReadRateLimiter } from '../middleware/rateLimiter.js';
import {
  widgetChat,
  updateWidgetSettings, recordWidgetInstallation, revokeWidgetToken, submitWidgetFeedback,
  getWidgetConfig,
  getWidgetSessionMessages,
  getEmbedScript,
  generateWidgetToken,
  getWidgetToken,
  confirmWidgetLeadEmail,
  getWidgetSessionMedia,
  getWidgetSessionDocument,
} from '../controllers/supportWidgetController.js';

const router = Router();

// Public endpoints (H10: rate-limited per IP to prevent lead-spam abuse)
router.post('/installed', publicWidgetRateLimiter, widgetBusinessScope, recordWidgetInstallation);
router.post('/session/:sessionId/feedback', publicWidgetRateLimiter, widgetBusinessScope, submitWidgetFeedback);
router.post('/chat', publicWidgetRateLimiter, widgetBusinessScope, widgetChat);
router.get('/session/:sessionId/messages', publicWidgetReadRateLimiter, widgetBusinessScope, getWidgetSessionMessages);
router.get('/session/:sessionId/media/:assetId', publicWidgetRateLimiter, widgetBusinessScope, getWidgetSessionMedia);
router.post('/session/:sessionId/messages/:messageId/documents/:documentId', publicWidgetRateLimiter, widgetBusinessScope, getWidgetSessionDocument);
router.get('/config', widgetBusinessScope, getWidgetConfig);
router.get('/embed.js', widgetBusinessScope, getEmbedScript);
router.get('/confirm-email', publicWidgetRateLimiter, widgetEmailBusinessScope, confirmWidgetLeadEmail);

// Authenticated endpoints (for dashboard settings)
router.put('/settings/:teamId', authenticateToken, updateWidgetSettings);
router.delete('/token/:teamId', authenticateToken, revokeWidgetToken);
router.get('/token', authenticateToken, getWidgetToken);
router.post('/generate-token', authenticateToken, generateWidgetToken);

export default router;
