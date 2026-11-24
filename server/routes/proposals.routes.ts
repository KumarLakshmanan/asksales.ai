import { proposalBusinessScope } from '../middleware/publicBusinessScope.js';
import { proposalSources, proposalResolveSource, proposalCatalog, saveProposalCatalog, proposalTimeline, proposalVersions, recoverProposalDelivery, proposalRelated, proposalPerformance, catalogSchema, recoverySchema } from '../controllers/proposalWorkspaceController.js';
import { configureProposalFollowups, createProposalRevision, createPublicProposalFeedback, getPublicProposalFeedback, listProposalFeedback, pauseProposalFollowups, previewProposalFollowups, proposalOnboardingResources, replyToProposalFeedback, resolveProposalFeedback } from '../controllers/proposalLifecycleController.js';
import { Router } from 'express';
import { listTemplateFavorites, setTemplateFavorite } from '../controllers/proposalTemplateLibraryController.js';
import { prepareProposalDelivery, approveProposalDelivery, deliverProposal, proposalApprovalPolicy, saveProposalApprovalPolicy, proposalApprovalRequests } from '../controllers/proposalDeliveryController.js';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { requireCredits } from '../middleware/creditCheck.js';
import { validateBody } from '../middleware/validation.js';
import {
  createProposalSchema,
  updateProposalSchema,
  updateLineItemsSchema,
  addProposalCommentSchema,
  updateProposalCommentSchema,
  createProposalTemplateSchema,
  updateProposalTemplateSchema,
  rejectProposalSchema,
  sendProposalSchema,
  publicProposalResponseSchema,
  createProposalReminderSchema,
  updateProposalReminderSchema,
} from '../middleware/schemas.js';
import {
  getProposals,
  getProposal,
  createProposal,
  generateProposal,
  suggestProposalDraft,
  proposalBrand,
  updateProposal,
  deleteProposal,
  updateLineItems,
  getComments,
  addComment,
  updateComment,
  getTemplates,
  createTemplate,
  importTemplateDocument,
  updateTemplate,
  deleteTemplate,
  acceptProposal,
  rejectProposal,
  getProposalReminders,
  createProposalReminder,
  updateProposalReminder,
  deleteProposalReminder,
  getProposalAnalytics,
  getPublicProposal,
  markPublicProposalViewed,
  acceptPublicProposal,
  rejectPublicProposal,
} from '../controllers/proposalController.js';

const router = Router();
router.use('/public/:token', proposalBusinessScope);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Token-authenticated customer review routes. These must remain before the
// seller session middleware; the opaque 256-bit token is the authorization.
router.get('/public/:token', getPublicProposal);
router.post('/public/:token/view', markPublicProposalViewed);
router.post('/public/:token/accept', validateBody(publicProposalResponseSchema), acceptPublicProposal);
router.post('/public/:token/reject', validateBody(publicProposalResponseSchema), rejectPublicProposal);
router.get('/public/:token/feedback', getPublicProposalFeedback);
router.post('/public/:token/feedback', createPublicProposalFeedback);

router.use(authenticateToken, requireModuleAccess('proposals'));

// Proposals
router.get('/', getProposals);
router.get('/analytics', getProposalAnalytics);
router.get('/brand', proposalBrand);
router.post('/suggest', requireCredits, validateBody(createProposalSchema), suggestProposalDraft);

// Templates (must be before /:id to avoid matching 'templates' as an id)
router.get('/templates', getTemplates);
router.get('/templates/favorites', listTemplateFavorites);
router.put('/templates/:id/favorite', setTemplateFavorite);
router.post('/templates/import', upload.single('file'), importTemplateDocument);
router.post('/templates', validateBody(createProposalTemplateSchema), createTemplate);
router.put('/templates/:id', validateBody(updateProposalTemplateSchema), updateTemplate);
router.delete('/templates/:id', deleteTemplate);

router.get('/sources', proposalSources);
router.get('/resolve-source', proposalResolveSource);
router.get('/catalog', proposalCatalog);
router.post('/catalog', validateBody(catalogSchema), saveProposalCatalog);
router.put('/catalog/:id', validateBody(catalogSchema), saveProposalCatalog);
router.get('/related', proposalRelated);
router.get('/performance', proposalPerformance);
router.get('/review-policy', proposalApprovalPolicy);
router.put('/review-policy', saveProposalApprovalPolicy);
router.get('/onboarding-resources', proposalOnboardingResources);
router.post('/:id/prepare-delivery', prepareProposalDelivery);
router.get('/:id/approvals', proposalApprovalRequests);
router.get('/:id/timeline', proposalTimeline);
router.get('/:id/versions', proposalVersions);
router.post('/:id/approve', approveProposalDelivery);
router.post('/:id/followups/preview', previewProposalFollowups);
router.post('/:id/followups', configureProposalFollowups);
router.patch('/:id/followups', pauseProposalFollowups);
router.get('/:id/feedback', listProposalFeedback);
router.post('/:id/feedback/:feedbackId/reply', replyToProposalFeedback);
router.patch('/:id/feedback/:feedbackId', resolveProposalFeedback);
router.post('/:id/revise', createProposalRevision);
router.post('/:id/recover-delivery', validateBody(recoverySchema), recoverProposalDelivery);
router.get('/:id', getProposal);
router.post('/', validateBody(createProposalSchema), createProposal);
router.post('/generate', requireCredits, validateBody(createProposalSchema), generateProposal);
router.put('/:id', validateBody(updateProposalSchema), updateProposal);
router.delete('/:id', deleteProposal);

// Status actions
router.post('/:id/send', validateBody(sendProposalSchema), deliverProposal);
router.post('/:id/accept', acceptProposal);
router.post('/:id/reject', validateBody(rejectProposalSchema), rejectProposal);

// Line items
router.put('/:id/line-items', validateBody(updateLineItemsSchema), updateLineItems);

// Comments
router.get('/:id/comments', getComments);
router.post('/:id/comments', validateBody(addProposalCommentSchema), addComment);
router.patch('/comments/:commentId', validateBody(updateProposalCommentSchema), updateComment);

// Reminders
router.get('/:id/reminders', getProposalReminders);
router.post('/:id/reminders', validateBody(createProposalReminderSchema), createProposalReminder);
router.put('/reminders/:reminderId', validateBody(updateProposalReminderSchema), updateProposalReminder);
router.delete('/reminders/:reminderId', deleteProposalReminder);

export default router;
