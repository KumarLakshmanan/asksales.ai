import { adminProposalTemplateSchema, listAdminProposalTemplates, saveAdminProposalTemplate, getAdminProposalTemplateHistory, rollbackAdminProposalTemplate, rollbackProposalTemplateSchema } from '../controllers/adminProposalTemplateController.js';
import { getInsightsReadiness } from '../services/insights/ReadinessService.js';
import { clearInsightsRuntimeCache } from '../services/insights/RuntimeService.js';
import { saveVerifiedPricingOverride } from '../services/insights/AdminPricingOverrides.js';
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { withSystemScope } from '../tenancy/businessContext.js';
import { adminUserCreateSchema, adminUserUpdateSchema, adminManagementIdSchema } from '../utils/adminManagementValidation.js';
/**
 * Admin Routes Module
 * All admin-scoped endpoints with admin token authentication
 */

import { Router } from 'express';
import { authenticateAdminToken, requireSuperAdmin } from '../middleware/auth.js';
import { validateBody, validateParams } from '../middleware/validation.js';
import { authRateLimiter, credentialsRateLimiter } from '../middleware/rateLimiter.js';
import {
  adminLoginSchema,
  addCreditsSchema,
  adminBootstrapSchema,
  adminResetPasswordSchema,
  forgotPasswordSchema,
  adminCreateSchema,
  adminUpdateSchema,
  adminCreateCampaignSchema,
  idParamSchema,
  userThreadIdParamSchema,
  threadIdParamSchema,
  changePasswordSchema,
  resetMemberPasswordSchema,
} from '../middleware/schemas.js';
import { getAvailableActors } from '../controllers/actorsController.js';
import {
  getAdminWorkflowsHandler,
  createWorkflowHandler,
  updateWorkflowHandler,
  deleteWorkflowHandler,
  executeAdminWorkflowHandler,
} from '../controllers/leadflowController.js';

// Admin auth
import {
  bootstrapAdmin, loginAdmin, forgotAdminPassword, resetAdminPassword,
  getCurrentAdmin, updateCurrentAdminProfile, logoutAdmin,
} from '../controllers/adminController.js';

// Admin management
import {
  getAdmins, getUsers, createAdminHandler, createUserHandler,
  getAdminByIdHandler, updateAdminHandler, deleteAdminHandler,
  getUserHandler, updateUserHandler, deleteUserHandler,
  getChatMessagesHandler as getAdminChatMessagesHandler,
  getAllUserContentHandler, getAllBrandToolkitsHandler,
  getAllOutreachConversationsHandler, getAllContentTemplatesHandler,
  getAllAdsHandler, getContentStatsHandler,
  verifyUserHandler, approveUserHandler, rejectUserHandler,
  getAdminLeadsHandler, exportAdminLeadsHandler, getUserCampaignsHandler, getUserStatsHandler,
  getAdminCampaignsHandler, getUserChatsHandler, getUserChatMessagesHandler,
  getUserLeadsHandler, getUserICPsHandler, getUserContentHandler,
  getUserBrandToolkitsHandler, getUserTemplatesHandler, getUserAdsHandler,
  getUserOutreachHandler, getUserKnowledgeBaseHandler, updateUserPasswordHandler, changeAdminPasswordHandler,
  deleteAdminCampaignHandler, createAdminCampaignHandler,
  deleteAdminLeadHandler, createAdminLeadHandler,
  getAdminContentTemplatesHandler, getAdminBrandToolkitsHandler,
  getAdminContentCalendarHandler, getAdminOutreachByChannelHandler,
  getAdminOutreachConversationMessagesHandler,
  createPredefinedTemplateHandler, updatePredefinedTemplateHandler,
  deletePredefinedTemplateHandler, getPredefinedTemplatesHandler,
} from '../controllers/adminManagementController.js';

// Dashboard
import { getAdminDashboardStats, getAdminUsageOverview } from '../controllers/dashboardController.js';

// Admin integrations (old system integrations controller is at /api/admin/integrations/system via routes.ts)
import adminSystemIntegrationsRoutes from '../controllers/adminIntegrationsController.js';
import { getAdminAssistantModels, saveAdminAssistantModel } from '../controllers/adminAssistantModelsController.js';
import {
  createIntegration,
  deleteIntegration,
  getAllIntegrations,
  getApifyBalances,
  getIntegration,
  getIntegrationFull,
  getIntegrationStats,
  getIntegrationAudit,
  getResendDomains,
  testIntegration,
  toggleIntegration,
  updateIntegration,
  validateApiKey,
} from '../controllers/adminIntegrationsNewController.js';
import {
  getMetaConfig,
  getMetaConfigFull,
  getMetaConnections,
  getMetaHealth,
  getMetaStats,
  getWebhookLogs,
  saveMetaConfig,
} from '../controllers/adminMetaController.js';

// API Credentials
import {
  getAllApiCredentials, getApiCredentialsSummary, toggleApiCredential,
  deleteApiCredential, createSystemCredential, getUserApiCredentials,
} from '../controllers/adminApiCredentialsController.js';

// Usage controllers
import { getAllOpenAIUsageHandler, getMyOpenAIUsageSummaryHandler } from '../controllers/openaiUsageController.js';
import { getAllApifyUsageHandler, getApifyUsageSummaryHandler } from '../controllers/adminApifyUsageController.js';
import { getGeminiUsage, getGeminiUsageStats } from '../controllers/adminGeminiUsageController.js';
import { getZerobounceUsage, getZerobounceUsageStats } from '../controllers/adminZerobounceUsageController.js';
import {
  getApifyUsageDetailed,
  getGeminiUsageDetailed,
  getLLMUsage,
  getPlatformUsage,
  getZerobounceUsageDetailed,
} from '../controllers/adminUsageController.js';
import { getEmbeddingUsage, getEmbeddingUsageStats } from '../controllers/adminEmbeddingUsageController.js';
import { getUserUsageStats } from '../controllers/adminUserUsageController.js';
import { getAdminWebhookLogs } from '../controllers/integrationWebhookLogsController.js';

// Infrastructure
import { getInfrastructureStatus, getQueueMetrics, getDetailedHealth } from '../controllers/infrastructureController.js';

// Credit pricing & wallet management
import {
  getCreditPricing, updateCreditPricing, bulkUpdateCreditPricing, seedPricing,
  getAllWallets, getUserWallet, adminAddCredits, getAdminCreditEvents,
  getRazorpayConfig, saveRazorpayConfig, testRazorpayConfig,
  getGlobalCreditAnalytics, getGlobalDailyCredits, getTopCreditUsers,
  getGlobalProviderAnalytics, getAdminUserCreditAnalytics,
} from '../controllers/adminCreditController.js';

// API pricing
import {
  getApiPricing,
  updateApiPricingSingle,
  bulkUpdateApiPricingHandler,
  createApiPricingEntry,
  deleteApiPricingEntry,
  getGenaiModelPrice,
  getGenaiProviderModels,
  getImagePricingReferenceHandler,
  getVideoPricingReferenceHandler,
} from '../controllers/adminApiPricingController.js';
import { getPricingAudit } from '../controllers/adminPricingAuditController.js';
import { getUnifiedAdminAudit } from '../controllers/adminAuditController.js';
import {
  getAdminPlatformControls,
  getAdminUserModuleAccess,
  updateAdminPlatformControls,
  updateAdminUserModuleAccess,
} from '../controllers/platformAccessController.js';
import { listClassifierIntegrations, getClassifierIntegration, createClassifierIntegration,
  updateClassifierIntegration, toggleClassifierIntegration, deleteClassifierIntegration,
  testClassifierIntegration, getClassifierAudit } from '../controllers/adminIntentClassifierIntegrationsController.js';

// Revenue analytics
import {
  getRevenueSummaryEndpoint,
  getDailyRevenueEndpoint,
  getRevenueDrillDown,
  getRevenueTransactionsEndpoint,
} from '../controllers/adminRevenueController.js';

// System logs
import {
  getSystemLogsHandler,
  getSystemLogStatsHandler,
  clearSystemLogsHandler,
} from '../controllers/systemLogsController.js';

// Admin notifications
import {
  getAdminNotificationsHandler,
  getUnreadCountHandler,
  markReadHandler,
  markAllReadHandler,
  deleteNotificationHandler,
} from '../controllers/adminNotificationController.js';

// Queue management
import {
  listQueues, listQueueJobs, retryJob, removeJob,
  pauseQueue, resumeQueue, cleanQueue,
} from '../controllers/adminQueueController.js';

// Business Profile Categories
import {
  getCategories, getCategoryById, createCategory, updateCategory, deleteCategory,
  getSubcategories, createSubcategory, updateSubcategory, deleteSubcategory,
} from '../controllers/adminBusinessCategoriesController.js';

// Storage management
import {
  getStorageDashboardStats,
  getStoragePlans, createStoragePlan, updateStoragePlan, deleteStoragePlan,
  getStoragePricing, updateStoragePricing, createStoragePricing,
  getAllStorageQuotas, getUserStorageDetail, setUserStorageLimit, setUserStoragePlan,
  recalculateUserStorage, getUserFiles, adminDeleteFile, adminBulkDeleteFiles,
} from '../controllers/adminStorageController.js';

import {
  getAdminPoliciesHandler,
  createAdminPolicyHandler,
  updateAdminPolicyHandler,
  deleteAdminPolicyHandler,
  getAccountDeletionRequestsHandler,
  updateAccountDeletionRequestHandler,
} from '../controllers/adminLegalController.js';
import {
  createAdminSupportPlaybookTemplate,
  listAdminSupportPlaybookTemplates,
  updateAdminSupportPlaybookTemplate,
  listAdminSupportAgentTemplates,
  updateAdminSupportAgentTemplate,
} from '../controllers/adminSupportPlaybookTemplateController.js';

import {
  getWhatsAppBillingOverview, listWhatsAppRateCards, previewWhatsAppRateCard, saveWhatsAppRateCard, updateWhatsAppRate,
  deleteWhatsAppRateCardVersion, listWhatsAppMarkets, previewWhatsAppMarkets, saveWhatsAppMarkets, deleteWhatsAppMarket,
  listWhatsAppBillingAccounts, saveWhatsAppBillingAccount, attachWhatsAppCreditLine, revokeWhatsAppCreditLine,
  listWhatsAppCharges, resolveWhatsAppChargeHandler, listWhatsAppReconciliation, runWhatsAppReconciliation,
  getWhatsAppCreditLineSettings, saveWhatsAppCreditLineSettings, testWhatsAppCreditLineSettings,
  listWhatsAppRateTiers, previewWhatsAppRateTiers, saveWhatsAppRateTiers, deleteWhatsAppRateTierVersion,
  getWhatsAppStatement, saveWhatsAppInvoiceHandler,
} from '../controllers/adminWhatsAppBillingController.js';
const router = Router();

// ─── Public admin auth ───────────────────────────────────────────────────────
router.post('/bootstrap', authRateLimiter, validateBody(adminBootstrapSchema), bootstrapAdmin);
router.post('/login', authRateLimiter, validateBody(adminLoginSchema), loginAdmin);
router.post('/logout', logoutAdmin);
router.post('/forgot-password', authRateLimiter, validateBody(forgotPasswordSchema), forgotAdminPassword);
router.post('/reset-password', authRateLimiter, validateBody(adminResetPasswordSchema), resetAdminPassword);

// ─── Protected admin routes ──────────────────────────────────────────────────
router.get('/me', authenticateAdminToken, getCurrentAdmin);
router.put('/profile', authenticateAdminToken, updateCurrentAdminProfile);

// Admin CRUD
router.get('/admins', authenticateAdminToken, getAdmins);
router.get('/admins/:id', authenticateAdminToken, validateParams(adminManagementIdSchema), getAdminByIdHandler);
router.post('/admins', authenticateAdminToken, requireSuperAdmin, validateBody(adminCreateSchema), createAdminHandler);
router.put('/admins/:id', authenticateAdminToken, requireSuperAdmin, validateParams(adminManagementIdSchema), validateBody(adminUpdateSchema), updateAdminHandler);
router.delete('/admins/:id', authenticateAdminToken, requireSuperAdmin, validateParams(adminManagementIdSchema), deleteAdminHandler);

// User management
router.get('/users', authenticateAdminToken, getUsers);
router.get('/users/:id', authenticateAdminToken, validateParams(adminManagementIdSchema), getUserHandler);
router.post('/users', authenticateAdminToken, validateBody(adminUserCreateSchema), createUserHandler);
router.put('/users/:id', authenticateAdminToken, validateParams(adminManagementIdSchema), validateBody(adminUserUpdateSchema), updateUserHandler);
router.delete('/users/:id', authenticateAdminToken, validateParams(adminManagementIdSchema), deleteUserHandler);
router.post('/users/:id/verify', authenticateAdminToken, validateParams(adminManagementIdSchema), verifyUserHandler);
router.post('/users/:id/approve', authenticateAdminToken, validateParams(adminManagementIdSchema), approveUserHandler);
router.post('/users/:id/reject', authenticateAdminToken, validateParams(adminManagementIdSchema), rejectUserHandler);
router.put('/users/:id/password', authenticateAdminToken, requireSuperAdmin, validateParams(adminManagementIdSchema), validateBody(resetMemberPasswordSchema), updateUserPasswordHandler);
router.get('/users/:id/modules', authenticateAdminToken, requireSuperAdmin, getAdminUserModuleAccess);
router.put('/users/:id/modules', authenticateAdminToken, requireSuperAdmin, updateAdminUserModuleAccess);

// Global maintenance and module readiness controls are super-admin only.
router.get('/platform-access', authenticateAdminToken, requireSuperAdmin, getAdminPlatformControls);
router.put('/platform-access', authenticateAdminToken, requireSuperAdmin, updateAdminPlatformControls);

// User drill-down
router.get('/users/:id/stats', authenticateAdminToken, getUserStatsHandler);
router.get('/users/:id/campaigns', authenticateAdminToken, validateParams(idParamSchema), getUserCampaignsHandler);
router.get('/users/:id/chats', authenticateAdminToken, validateParams(idParamSchema), getUserChatsHandler);
router.get('/users/:id/chats/:threadId/messages', authenticateAdminToken, validateParams(userThreadIdParamSchema), getUserChatMessagesHandler);
router.get('/users/:id/leads', authenticateAdminToken, getUserLeadsHandler);
router.get('/users/:id/icps', authenticateAdminToken, getUserICPsHandler);
router.get('/users/:id/content', authenticateAdminToken, getUserContentHandler);
router.get('/users/:id/brand-toolkits', authenticateAdminToken, getUserBrandToolkitsHandler);
router.get('/users/:id/templates', authenticateAdminToken, getUserTemplatesHandler);
router.get('/users/:id/ads', authenticateAdminToken, validateParams(idParamSchema), getUserAdsHandler);
router.get('/users/:id/knowledge-base', authenticateAdminToken, getUserKnowledgeBaseHandler);
router.get('/users/:id/outreach/:channel', authenticateAdminToken, getUserOutreachHandler);
router.get('/users/:id/outreach', authenticateAdminToken, getUserOutreachHandler);

// Admin password
router.post('/change-password', authenticateAdminToken, validateBody(changePasswordSchema), changeAdminPasswordHandler);

// Dashboard
router.get('/dashboard/stats', authenticateAdminToken, getAdminDashboardStats);
router.get('/dashboard/usage', authenticateAdminToken, getAdminUsageOverview);
router.get('/usage/overview', authenticateAdminToken, getAdminUsageOverview);

// All-resource views
router.get('/all-content', authenticateAdminToken, getAllUserContentHandler);
router.get('/all-brand-toolkits', authenticateAdminToken, getAllBrandToolkitsHandler);
router.get('/all-outreach-conversations', authenticateAdminToken, getAllOutreachConversationsHandler);
router.get('/all-content-templates', authenticateAdminToken, getAllContentTemplatesHandler);
router.get('/all-ads', authenticateAdminToken, getAllAdsHandler);

// Predefined templates management
router.get('/predefined-templates', authenticateAdminToken, getPredefinedTemplatesHandler);
router.post('/predefined-templates', authenticateAdminToken, createPredefinedTemplateHandler);
router.put('/predefined-templates/:id', authenticateAdminToken, updatePredefinedTemplateHandler);
router.delete('/predefined-templates/:id', authenticateAdminToken, deletePredefinedTemplateHandler);
router.get('/proposal-templates', authenticateAdminToken, listAdminProposalTemplates);
router.get('/proposal-templates/:id/history', authenticateAdminToken, getAdminProposalTemplateHistory);
router.post('/proposal-templates/:id/rollback', authenticateAdminToken, requireSuperAdmin, validateBody(rollbackProposalTemplateSchema), rollbackAdminProposalTemplate);
router.post('/proposal-templates', authenticateAdminToken, requireSuperAdmin, validateBody(adminProposalTemplateSchema), saveAdminProposalTemplate);
router.put('/proposal-templates/:id', authenticateAdminToken, requireSuperAdmin, validateBody(adminProposalTemplateSchema), saveAdminProposalTemplate);

router.get('/support-playbook-templates', authenticateAdminToken, listAdminSupportPlaybookTemplates);
router.post('/support-playbook-templates', authenticateAdminToken, requireSuperAdmin, createAdminSupportPlaybookTemplate);
router.put('/support-playbook-templates/:templateKey', authenticateAdminToken, requireSuperAdmin, updateAdminSupportPlaybookTemplate);
router.get('/support-agent-templates', authenticateAdminToken, listAdminSupportAgentTemplates);
router.put('/support-agent-templates/:agentType', authenticateAdminToken, requireSuperAdmin, updateAdminSupportAgentTemplate);
router.get('/policies', authenticateAdminToken, getAdminPoliciesHandler);
router.post('/policies', authenticateAdminToken, requireSuperAdmin, createAdminPolicyHandler);
router.put('/policies/:id', authenticateAdminToken, requireSuperAdmin, updateAdminPolicyHandler);
router.delete('/policies/:id', authenticateAdminToken, requireSuperAdmin, deleteAdminPolicyHandler);
router.get('/account-deletion-requests', authenticateAdminToken, getAccountDeletionRequestsHandler);
router.patch('/account-deletion-requests/:id', authenticateAdminToken, updateAccountDeletionRequestHandler);
router.get('/content/stats', authenticateAdminToken, getContentStatsHandler);
router.get('/leads', authenticateAdminToken, getAdminLeadsHandler);
router.get('/leads/export', authenticateAdminToken, exportAdminLeadsHandler);
router.get('/campaigns', authenticateAdminToken, getAdminCampaignsHandler);
router.get('/chat-messages/:threadId', authenticateAdminToken, validateParams(threadIdParamSchema), getAdminChatMessagesHandler);

// Admin CRUD for campaigns/leads
router.post('/campaigns', authenticateAdminToken, validateBody(adminCreateCampaignSchema), createAdminCampaignHandler);
router.delete('/campaigns/:id', authenticateAdminToken, validateParams(idParamSchema), deleteAdminCampaignHandler);
router.post('/leads', authenticateAdminToken, createAdminLeadHandler);
router.delete('/leads/:id', authenticateAdminToken, deleteAdminLeadHandler);

// More admin views
router.get('/content-templates', authenticateAdminToken, getAdminContentTemplatesHandler);
router.get('/brand-toolkits', authenticateAdminToken, getAdminBrandToolkitsHandler);
router.get('/content-calendar', authenticateAdminToken, getAdminContentCalendarHandler);
router.get('/outreach/:channel', authenticateAdminToken, getAdminOutreachByChannelHandler);
router.get('/outreach-conversations/:conversationId/messages', authenticateAdminToken, getAdminOutreachConversationMessagesHandler);

// API Credentials management
router.get('/api-credentials', authenticateAdminToken, getAllApiCredentials);
router.get('/api-credentials/summary', authenticateAdminToken, getApiCredentialsSummary);
router.put('/api-credentials/:id/toggle', authenticateAdminToken, requireSuperAdmin, validateParams(idParamSchema), toggleApiCredential);
router.post('/api-credentials/:id/toggle', authenticateAdminToken, requireSuperAdmin, validateParams(idParamSchema), toggleApiCredential);
router.delete('/api-credentials/:id', authenticateAdminToken, requireSuperAdmin, validateParams(idParamSchema), deleteApiCredential);
router.post('/api-credentials/system', authenticateAdminToken, requireSuperAdmin, createSystemCredential);
router.get('/api-credentials/user/:userId', authenticateAdminToken, getUserApiCredentials);
router.get('/users/:userId/api-credentials', authenticateAdminToken, getUserApiCredentials);
router.get('/users/:userId/usage', authenticateAdminToken, getUserUsageStats);

// Normalized paginated usage contracts consumed by the admin UI.
router.get('/usage/llm', authenticateAdminToken, getLLMUsage);
router.get('/usage/apify', authenticateAdminToken, getApifyUsageDetailed);
router.get('/usage/gemini', authenticateAdminToken, getGeminiUsageDetailed);
router.get('/usage/zerobounce', authenticateAdminToken, getZerobounceUsageDetailed);
router.get('/usage/embeddings', authenticateAdminToken, getEmbeddingUsage);
router.get('/usage/platform', authenticateAdminToken, getPlatformUsage);

// Provider-specific compatibility endpoints.
router.get('/usage/openai', authenticateAdminToken, getAllOpenAIUsageHandler);
router.get('/usage/apify/summary', authenticateAdminToken, getApifyUsageSummaryHandler);
router.get('/usage/gemini/stats', authenticateAdminToken, getGeminiUsageStats);
router.get('/usage/zerobounce/stats', authenticateAdminToken, getZerobounceUsageStats);
router.get('/openai-usage', authenticateAdminToken, getAllOpenAIUsageHandler);
router.get('/openai-usage/summary', authenticateAdminToken, getMyOpenAIUsageSummaryHandler);
router.get('/apify-usage', authenticateAdminToken, getAllApifyUsageHandler);
router.get('/apify-usage/summary', authenticateAdminToken, getApifyUsageSummaryHandler);
router.get('/gemini-usage', authenticateAdminToken, getGeminiUsage);
router.get('/gemini-usage/stats', authenticateAdminToken, getGeminiUsageStats);
router.get('/zerobounce-usage', authenticateAdminToken, getZerobounceUsage);
router.get('/zerobounce-usage/stats', authenticateAdminToken, getZerobounceUsageStats);
router.get('/embedding-usage', authenticateAdminToken, getEmbeddingUsage);
router.get('/embedding-usage/stats', authenticateAdminToken, getEmbeddingUsageStats);

router.use('/integrations/system', authenticateAdminToken, requireSuperAdmin, adminSystemIntegrationsRoutes);
router.get('/meta/config', authenticateAdminToken, getMetaConfig);
router.get('/meta/config/full', authenticateAdminToken, requireSuperAdmin, getMetaConfigFull);
router.post('/meta/config', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, saveMetaConfig);
router.get('/meta/connections', authenticateAdminToken, getMetaConnections);
router.get('/meta/stats', authenticateAdminToken, getMetaStats);
router.get('/meta/health', authenticateAdminToken, getMetaHealth);
router.get('/meta/webhook-logs', authenticateAdminToken, getWebhookLogs);
router.get('/webhook-logs', authenticateAdminToken, getAdminWebhookLogs);

// Infrastructure monitoring (V2)
router.get('/infrastructure/status', authenticateAdminToken, getInfrastructureStatus);
router.get('/infrastructure/queues', authenticateAdminToken, getQueueMetrics);
router.get('/infrastructure/health', authenticateAdminToken, getDetailedHealth);

// Credit pricing management
router.get('/credit-pricing', authenticateAdminToken, getCreditPricing);
router.put('/credit-pricing/bulk', authenticateAdminToken, requireSuperAdmin, bulkUpdateCreditPricing);
router.put('/credit-pricing/:id', authenticateAdminToken, requireSuperAdmin, updateCreditPricing);

// WhatsApp platform billing (we pay Meta through a credit line and charge wallets)
const WA = '/whatsapp-billing';
router.get(`${WA}/overview`, authenticateAdminToken, getWhatsAppBillingOverview);
router.get(`${WA}/rate-cards`, authenticateAdminToken, listWhatsAppRateCards);
router.post(`${WA}/rate-cards/preview`, authenticateAdminToken, requireSuperAdmin, previewWhatsAppRateCard);
router.post(`${WA}/rate-cards`, authenticateAdminToken, requireSuperAdmin, saveWhatsAppRateCard);
router.put(`${WA}/rate-cards/:id`, authenticateAdminToken, requireSuperAdmin, updateWhatsAppRate);
router.post(`${WA}/rate-cards/delete-version`, authenticateAdminToken, requireSuperAdmin, deleteWhatsAppRateCardVersion);
router.get(`${WA}/tiers`, authenticateAdminToken, listWhatsAppRateTiers);
router.post(`${WA}/tiers/preview`, authenticateAdminToken, requireSuperAdmin, previewWhatsAppRateTiers);
router.post(`${WA}/tiers`, authenticateAdminToken, requireSuperAdmin, saveWhatsAppRateTiers);
router.post(`${WA}/tiers/delete-version`, authenticateAdminToken, requireSuperAdmin, deleteWhatsAppRateTierVersion);
router.get(`${WA}/statement`, authenticateAdminToken, getWhatsAppStatement);
router.put(`${WA}/statement/invoice`, authenticateAdminToken, requireSuperAdmin, saveWhatsAppInvoiceHandler);
router.get(`${WA}/markets`, authenticateAdminToken, listWhatsAppMarkets);
router.post(`${WA}/markets/preview`, authenticateAdminToken, requireSuperAdmin, previewWhatsAppMarkets);
router.post(`${WA}/markets`, authenticateAdminToken, requireSuperAdmin, saveWhatsAppMarkets);
router.delete(`${WA}/markets/:callingCode`, authenticateAdminToken, requireSuperAdmin, deleteWhatsAppMarket);
router.get(`${WA}/accounts`, authenticateAdminToken, listWhatsAppBillingAccounts);
router.put(`${WA}/accounts/:wabaId`, authenticateAdminToken, requireSuperAdmin, saveWhatsAppBillingAccount);
router.post(`${WA}/accounts/:wabaId/attach`, authenticateAdminToken, requireSuperAdmin, attachWhatsAppCreditLine);
router.post(`${WA}/accounts/:wabaId/revoke`, authenticateAdminToken, requireSuperAdmin, revokeWhatsAppCreditLine);
router.get(`${WA}/charges`, authenticateAdminToken, listWhatsAppCharges);
router.post(`${WA}/charges/:id/resolve`, authenticateAdminToken, requireSuperAdmin, resolveWhatsAppChargeHandler);
router.get(`${WA}/reconciliation`, authenticateAdminToken, listWhatsAppReconciliation);
router.post(`${WA}/reconciliation/run`, authenticateAdminToken, requireSuperAdmin, runWhatsAppReconciliation);
router.get(`${WA}/credit-line`, authenticateAdminToken, getWhatsAppCreditLineSettings);
router.put(`${WA}/credit-line`, authenticateAdminToken, requireSuperAdmin, saveWhatsAppCreditLineSettings);
router.post(`${WA}/credit-line/test`, authenticateAdminToken, requireSuperAdmin, testWhatsAppCreditLineSettings);
router.post('/credit-pricing/seed', authenticateAdminToken, requireSuperAdmin, seedPricing);

// Wallet management
router.get('/wallets', authenticateAdminToken, getAllWallets);
router.get('/wallets/:userId', authenticateAdminToken, getUserWallet);
router.post('/wallets/:userId/add-credits', authenticateAdminToken, requireSuperAdmin, validateBody(addCreditsSchema), adminAddCredits);

// Credit event logs
router.get('/credit-events', authenticateAdminToken, getAdminCreditEvents);

// Credit analytics
router.get('/credit-analytics/summary', authenticateAdminToken, getGlobalCreditAnalytics);
router.get('/credit-analytics/daily', authenticateAdminToken, getGlobalDailyCredits);
router.get('/credit-analytics/top-users', authenticateAdminToken, getTopCreditUsers);
router.get('/credit-analytics/providers', authenticateAdminToken, getGlobalProviderAnalytics);
router.get('/credit-analytics/user/:userId', authenticateAdminToken, getAdminUserCreditAnalytics);

// Razorpay integration
router.get('/integrations/razorpay', authenticateAdminToken, getRazorpayConfig);
router.put('/integrations/razorpay', authenticateAdminToken, requireSuperAdmin, saveRazorpayConfig);
router.post('/integrations/razorpay/test', authenticateAdminToken, requireSuperAdmin, testRazorpayConfig);

// Encrypted integration credentials. Keep named provider routes above the
// parameterized ID routes so "razorpay" can never be interpreted as an ID.
router.get('/intent-classifier-integrations', authenticateAdminToken, requireSuperAdmin, listClassifierIntegrations);
router.get('/intent-classifier-integrations/audit', authenticateAdminToken, requireSuperAdmin, getClassifierAudit);
router.get('/intent-classifier-integrations/:id/full', authenticateAdminToken, requireSuperAdmin, getClassifierIntegration);
router.post('/intent-classifier-integrations', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, createClassifierIntegration);
router.put('/intent-classifier-integrations/:id', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, updateClassifierIntegration);
router.post('/intent-classifier-integrations/:id/toggle', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, toggleClassifierIntegration);
router.post('/intent-classifier-integrations/:id/test', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, testClassifierIntegration);
router.delete('/intent-classifier-integrations/:id', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, deleteClassifierIntegration);
router.get('/integrations', authenticateAdminToken, getAllIntegrations);
router.get('/assistant-models', authenticateAdminToken, getAdminAssistantModels);
router.post('/assistant-models', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, saveAdminAssistantModel);
router.put('/assistant-models/:id', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, saveAdminAssistantModel);
router.get('/integrations/stats', authenticateAdminToken, getIntegrationStats);
router.get('/integrations/audit', authenticateAdminToken, requireSuperAdmin, getIntegrationAudit);
router.get('/integrations/apify/balance', authenticateAdminToken, getApifyBalances);
router.get('/integrations/resend-domains', authenticateAdminToken, getResendDomains);
router.post('/integrations/validate', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, validateApiKey);
router.get('/integrations/:id/full', authenticateAdminToken, requireSuperAdmin, getIntegrationFull);
router.get('/integrations/:id', authenticateAdminToken, getIntegration);
router.post('/integrations', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, createIntegration);
router.put('/integrations/:id', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, updateIntegration);
router.post('/integrations/:id/toggle', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, toggleIntegration);
router.post('/integrations/:id/test', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, testIntegration);
router.delete('/integrations/:id', authenticateAdminToken, requireSuperAdmin, credentialsRateLimiter, deleteIntegration);

// Leadflow actors (for admin integrations)
router.get('/leadflow/actors', authenticateAdminToken, getAvailableActors);

// Leadflow workflow management
router.get('/leadflow/workflows', authenticateAdminToken, getAdminWorkflowsHandler);
router.post('/leadflow/workflows', authenticateAdminToken, createWorkflowHandler);
router.put('/leadflow/workflows/:id', authenticateAdminToken, updateWorkflowHandler);
router.delete('/leadflow/workflows/:id', authenticateAdminToken, deleteWorkflowHandler);
router.post('/leadflow/workflows/:id/execute', authenticateAdminToken, executeAdminWorkflowHandler);

// API pricing management
router.get('/insights/readiness', authenticateAdminToken, requireSuperAdmin, async (_req,res) => {
  try { return res.json(await getInsightsReadiness()); }
  catch { return res.status(503).json({error:'Insights readiness check is unavailable.'}); }
});
router.post('/insights/pricing-overrides', authenticateAdminToken, requireSuperAdmin, async (req,res) => {
  try { return res.json({success:true,data:await saveVerifiedPricingOverride(req.body,Number(req.user?.id))}); }
  catch(error) {
    if(error instanceof Error && /required|must|invalid|Choose|supported/i.test(error.message))return res.status(400).json({error:error.message});
    return res.status(500).json({error:'Unable to save pricing override.'});
  }
});
router.post('/insights/activate', authenticateAdminToken, requireSuperAdmin, async (_req,res) => {
  try {
    const readiness=await getInsightsReadiness();
    if(!readiness.ready) return res.status(409).json({error:'Verify all active prices and reconcile ledger totals before activation.',readiness});
    await withSystemScope('Activate validated Insights and missing-price guard',()=>db.execute(sql`
      UPDATE workspace_insights_runtime SET enabled=true,pricing_guard_enabled=true,updated_at=now() WHERE id=1`));
    clearInsightsRuntimeCache();
    return res.json({activated:true,readiness});
  } catch { return res.status(503).json({error:'Insights activation is unavailable.'}); }
});
router.get('/pricing-audit', authenticateAdminToken, requireSuperAdmin, getPricingAudit);
router.get('/audit-logs', authenticateAdminToken, requireSuperAdmin, getUnifiedAdminAudit);
router.get('/api-pricing/genai-model-price', authenticateAdminToken, getGenaiModelPrice);
router.get('/api-pricing/genai-provider-models', authenticateAdminToken, getGenaiProviderModels);
router.get('/api-pricing/image-pricing-reference', authenticateAdminToken, getImagePricingReferenceHandler);
router.get('/api-pricing/video-pricing-reference', authenticateAdminToken, getVideoPricingReferenceHandler);
router.get('/api-pricing', authenticateAdminToken, getApiPricing);
router.post('/api-pricing', authenticateAdminToken, requireSuperAdmin, createApiPricingEntry);
router.put('/api-pricing/bulk', authenticateAdminToken, requireSuperAdmin, bulkUpdateApiPricingHandler);
router.put('/api-pricing/:id', authenticateAdminToken, requireSuperAdmin, updateApiPricingSingle);
router.delete('/api-pricing/:id', authenticateAdminToken, requireSuperAdmin, deleteApiPricingEntry);

// Revenue analytics
router.get('/revenue/summary', authenticateAdminToken, getRevenueSummaryEndpoint);
router.get('/revenue/daily', authenticateAdminToken, getDailyRevenueEndpoint);
router.get('/revenue/drill-down', authenticateAdminToken, getRevenueDrillDown);
router.get('/revenue/transactions', authenticateAdminToken, getRevenueTransactionsEndpoint);

// System logs
router.get('/system-logs', authenticateAdminToken, getSystemLogsHandler);
router.get('/system-logs/stats', authenticateAdminToken, getSystemLogStatsHandler);
router.delete('/system-logs', authenticateAdminToken, requireSuperAdmin, clearSystemLogsHandler);

// ─── Storage Management ──────────────────────────────────────────────────────
router.get('/storage/dashboard', authenticateAdminToken, getStorageDashboardStats);

// Storage plans
router.get('/storage/plans', authenticateAdminToken, getStoragePlans);
router.post('/storage/plans', authenticateAdminToken, requireSuperAdmin, createStoragePlan);
router.put('/storage/plans/:id', authenticateAdminToken, requireSuperAdmin, updateStoragePlan);
router.delete('/storage/plans/:id', authenticateAdminToken, requireSuperAdmin, deleteStoragePlan);

// Storage pricing
router.get('/storage/pricing', authenticateAdminToken, getStoragePricing);
router.post('/storage/pricing', authenticateAdminToken, requireSuperAdmin, createStoragePricing);
router.put('/storage/pricing/:id', authenticateAdminToken, requireSuperAdmin, updateStoragePricing);

// User quotas
router.get('/storage/quotas', authenticateAdminToken, getAllStorageQuotas);
router.get('/storage/users/:userId', authenticateAdminToken, getUserStorageDetail);
router.put('/storage/users/:userId/limit', authenticateAdminToken, requireSuperAdmin, setUserStorageLimit);
router.put('/storage/users/:userId/plan', authenticateAdminToken, requireSuperAdmin, setUserStoragePlan);
router.post('/storage/users/:userId/recalculate', authenticateAdminToken, requireSuperAdmin, recalculateUserStorage);
router.get('/storage/users/:userId/files', authenticateAdminToken, getUserFiles);
router.delete('/storage/users/:userId/files/:fileId', authenticateAdminToken, requireSuperAdmin, adminDeleteFile);
router.post('/storage/users/:userId/files/bulk-delete', authenticateAdminToken, requireSuperAdmin, adminBulkDeleteFiles);

// ─── Business Profile Categories ─────────────────────────────────────────────
router.get('/business-categories', authenticateAdminToken, getCategories);
router.get('/business-categories/:id', authenticateAdminToken, getCategoryById);
router.post('/business-categories', authenticateAdminToken, createCategory);
router.put('/business-categories/:id', authenticateAdminToken, updateCategory);
router.delete('/business-categories/:id', authenticateAdminToken, deleteCategory);

// Subcategories
router.get('/business-categories/:categoryId/subcategories', authenticateAdminToken, getSubcategories);
router.post('/business-categories/:categoryId/subcategories', authenticateAdminToken, createSubcategory);
router.put('/business-categories/:categoryId/subcategories/:subId', authenticateAdminToken, updateSubcategory);
router.delete('/business-categories/:categoryId/subcategories/:subId', authenticateAdminToken, deleteSubcategory);

// ─── Queue Management ────────────────────────────────────────────────────────
router.get('/queues', authenticateAdminToken, requireSuperAdmin, listQueues);
router.get('/queues/:queueName/jobs', authenticateAdminToken, requireSuperAdmin, listQueueJobs);
router.post('/queues/:queueName/jobs/:jobId/retry', authenticateAdminToken, requireSuperAdmin, retryJob);
router.delete('/queues/:queueName/jobs/:jobId', authenticateAdminToken, requireSuperAdmin, removeJob);
router.post('/queues/:queueName/pause', authenticateAdminToken, requireSuperAdmin, pauseQueue);
router.post('/queues/:queueName/resume', authenticateAdminToken, requireSuperAdmin, resumeQueue);
router.post('/queues/:queueName/clean', authenticateAdminToken, requireSuperAdmin, cleanQueue);

// ─── Admin Notifications ─────────────────────────────────────────────────────
router.get('/notifications', authenticateAdminToken, getAdminNotificationsHandler);
router.get('/notifications/unread-count', authenticateAdminToken, getUnreadCountHandler);
router.patch('/notifications/read-all', authenticateAdminToken, markAllReadHandler);
router.patch('/notifications/:id/read', authenticateAdminToken, markReadHandler);
router.delete('/notifications/:id', authenticateAdminToken, deleteNotificationHandler);

export default router;
