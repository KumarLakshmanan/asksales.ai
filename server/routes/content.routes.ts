/**
 * Content Routes Module
 * Handles content generation, calendar, brand toolkit, and templates
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { requireCredits } from '../middleware/creditCheck.js';
import { validateBody } from '../middleware/validation.js';
import { contentRequestReceipt } from '../middleware/contentRequestReceipt.js';
import { preserveAsyncContext } from '../middleware/preserveAsyncContext.js';
import { getContentEstimate, getImageGenerationOptions } from '../controllers/contentEstimateController.js';
import {
  contentStudioPlanSchema,
  contentStudioAdCopySchema,
  contentStudioGenerateSchema,
  contentStudioCreativesSchema,
  contentStudioOutreachCopySchema,
  contentStudioMetaPromptSchema,
  contentStudioPromptVariationsSchema,
  contentStudioEmailSchema,
  contentStudioSmsSchema,
  contentStudioSocialSchema,
  contentStudioSocialMessageSchema,
  contentStudioAdCopyContentSchema,
  contentStudioBlogSchema,
  contentStudioMagicPromptSchema,
  contentStudioEnhancePromptSchema,
  contentStudioImageSchema,
  contentStudioVideoSchema,
  contentStudioStartVideoSchema,
  generateEmailTemplateSchema,
  contentCalendarSchema,
  brandToolkitSchema,
  contentTemplateSchema,
  contentAssetSchema,
  contentAssetPreviewSchema,
  contentAssetPreviewUpdateSchema,
} from '../middleware/schemas.js';
import {
  generateContentPlan,
  generateAdCopy,
  generateContent,
  generateCreatives,
  getContentPlans,
  generateOutreachCopy,
  generateMetaPrompt,
  generatePromptVariations,
  getMediaStatus,
  generateEmail,
  generateSMS,
  generateSocial,
  generateSocialMessage,
  generateAdCopyContent,
  generateMagicPrompt,
  generateBlogPost,
  enhancePrompt,
  getGenerationStatus,
  generateEmailHtmlTemplate,
  generateImage,
  generateVideo,
  startVideoGeneration,
  checkVideoStatus,
} from '../controllers/contentStudioController.js';
import {
  getCalendarItems,
  createCalendarItem,
  updateCalendarItem,
  deleteCalendarItem,
  updateCalendarItemStatus,
  getCalendarSummary,
  bulkCalendarAction,
  importCalendarItems,
} from '../controllers/contentCalendarController.js';
import {
  getBrandToolkits,
  getBrandToolkit,
  getDefaultBrandToolkit,
  checkBrandToolkits,
  createBrandToolkit,
  updateBrandToolkit,
  deleteBrandToolkit,
  setDefaultBrandToolkitHandler,
  uploadLogo,
  uploadLogoMiddleware,
  uploadBrandImage,
  uploadBrandImageMiddleware,
} from '../controllers/brandToolkitController.js';
import {
  getContentTemplates,
  getContentTemplateById,
  createContentTemplate,
  updateContentTemplate,
  deleteContentTemplate,
  useTemplate,
  getMostUsedTemplates,
  getContentTemplateCounts,
  duplicateContentTemplate,
  getPredefinedTemplates,
  importPredefinedTemplate,
  getContentTemplateVersions,
  approveContentTemplate,
} from '../controllers/contentTemplatesController.js';
import {
  getContentAssets,
  getContentAsset,
  createContentAsset,
  updateContentAsset,
  deleteContentAsset,
  uploadContentMedia,
  uploadMediaMiddleware,
  publishContentAsset,
  getOrganicPublishingAccounts,
  rescheduleContentAsset,
  cancelContentAssetSchedule,
  recoverContentAssetPublishAttempt,
  getContentAssetPublishAttempts,
  unpublishContentAsset,
  getContentAssetCounts,
} from '../controllers/contentAssetController.js';
import {
  getContentAssetPreviews,
  createContentAssetPreview,
  updateContentAssetPreview,
} from '../controllers/contentAssetPreviewController.js';

const router = Router();

router.use(authenticateToken, requireModuleAccess('content'));
router.use((req, res, next) => {
  const protectedPath = /^\/studio\/(generate|email|sms|social|social-message|ad-copy-content|blog-post|image|video|video\/start)$/.test(req.path) || req.path === '/assets';
  if (req.method === 'POST' && protectedPath) return contentRequestReceipt(req, res, next);
  return next();
});

// ─── Content Studio (AI Generation) ─────────────────────────────────────────────
router.get('/studio/estimates', getContentEstimate);
router.get('/studio/image-options', getImageGenerationOptions);
router.post('/studio/plan', requireCredits, validateBody(contentStudioPlanSchema), generateContentPlan);
router.get('/studio/plans', getContentPlans);
router.post('/studio/ad-copy', requireCredits, validateBody(contentStudioAdCopySchema), generateAdCopy);
router.post('/studio/generate', requireCredits, validateBody(contentStudioGenerateSchema), generateContent);
router.post('/studio/creatives', requireCredits, validateBody(contentStudioCreativesSchema), generateCreatives);
router.post('/studio/outreach-copy', requireCredits, validateBody(contentStudioOutreachCopySchema), generateOutreachCopy);
router.post('/studio/meta-prompt', requireCredits, validateBody(contentStudioMetaPromptSchema), generateMetaPrompt);
router.post('/studio/prompt-variations', requireCredits, validateBody(contentStudioPromptVariationsSchema), generatePromptVariations);
// Image/video generation: available via both REST (direct tab UI) and Mastra tool calling (chat-initiated)
// REST endpoints: POST /api/content/studio/image, /api/content/studio/video
// Mastra: tool executors in server/mastra/tools/executors/ handle AI agent requests
router.get('/studio/media/status', getMediaStatus);
router.post('/studio/image', requireCredits, validateBody(contentStudioImageSchema), generateImage);
router.post('/studio/video', requireCredits, validateBody(contentStudioVideoSchema), generateVideo);
router.post('/studio/video/start', requireCredits, validateBody(contentStudioStartVideoSchema), startVideoGeneration);
router.get('/studio/video/status/:operationName', checkVideoStatus);
router.post('/studio/email', requireCredits, validateBody(contentStudioEmailSchema), generateEmail);
router.post('/studio/sms', requireCredits, validateBody(contentStudioSmsSchema), generateSMS);
router.post('/studio/social', requireCredits, validateBody(contentStudioSocialSchema), generateSocial);
router.post('/studio/social-message', requireCredits, validateBody(contentStudioSocialMessageSchema), generateSocialMessage);
router.post('/studio/ad-copy-content', requireCredits, validateBody(contentStudioAdCopyContentSchema), generateAdCopyContent);
router.post('/studio/magic-prompt', requireCredits, validateBody(contentStudioMagicPromptSchema), generateMagicPrompt);
router.post('/studio/blog-post', requireCredits, validateBody(contentStudioBlogSchema), generateBlogPost);
router.post('/studio/enhance-prompt', requireCredits, validateBody(contentStudioEnhancePromptSchema), enhancePrompt);
router.get('/studio/generation-status/:jobId', getGenerationStatus);
router.post('/generate-email-template', requireCredits, validateBody(generateEmailTemplateSchema), generateEmailHtmlTemplate);

// ─── Content Calendar ───────────────────────────────────────────────────────────
router.get('/calendar', getCalendarItems);
router.get('/calendar/summary', getCalendarSummary);
router.post('/calendar', validateBody(contentCalendarSchema), createCalendarItem);
router.put('/calendar/:itemId', updateCalendarItem);
router.patch('/calendar/:itemId/status', updateCalendarItemStatus);
router.delete('/calendar/:itemId', deleteCalendarItem);
router.post('/calendar/bulk', bulkCalendarAction);
router.post('/calendar/import', importCalendarItems);

// ─── Brand Toolkit ──────────────────────────────────────────────────────────────
router.get('/brand-toolkits', getBrandToolkits);
router.get('/brand-toolkits/check', checkBrandToolkits);
router.get('/brand-toolkits/default', getDefaultBrandToolkit);
router.get('/brand-toolkits/:id', getBrandToolkit);
router.post('/brand-toolkits', validateBody(brandToolkitSchema), createBrandToolkit);
router.put('/brand-toolkits/:id', validateBody(brandToolkitSchema.partial()), updateBrandToolkit);
router.delete('/brand-toolkits/:id', deleteBrandToolkit);
router.post('/brand-toolkits/:id/default', setDefaultBrandToolkitHandler);
router.post('/brand-toolkits/:id/logo', preserveAsyncContext(uploadLogoMiddleware), uploadLogo);
router.post('/brand-toolkits/upload-logo', preserveAsyncContext(uploadLogoMiddleware), uploadLogo);
router.post('/brand-toolkits/upload-image', preserveAsyncContext(uploadBrandImageMiddleware), uploadBrandImage);

// ─── Content Templates ─────────────────────────────────────────────────────────
router.get('/templates', getContentTemplates);
router.get('/templates/most-used', getMostUsedTemplates);
router.get('/templates/counts', getContentTemplateCounts);
router.get('/templates/predefined', getPredefinedTemplates);
router.get('/templates/:id', getContentTemplateById);
router.post('/templates', validateBody(contentTemplateSchema), createContentTemplate);
router.put('/templates/:id', validateBody(contentTemplateSchema.partial()), updateContentTemplate);
router.delete('/templates/:id', deleteContentTemplate);
router.post('/templates/:id/use', useTemplate);
router.post('/templates/:id/duplicate', duplicateContentTemplate);
router.post('/templates/:id/import', importPredefinedTemplate);
router.get('/templates/:id/versions', getContentTemplateVersions);
router.post('/templates/:id/approve', approveContentTemplate);

// ─── Content Assets ─────────────────────────────────────────────────────────────
router.get('/assets', getContentAssets);
router.get('/assets/counts', getContentAssetCounts);
router.get('/assets/:assetId', getContentAsset);
router.post('/assets', validateBody(contentAssetSchema), createContentAsset);
router.put('/assets/:id', validateBody(contentAssetSchema.partial()), updateContentAsset);
router.delete('/assets/:id', deleteContentAsset);
router.post('/assets/upload', preserveAsyncContext(uploadMediaMiddleware), uploadContentMedia);
router.post('/assets/:assetId/publish', requireCredits, publishContentAsset);
router.post('/assets/:assetId/reschedule', rescheduleContentAsset);
router.patch('/assets/:assetId/reschedule', rescheduleContentAsset);
router.get('/publishing/accounts', getOrganicPublishingAccounts);
router.get('/assets/:assetId/publish-attempts', getContentAssetPublishAttempts);
router.post('/assets/:assetId/cancel', cancelContentAssetSchedule);
router.post('/assets/:assetId/publish-attempts/:attemptId/recover', recoverContentAssetPublishAttempt);
router.post('/assets/:assetId/unpublish', unpublishContentAsset);

// ─── Content Asset Previews ─────────────────────────────────────────────────────
router.get('/asset-previews', getContentAssetPreviews);
router.post('/asset-previews', validateBody(contentAssetPreviewSchema), createContentAssetPreview);
router.put('/asset-previews/:id', validateBody(contentAssetPreviewUpdateSchema), updateContentAssetPreview);

export default router;
