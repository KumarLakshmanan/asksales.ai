/**
 * Settings Routes Module
 * Handles user settings, AI settings, company profile, and integrations
 */

import { Router } from 'express';
import { requireBusinessManager } from '../middleware/businessPermissions.js';
import { getEmailDesignSettings, updateEmailDesignSettings } from '../controllers/emailDesignController.js';
import outreachAssistantsRouter from './outreachAssistants.routes.js';
import { getBusinessInvitations,acceptBusinessStaffInvitation,getBusinessStaff,addBusinessStaff,updateBusinessStaff,removeBusinessStaff } from '../controllers/businessStaffController.js';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { preserveAsyncContext } from '../middleware/preserveAsyncContext.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { listSupportDocuments, createSupportDocument, updateSupportDocument, publishSupportDocument,
  withdrawSupportDocument, downloadSupportDocument } from '../controllers/supportDocumentLibraryController.js';
import { validateBody, validateParams, commonSchemas } from '../middleware/validation.js';
import { businessProfileSchema, createBusinessProfileSchema } from '../middleware/schemas.js';
import {
  getLeadSettings,
  updateLeadSettings,
  getOutreachSettings,
  updateOutreachSettings,
  getUserPreferences,
  updateUserPreferences,
  getIntegrationFollowUpSettings,
  updateIntegrationFollowUpSettings,
} from '../controllers/settingsController.js';
import {
  getUserProfileHandler,
  updateUserProfileHandler,
  changePasswordHandler,
  getNotificationPreferencesHandler,
  updateNotificationPreferencesHandler,
} from '../controllers/userProfileController.js';
import {
  getBusinessProfiles,
  getBusinessProfile,
  createBusinessProfile,
  updateBusinessProfile,
  deleteBusinessProfile,
  archiveBusinessProfile,
  setDefaultBusinessProfile,
  getActiveBusinessCategories,
} from "../controllers/businessProfilesController.js";
import {
  getKnowledgeBaseEntries,
  getKnowledgeBaseEntry,
  getKnowledgeBaseExtractedText,
  createKnowledgeBaseEntry,
  updateKnowledgeBaseEntry,
  reprocessKnowledgeBaseFile,
  deleteKnowledgeBaseEntry,
  uploadKnowledgeBaseFile,
  uploadMiddleware,
  createQAEntry,
} from '../controllers/knowledgeBaseController.js';
import {
  listKnowledgeVersions,
  publishKnowledgeVersion,
  quarantineKnowledgeVersion,
  updateKnowledgeDraftScope, withdrawKnowledgeEntry, testKnowledgeRetrieval, createKnowledgeVersionDraft,
} from '../controllers/knowledgeGovernanceController.js';
import {
  getApiCredentialsSummary,
  getUserApiCredentials,
} from '../controllers/adminApiCredentialsController.js';
import {
  getMyStorageUsage,
  uploadMyFile,
  getMyFiles,
  deleteMyFile,
  deleteMyFiles,
  checkUploadAllowed,
  downloadMyFile,
  renameMyFile,
} from '../controllers/storageController.js';
import {
  adSettingsSchema,
  adAutonomySettingsSchema,
  getAdSettings,
  getAdAutonomySettings,
  updateAdSettings,
  updateAdAutonomySettings,
} from '../controllers/autonomousAdsController.js';
import {
  createSupportMediaGallery,
  downloadSupportMediaAsset,
  getSupportMediaGallery,
  listSupportMediaGalleries,
  replaceSupportMediaAsset,
  retireSupportMediaGallery,
  retireSupportMediaAsset,
  retrySupportMediaScans,
  reviewSupportMediaAsset,
  listUncertainMediaDeliveries,
  reconcileMediaDelivery,
  retryMediaDelivery,
  supportMediaReplaceUpload,
  supportMediaUpload,
  updateSupportMediaAsset,
  updateSupportMediaGallery,
  uploadSupportMediaAssets,
} from '../controllers/supportMediaGalleryController.js';

import {
  getStorageWorkspace,
  getStorageWorkspaceFiles,
  getStorageWorkspaceFile,
  changeStorageWorkspace,
  getStorageActorFolders,
  getStorageActivity,
  streamStorageFile,
  getStorageThumbnail,
  createStorageDownload,
  redeemStorageDownload,
} from "../controllers/storageWorkspaceController.js";

const router = Router();
const storageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

router.get("/storage/download-ticket", redeemStorageDownload);

router.use(authenticateToken);
// These aliases share the canonical domain's availability policy. Keep the
// guards before upload middleware and every read/write handler in the subtree.
router.use('/knowledge-base', requireModuleAccess('knowledge_base'));
router.use('/storage', requireModuleAccess('storage'));
router.use('/outreach/assistants', outreachAssistantsRouter);

// Owner-managed customer document publication. Uploading bytes alone never approves sharing.
router.get('/support-documents', listSupportDocuments);
router.post('/support-documents', createSupportDocument);
router.put('/support-documents/:id', updateSupportDocument);
router.post('/support-documents/:id/publish', publishSupportDocument);
router.post('/support-documents/:id/withdraw', withdrawSupportDocument);
router.get('/support-documents/:id/content', downloadSupportDocument);

// ─── User Profile ───────────────────────────────────────────────────────────────
router.get('/profile', getUserProfileHandler);
router.put('/profile', updateUserProfileHandler);
router.post('/profile/change-password', changePasswordHandler);
router.get('/profile/notification-preferences', getNotificationPreferencesHandler);
router.put('/profile/notification-preferences', updateNotificationPreferencesHandler);

// ─── Settings ───────────────────────────────────────────────────────────────────
router.get('/leads', getLeadSettings);
router.put('/leads', updateLeadSettings);
router.get('/outreach', getOutreachSettings);
router.get('/outreach/email-designs', getEmailDesignSettings);
router.put('/outreach/email-designs', requireBusinessManager, updateEmailDesignSettings);
router.put('/outreach', updateOutreachSettings);
router.get('/ads', requireModuleAccess('performance_marketing'), getAdSettings);
router.put('/ads', requireModuleAccess('performance_marketing'), validateBody(adSettingsSchema), updateAdSettings);
router.get('/ads/autonomy', requireModuleAccess('performance_marketing'), getAdAutonomySettings);
router.put('/ads/autonomy', requireModuleAccess('performance_marketing'), validateBody(adAutonomySettingsSchema), updateAdAutonomySettings);
router.get('/preferences', getUserPreferences);
router.put('/preferences', updateUserPreferences);
router.get('/integrations/:integrationKey/follow-ups', getIntegrationFollowUpSettings);
router.put('/integrations/:integrationKey/follow-ups', updateIntegrationFollowUpSettings);

// ─── Business Profiles ──────────────────────────────────────────────────────────
router.get('/business-profiles', getBusinessProfiles);
router.get('/business-profiles/invitations', getBusinessInvitations);
router.post('/business-profiles/invitations/:invitationId/accept', acceptBusinessStaffInvitation);
router.get('/business-profiles/:id/members', getBusinessStaff);
router.post('/business-profiles/:id/members', addBusinessStaff);
router.patch('/business-profiles/:id/members/:membershipId', updateBusinessStaff);
router.delete('/business-profiles/:id/members/:membershipId', removeBusinessStaff);
router.get('/business-profiles/:id', validateParams(commonSchemas.id), getBusinessProfile);
router.post('/business-profiles', validateBody(createBusinessProfileSchema, { strict: false }), createBusinessProfile);
router.put('/business-profiles/:id', validateParams(commonSchemas.id), validateBody(businessProfileSchema, { strict: false }), updateBusinessProfile);
router.delete('/business-profiles/:id', validateParams(commonSchemas.id), deleteBusinessProfile);
router.post(
  "/business-profiles/:id/archive",
  validateParams(commonSchemas.id),
  archiveBusinessProfile,
);
router.post(
  "/business-profiles/:id/restore",
  validateParams(commonSchemas.id),
  archiveBusinessProfile,
);
router.post('/business-profiles/:id/default', validateParams(commonSchemas.id), setDefaultBusinessProfile);

// ─── Business Categories (public - for setup page selection) ─────────────────
router.get('/business-categories', getActiveBusinessCategories);


// ─── Knowledge Base ─────────────────────────────────────────────────────────────
router.get('/knowledge-base', getKnowledgeBaseEntries);
router.post('/knowledge-base/test-retrieval', testKnowledgeRetrieval);
router.get('/knowledge-base/:id', getKnowledgeBaseEntry);
router.get('/knowledge-base/:id/extracted-text', getKnowledgeBaseExtractedText);
router.get('/knowledge-base/:id/versions', listKnowledgeVersions);
router.post('/knowledge-base/:id/versions/:versionId/publish', publishKnowledgeVersion);
router.post('/knowledge-base/:id/versions/:versionId/quarantine', quarantineKnowledgeVersion);
router.put('/knowledge-base/:id/versions/:versionId/scope', updateKnowledgeDraftScope);
router.post('/knowledge-base/:id/versions/:versionId/draft', createKnowledgeVersionDraft);
router.post('/knowledge-base/:id/withdraw', withdrawKnowledgeEntry);
router.post('/knowledge-base/:id/reprocess', reprocessKnowledgeBaseFile);
router.post('/knowledge-base', createKnowledgeBaseEntry);
router.put('/knowledge-base/:id', updateKnowledgeBaseEntry);
router.delete('/knowledge-base/:id', deleteKnowledgeBaseEntry);
router.post('/knowledge-base/upload', preserveAsyncContext(uploadMiddleware), uploadKnowledgeBaseFile);
router.post('/knowledge-base/qa', createQAEntry);

// ─── Governed Support Media Galleries ────────────────────────────────────────
router.get('/media-galleries', listSupportMediaGalleries);
router.get('/media-deliveries/uncertain', listUncertainMediaDeliveries);
router.post('/media-deliveries/:partId/reconcile', reconcileMediaDelivery);
router.post('/media-deliveries/:partId/retry', retryMediaDelivery);
router.post('/media-galleries', createSupportMediaGallery);
router.get('/media-galleries/assets/:assetId/content', downloadSupportMediaAsset);
router.get('/media-galleries/:id', getSupportMediaGallery);
router.put('/media-galleries/:id', updateSupportMediaGallery);
router.post('/media-galleries/:id/images', supportMediaUpload, uploadSupportMediaAssets);
router.patch('/media-galleries/:id/assets/:assetId', updateSupportMediaAsset);
router.post('/media-galleries/:id/assets/:assetId/review', reviewSupportMediaAsset);
router.post('/media-galleries/:id/assets/:assetId/replace', supportMediaReplaceUpload, replaceSupportMediaAsset);
router.delete('/media-galleries/:id/assets/:assetId', retireSupportMediaAsset);
router.post('/media-galleries/:id/retry-scans', retrySupportMediaScans);
router.delete('/media-galleries/:id', retireSupportMediaGallery);

// ─── API Credentials ────────────────────────────────────────────────────────────
router.get('/api-credentials/summary', getApiCredentialsSummary);
router.get('/api-credentials', getUserApiCredentials);

// ─── Storage ────────────────────────────────────────────────────────────────────
router.get("/storage/workspace", getStorageWorkspace);
router.get("/storage/workspace/files", getStorageWorkspaceFiles);
router.get("/storage/workspace/files/:fileId", getStorageWorkspaceFile);
router.post("/storage/workspace/actions", changeStorageWorkspace);
router.get("/storage/workspace/folders", getStorageActorFolders);
router.get("/storage/workspace/activity", getStorageActivity);
router.get("/storage/workspace/files/:fileId/content", streamStorageFile);
router.get("/storage/workspace/files/:fileId/thumbnail", getStorageThumbnail);
router.post("/storage/workspace/download", createStorageDownload);

// ─── Storage ────────────────────────────────────────────────────────────────────
router.get('/storage/usage', getMyStorageUsage);
router.post('/storage/files', preserveAsyncContext(storageUpload.single('file')), uploadMyFile);
router.get('/storage/files', getMyFiles);
router.get('/storage/files/:fileId/download', downloadMyFile);
router.patch('/storage/files/:fileId', renameMyFile);
router.get('/storage/check-upload', checkUploadAllowed);
router.delete('/storage/files/:fileId', deleteMyFile);
router.post('/storage/files/bulk-delete', deleteMyFiles);

export default router;
