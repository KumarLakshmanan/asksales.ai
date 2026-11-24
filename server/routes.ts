import { boundedUpload } from './middleware/boundedUpload.js';
import { demoParseRateLimiter } from './middleware/rateLimiter.js';
import { getOutreachQueue } from './controllers/outreachQueueController.js';
import { registerSocialReportRoutes } from './routes/socialReports.routes.js';
import { preserveAsyncContext } from './middleware/preserveAsyncContext.js';
import { setupReadiness } from './controllers/setupReadinessController.js';
import { requireBusinessManager, requireBusinessOwner } from './middleware/businessPermissions.js';
import { setupDraft } from './controllers/setupDraftController.js';
import { setupAnalysisJob } from './controllers/setupAnalysisJobsController.js';
import instagramAutomationsRoutes from './routes/instagramAutomations.routes.js';
import { businessWebhookScope } from './middleware/businessWebhookScope.js';
import { emailOpenPixel } from './controllers/emailOpenTrackingController.js';
import { oauthBusinessScope } from './tenancy/oauthBusinessScope.js';
import { socialCommentAction } from "./controllers/socialEngagementController";
import { getOutreachInbox, getOutreachInboxItem } from './controllers/outreachInboxController.js';
import { getOutreachCreationOptions, getOutreachCreationRecipients, reviewOutreachCreationRecipients, getOutreachCreationTemplates, getOutreachCreationImportSources, prepareOutreachCreationContact } from './controllers/outreachCreationController.js';
import { templateMediaUpload, uploadOutreachTemplateMedia } from './controllers/outreachTemplateMediaController.js';
import { listSocialContent, listSocialContentComments, listSocialContentReplies, getSocialContent, getSocialSyncJob } from './controllers/socialContentController';
import type { Express } from "express";
import { createServer, type Server } from "http";
import { bulkImportLeads } from "./controllers/leadController";
import { getPosts, getPostsByThread } from "./controllers/postsController";
import { requestAICampaignPlan } from "./controllers/campaignController";
import { getStrategyOptions, createStrategyOption, updateStrategyOption } from "./controllers/strategyOptionController";
import { getSentMessages, getSentMessagesByLeadId } from "./controllers/sentMessageController";
import { getLeadGenCampaigns, getLeadGenCampaign, createLeadGenCampaign, updateLeadGenCampaign } from "./controllers/leadGenCampaignController";
import {
  getAllUserContentHandler,
  getAllBrandToolkitsHandler,
  getAllOutreachConversationsHandler,
  getAllContentTemplatesHandler,
  getAllAdsHandler,
} from "./controllers/adminManagementController";
import { getUserDashboardStats } from "./controllers/dashboardController";
import { getMyOpenAIUsageSummaryHandler } from "./controllers/openaiUsageController";
import { getUserSuggestions, regenerateSuggestions } from "./controllers/userSuggestionsController";
import { getAdHandler, getAdsHandler, getAdsByCampaignHandler, createAdHandler, updateAdHandler, deleteAdHandler } from "./controllers/adsController";
import { getCampaignAnalytics, getCampaignPerformanceTrends, getTopHooksAndHashtags } from "./controllers/campaignAnalyticsController";
import { getMyCompanyProfileHandler, createCompanyProfileHandler, updateCompanyProfileHandler } from "./controllers/companyProfileController";
import { getKnowledgeBaseEntries, getKnowledgeBaseEntry, getKnowledgeBaseExtractedText, createKnowledgeBaseEntry, updateKnowledgeBaseEntry, reprocessKnowledgeBaseFile, deleteKnowledgeBaseEntry, uploadKnowledgeBaseFile, uploadMiddleware, createQAEntry, crawlUrlForKnowledgeBase, createUrlEntry } from "./controllers/knowledgeBaseController";
import { listKnowledgeVersions, publishKnowledgeVersion, quarantineKnowledgeVersion, updateKnowledgeDraftScope, withdrawKnowledgeEntry, testKnowledgeRetrieval, createKnowledgeVersionDraft } from './controllers/knowledgeGovernanceController.js';
import { getExistingLeadInputsHandler } from "./controllers/chatController";
import { stoppedThreads } from "./mastra/tools/executors/leadExecutor";
import { analyzeGoalHandler, getWorkflowHandler as getOrchestratorWorkflowHandler, getWorkflowsHandler } from "./controllers/orchestratorController";
import { getStrategyRecommendationsHandler, selectStrategyHandler } from "./controllers/strategyController";
import { buildIcpHandler, getIcpHandler, getIcpByThreadIdHandler, updateIcpHandler, listIcpProfilesHandler, getIcpsByBusinessIdHandler, createIcpProfileHandler } from "./controllers/icpController";
import { getApprovalsHandler, approveCheckpointHandler, rejectCheckpointHandler, executeLeadWorkflowHandler } from "./controllers/approvalController";
import { listChannelAccounts, removeChannelAccount, selectChannelAccount } from './controllers/channelAccountController';
import { updateSocialCompetitor, deleteSocialCompetitor, refreshSocialCompetitor, updateListeningEvent, deleteListeningEvent, computeBestTimes, createSocialCompetitor, getCompetitorBenchmark, getGroundedSocialRecommendation, getSocialAnalyticsDashboard, ingestCompetitorSnapshot, ingestListeningEvent, ingestSocialSnapshot, listBestTimes, listCompetitorSnapshots, listListeningEvents, listSocialCompetitors, listSocialSnapshots, syncOfficialSocialAnalytics } from './controllers/socialAnalyticsController';
import { startScrapingHandler, getScrapingProgressHandler, updateScrapingProgressHandler } from "./controllers/scrapingController";
import { getNotifications, getUnreadNotifications, getUnreadCount, markNotificationAsRead, markAllNotificationsAsRead, deleteNotificationById } from "./controllers/notificationsController";
import { healthCheck, detailedHealthCheck } from "./controllers/healthController";
import { analyzeWebsite } from "./controllers/setupController";
import { uploadLeads, uploadLeadsFile } from "./controllers/outreachAgentController";
import { legacyOutreachAgentRoutes } from "./routes/outreach.routes.js";
import { createWorkflowHandler, getWorkflowHandler, getUserWorkflowsHandler, updateWorkflowHandler, deleteWorkflowHandler, executeWorkflowHandler, getExecutionHandler, getWorkflowExecutionsHandler, getUserExecutionsHandler, listAvailableWorkflowsHandler, getAvailableWorkflowHandler, executeAvailableWorkflowHandler, getExecutionStatusHandler } from "./controllers/leadflowController";
import { getAvailableActors } from "./controllers/actorsController";
import adPlatformOAuthRoutes from "./controllers/adPlatformOAuthController";
import googleAdsOAuthRoutes from "./controllers/googleAdsOAuthController";
import { generateWorkflowInputsHandler, generatePlatformInputHandler } from "./controllers/workflowInputController";
import { listWorkflows, getWorkflow, listSubWorkflows } from "./controllers/workflowController";
import { webhookHealthCheck } from "./controllers/webhookController";
import { verifyWebhook as verifyInstagramWebhook, handleWebhook as handleInstagramWebhookMessage, getWebhookEvents as getInstagramWebhookEvents, getWebhookStats as getInstagramWebhookStats } from "./controllers/instagramWebhookController";
import instagramOAuthRoutes from "./controllers/instagramOAuthController";
import facebookOAuthRoutes, { getFacebookSettings, updateFacebookSettings } from "./controllers/facebookOAuthController";
import { saveFacebookManualCredentials, getFacebookManualCredentials, saveInstagramManualCredentials, getInstagramManualCredentials, saveWhatsAppManualCredentials, getWhatsAppManualCredentials } from "./controllers/metaManualCredentialsController";
import { saveYouTubeCredentials, getYouTubeCredentials, disconnectYouTube } from "./controllers/youtubeCredentialsController";
import { credentialsRateLimiter, aiRateLimiter } from "./middleware/rateLimiter.js";
import twitterOAuthRoutes from "./controllers/twitterOAuthController";
import linkedinOAuthRoutes from "./controllers/linkedinOAuthController";
import gmailOAuthRoutes from "./controllers/gmailOAuthController";
import youtubeOAuthRoutes from "./controllers/youtubeOAuthController";
import youtubeManagementRoutes from "./controllers/youtubeManagementController";
import { handleGmailPubSubWebhook } from "./controllers/gmailWebhookController";
import { checkReplies, verifyEmailConnection, getEmailHistory, getEmailTemplates, saveEmailTemplate, getEmailStats } from "./controllers/emailOutreachController";
import {
  getWorkflowLogs,
  getWorkflowLogsByThread,
  getUserWorkflowLogs,
  getWorkflowExecution,
  getUserExecutions as getWorkflowUserExecutions,
  pauseWorkflowExecution,
  resumeWorkflowExecution,
  cancelWorkflowExecution,
} from "./controllers/workflowLogsController";
import {
  getGmailStatus,
  checkReplies as checkGmailReplies,
  getEmailHistory as getGmailHistory,
  generateEmail as generateGmailEmail,
  generateSequence as generateGmailSequence,
  getGmailStats,
  getPendingReplies as getGmailPendingReplies,
  generateSmartReply as generateGmailSmartReply,
} from "./controllers/gmailOutreachController";
import {
  initializeInstagram,
  sendDirectMessage as sendInstagramDM,
  sendBulkDirectMessages as sendInstagramBulkDMs,
  getUserInfo as getInstagramUserInfo,
  getDirectThreads,
  getFollowers as getInstagramFollowers,
  checkCredentialsStatus as checkInstagramCredentials,
  getInstagramSettings,
  updateInstagramSettings
} from "./controllers/instagramController";
import {
  getConversationsByChannel,
  getConversationWithMessages,
  sendMessage as sendConversationMessage,
  createConversation,
  searchConversations,
  syncReplies,
  getUnreadCounts,
  deleteConversation,
  generateDraftReply,
  sendDraftMessage,
  discardDraft,
  bulkCreateConversations,
  getDailyOutreachStats,
} from "./controllers/outreachConversationsController";
import {
  getRecommendedChannel,
  getRecommendedChannelsBulk,
  getChannelStats,
  generateSmartReply,
  generateReplyVariations,
  analyzeEmailForReply,
  enhanceReply
} from "./controllers/outreachChannelController";
import {
  getApifyTokens,
  addApifyToken,
  updateApifyToken,
  deleteApifyToken
} from "./controllers/apifyController";
import {
  getUserWebhooks,
  handleUserWebhook,
  handleInstagramWebhook as handleInstagramUserWebhook,
  handleFacebookWebhook,
  handleWhatsAppWebhook as handleWhatsAppUserWebhook,
  handleSMSWebhook,
  handleTwitterWebhook,
  handleLinkedInWebhook,
  handleLeadWebhook,
  handleAutomationWebhook,
  regenerateWebhookTokens
} from "./controllers/webhooksController";
import {
  getGoogleAdsConfig,
  getGoogleAdsAccounts,
  selectGoogleAdsAccount,
  disconnectGoogleAds,
  getTwitterConfig,
  saveTwitterConfig,
  getLinkedInConfig,
  saveLinkedInConfig,
} from "./controllers/integrationsController";
import {
  openai as openaiCredentials,
  zerobounce as zerobounceCredentials,
  gemini as geminiCredentials,
  openrouter as openrouterCredentials
} from "./controllers/apiCredentialsController";
import {
  getEmailSettings,
  getEmailStatus,
  saveEmailSettings,
  testEmailConnection,
  sendTestEmail,
  disconnectEmail,
  setActiveEmailProvider,
} from "./controllers/emailSettingsController";
import {
  listEmailSenders,
  getDefaultSender,
  createEmailSender,
  updateEmailSender,
  setDefaultEmailSender,
  deleteEmailSender,
  syncEmailSenders,
} from "./controllers/emailSendersController";
import {
  getMsg91Settings,
  saveMsg91Settings,
  testMsg91Connection_handler,
  disconnectMsg91,
} from "./controllers/msg91SettingsController";
import {
  getWhatsAppConfig,
  saveWhatsAppConfig,
  testWhatsAppConnection,
  deleteWhatsAppConfig,
  verifyWebhook as verifyWhatsAppWebhook,
  handleWebhook as handleWhatsAppWebhookMessage,
  handleOAuthCallback,
  getOAuthUrl,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  toggleWhatsApp,
} from "./controllers/whatsappController";
import {
  getTemplates as getWhatsAppTemplates,
  getTemplate as getWhatsAppTemplate,
  createTemplate as createWhatsAppTemplate,
  updateTemplate as createWhatsAppUpdateTemplate,
  deleteTemplate as deleteWhatsAppTemplate,
  syncTemplates as syncWhatsAppTemplates,
  refreshTemplate as refreshWhatsAppTemplate,
  submitTemplate as submitWhatsAppTemplate,
  uploadTemplateMedia as uploadWhatsAppTemplateMedia,
  uploadWhatsAppTemplateMediaMiddleware,
} from "./controllers/whatsappTemplateController";
import { preflightTemplateMedia } from './controllers/whatsappTemplateMediaPreflightController';
import { checkWhatsAppMarketingLimit, getWhatsAppBilling, quoteWhatsAppMessages } from './controllers/whatsappBillingController';
import {
  addDomain as addResendDomain,
  verifyDomain as verifyResendDomain,
  getDomainStatus as getResendDomainStatus,
  listDomains as listResendDomains,
  deleteDomain as deleteResendDomain,
  updateDomain as updateResendDomain,
  enableReceiving as enableResendReceiving,
  sendTestEmail as sendResendTestEmail,
  createWebhook as createResendWebhook,
  listWebhooks as listResendWebhooks,
  deleteWebhook as deleteResendWebhook,
  createApiKey as createResendApiKey,
  listApiKeys as listResendApiKeys,
  deleteApiKey as deleteResendApiKey,
  getEmailById as getResendEmail,
  listSentEmails as listResendEmails,

  createSegment as createResendSegment,
  listSegments as listResendSegments,
  getSegment as getResendSegment,
  deleteSegment as deleteResendSegment,
  createContact as createResendContact,
  listContacts as listResendContacts,
  getContact as getResendContact,
  updateContact as updateResendContact,
  deleteContact as deleteResendContact,
  createBroadcast as createResendBroadcast,
  sendBroadcast as sendResendBroadcast,
  listBroadcasts as listResendBroadcasts,
  getBroadcast as getResendBroadcast,
  deleteBroadcast as deleteResendBroadcast,
  updateBroadcast as updateResendBroadcast,
} from "./controllers/resendController";
import { handleResendWebhook } from "./controllers/resendWebhookController";
import { authenticateToken, authenticateAdminToken, requireSuperAdmin } from "./middleware/auth";
import { requireCredits } from "./middleware/creditCheck";
import { requireModuleAccess } from "./middleware/platformAccess";
import { setupChatWebSocket } from "./websocket/ChatWebSocketServer";
import widgetRoutes from "./routes/widget.routes";

export async function registerRoutes(app: Express): Promise<Server> {
  app.get('/api/email-events/open/:id.gif', emailOpenPixel);
  // Meta Ads OAuth routes: /api/meta/oauth/...
  // Callback must be public (Facebook redirects here without auth)
  app.use("/api/meta/oauth", (req, res, next) => {
    if (req.path === '/callback') return next();
    authenticateToken(req, res, next);
  }, adPlatformOAuthRoutes);

  // Legacy admin content aliases retained for backward compatibility. Admin
  // identity, user, lead, and dashboard routes live only in admin.routes.ts.
  app.get("/api/admin/content/assets", authenticateAdminToken, getAllUserContentHandler);
  app.get("/api/admin/content/brand-toolkits", authenticateAdminToken, getAllBrandToolkitsHandler);
  app.get("/api/admin/content/outreach-conversations", authenticateAdminToken, getAllOutreachConversationsHandler);
  app.get("/api/admin/content/templates", authenticateAdminToken, getAllContentTemplatesHandler);
  app.get("/api/admin/content/ads", authenticateAdminToken, getAllAdsHandler);

  // Campaign analytics routes (admin)
  app.get("/api/admin/campaign-analytics", authenticateAdminToken, getCampaignAnalytics);
  app.get("/api/admin/campaign-analytics/trends", authenticateAdminToken, getCampaignPerformanceTrends);
  app.get("/api/admin/campaign-analytics/hooks-hashtags", authenticateAdminToken, getTopHooksAndHashtags);

  // User dashboard routes
  app.get("/api/dashboard/stats", authenticateToken, getUserDashboardStats);

  // User suggestions routes
  app.get("/api/suggestions", authenticateToken, getUserSuggestions);
  app.post("/api/suggestions/regenerate", authenticateToken, regenerateSuggestions);

  // Lead and enrichment APIs are owned by the modular routers mounted in index.ts.

  // Posts routes (scraped posts from social media workflows)
  app.get("/api/posts", authenticateToken, getPosts);
  app.get("/api/posts/thread/:threadId", authenticateToken, getPostsByThread);

  // Campaigns routes — CRUD is handled by the modular campaigns.routes.ts (mounted first in index.ts)
  // Only keeping routes that are NOT in campaigns.routes.ts to avoid duplicate execution
  app.post("/api/campaigns/:id/ai-plan-request", authenticateToken, requestAICampaignPlan);

  // Outreach routes are owned by routes/outreach.routes.ts and mounted in index.ts.

  // Strategy options routes
  app.get("/api/strategy-options", authenticateToken, getStrategyOptions);
  app.post("/api/strategy-options", authenticateToken, createStrategyOption);
  app.put("/api/strategy-options/:id", authenticateToken, updateStrategyOption);

  // Sent messages routes
  app.get("/api/sent-messages", authenticateToken, getSentMessages);
  app.get("/api/sent-messages/lead/:leadId", authenticateToken, getSentMessagesByLeadId);

  // Lead gen campaigns routes
  app.get("/api/lead-gen-campaigns", authenticateToken, getLeadGenCampaigns);
  app.get("/api/lead-gen-campaigns/:id", authenticateToken, getLeadGenCampaign);
  app.post("/api/lead-gen-campaigns", authenticateToken, createLeadGenCampaign);
  app.put("/api/lead-gen-campaigns/:id", authenticateToken, updateLeadGenCampaign);

  // Ads routes
  app.get("/api/ads", authenticateToken, getAdsHandler);
  app.get("/api/ads/:id", authenticateToken, getAdHandler);
  app.get("/api/campaigns/:campaignId/ads", authenticateToken, requireModuleAccess('performance_marketing'), getAdsByCampaignHandler);
  app.post("/api/ads", authenticateToken, requireCredits, createAdHandler);
  app.put("/api/ads/:id", authenticateToken, updateAdHandler);
  app.delete("/api/ads/:id", authenticateToken, deleteAdHandler);
  app.post("/api/ads/publish-campaign", authenticateToken, (_req, res) => {
    res.status(410).json({
      error: "This direct provider workflow is retired. Use POST /api/campaigns/autonomous.",
    });
  });
  app.post("/api/ads/save-campaign-draft", authenticateToken, (_req, res) => {
    res.status(410).json({
      error: "This draft workflow is retired. Use POST /api/campaigns/autonomous with publish=false.",
    });
  });

  // ============================================
  // Route Aliases (for client compatibility)
  // These routes map client-side calls to existing endpoints
  // ============================================
  
  // Lead import alias - Client calls /api/leads/import/csv, server has uploadLeads
  app.post("/api/leads/import/save", authenticateToken, bulkImportLeads);
  app.post("/api/leads/import/csv", authenticateToken, uploadLeadsFile, uploadLeads);
  app.post("/api/leads/import", authenticateToken, uploadLeadsFile, uploadLeads);

  // Company profile routes
  app.get("/api/company-profile", authenticateToken, getMyCompanyProfileHandler);
  app.post("/api/company-profile", authenticateToken, createCompanyProfileHandler);
  app.put("/api/company-profile", authenticateToken, updateCompanyProfileHandler);

  // Knowledge Base routes
  app.get("/api/knowledge-base", authenticateToken, getKnowledgeBaseEntries);
  app.post('/api/knowledge-base/test-retrieval', authenticateToken, testKnowledgeRetrieval);
  app.get("/api/knowledge-base/:id", authenticateToken, getKnowledgeBaseEntry);
  app.get("/api/knowledge-base/:id/extracted-text", authenticateToken, getKnowledgeBaseExtractedText);
  app.get('/api/knowledge-base/:id/versions', authenticateToken, listKnowledgeVersions);
  app.post('/api/knowledge-base/:id/versions/:versionId/publish', authenticateToken, publishKnowledgeVersion);
  app.post('/api/knowledge-base/:id/versions/:versionId/quarantine', authenticateToken, quarantineKnowledgeVersion);
  app.put('/api/knowledge-base/:id/versions/:versionId/scope', authenticateToken, updateKnowledgeDraftScope);
  app.post('/api/knowledge-base/:id/versions/:versionId/draft', authenticateToken, createKnowledgeVersionDraft);
  app.post('/api/knowledge-base/:id/withdraw', authenticateToken, withdrawKnowledgeEntry);
  app.post("/api/knowledge-base/:id/reprocess", authenticateToken, reprocessKnowledgeBaseFile);
  app.post("/api/knowledge-base", authenticateToken, createKnowledgeBaseEntry);
  app.put("/api/knowledge-base/:id", authenticateToken, updateKnowledgeBaseEntry);
  app.delete("/api/knowledge-base/:id", authenticateToken, deleteKnowledgeBaseEntry);
  app.post("/api/knowledge-base/upload", authenticateToken, preserveAsyncContext(uploadMiddleware), uploadKnowledgeBaseFile);
  app.post("/api/knowledge-base/qa", authenticateToken, createQAEntry);
  app.post("/api/knowledge-base/crawl-url", authenticateToken, crawlUrlForKnowledgeBase);
  app.post("/api/knowledge-base/url", authenticateToken, createUrlEntry);

  // Business Profiles routes
  // Setup helper — website analyzer
  app.post("/api/setup/analyze-website", authenticateToken, analyzeWebsite);
  app.get('/api/setup/onboarding-status', authenticateToken, setupReadiness);
  app.get('/api/setup/drafts/:draftKey', authenticateToken, setupDraft);
  app.put('/api/setup/drafts/:draftKey', authenticateToken, setupDraft);
  app.delete('/api/setup/drafts/:draftKey', authenticateToken, setupDraft);
  app.post('/api/setup/website-analysis/jobs', authenticateToken, setupAnalysisJob);
  app.get('/api/setup/website-analysis/jobs/:jobId', authenticateToken, setupAnalysisJob);
  app.delete('/api/setup/website-analysis/jobs/:jobId', authenticateToken, setupAnalysisJob);
  app.post('/api/setup/website-analysis/jobs/:jobId/retry', authenticateToken, setupAnalysisJob);

  // Chat routes and compatibility aliases are owned by routes/chat.routes.ts.

  // Workflow logs and control routes
  app.get("/api/workflow/logs/:executionId", authenticateToken, getWorkflowLogs);
  app.get("/api/workflow/logs/thread/:threadId", authenticateToken, getWorkflowLogsByThread);
  app.get("/api/workflow/logs", authenticateToken, getUserWorkflowLogs);
  app.get("/api/workflow/executions/:executionId", authenticateToken, getWorkflowExecution);
  app.get("/api/workflow/executions", authenticateToken, getWorkflowUserExecutions);
  app.post("/api/workflow/pause", authenticateToken, pauseWorkflowExecution);
  app.post("/api/workflow/resume", authenticateToken, resumeWorkflowExecution);
  app.post("/api/workflow/cancel", authenticateToken, cancelWorkflowExecution);
  app.post("/api/workflow/stop-thread", authenticateToken, (req, res) => {
    const threadId = parseInt(req.body.threadId);
    if (!threadId) {
      return res.status(400).json({ error: "threadId is required" });
    }
    stoppedThreads.add(threadId);
    return res.json({ success: true, message: `Thread ${threadId} marked as stopped` });
  });

  // User profile routes
  // Orchestration routes
  app.post("/api/orchestrator/analyze-goal", authenticateToken, analyzeGoalHandler);
  app.get("/api/orchestrator/workflows", authenticateToken, getWorkflowsHandler);
  app.get("/api/orchestrator/workflows/:id", authenticateToken, getOrchestratorWorkflowHandler);

  // Strategy routes
  app.get("/api/strategies/:workflowId/recommendations", authenticateToken, getStrategyRecommendationsHandler);
  app.post("/api/strategies/:id/select", authenticateToken, selectStrategyHandler);

  // ICP Routes
  app.get("/api/icp", authenticateToken, listIcpProfilesHandler);
  app.post("/api/icp/build", authenticateToken, buildIcpHandler);
  app.get("/api/icp/business/:businessId", authenticateToken, getIcpsByBusinessIdHandler);
  app.get("/api/icp/profile/:id", authenticateToken, getIcpHandler);
  app.get("/api/icp/thread/:threadId", authenticateToken, getIcpByThreadIdHandler);
  app.put("/api/icp/:id", authenticateToken, updateIcpHandler);
  
  // ICP Routes aliases (for client compatibility)
  app.get("/api/icps/:id", authenticateToken, getIcpHandler);
  app.post("/api/icp-profiles", authenticateToken, createIcpProfileHandler);
  app.put("/api/icp-profiles/:id", authenticateToken, updateIcpHandler);

  // Approval routes
  app.get("/api/approvals/:workflowId", authenticateToken, getApprovalsHandler);
  app.post("/api/approvals/:id/approve", authenticateToken, approveCheckpointHandler);
  app.post("/api/approvals/:id/reject", authenticateToken, rejectCheckpointHandler);
  app.post("/api/lead-workflow/execute", authenticateToken, executeLeadWorkflowHandler);

  // Account pickers work across all OAuth integrations that can authorize
  // more than one publishing identity.
  app.get('/api/channel-accounts/:platform', authenticateToken, listChannelAccounts);
  app.post('/api/channel-accounts/:platform/select', authenticateToken, selectChannelAccount);
  app.delete('/api/channel-accounts/:platform/:credentialId', authenticateToken, removeChannelAccount);

  app.get('/api/social-analytics/snapshots', authenticateToken, requireModuleAccess('content'), listSocialSnapshots);
  app.get('/api/social-analytics/dashboard', authenticateToken, requireModuleAccess('content'), getSocialAnalyticsDashboard);
  app.post('/api/social-analytics/snapshots', authenticateToken, requireModuleAccess('content'), ingestSocialSnapshot);
  app.post('/api/social-analytics/sync', authenticateToken, requireModuleAccess('content'), syncOfficialSocialAnalytics);
  app.get('/api/social-analytics/content', authenticateToken, requireModuleAccess('content'), listSocialContent);
  app.get('/api/social-analytics/content/:id', authenticateToken, requireModuleAccess('content'), getSocialContent);
  app.get('/api/social-analytics/content/:id/comments/:commentId/replies', authenticateToken, requireModuleAccess('content'), listSocialContentReplies);
  app.get('/api/social-analytics/content/:id/comments', authenticateToken, requireModuleAccess('content'), listSocialContentComments);
  app.get('/api/social-analytics/sync-jobs/:id', authenticateToken, requireModuleAccess('content'), getSocialSyncJob);
  app.post('/api/social-analytics/best-times', authenticateToken, requireModuleAccess('content'), computeBestTimes);
  app.get('/api/social-analytics/best-times', authenticateToken, requireModuleAccess('content'), listBestTimes);
  app.get('/api/social-analytics/listening', authenticateToken, requireModuleAccess('content'), listListeningEvents);
  app.post('/api/social-analytics/listening', authenticateToken, requireModuleAccess('content'), ingestListeningEvent);
  app.get('/api/social-analytics/competitors', authenticateToken, requireModuleAccess('content'), listSocialCompetitors);
  app.post('/api/social-analytics/competitors', authenticateToken, requireModuleAccess('content'), createSocialCompetitor);
  app.get('/api/social-analytics/competitors/:id/benchmark', authenticateToken, requireModuleAccess('content'), getCompetitorBenchmark);
  app.get('/api/social-analytics/competitors/:id/snapshots', authenticateToken, requireModuleAccess('content'), listCompetitorSnapshots);
  app.post('/api/social-analytics/competitors/:id/snapshots', authenticateToken, requireModuleAccess('content'), ingestCompetitorSnapshot);
  app.get('/api/social-analytics/recommendation', authenticateToken, requireModuleAccess('content'), getGroundedSocialRecommendation);
  registerSocialReportRoutes(app, authenticateToken, requireModuleAccess('content'));

  app.post('/api/social-analytics/content/:id/comments/:commentId/actions', authenticateToken, requireModuleAccess('content'), socialCommentAction);
  app.patch('/api/social-analytics/competitors/:id', authenticateToken, requireModuleAccess('content'), updateSocialCompetitor);
  app.delete('/api/social-analytics/competitors/:id', authenticateToken, requireModuleAccess('content'), deleteSocialCompetitor);
  app.post('/api/social-analytics/competitors/:id/refresh', authenticateToken, requireModuleAccess('content'), refreshSocialCompetitor);
  app.patch('/api/social-analytics/listening/:id', authenticateToken, requireModuleAccess('content'), updateListeningEvent);
  app.delete('/api/social-analytics/listening/:id', authenticateToken, requireModuleAccess('content'), deleteListeningEvent);

  // Scraping routes
  app.post("/api/scraping/start", authenticateToken, requireCredits, startScrapingHandler);
  app.get("/api/scraping/:workflowId/progress", authenticateToken, getScrapingProgressHandler);
  app.post("/api/scraping/update", authenticateToken, updateScrapingProgressHandler);

  // Backward-compatible aliases. The modular /api/settings/profile contract is authoritative.
  app.all("/api/user/profile", authenticateToken, (_req, res) => res.redirect(308, "/api/settings/profile"));
  app.all("/api/user/change-password", authenticateToken, (_req, res) => res.redirect(308, "/api/settings/profile/change-password"));
  app.all("/api/user/notification-preferences", authenticateToken, (_req, res) =>
    res.redirect(308, "/api/settings/profile/notification-preferences"));

  // Notifications routes
  app.get("/api/notifications", authenticateToken, getNotifications);
  app.get("/api/notifications/unread", authenticateToken, getUnreadNotifications);
  app.get("/api/notifications/unread/count", authenticateToken, getUnreadCount);
  app.put("/api/notifications/:id/read", authenticateToken, markNotificationAsRead);
  app.put("/api/notifications/read-all", authenticateToken, markAllNotificationsAsRead);
  app.delete("/api/notifications/:id", authenticateToken, deleteNotificationById);

  // OpenAI Usage routes (admin shared)
  app.get("/api/openai-usage/summary", authenticateToken, getMyOpenAIUsageSummaryHandler);

  // Email Settings routes
  app.get("/api/email/status", authenticateToken, getEmailStatus);
  app.post("/api/email-settings/provider", authenticateToken, setActiveEmailProvider);
  app.get("/api/email-settings", authenticateToken, getEmailSettings);
  app.post("/api/email-settings", authenticateToken, saveEmailSettings);
  app.post("/api/email-settings/test", authenticateToken, credentialsRateLimiter, testEmailConnection);
  app.post("/api/email-settings/send-test", authenticateToken, credentialsRateLimiter, sendTestEmail);
  app.delete("/api/email-settings", authenticateToken, disconnectEmail);

  // Unified disconnect endpoint (MED-14 / Improvement #2):
  //   DELETE /api/integrations/:platform/disconnect
  //   Supported platforms: instagram, facebook, whatsapp, twitter, linkedin,
  //                        gmail, meta, google_ads, email, msg91
  // Marks credentials inactive without deleting (preserves audit history).
   
  const { disconnectIntegration } = await import('./controllers/integrationDisconnectController');
  app.delete("/api/integrations/:platform/disconnect", authenticateToken, disconnectIntegration);

  // Email Senders routes (multi-account)
  app.get("/api/email-senders", authenticateToken, listEmailSenders);
  app.get("/api/email-senders/default", authenticateToken, getDefaultSender);
  app.post("/api/email-senders", authenticateToken, createEmailSender);
  app.post("/api/email-senders/sync", authenticateToken, syncEmailSenders);
  app.patch("/api/email-senders/:id", authenticateToken, updateEmailSender);
  app.post("/api/email-senders/:id/default", authenticateToken, setDefaultEmailSender);
  app.delete("/api/email-senders/:id", authenticateToken, deleteEmailSender);

  // Resend Domain & Email routes
  app.get("/api/resend/domains", authenticateToken, listResendDomains);
  app.post("/api/resend/domains", authenticateToken, requireBusinessManager, addResendDomain);
  app.get("/api/resend/domains/:id", authenticateToken, getResendDomainStatus);
  app.patch("/api/resend/domains/:id", authenticateToken, requireBusinessManager, updateResendDomain);
  app.post("/api/resend/domains/:id/verify", authenticateToken, requireBusinessManager, verifyResendDomain);
  app.post("/api/resend/domains/:id/enable-receiving", authenticateToken, requireBusinessManager, enableResendReceiving);
  app.delete("/api/resend/domains/:id", authenticateToken, requireBusinessManager, deleteResendDomain);
  app.post("/api/resend/send-test", authenticateToken, credentialsRateLimiter, sendResendTestEmail);
  app.get("/api/resend/webhooks", authenticateToken, listResendWebhooks);
  app.post("/api/resend/webhooks", authenticateToken, createResendWebhook);
  app.delete("/api/resend/webhooks/:webhookId", authenticateToken, deleteResendWebhook);
  app.get("/api/resend/api-keys", authenticateToken, listResendApiKeys);
  app.post("/api/resend/api-keys", authenticateToken, createResendApiKey);
  app.delete("/api/resend/api-keys/:keyId", authenticateToken, deleteResendApiKey);
  app.post("/api/resend/webhook", handleResendWebhook);

  // Resend Email management routes
  app.get("/api/resend/emails", authenticateToken, listResendEmails);
  app.get("/api/resend/emails/:emailId", authenticateToken, getResendEmail);

  // Resend Segments (Audiences) routes
  app.get("/api/resend/segments", authenticateToken, listResendSegments);
  app.post("/api/resend/segments", authenticateToken, createResendSegment);
  app.get("/api/resend/segments/:segmentId", authenticateToken, getResendSegment);
  app.delete("/api/resend/segments/:segmentId", authenticateToken, deleteResendSegment);

  // Resend Contacts routes
  app.get("/api/resend/contacts", authenticateToken, listResendContacts);
  app.post("/api/resend/contacts", authenticateToken, createResendContact);
  app.get("/api/resend/contacts/:contactId", authenticateToken, getResendContact);
  app.patch("/api/resend/contacts/:contactId", authenticateToken, updateResendContact);
  app.delete("/api/resend/contacts/:contactId", authenticateToken, deleteResendContact);

  // Resend Broadcasts routes
  app.get("/api/resend/broadcasts", authenticateToken, listResendBroadcasts);
  app.post("/api/resend/broadcasts", authenticateToken, createResendBroadcast);
  app.get("/api/resend/broadcasts/:broadcastId", authenticateToken, getResendBroadcast);
  app.patch("/api/resend/broadcasts/:broadcastId", authenticateToken, updateResendBroadcast);
  app.delete("/api/resend/broadcasts/:broadcastId", authenticateToken, deleteResendBroadcast);
  app.post("/api/resend/broadcasts/:broadcastId/send", authenticateToken, sendResendBroadcast);

  // MSG91 SMS Settings routes (user SMS configuration)
  app.get("/api/msg91-settings", authenticateToken, getMsg91Settings);
  app.post("/api/msg91-settings", authenticateToken, requireBusinessManager, credentialsRateLimiter, saveMsg91Settings);
  app.post("/api/msg91-settings/test", authenticateToken, requireBusinessManager, credentialsRateLimiter, testMsg91Connection_handler);
  app.delete("/api/msg91-settings", authenticateToken, requireBusinessManager, disconnectMsg91);

  // WhatsApp Business API routes
  app.get("/api/whatsapp/config", authenticateToken, requireBusinessManager, getWhatsAppConfig);
  app.post("/api/whatsapp/config", authenticateToken, requireBusinessManager, saveWhatsAppConfig);
  app.post("/api/whatsapp/toggle", authenticateToken, requireBusinessManager, toggleWhatsApp);
  app.post("/api/whatsapp/test", authenticateToken, requireBusinessManager, credentialsRateLimiter, testWhatsAppConnection);
  app.delete("/api/whatsapp/config", authenticateToken, requireBusinessManager, deleteWhatsAppConfig);
  app.post("/api/whatsapp/send/template", authenticateToken, sendWhatsAppTemplate);
  app.post("/api/whatsapp/send/text", authenticateToken, sendWhatsAppText);
  app.get("/api/whatsapp/oauth/url", authenticateToken, requireBusinessManager, getOAuthUrl);
  app.get("/api/whatsapp/oauth/callback", oauthBusinessScope, handleOAuthCallback);
  app.get("/api/whatsapp/webhook", verifyWhatsAppWebhook);
  app.post("/api/whatsapp/webhook", handleWhatsAppWebhookMessage);
  // Lightweight status alias used by the outreach create page (returns {connected: boolean})
  app.get("/api/integrations/whatsapp/status", authenticateToken, async (req, res) => {
    try {
      const { whatsappApiService } = await import('./services/whatsappApiService.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const creds = await whatsappApiService.resolveCreds(userId);
      return res.json({
        success: true,
        connected: !!(creds && creds.phoneNumberId),
        source: creds?.source || null,
        phoneNumberId: creds?.phoneNumberId || null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        displayPhoneNumber: (creds?.sessionData as any)?.displayPhoneNumber || null,
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return res.status(500).json({ success: false, connected: false, error: e.message });
    }
  });
  
  // WhatsApp platform billing: month-to-date Meta message charges and pre-send price quotes
  app.get("/api/whatsapp/billing/summary", authenticateToken, getWhatsAppBilling);
  app.post("/api/whatsapp/billing/quote", authenticateToken, quoteWhatsAppMessages);
  app.post("/api/whatsapp/marketing-limit", authenticateToken, checkWhatsAppMarketingLimit);

  // WhatsApp Template routes
  app.get("/api/whatsapp/templates", authenticateToken, getWhatsAppTemplates);
  app.get("/api/whatsapp/templates/:id", authenticateToken, getWhatsAppTemplate);
  app.post("/api/whatsapp/templates", authenticateToken, createWhatsAppTemplate);
  app.post("/api/whatsapp/templates/media-preflight", authenticateToken, preflightTemplateMedia);
  app.put("/api/whatsapp/templates/:id", authenticateToken, createWhatsAppUpdateTemplate);
  app.post("/api/whatsapp/templates/:id/media", authenticateToken, uploadWhatsAppTemplateMediaMiddleware, uploadWhatsAppTemplateMedia);
  app.post("/api/whatsapp/templates/:id/refresh", authenticateToken, refreshWhatsAppTemplate);
  app.post("/api/whatsapp/templates/:id/submit", authenticateToken, submitWhatsAppTemplate);
  app.delete("/api/whatsapp/templates/:id", authenticateToken, deleteWhatsAppTemplate);
  app.post("/api/whatsapp/templates/sync", authenticateToken, syncWhatsAppTemplates);

  // Apify Integration routes (user API tokens)
  app.get("/api/apify/tokens", authenticateToken, requireBusinessManager, getApifyTokens);
  app.post("/api/apify/tokens", authenticateToken, requireBusinessManager, addApifyToken);
  app.put("/api/apify/tokens/:id", authenticateToken, requireBusinessManager, updateApifyToken);
  app.delete("/api/apify/tokens/:id", authenticateToken, requireBusinessManager, deleteApifyToken);

  // User-specific Webhooks routes
  app.get("/api/webhooks/config", authenticateToken, requireBusinessManager, getUserWebhooks);
  app.post("/api/webhooks/regenerate", authenticateToken, requireBusinessManager, regenerateWebhookTokens);
  // Public webhook endpoints (no auth - validated by token in URL)
  app.all("/api/webhooks/user/:userToken", businessWebhookScope, handleUserWebhook);
  app.all("/api/webhooks/instagram/:userToken", businessWebhookScope, handleInstagramUserWebhook);
  app.all("/api/webhooks/facebook/:userToken", businessWebhookScope, handleFacebookWebhook);
  app.all("/api/webhooks/whatsapp/:userToken", businessWebhookScope, handleWhatsAppUserWebhook);
  app.post("/api/webhooks/sms/:userToken", businessWebhookScope, handleSMSWebhook);
  app.post("/api/webhooks/sms/:userToken/:callbackType(delivery)", businessWebhookScope, handleSMSWebhook);
  app.all("/api/webhooks/twitter/:userToken", businessWebhookScope, handleTwitterWebhook);
  app.all("/api/webhooks/linkedin/:userToken", businessWebhookScope, handleLinkedInWebhook);
  app.all("/api/webhooks/email/:userToken", businessWebhookScope, handleUserWebhook);
  app.all("/api/webhooks/leads/:userToken", businessWebhookScope, handleLeadWebhook);
  app.all("/api/webhooks/automation/:userToken", businessWebhookScope, handleAutomationWebhook);

  // Meta Ads config is now admin-managed via /api/admin/meta/* routes
  // Per-user meta-ads config routes removed — credentials come from OAuth + admin config

  // Google Ads Integration config routes
  app.get("/api/integrations/google-ads/config", authenticateToken, getGoogleAdsConfig);
  app.get("/api/integrations/google-ads/accounts", authenticateToken, getGoogleAdsAccounts);
  app.post("/api/integrations/google-ads/select", authenticateToken, requireBusinessManager, selectGoogleAdsAccount);
  app.delete("/api/integrations/google-ads/disconnect", authenticateToken, requireBusinessManager, disconnectGoogleAds);
  app.use("/api/google-ads/oauth", (req, res, next) => {
    if (req.path === '/callback') return next();
    authenticateToken(req, res, next);
  }, googleAdsOAuthRoutes);

  // Meta App config is now admin-managed via /api/admin/meta/* routes

  // Twitter config routes
  app.get("/api/integrations/twitter/config", authenticateToken, getTwitterConfig);
  app.post("/api/integrations/twitter/config", authenticateToken, requireBusinessManager, saveTwitterConfig);

  // LinkedIn config routes
  app.get("/api/integrations/linkedin/config", authenticateToken, getLinkedInConfig);
  app.post("/api/integrations/linkedin/config", authenticateToken, requireBusinessManager, saveLinkedInConfig);
  app.get("/api/linkedin/config", authenticateToken, getLinkedInConfig);
  app.post("/api/linkedin/config", authenticateToken, requireBusinessManager, saveLinkedInConfig);

  // API Credentials routes (OpenAI, ZeroBounce, Gemini)
  app.get("/api/credentials/openai", authenticateToken, requireBusinessManager, openaiCredentials.get);
  app.post("/api/credentials/openai", authenticateToken, requireBusinessManager, openaiCredentials.add);
  app.put("/api/credentials/openai/:id", authenticateToken, requireBusinessManager, openaiCredentials.update);
  app.delete("/api/credentials/openai/:id", authenticateToken, requireBusinessManager, openaiCredentials.delete);

  app.get("/api/credentials/zerobounce", authenticateToken, requireBusinessManager, zerobounceCredentials.get);
  app.post("/api/credentials/zerobounce", authenticateToken, requireBusinessManager, zerobounceCredentials.add);
  app.put("/api/credentials/zerobounce/:id", authenticateToken, requireBusinessManager, zerobounceCredentials.update);
  app.delete("/api/credentials/zerobounce/:id", authenticateToken, requireBusinessManager, zerobounceCredentials.delete);

  app.get("/api/credentials/gemini", authenticateToken, requireBusinessManager, geminiCredentials.get);
  app.post("/api/credentials/gemini", authenticateToken, requireBusinessManager, geminiCredentials.add);
  app.put("/api/credentials/gemini/:id", authenticateToken, requireBusinessManager, geminiCredentials.update);
  app.delete("/api/credentials/gemini/:id", authenticateToken, requireBusinessManager, geminiCredentials.delete);

  app.get("/api/credentials/openrouter", authenticateToken, requireBusinessManager, openrouterCredentials.get);
  app.post("/api/credentials/openrouter", authenticateToken, requireBusinessManager, openrouterCredentials.add);
  app.put("/api/credentials/openrouter/:id", authenticateToken, requireBusinessManager, openrouterCredentials.update);
  app.delete("/api/credentials/openrouter/:id", authenticateToken, requireBusinessManager, openrouterCredentials.delete);

  // Legacy URLs delegate to the canonical router, including all authorization/credit policy.
  app.use("/api/outreach-agent", legacyOutreachAgentRoutes);

  // Email Outreach routes (Gmail SMTP/IMAP)
  app.post("/api/email-outreach/check-replies", authenticateToken, checkReplies);
  app.get("/api/email-outreach/verify", authenticateToken, verifyEmailConnection);
  app.get("/api/email-outreach/history/:leadId", authenticateToken, getEmailHistory);
  app.get("/api/email-outreach/templates", authenticateToken, getEmailTemplates);
  app.post("/api/email-outreach/templates", authenticateToken, saveEmailTemplate);
  app.get("/api/email-outreach/stats", authenticateToken, getEmailStats);


  // Outreach Channel Decision routes
  app.get("/api/outreach-channel/recommend/:leadId", authenticateToken, getRecommendedChannel);
  app.post("/api/outreach-channel/recommend-bulk", authenticateToken, getRecommendedChannelsBulk);
  app.get("/api/outreach-channel/stats", authenticateToken, getChannelStats);

  // Smart Reply routes
  app.post("/api/smart-reply/generate", authenticateToken, aiRateLimiter, generateSmartReply);
  app.post("/api/smart-reply/variations", authenticateToken, aiRateLimiter, generateReplyVariations);
  app.post("/api/smart-reply/analyze", authenticateToken, aiRateLimiter, analyzeEmailForReply);
  app.post("/api/smart-reply/enhance", authenticateToken, aiRateLimiter, enhanceReply);

  // Instagram Outreach routes
  app.use("/api/instagram/automations", instagramAutomationsRoutes);
  app.post("/api/instagram/initialize", authenticateToken, initializeInstagram);
  app.post("/api/instagram/dm", authenticateToken, requireCredits, sendInstagramDM);
  app.post("/api/instagram/dm/bulk", authenticateToken, requireCredits, sendInstagramBulkDMs);
  app.get("/api/instagram/user/:username", authenticateToken, getInstagramUserInfo);
  app.get("/api/instagram/threads", authenticateToken, getDirectThreads);
  app.get("/api/instagram/followers", authenticateToken, getInstagramFollowers);
  app.get("/api/instagram/status", authenticateToken, checkInstagramCredentials);
  app.get("/api/instagram/settings", authenticateToken, getInstagramSettings);
  app.post("/api/instagram/settings", authenticateToken, requireBusinessManager, updateInstagramSettings);



  // Instagram OAuth routes (Official Instagram/Meta API)
  // Callback and debug must be public
  app.use("/api/instagram/oauth", (req, res, next) => {
    if (req.path === '/callback' || req.path === '/debug') return next();
    authenticateToken(req, res, next);
  }, instagramOAuthRoutes);

  // Facebook OAuth routes (Official Facebook/Meta API)
  // Callback must be public (Facebook redirects here without auth)
  app.use("/api/facebook/oauth", (req, res, next) => {
    if (req.path === '/callback') return next();
    authenticateToken(req, res, next);
  }, facebookOAuthRoutes);
  app.get("/api/facebook/settings", authenticateToken, getFacebookSettings);
  app.post("/api/facebook/settings", authenticateToken, requireBusinessManager, updateFacebookSettings);

  // Manual developer credentials routes (user's own Meta App credentials)
  app.post("/api/facebook/manual-credentials", authenticateToken, requireBusinessManager, credentialsRateLimiter, saveFacebookManualCredentials);
  app.get("/api/facebook/manual-credentials", authenticateToken, requireBusinessManager, getFacebookManualCredentials);
  app.post("/api/instagram/manual-credentials", authenticateToken, requireBusinessManager, credentialsRateLimiter, saveInstagramManualCredentials);
  app.get("/api/instagram/manual-credentials", authenticateToken, requireBusinessManager, getInstagramManualCredentials);
  app.post("/api/whatsapp/manual-credentials", authenticateToken, requireBusinessManager, credentialsRateLimiter, saveWhatsAppManualCredentials);
  app.get("/api/whatsapp/manual-credentials", authenticateToken, requireBusinessManager, getWhatsAppManualCredentials);

  // YouTube credentials routes
  app.post("/api/youtube/credentials", authenticateToken, requireBusinessManager, credentialsRateLimiter, saveYouTubeCredentials);
  app.get("/api/youtube/credentials", authenticateToken, requireBusinessManager, getYouTubeCredentials);
  app.delete("/api/youtube/credentials", authenticateToken, requireBusinessManager, disconnectYouTube);

  // Twitter/X OAuth routes
  app.use("/api/twitter/oauth", authenticateToken, twitterOAuthRoutes);

  // LinkedIn OAuth routes
  app.use("/api/linkedin/oauth", authenticateToken, linkedinOAuthRoutes);

  // Gmail OAuth routes (Gmail API)
  // Pub/Sub webhook must be mounted WITHOUT auth — Google Pub/Sub cannot send JWT tokens
  app.post("/api/gmail/oauth/webhook", handleGmailPubSubWebhook);
  app.use("/api/gmail/oauth", (req, res, next) => {
    // Allow /callback without auth (Google redirects here)
    if (req.path === '/callback') return next();
    authenticateToken(req, res, next);
  }, gmailOAuthRoutes);

  // Legacy callback alias: supports redirect URIs configured as /api/gmail-oauth/callback
  // (e.g. when the Google OAuth app was registered with that path)
  app.get("/api/gmail-oauth/callback", (req, res) => {
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    res.redirect(302, `/api/gmail/oauth/callback${query ? '?' + query : ''}`);
  });

  // YouTube OAuth routes (for video publishing)
  app.use("/api/youtube/oauth", (req, res, next) => {
    // Allow /callback without auth (Google redirects here)
    if (req.path === '/callback') return next();
    authenticateToken(req, res, next);
  }, youtubeOAuthRoutes);

  // Provider-backed YouTube management. Uploads are resumed in bounded chunks;
  // provider OAuth material remains server-side and whole files are never
  // buffered by app workers.
  app.use("/api/youtube/manage", authenticateToken, requireModuleAccess('content'), youtubeManagementRoutes);
  
  // Gmail Outreach routes (Gmail API-based email outreach)
  app.get("/api/gmail-outreach/status", authenticateToken, getGmailStatus);
  app.post("/api/gmail-outreach/check-replies", authenticateToken, checkGmailReplies);
  app.get("/api/gmail-outreach/history/:leadId", authenticateToken, getGmailHistory);
  app.post("/api/gmail-outreach/generate", authenticateToken, generateGmailEmail);
  app.post("/api/gmail-outreach/generate-sequence", authenticateToken, generateGmailSequence);
  app.get("/api/gmail-outreach/stats", authenticateToken, getGmailStats);
  app.get("/api/gmail-outreach/pending-replies", authenticateToken, getGmailPendingReplies);
  app.post("/api/gmail-outreach/smart-reply/:leadId", authenticateToken, aiRateLimiter, generateGmailSmartReply);

  // Outreach Conversations routes (Email & Instagram chat view)
  app.get("/api/outreach-conversations/inbox", authenticateToken, getOutreachInbox);
  app.get("/api/outreach-conversations/inbox/:kind/:id", authenticateToken, getOutreachInboxItem);
  app.get("/api/outreach-conversations/compose/options", authenticateToken, getOutreachCreationOptions);
  app.get("/api/outreach-conversations/compose/recipients", authenticateToken, getOutreachCreationRecipients);
  app.post("/api/outreach-conversations/compose/recipients/review", authenticateToken, reviewOutreachCreationRecipients);
  app.get("/api/outreach-conversations/compose/import-sources", authenticateToken, getOutreachCreationImportSources);
  app.get("/api/outreach-conversations/compose/templates", authenticateToken, getOutreachCreationTemplates);
  app.post("/api/outreach-conversations/compose/template-media", authenticateToken, requireModuleAccess('outreach'), preserveAsyncContext(templateMediaUpload), uploadOutreachTemplateMedia);
  app.post("/api/outreach-conversations/compose/contact", authenticateToken, prepareOutreachCreationContact);
  app.get("/api/outreach-conversations/unread", authenticateToken, getUnreadCounts);
  app.get("/api/outreach-conversations/search", authenticateToken, searchConversations);
  app.get("/api/outreach-conversations/daily-stats", authenticateToken, getDailyOutreachStats);
  app.get("/api/outreach-conversations/queue", authenticateToken, getOutreachQueue);
  app.post("/api/outreach-conversations/bulk", authenticateToken, requireCredits, bulkCreateConversations);
  app.post("/api/outreach-conversations", authenticateToken, createConversation);
  app.get("/api/outreach-conversations/:channel", authenticateToken, getConversationsByChannel);
  app.post("/api/outreach-conversations/:channel/:conversationId/draft-reply", authenticateToken, generateDraftReply);
  app.post("/api/outreach-conversations/:channel/:conversationId/send-draft", authenticateToken, requireCredits, sendDraftMessage);
  app.post("/api/outreach-conversations/:channel/:conversationId/discard-draft", authenticateToken, discardDraft);
  app.get("/api/outreach-conversations/:channel/:conversationId/messages", authenticateToken, getConversationWithMessages);
  app.post("/api/outreach-conversations/:channel/:conversationId/messages", authenticateToken, requireCredits, sendConversationMessage);
  app.post("/api/outreach-conversations/:channel/sync", authenticateToken, syncReplies);
  app.delete("/api/outreach-conversations/:conversationId", authenticateToken, deleteConversation);

  // Workflow Input Generation routes
  app.post("/api/workflows/generate-inputs", authenticateToken, generateWorkflowInputsHandler);
  app.post("/api/workflows/generate-inputs/:platform", authenticateToken, generatePlatformInputHandler);
  app.get("/api/workflows/existing-inputs/:threadId", authenticateToken, getExistingLeadInputsHandler);

  // Leadflow routes
  app.get("/api/leadflow/actors", authenticateToken, getAvailableActors);
  app.post("/api/leadflow/workflows", authenticateToken, createWorkflowHandler);
  app.get("/api/leadflow/workflows", authenticateToken, getUserWorkflowsHandler);
  app.get("/api/leadflow/workflows/:id", authenticateToken, getWorkflowHandler);
  app.put("/api/leadflow/workflows/:id", authenticateToken, updateWorkflowHandler);
  app.delete("/api/leadflow/workflows/:id", authenticateToken, deleteWorkflowHandler);
  app.post("/api/leadflow/workflows/:id/execute", authenticateToken, executeWorkflowHandler);
  app.get("/api/leadflow/executions/:id", authenticateToken, getExecutionHandler);
  app.get("/api/leadflow/workflows/:id/executions", authenticateToken, getWorkflowExecutionsHandler);
  app.get("/api/leadflow/executions", authenticateToken, getUserExecutionsHandler);

  // Leadflow Catalog routes (for JSON-based workflows)
  app.get("/api/leadflow/catalog/workflows", authenticateToken, listAvailableWorkflowsHandler);
  app.get("/api/leadflow/catalog/workflows/:workflowId", authenticateToken, getAvailableWorkflowHandler);
  app.post("/api/leadflow/catalog/workflows/:workflowId/execute", authenticateToken, executeAvailableWorkflowHandler);
  app.get("/api/leadflow/catalog/executions/:executionId/status", authenticateToken, getExecutionStatusHandler);

  // Webhook routes (public - called by external services)
  app.get("/api/webhooks/health", webhookHealthCheck);

  // Privacy / GDPR routes (Phase 4.7 / SEC-009). Mounted as a sub-router.
   
  const privacyRoutes = (await import('./routes/privacy.routes.js')).default;
  app.use("/api/privacy", privacyRoutes);
  
  // Instagram/Facebook webhook routes (public - called by Meta)
  // Unified Meta webhook (recommended — single URL for both IG and FB)
  app.get("/api/webhooks/meta", verifyInstagramWebhook);
  app.post("/api/webhooks/meta", handleInstagramWebhookMessage);
  // Legacy per-platform routes (backward compat)
  app.get("/api/webhooks/instagram", verifyInstagramWebhook);
  app.post("/api/webhooks/instagram", handleInstagramWebhookMessage);
  app.get("/api/webhooks/facebook", verifyInstagramWebhook);
  app.post("/api/webhooks/facebook", handleInstagramWebhookMessage);
  
  // Instagram webhook event viewer (protected)
  app.get("/api/instagram/webhook-events", authenticateToken, getInstagramWebhookEvents);
  app.get("/api/instagram/webhook-stats", authenticateToken, getInstagramWebhookStats);

  // Generic per-integration webhook event viewer (protected)
  // Supports: instagram | whatsapp | facebook | meta | gmail | resend | razorpay
  const { getIntegrationWebhookEvents, getIntegrationWebhookStats } = await import('./controllers/integrationWebhookLogsController.js');
  app.get("/api/integrations/:platform/webhook-events", authenticateToken, getIntegrationWebhookEvents);
  app.get("/api/integrations/:platform/webhook-stats", authenticateToken, getIntegrationWebhookStats);

  // Workflow routes (protected - require authentication)
  app.get("/api/workflows/sub-workflows", authenticateToken, listSubWorkflows);
  app.get("/api/workflows", authenticateToken, listWorkflows);
  app.get("/api/workflows/:workflowId", authenticateToken, getWorkflow);

  // Widget routes (interactive chat widgets)
  app.use("/api/widgets", widgetRoutes);

  // Public liveness remains minimal; detailed process/database diagnostics are super-admin only.
  app.get("/api/health", healthCheck);
  app.get("/api/health/detailed", authenticateAdminToken, requireSuperAdmin, detailedHealthCheck);

  // AI Agent Configuration routes
  const aiAgentConfigController = await import("./controllers/aiAgentConfigController.js");
  const multer = (await import("multer")).default;
  const upload = boundedUpload({ field: 'file', files: 1, single: true,
    mimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] });
  const hotelImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  const qrUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
      if (allowed.has(file.mimetype)) callback(null, true);
      else callback(new Error("Only PNG, JPEG, WebP, or GIF images are allowed."));
    },
  });
  const requireSupportAi = requireModuleAccess('support_ai');
  app.get("/api/settings/ai-agents", authenticateToken, requireSupportAi, aiAgentConfigController.listAgentConfigs);
  app.put("/api/settings/ai-agents/active", authenticateToken, requireBusinessOwner, requireSupportAi, aiAgentConfigController.activateAgentConfig);
  app.get("/api/settings/ai-agents/:type", authenticateToken, requireSupportAi, aiAgentConfigController.getAgentConfig);
  app.put("/api/settings/ai-agents/:type", authenticateToken, requireBusinessOwner, requireSupportAi, aiAgentConfigController.updateAgentConfig);
  app.post("/api/settings/ai-agents/:type/reset-default", authenticateToken, requireBusinessOwner, requireSupportAi, aiAgentConfigController.resetAgentConfigToAdminTemplate);
  app.post("/api/settings/ai-agents/seed", authenticateToken, requireBusinessOwner, requireSupportAi, aiAgentConfigController.seedAgentConfigs);
  app.post("/api/settings/ai-agents/parse-demo-file", authenticateToken, requireBusinessOwner, requireSupportAi, aiRateLimiter, demoParseRateLimiter, preserveAsyncContext(upload), aiAgentConfigController.parseDemoFile);
  app.post("/api/settings/ai-agents/parse-kb-entry", authenticateToken, requireBusinessOwner, requireSupportAi, aiRateLimiter, demoParseRateLimiter, aiAgentConfigController.parseKbEntry);

  // Hotel Admin Routes
  const hotelAdminController = await import("./controllers/hotelAdminController.js");
  app.get("/api/hotel/summary", authenticateToken, hotelAdminController.getHotelSummary);
  app.get("/api/hotel/property", authenticateToken, hotelAdminController.getHotelProperty);
  app.post("/api/hotel/property", authenticateToken, hotelAdminController.saveHotelProperty);
  app.get("/api/hotel/payment-settings", authenticateToken, hotelAdminController.getPaymentSettings);
  app.post("/api/hotel/payment-settings", authenticateToken, hotelAdminController.savePaymentSettings);
  app.get("/api/hotel/room-types", authenticateToken, hotelAdminController.listRoomTypes);
  app.post("/api/hotel/room-types", authenticateToken, hotelAdminController.createRoomType);
  app.put("/api/hotel/room-types/:id", authenticateToken, hotelAdminController.updateRoomType);
  app.delete("/api/hotel/room-types/:id", authenticateToken, hotelAdminController.deleteRoomType);
  app.get("/api/hotel/availability", authenticateToken, hotelAdminController.getAvailability);
  app.post("/api/hotel/availability", authenticateToken, hotelAdminController.setAvailability);
  app.get("/api/hotel/bookings", authenticateToken, hotelAdminController.listBookings);
  app.get("/api/hotel/escalations", authenticateToken, hotelAdminController.listEscalations);
  app.get("/api/hotel/leads", authenticateToken, hotelAdminController.listLeadIntel);
  app.get("/api/hotel/follow-ups", authenticateToken, hotelAdminController.listFollowUps);
  
  // Hotel Import Route
  const hotelImportController = await import("./controllers/hotelImportController.js");
  app.post("/api/hotel/import-rate-report", authenticateToken, preserveAsyncContext(hotelImportUpload.single("file")), hotelImportController.importRateReport);
  app.post("/api/hotel/upload-qr", authenticateToken, qrUpload.single("file"), hotelAdminController.uploadQrCode);

  // Payment Webhook Routes
  const bookingPaymentController = await import("./controllers/bookingPaymentController.js");
  app.post("/api/webhooks/razorpay", bookingPaymentController.handlePaymentWebhook);
  // Compatibility endpoint for existing Razorpay dashboard configuration.
  app.post("/api/whatsapp/payment/webhook", bookingPaymentController.handlePaymentWebhook);
  app.get("/api/whatsapp/payment/mock-confirm", bookingPaymentController.handleMockPaymentConfirm);
  app.post("/api/whatsapp/payment/mock-confirm", bookingPaymentController.handleMockPaymentConfirm);
  app.put("/api/hotel/bookings/:id/confirm", authenticateToken, bookingPaymentController.manuallyConfirmBooking);
  app.post("/api/hotel/bookings/:id/recovery", authenticateToken, bookingPaymentController.retryBookingConfirmationSetup);
  app.put("/api/hotel/bookings/:id/cancel", authenticateToken, bookingPaymentController.cancelBooking);


  const httpServer = createServer(app);

  // Setup WebSocket server (extracted to dedicated module)
  setupChatWebSocket(httpServer);

  return httpServer;
}
