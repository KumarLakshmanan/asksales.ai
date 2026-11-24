import { conversationTurnHandler } from '../controllers/conversationTurnController.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { memberProposalReviews, decideMemberProposalReview } from '../controllers/proposalDeliveryController.js';
import { authenticateSupportMember } from '../middleware/supportAuth.js';
import { validateBody } from '../middleware/validation.js';
import { aiRateLimiter, authRateLimiter } from '../middleware/rateLimiter.js';
import { changePasswordSchema, supportLoginSchema } from '../middleware/schemas.js';
import {
  supportMemberLogin,
  supportMemberLogout,
  supportMemberMe,
  supportMemberChangePassword,
  getAssignedTickets,
  getTicketDetail,
  updateTicketStatus,
  addTicketReply,
  getSupportMemberStats,
  getSupportKnowledgeBase,
  getSupportKnowledgeBaseExtractedText,
  closeTicketAndRequestReview,
  getTicketReview,
  getTeamQueue,
  reassignTicket,
  claimTicket,
  getTicketTimeline,
  refreshTicketSummary,
  getMyTeamMembers,
} from '../controllers/supportMemberController.js';
import * as supportChat from '../controllers/supportChatController.js';
import * as supportHandoff from '../controllers/supportHandoffController.js';
import {
  downloadMemberSupportAttachment,
  supportAttachmentUpload,
  uploadMemberSupportAttachment,
} from '../controllers/supportAttachmentController.js';
import {
  confirmMyDestinationVerification,
  getMyNotificationPreferences,
  getMyNotificationAvailability,
  getTeamNotificationDefaults,
  acknowledgeMySupportNotification,
  claimMySupportNotificationTicket,
  listMySupportNotifications,
  markAllMySupportNotificationsRead,
  markMySupportNotificationRead,
  requestMyDestinationVerification,
  retryMySupportNotificationDelivery,
  updateMyNotificationPreferences,
  updateMyNotificationAvailability,
  updateTeamNotificationDefaults,
} from '../controllers/supportNotificationPreferencesController.js';
import { getMyPresence, heartbeat } from '../controllers/supportPresenceController.js';
import {
  downloadMemberMediaAsset,
  getMemberMediaGallery,
  listMemberMediaGalleries,
  listMemberPlaybooks,
} from '../controllers/supportMemberResourcesController.js';

const router = Router();
const deprecatedNotificationPreferences = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Deprecation', 'true');
  next();
};

// Public (no auth)
router.post('/login', authRateLimiter, validateBody(supportLoginSchema), supportMemberLogin);
router.post('/logout', supportMemberLogout);

// Protected
router.use(authenticateSupportMember);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
});
router.get('/me', supportMemberMe);
router.post('/presence/heartbeat', heartbeat);
router.get('/presence', getMyPresence);
router.put('/change-password', validateBody(changePasswordSchema), supportMemberChangePassword);
router.get('/notification-preferences', deprecatedNotificationPreferences, getMyNotificationPreferences);
router.put('/notification-preferences', deprecatedNotificationPreferences, updateMyNotificationPreferences);
router.get('/notification-availability', getMyNotificationAvailability);
router.put('/notification-availability', updateMyNotificationAvailability);
router.post('/notification-preferences/verification/request', deprecatedNotificationPreferences, authRateLimiter, requestMyDestinationVerification);
router.post('/notification-preferences/verification/confirm', deprecatedNotificationPreferences, authRateLimiter, confirmMyDestinationVerification);
router.get('/notification-defaults', deprecatedNotificationPreferences, getTeamNotificationDefaults);
router.put('/notification-defaults', deprecatedNotificationPreferences, updateTeamNotificationDefaults);
router.get('/notifications', listMySupportNotifications);
router.post('/notifications/read-all', markAllMySupportNotificationsRead);
router.post('/notifications/:id/read', markMySupportNotificationRead);
router.post('/notifications/:id/acknowledge', acknowledgeMySupportNotification);
router.post('/notifications/:id/claim', claimMySupportNotificationTicket);
router.post('/notification-deliveries/:deliveryId/retry', retryMySupportNotificationDelivery);
router.get('/stats', getSupportMemberStats);
router.get('/team-members', getMyTeamMembers);
router.get('/proposal-reviews', memberProposalReviews);
router.post('/proposal-reviews/:id/decision', decideMemberProposalReview);
router.get('/handoffs', supportHandoff.listHandoffs);
router.get('/handoffs/:id', supportHandoff.getHandoff);
router.post('/handoffs/:id/claim', supportHandoff.claimHandoff);
router.post('/handoffs/:id/ai-replies', supportHandoff.setAiReplyEnabled);
router.put('/handoffs/:id/draft', supportHandoff.updateDraft);
router.post('/handoffs/:id/resolve', supportHandoff.resolveHandoff);
router.post('/handoffs/:id/tool-approvals/:approvalId/decision', supportHandoff.decideToolApproval);
router.get('/handoffs/:id/messages/:messageId/reveal', supportHandoff.revealMessage);
router.post('/handoffs/:id/assist', aiRateLimiter, supportHandoff.generateHandoffAssist);
router.get('/canned-responses', supportHandoff.listCannedResponses);
router.post('/canned-responses', supportHandoff.createCannedResponse);
router.put('/canned-responses/:id', supportHandoff.updateCannedResponse);
router.delete('/canned-responses/:id', supportHandoff.deleteCannedResponse);
router.get('/tickets', getAssignedTickets);
router.get('/team-queue', getTeamQueue);
router.get('/tickets/:id', getTicketDetail);
router.put('/tickets/:id', updateTicketStatus);
router.post('/tickets/:id/claim', claimTicket);
router.get('/tickets/:id/timeline', getTicketTimeline);
router.post('/tickets/:id/summary/refresh', aiRateLimiter, refreshTicketSummary);
router.post('/tickets/:id/reply', addTicketReply);
router.post('/tickets/:id/attachments', supportAttachmentUpload, uploadMemberSupportAttachment);
router.get('/tickets/:id/attachments/:fileId', downloadMemberSupportAttachment);
router.post('/tickets/:id/reassign', reassignTicket);
router.post('/tickets/:id/close', closeTicketAndRequestReview);
router.get('/tickets/:id/review', getTicketReview);

// Knowledge base (read-only)
router.get('/knowledge-base', getSupportKnowledgeBase);
router.get('/knowledge-base/:id/extracted-text', getSupportKnowledgeBaseExtractedText);

// Published support resources (read-only for support members)
router.get('/media-galleries', listMemberMediaGalleries);
router.get('/media-galleries/assets/:assetId/content', downloadMemberMediaAsset);
router.get('/media-galleries/:id', getMemberMediaGallery);
router.get('/playbooks', listMemberPlaybooks);

// Chat sessions (RAG support assistant)
router.post('/chat/sessions', supportChat.createSession);
router.get('/chat/sessions', supportChat.listSessions);
router.get('/chat/sessions/:id/turns', conversationTurnHandler('support_member', 'list'));
router.post('/chat/sessions/:id/stop', conversationTurnHandler('support_member', 'stop'));
router.post('/chat/sessions/:id/reconcile', conversationTurnHandler('support_member', 'reconcile'));
router.get('/chat/sessions/:id', supportChat.getSession);
router.put('/chat/sessions/:id', supportChat.renameSession);
router.patch('/chat/sessions/:id', supportChat.archiveSession);
router.delete('/chat/sessions/:id', supportChat.deleteSession);
router.post('/chat/sessions/:id/messages', supportChat.sendMessage);

export default router;
