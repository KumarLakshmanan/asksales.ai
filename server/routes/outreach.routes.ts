/**
 * Outreach Routes Module
 * Handles multi-channel outreach: email, SMS, Instagram
 */

import { Router } from 'express';
import { campaignReport } from '../controllers/campaignReportController.js';
import {preparedOutreach} from '../controllers/preparedOutreachController.js';
import {outreachRetries} from '../controllers/outreachRetryController.js';
import {campaignEngagement} from '../controllers/campaignEngagementController.js';
import {campaignExport} from '../controllers/campaignExportController.js';
import {
  outreachBatchDaily, outreachBatchExport, outreachBatchFailures, outreachBatchList, outreachBatchRecipients, outreachBatchRename, outreachBatchSummary,
  outreachBatchUpcoming, outreachDaily, outreachTemplatePerformance, outreachUpcoming,
} from '../controllers/outreachTrackingController.js';
import { campaignManualFollowUps } from '../controllers/campaignManualFollowUpController.js';
import { canonicalOutreachPath } from '../utils/outreachRouteAliases.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { requireCredits } from '../middleware/creditCheck.js';
import { validateBody } from '../middleware/validation.js';
import { sendOutreachSchema, startOutreachSchema } from '../middleware/schemas.js';
import {
  getOutreachMessages,
  getOutreachStats,
  getOutreachProgress,
  sendOutreachMessage,
  startOutreachHandler,
} from '../controllers/outreachController.js';
import {
  uploadLeads,
  uploadLeadsFile,
  generateEmailSequence,
  generateSMSSequence,
  createCampaign as createOutreachCampaign,
  scheduleCampaign,
  previewCampaign,
  getCampaigns as getOutreachCampaigns,
  getCampaignById as getOutreachCampaignById,
  getSequences,
  cancelCampaign,
  retryFailedCampaign,
} from '../controllers/outreachAgentController.js';
import {
  getSentMessages,
  getSentMessagesByLeadId,
} from '../controllers/sentMessageController.js';
import {
  deleteOutreachMessageHandler,
  uploadAttachments,
  attachmentUploadMiddleware,
  downloadAttachment,
} from '../controllers/outreachConversationsController.js';

const router = Router();

router.use(authenticateToken, requireModuleAccess('outreach'));
// Draft configuration and previews do not send or require a live assistant/provider.
router.get('/manual-follow-ups/campaign-options', campaignManualFollowUps);
router.post('/manual-follow-ups/campaign-options', campaignManualFollowUps);
router.get('/manual-follow-ups', campaignManualFollowUps);
router.put('/manual-follow-ups', campaignManualFollowUps);
router.post('/manual-follow-ups/preview', campaignManualFollowUps);
router.post('/manual-follow-ups/pending-preview', campaignManualFollowUps);
router.post('/manual-follow-ups/apply-reviewed', campaignManualFollowUps);

// ─── Outreach Operations ────────────────────────────────────────────────────────
router.get('/messages', getOutreachMessages);
router.delete('/messages/:messageId', deleteOutreachMessageHandler);
router.get('/stats', getOutreachStats);
router.get('/reports', campaignReport);
router.get('/reports/options', campaignReport);
router.get('/reports/customers',campaignEngagement);
router.get('/reports/history',campaignEngagement);
router.post('/reports/exports',campaignExport);
router.get('/reports/exports/:id',campaignExport);
router.post('/reports/exports/:id/resume',campaignExport);
router.get('/reports/exports/:id/download/:format',campaignExport);
// Message tracking: one record per outreach launch.
router.get('/batches', outreachBatchList);
router.get('/batches/:id', outreachBatchSummary);
router.patch('/batches/:id', outreachBatchRename);
router.get('/batches/:id/messages', outreachBatchRecipients);
router.get('/batches/:id/failures', outreachBatchFailures);
router.get('/batches/:id/daily', outreachBatchDaily);
router.get('/batches/:id/export.csv', outreachBatchExport);
router.get('/batches/:id/upcoming', outreachBatchUpcoming);
router.get('/daily', outreachDaily);
router.get('/upcoming', outreachUpcoming);
router.get('/templates/performance', outreachTemplatePerformance);
router.post('/prepared',preparedOutreach);
router.get('/prepared/:id',preparedOutreach);
router.post('/retries/preview',outreachRetries);
router.get('/retries/:id',outreachRetries);
router.post('/retries/:id/apply',outreachRetries);
router.post('/retries/:id/resume',outreachRetries);
router.get('/progress/:campaignId', getOutreachProgress);
router.post('/send', requireCredits, validateBody(sendOutreachSchema), sendOutreachMessage);
router.post('/start', requireCredits, validateBody(startOutreachSchema), startOutreachHandler);

// ─── Outreach Campaigns ─────────────────────────────────────────────────────────
router.get('/campaigns', getOutreachCampaigns);
router.get('/campaigns/:id', getOutreachCampaignById);
router.post('/campaigns', requireCredits, createOutreachCampaign);
router.post('/campaigns/:id/preview', previewCampaign);
router.post('/campaigns/:id/schedule', scheduleCampaign);
router.post('/campaigns/:id/cancel', cancelCampaign);
router.post('/campaigns/:id/retry-failed', retryFailedCampaign);

// ─── Sequences ──────────────────────────────────────────────────────────────────
router.get('/sequences', getSequences);
router.post('/sequences/email', requireCredits, generateEmailSequence);
router.post('/sequences/sms', requireCredits, generateSMSSequence);

// ─── Lead Uploads ───────────────────────────────────────────────────────────────
router.post('/leads/upload-file', uploadLeadsFile, uploadLeads);

// ─── Sent Messages ──────────────────────────────────────────────────────────
router.get('/sent', getSentMessages);
router.get('/sent/lead/:leadId', getSentMessagesByLeadId);

// ─── Attachments ────────────────────────────────────────────────────────────
router.post('/attachments', attachmentUploadMiddleware, uploadAttachments);
router.get('/attachments/:attachmentId', downloadAttachment);

// Reuse this exact router so aliases cannot drift from module, auth or credit checks.
export const legacyOutreachAgentRoutes = Router();
legacyOutreachAgentRoutes.use((req, res, next) => {
  const canonical = canonicalOutreachPath(req.path);
  if (!canonical) return res.status(404).json({ error: 'Unknown outreach endpoint.' });
  const queryAt = req.url.indexOf('?');
  req.url = canonical + (queryAt >= 0 ? req.url.slice(queryAt) : '');
  return next();
});
legacyOutreachAgentRoutes.use(router);

export default router;
