import { requireBusinessOwner } from '../middleware/businessPermissions.js';
import { reviewBusinessScope } from '../middleware/publicBusinessScope.js';
import { listConversationRecovery, reconcileConversationRecovery } from '../controllers/supportConversationRecoveryController.js';
import { conversationTurnHandler } from '../controllers/conversationTurnController.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { aiRateLimiter, apiRateLimiter, publicReviewRateLimiter } from '../middleware/rateLimiter.js';
import { validateBody } from '../middleware/validation.js';
import { resetMemberPasswordSchema } from '../middleware/schemas.js';
import {
  getTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  createTicketFromConversation,
  addMessage,
  getMessages,
  getTicketTimeline,
  revealOwnerTicketMessage,
  getSupportAnalytics,
  resolveTicketOwnership,
  submitReview,
  getTicketReview,
  getMyReviews,
  getReviewStats,
  getPublicReview,
  submitPublicReview,
} from '../controllers/supportController.js';
import * as supportOrchestration from '../controllers/supportOrchestrationController.js';
import {
  getTeams,
  getTeam,
  createTeam,
  updateTeam,
  deleteTeam,
  addTeamMember,
  updateTeamMember,
  removeTeamMember,
  getTeamTickets,
  getMemberTickets,
  resetMemberPassword,
  toggleMemberActive,
} from '../controllers/supportTeamsController.js';
import {
  listOwnerSupportSessions,
  getOwnerSupportSession,
  ownerSupportChat,
  deleteOwnerSupportSession,
  archiveOwnerSupportSession,
  getSupportSessionsByLead,
  getSupportSessionMessages,
  getSupportAIReport,
  getSupportAIQuality,
  updateSupportMessageFeedback,
} from '../controllers/ownerSupportAIController.js';
import {
  downloadOwnerSupportAttachment,
  supportAttachmentUpload,
  uploadOwnerSupportAttachment,
} from '../controllers/supportAttachmentController.js';
import {
  confirmOwnerDestinationVerification,
  getOwnerNotificationHealth,
  listOwnerNotificationTemplates,
  publishOwnerNotificationTemplate,
  getMemberNotificationPreferences,
  getOwnerNotificationProviderCapabilities,
  previewOwnerSupportNotification,
  requestOwnerDestinationVerification,
  retryOwnerSupportNotificationDelivery,
  restoreOwnerAssignmentEmailTemplate,
  saveOwnerNotificationProviderBinding,
  testOwnerSupportNotificationChannel,
  saveOwnerNotificationTemplate,
  updateMemberNotificationPreferences,
} from '../controllers/supportNotificationPreferencesController.js';
import * as supportPresence from '../controllers/supportPresenceController.js';
import {
  getGlobalSupportNotificationSettings,
  updateGlobalEmailNotificationSettings,
  updateGlobalWhatsappNotificationSettings,
} from '../controllers/supportNotificationSettingsController.js';

const router = Router();
const deprecatedMemberNotificationPreferences = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</api/support/notification-settings>; rel="successor-version"');
  next();
};

// Public routes (no auth required) — token-based review (H11: rate-limited)
router.get('/review-public/:token', publicReviewRateLimiter, reviewBusinessScope, getPublicReview);
router.post('/review-public/:token', publicReviewRateLimiter, reviewBusinessScope, submitPublicReview);

router.use(authenticateToken);
router.use('/ai', requireModuleAccess('support_ai'));
router.use((req, res, next) => {
  if (req.path === '/ai' || req.path.startsWith('/ai/')) return next();
  return requireModuleAccess('support')(req, res, next);
});

// Canonical support AI playbooks (owner/admin control plane)
router.get('/ai/playbooks', supportOrchestration.listPlaybooks);
router.post('/ai/playbooks/defaults', requireBusinessOwner, apiRateLimiter, supportOrchestration.provisionDefaultPlaybooks);
router.get('/ai/playbook-templates', supportOrchestration.listAvailablePlaybookTemplates);
router.post('/ai/playbook-templates/:templateKey/install', apiRateLimiter, supportOrchestration.installPlaybookTemplate);
router.post('/ai/playbooks', requireBusinessOwner, apiRateLimiter, supportOrchestration.createPlaybook);
router.post('/ai/playbooks/validate', requireBusinessOwner, apiRateLimiter, supportOrchestration.validatePlaybook);
router.get('/ai/playbooks/:id', supportOrchestration.getPlaybook);
router.put('/ai/playbooks/:id', requireBusinessOwner, apiRateLimiter, supportOrchestration.updatePlaybook);
router.post('/ai/playbooks/:id/publish', requireBusinessOwner, apiRateLimiter, supportOrchestration.publishPlaybook);
router.post('/ai/playbooks/:id/archive', requireBusinessOwner, apiRateLimiter, supportOrchestration.archivePlaybook);
router.patch('/ai/playbooks/:id/enabled', requireBusinessOwner, apiRateLimiter, supportOrchestration.setPlaybookEnabled);
router.post('/ai/playbooks/:id/reset-default', requireBusinessOwner, apiRateLimiter, supportOrchestration.resetPlaybookToAdminTemplate);
router.post('/ai/playbooks/:id/assignments', requireBusinessOwner, apiRateLimiter, supportOrchestration.createPlaybookAssignment);
router.patch('/ai/playbooks/:id/assignments/:assignmentId/enabled', requireBusinessOwner, apiRateLimiter, supportOrchestration.setPlaybookAssignmentEnabled);
router.delete('/ai/playbooks/:id/assignments/:assignmentId', requireBusinessOwner, apiRateLimiter, supportOrchestration.deletePlaybookAssignment);
router.get('/ai/orchestration-report', supportOrchestration.getOrchestrationReport);
router.get('/ai/conversation-recovery', listConversationRecovery);
router.post('/ai/conversation-recovery/:kind/:id', apiRateLimiter, reconcileConversationRecovery);
router.get('/ai/delivery-actions', supportOrchestration.listDeliveryActions);
router.post('/ai/delivery-actions/:id/reconcile', apiRateLimiter, supportOrchestration.reconcileDeliveryAction);
router.get('/ai/tool-executions', supportOrchestration.listToolExecutions);
router.get('/ai/approval-recovery', supportOrchestration.listApprovalRecovery);
router.post('/ai/tool-executions/:id/reconcile', apiRateLimiter, supportOrchestration.reconcileToolExecution);
router.post('/ai/simulate', aiRateLimiter, supportOrchestration.simulateSupportTurn);

// Teams
router.get('/teams/capacity-settings', supportPresence.getCapacitySettings);
router.put('/teams/capacity-settings', apiRateLimiter, supportPresence.updateCapacitySettings);
router.get('/teams/routing-estimate', supportPresence.getRoutingEstimate);
router.get('/teams', getTeams);
router.get('/teams/:id', getTeam);
router.post('/teams', createTeam);
router.put('/teams/:id', updateTeam);
router.delete('/teams/:id', deleteTeam);
router.post('/teams/:id/members', addTeamMember);
router.put('/teams/:teamId/members/:memberId', updateTeamMember);
router.delete('/teams/:teamId/members/:memberId', removeTeamMember);
router.get('/teams/:teamId/members/:memberId/notification-preferences', deprecatedMemberNotificationPreferences, getMemberNotificationPreferences);
router.put('/teams/:teamId/members/:memberId/notification-preferences', deprecatedMemberNotificationPreferences, updateMemberNotificationPreferences);
router.post('/teams/:teamId/members/:memberId/notification-preferences/verification/request', deprecatedMemberNotificationPreferences, apiRateLimiter, requestOwnerDestinationVerification);
router.post('/teams/:teamId/members/:memberId/notification-preferences/verification/confirm', deprecatedMemberNotificationPreferences, apiRateLimiter, confirmOwnerDestinationVerification);
router.get('/notification-health', getOwnerNotificationHealth);
router.get('/notification-settings', getGlobalSupportNotificationSettings);
router.put('/notification-settings/email', apiRateLimiter, updateGlobalEmailNotificationSettings);
router.put('/notification-settings/whatsapp', apiRateLimiter, updateGlobalWhatsappNotificationSettings);
router.post('/notification-deliveries/:deliveryId/retry', apiRateLimiter, retryOwnerSupportNotificationDelivery);
router.get('/notification-provider-capabilities', getOwnerNotificationProviderCapabilities);
router.put('/notification-provider-bindings/:eventType', apiRateLimiter, saveOwnerNotificationProviderBinding);
router.post('/notification-preview', apiRateLimiter, previewOwnerSupportNotification);
router.post('/notification-test', apiRateLimiter, testOwnerSupportNotificationChannel);
router.get('/notification-templates', listOwnerNotificationTemplates);
router.post('/notification-templates', apiRateLimiter, saveOwnerNotificationTemplate);
router.post('/notification-templates/:id/publish', apiRateLimiter, publishOwnerNotificationTemplate);
router.post('/notification-templates/restore-assignment-default', apiRateLimiter, restoreOwnerAssignmentEmailTemplate);
router.get('/teams/:id/tickets', getTeamTickets);
router.get('/teams/:teamId/members/:memberId/tickets', getMemberTickets);
router.put('/teams/:teamId/members/:memberId/reset-password', validateBody(resetMemberPasswordSchema), resetMemberPassword);
router.put('/teams/:teamId/members/:memberId/toggle-active', toggleMemberActive);
router.get('/teams/:teamId/members/:memberId/presence', supportPresence.getOwnerMemberPresence);

// Owner Support AI (must be before /:id catch-all)
router.get('/ai/report', getSupportAIReport);
router.get('/ai/quality', getSupportAIQuality);
router.put('/ai/messages/:messageId/feedback', apiRateLimiter, updateSupportMessageFeedback);
router.get('/ai/sessions', listOwnerSupportSessions);
router.get('/ai/sessions/by-lead/:leadId', getSupportSessionsByLead);
router.get('/ai/sessions/:id/turns', conversationTurnHandler('support_owner', 'list'));
router.post('/ai/sessions/:id/stop', conversationTurnHandler('support_owner', 'stop'));
router.post('/ai/sessions/:id/reconcile', conversationTurnHandler('support_owner', 'reconcile'));
router.get('/ai/sessions/:id', getOwnerSupportSession);
router.get('/ai/sessions/:sessionId/messages', getSupportSessionMessages);
router.post('/ai/chat', ownerSupportChat);
router.delete('/ai/sessions/:id', deleteOwnerSupportSession);
router.patch('/ai/sessions/:id', archiveOwnerSupportSession);

// Tickets
router.get('/', getTickets);
router.get('/analytics', getSupportAnalytics);
router.get('/reviews', getMyReviews);
router.get('/review-stats', getReviewStats);
router.post('/:id/resolve-ownership', apiRateLimiter, resolveTicketOwnership);
router.get('/:id', getTicket);
router.post('/', createTicket);
router.put('/:id', updateTicket);
router.delete('/:id', deleteTicket);

// Create from conversation
router.post('/from-conversation/:conversationId', createTicketFromConversation);

// Messages
router.get('/:id/messages', getMessages);
router.get('/:id/timeline', getTicketTimeline);
router.post('/:id/messages/:source/:messageId/reveal', apiRateLimiter, revealOwnerTicketMessage);
router.post('/:id/messages', addMessage);
router.post('/:id/attachments', supportAttachmentUpload, uploadOwnerSupportAttachment);
router.get('/:id/attachments/:fileId', downloadOwnerSupportAttachment);

// Reviews
router.post('/:id/review', submitReview);
router.get('/:id/review', getTicketReview);

export default router;
