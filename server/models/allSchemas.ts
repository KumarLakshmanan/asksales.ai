import * as smsQueueDeliveries from './smsQueueDeliveries/schema.js';
import * as campaignManualFollowUps from './campaignManualFollowUps/schema.js';
export * from './campaignManualFollowUps/schema.js';
export * from './smsQueueDeliveries/schema.js';
import * as campaignCrmContacts from './campaignCrmContacts/schema.js';
export * from './campaignCrmContacts/schema.js';
import * as walletRechargeOrderOrigins from './walletRechargeOrderOrigins/schema.js';
export * from './walletRechargeOrderOrigins/schema.js';
import * as instagramAutomations from './instagramAutomations/schema.js';
export * from './instagramAutomations/schema.js';
/**
 * All Database Schemas
 * Central export of all database table schemas for migrations and sync
 */

// 1. Import everything first
import * as ads from './ads/schema';
import * as agentExecutions from './agentExecutions/schema';
import * as agents from './agents/schema';
import * as aiSettings from './aiSettings/schema';
import * as apiCredentials from './apiCredentials/schema';
import * as approvalCheckpoints from './approvalCheckpoints/schema';
import * as brandToolkits from './brandToolkits/schema';
import * as budgetPlans from './budgetPlans/schema';
import * as campaigns from './campaigns/schema';
import * as channelCredentials from './channelCredentials/schema';
import * as chatMessages from './chatMessages/schema';
import * as metaPageConnections from './metaPageConnections/schema';
import * as webhookEvents from './webhookEvents/schema';
import * as chatSummaries from './chatSummaries/schema';
import * as chatTabConfigs from './chatTabConfigs/schema';
import * as chatThreads from './chatThreads/schema';
import * as conversationToolApprovals from './conversationToolApprovals/schema';
import * as conversationWorkflow from './conversationWorkflow/schema';
import * as companyProfiles from './companyProfiles/schema';
import * as companySettings from './companySettings/schema';
import * as contentAssetPreviews from './contentAssetPreviews/schema';
import * as contentAssets from './contentAssets/schema';
import * as contentPlans from './contentPlans/schema';
import * as contentTemplates from './contentTemplates/schema';
import * as socialPublishAttempts from './socialPublishAttempts/schema';
import * as policyPages from './policyPages/schema';
import * as accountDeletionRequests from './accountDeletionRequests/schema';
import * as conversationThreads from './conversationThreads/schema';
import * as icpData from './icpData/schema';
import * as leadGenCampaigns from './leadGenCampaigns/schema';
import * as leadInputs from './leadInputs/schema';
import * as leadGenerationProviderRuns from './leadGenerationProviderRuns/schema';
import * as leadSettings from './leadSettings/schema';
import * as leads from './leads/schema';
import * as messageSequences from './messageSequences/schema';
import * as notifications from './notifications/schema';
import * as adminNotifications from './adminNotifications/schema';
import * as openaiUsages from './openaiUsages/schema';
import * as aiUsageEvents from './aiUsageEvents/schema.js';
import * as salesOutcomeEvents from './salesOutcomeEvents/schema.js';
export { aiUsageEventsTable } from './aiUsageEvents/schema.js';
export { salesOutcomeEventsTable } from './salesOutcomeEvents/schema.js';
import * as apifyUsages from './apifyUsages/schema';
import * as outreachCampaigns from './outreachCampaigns/schema';
import * as outreachJobs from './outreachJobs/schema';
import * as outreachSettings from './outreachSettings/schema';
import * as performanceAdCampaigns from './performanceAdCampaigns/schema';
import * as performanceMetrics from './performanceMetrics/schema';
import * as autonomousAds from './autonomousAds/schema';
import * as posts from './posts/schema';
import * as scrapingDetails from './scrapingDetails/schema';
import * as scrapingProgress from './scrapingProgress/schema';
import * as sentMessages from './sentMessages/schema';
import * as sequenceExecutions from './sequenceExecutions/schema';
import * as strategyOptions from './strategyOptions/schema';
import * as userPreferences from './userPreferences/schema';
import * as users from './users/schema';
import * as workflowSessions from './workflowSessions/schema';
import * as workflows from './workflows/schema';
import * as mappingSchema from './workflows/mappingSchema';
import * as followupSequences from './followupSequences/schema';
import * as outreachConversations from './outreachConversations/schema';
import * as socialFollowUpSchedules from './socialFollowUpSchedules/schema';
import * as instagramWebhookEvents from './instagramWebhookEvents/schema';
import * as systemIntegrations from './systemIntegrations/schema';
import * as knowledgeBase from './knowledgeBase/schema';
import * as knowledge from './knowledge/schema';
import * as campaignPerformanceCache from './campaignPerformanceCache/schema';
import * as workflowLogs from './workflowLogs/schema';
import * as geminiUsages from './geminiUsages/schema';
import * as llmUsages from './llmUsages/schema';
import * as toolApprovals from './toolApprovals/schema';
import * as zerobounceUsages from './zerobounceUsages/schema';
import * as adminApiCredentials from './adminApiCredentials/schema';
import * as intentClassifierCredentials from './intentClassifierCredentials/schema';
import * as admins from './admins/schema';
import * as apiPricing from './apiPricing/schema';
import * as pricingAudit from './pricingAudit/schema';
import * as platformAccess from './platformAccess/schema';
import * as userSuggestions from './userSuggestions/schema';
import * as wallets from './wallets/schema';
import * as walletTransactions from './walletTransactions/schema';
import * as creditPricing from './creditPricing/schema';
import * as creditEventLogs from './creditEventLogs/schema';
import * as systemLogs from './systemLogs/schema';
import * as resendDomains from './resendDomains/schema';
import * as emailSenders from './emailSenders/schema';
import * as storagePlans from './storagePlans/schema';
import * as storageQuotas from './storageQuotas/schema';
import * as storageFiles from './storageFiles/schema';
import * as storagePricing from './storagePricing/schema';
import * as embeddings from './embeddings/schema';
import * as embeddingSettings from './embeddingSettings/schema';
import * as embeddingUsages from './embeddingUsages/schema';
import * as crmContacts from './crmContacts/schema';
import * as crmActivities from './crmActivities/schema';
import * as supportTickets from './supportTickets/schema';
import * as supportTicketMessages from './supportTicketMessages/schema';
import * as proposals from './proposals/schema';
import * as proposalLineItems from './proposalLineItems/schema';
import * as proposalWorkspace from './proposalWorkspace/schema';
import * as proposalTemplates from './proposalTemplates/schema';
import * as proposalReminders from './proposalReminders/schema';
import * as crmActivityReminders from './crmActivityReminders/schema';
import * as crmAlerts from './crmAlerts/schema';
import * as crmAlertLogs from './crmAlertLogs/schema';
import * as crmPipelineAutomations from './crmPipelineAutomations/schema';
import * as crmAutomationLogs from './crmAutomationLogs/schema';
import * as crmAutomationRuntime from './crmAutomationRuntime/schema';
import * as proposalComments from './proposalComments/schema';
import * as crmContactImports from './crmContactImports/schema.js';
import * as crmContactImportDetails from './crmContactImportDetails/schema.js';
import * as instagramFollowers from './instagramFollowers/schema.js';
import * as supportTeams from './supportTeams/schema';
import * as teamMembers from './teamMembers/schema';
import * as supportChatSessions from './supportChatSessions/schema';
import * as supportChatMessages from './supportChatMessages/schema';
import * as supportTicketReviews from './supportTicketReviews/schema';
import * as enrichmentRuns from './enrichmentRuns/schema';
import * as enrichmentSteps from './enrichmentSteps/schema';
import * as subAgentConfigs from './subAgentConfigs/schema';
import * as businessProfileCategories from './businessProfileCategories/schema';
import * as whatsappTemplates from './whatsappTemplates/schema';
import * as whatsappBilling from './whatsappBilling/schema';
import * as widgetStates from './widgetStates/schema';
import * as systemAlerts from './systemAlerts/schema';
import * as handoffQueue from './handoffQueue/schema';
import * as agentAuditLogs from './agentAuditLogs/schema';
import * as supportOrchestration from './supportOrchestration/schema';
import * as supportMedia from './supportMedia/schema';
import * as contentApprovalWorkflows from './contentApprovalWorkflows/schema';
import * as providerVerificationRuns from './providerVerificationRuns/schema';
import * as providerCanaryRuns from './providerCanaryRuns/schema';
import * as youtubeAnalyticsSnapshots from './youtubeAnalyticsSnapshots/schema';

// 2. Export individual tables (aliased for consistency where needed)
export { adsTable } from './ads/schema';
export { agentExecutionsTable } from './agentExecutions/schema';
export { agentsTable } from './agents/schema';
export { aiSettings as aiSettingsTable } from './aiSettings/schema';
export { apiCredentialsTable } from './apiCredentials/schema';
export { approvalCheckpointsTable } from './approvalCheckpoints/schema';
export { brandToolkitsTable } from './brandToolkits/schema';
export { budgetPlansTable } from './budgetPlans/schema';
export { campaignsTable } from './campaigns/schema';
export { channelCredentialsTable } from './channelCredentials/schema';
export { chatMessagesTable } from './chatMessages/schema';
export { chatSummariesTable } from './chatSummaries/schema';
export { chatTabConfigsTable } from './chatTabConfigs/schema';
export { chatThreadsTable } from './chatThreads/schema';
export { companyProfilesTable } from './companyProfiles/schema';
export { companySettings as companySettingsTable } from './companySettings/schema';
export { contentAssetPreviewsTable } from './contentAssetPreviews/schema';
export { contentAssetsTable } from './contentAssets/schema';
export { contentPlansTable } from './contentPlans/schema';
export { contentTemplatesTable } from './contentTemplates/schema';
export { policyPagesTable } from './policyPages/schema';
export { accountDeletionRequestsTable } from './accountDeletionRequests/schema';
export { conversationThreadsTable } from './conversationThreads/schema';
export { icpProfilesTable as icpDataTable } from './icpData/schema';
export { leadGenCampaignsTable } from './leadGenCampaigns/schema';
export { leadInputsTable } from './leadInputs/schema';
export { leadGenerationProviderRunsTable } from './leadGenerationProviderRuns/schema';
export { leadSettings as leadSettingsTable } from './leadSettings/schema';
export { leadsTable } from './leads/schema';
export { messageSequencesTable } from './messageSequences/schema';
export { notifications as notificationsTable } from './notifications/schema';
export { adminNotifications as adminNotificationsTable } from './adminNotifications/schema';
export { openaiUsagesTable } from './openaiUsages/schema';
export { apifyUsagesTable } from './apifyUsages/schema';
export { outreachCampaignsTable } from './outreachCampaigns/schema';
export { outreachJobsTable } from './outreachJobs/schema';
export { outreachSettings as outreachSettingsTable } from './outreachSettings/schema';
export { performanceAdCampaignsTable } from './performanceAdCampaigns/schema';
export { performanceMetricsTable } from './performanceMetrics/schema';
export * from './autonomousAds/schema';
export { postsTable } from './posts/schema';
export { scrapingDetailsTable } from './scrapingDetails/schema';
export { scrapingProgressTable } from './scrapingProgress/schema';
export { sentMessagesTable } from './sentMessages/schema';
export { sequenceExecutionsTable } from './sequenceExecutions/schema';
export { strategyOptionsTable } from './strategyOptions/schema';
export { userPreferences as userPreferencesTable } from './userPreferences/schema';
export { usersTable } from './users/schema';
export { userConsentsTable } from './userConsents/schema';
export { failedJobsTable } from './failedJobs/schema';
export { workflowSessionsTable } from './workflowSessions/schema';
export { workflows as workflowsTable, workflowExecutions as workflowExecutionsTable } from './workflows/schema';
export { followupSequencesTable } from './followupSequences/schema';
export { outreachConversationsTable, outreachMessagesTable } from './outreachConversations/schema';
export { socialFollowUpSchedulesTable } from './socialFollowUpSchedules/schema';
export { instagramWebhookEventsTable } from './instagramWebhookEvents/schema';
export { systemIntegrationsTable } from './systemIntegrations/schema';
export { knowledgeBaseTable } from './knowledgeBase/schema';
export {
  knowledgeIndexVersionsTable,
  knowledgeDocumentsTable,
  knowledgeDocumentVersionsTable,
  knowledgeChunksTable,
  knowledgeRetrievalAuditsTable,
  knowledgeRuntimeSettingsTable,
} from './knowledge/schema';
export { campaignPerformanceCacheTable } from './campaignPerformanceCache/schema';
export { workflowLogs as workflowLogsTable, workflowActivityExecutions as workflowActivityExecutionsTable, workflowLogTypeEnum, workflowLogStatusEnum } from './workflowLogs/schema';
export { geminiUsagesTable } from './geminiUsages/schema';
export { zerobounceUsagesTable } from './zerobounceUsages/schema';
export { adminApiCredentialsTable, adminCredentialAuditTable } from './adminApiCredentials/schema';
export { intentClassifierCredentialsTable, intentClassifierCredentialAuditTable } from './intentClassifierCredentials/schema';
export { adminsTable } from './admins/schema';
export { apiPricingTable } from './apiPricing/schema';
export { pricingAuditTable } from './pricingAudit/schema';
export {
  platformSettingsTable,
  platformModulesTable,
  userModuleAccessTable,
  platformAccessAuditTable,
} from './platformAccess/schema';
export { userSuggestionsTable } from './userSuggestions/schema';
export { walletsTable } from './wallets/schema';
export { walletTransactionsTable } from './walletTransactions/schema';
export { walletRechargeClaimsTable } from './walletRechargeClaims/schema';
export { creditPricingTable } from './creditPricing/schema';
export { creditEventLogsTable } from './creditEventLogs/schema';
export { systemLogsTable } from './systemLogs/schema';
export { resendDomainsTable } from './resendDomains/schema';
export { emailSendersTable } from './emailSenders/schema';
export { storagePlansTable } from './storagePlans/schema';
export { storageQuotasTable } from './storageQuotas/schema';
export { storageFilesTable } from './storageFiles/schema';
export { storagePricingTable } from './storagePricing/schema';
export { embeddingsTable } from './embeddings/schema';
export { embeddingSettingsTable } from './embeddingSettings/schema';
export { embeddingUsagesTable } from './embeddingUsages/schema';
export { crmContactsTable } from './crmContacts/schema';
export { crmContactChannelIdentitiesTable } from './crmContactChannelIdentities/schema';
export { crmActivitiesTable } from './crmActivities/schema';
export { supportTicketsTable } from './supportTickets/schema';
export { supportTicketMessagesTable } from './supportTicketMessages/schema';
export { supportTicketSummariesTable } from './supportTicketSummaries/schema';
export { proposalsTable } from './proposals/schema';
export { proposalLineItemsTable } from './proposalLineItems/schema';
export * from './proposalWorkspace/schema';
export { proposalTemplatesTable } from './proposalTemplates/schema';
export { proposalRemindersTable } from './proposalReminders/schema';
export { crmActivityRemindersTable } from './crmActivityReminders/schema';
export { crmAlertsTable } from './crmAlerts/schema';
export { crmAlertLogsTable } from './crmAlertLogs/schema';
export { crmPipelineAutomationsTable } from './crmPipelineAutomations/schema';
export { crmAutomationLogsTable } from './crmAutomationLogs/schema';
export * from './crmAutomationRuntime/schema';
export { proposalCommentsTable } from './proposalComments/schema';
export { crmContactImportsTable } from './crmContactImports/schema';
export { crmContactImportDetailsTable } from './crmContactImportDetails/schema.js';
export { instagramFollowersTable } from './instagramFollowers/schema.js';
export { supportTeamsTable } from './supportTeams/schema';
export { teamMembersTable } from './teamMembers/schema';
export { supportChatSessionsTable } from './supportChatSessions/schema';
export { supportChatMessagesTable } from './supportChatMessages/schema';
export { supportTicketReviewsTable } from './supportTicketReviews/schema';
export { enrichmentRunsTable } from './enrichmentRuns/schema';
export { enrichmentStepsTable } from './enrichmentSteps/schema';
export { businessProfileCategoriesTable, businessProfileSubcategoriesTable } from './businessProfileCategories/schema';
export { metaPageConnectionsTable } from './metaPageConnections/schema';
export { webhookEventsTable } from './webhookEvents/schema';
export { whatsappTemplatesTable } from './whatsappTemplates/schema';
export { whatsappRateMarketsTable, whatsappRateCardsTable, whatsappBillingAccountsTable, whatsappBillingReconciliationTable, whatsappMessageChargesTable } from './whatsappBilling/schema';
export { widgetStatesTable } from './widgetStates/schema';
export { conversationToolApprovalsTable } from './conversationToolApprovals/schema';
export {
  conversationWorkflowRunsTable,
  conversationWorkflowActionsTable,
  leadStrategySelectionsTable,
  leadInputSetsTable,
  leadSelectionSnapshotsTable,
} from './conversationWorkflow/schema';
export { systemAlertsTable } from './systemAlerts/schema';
export { subAgentConfigsTable } from './subAgentConfigs/schema';
export { handoffQueueTable } from './handoffQueue/schema';
export { agentAuditLogsTable } from './agentAuditLogs/schema';
export {
  supportPrivacyVaultTable,
  supportPlaybooksTable,
  supportPlaybookVersionsTable,
  supportPlaybookAssignmentsTable,
  supportPlaybookRunsTable,
  supportDeliveryOutboxTable,
  supportToolExecutionsTable,
  supportCannedResponsesTable,
  supportAdminAuditLogsTable,
  supportConversationTurnsTable,
  supportConversationTurnInputsTable,
  supportConversationTurnRunsTable,
} from './supportOrchestration/schema';
// Historical-only retired tables remain registered so schema tooling cannot
// mistake retained audit data for orphaned database objects.
export * from './contentApprovalWorkflows/schema';
export { providerVerificationRunsTable } from './providerVerificationRuns/schema';
export { providerCanaryRunsTable } from './providerCanaryRuns/schema';
export { youtubeAnalyticsSnapshotsTable } from './youtubeAnalyticsSnapshots/schema';
export { 
  connectionMappings as connectionMappingsTable,
  fieldMappings as fieldMappingsTable,
  arrayIterationConfigs as arrayIterationConfigsTable,
  dbSaveMappings as dbSaveMappingsTable
} from './workflows/mappingSchema';

// 3. Create schema object for Drizzle
export const schema = {
  ...walletRechargeOrderOrigins,
  ...ads,
  ...agentExecutions,
  ...agents,
  ...aiSettings,
  ...apiCredentials,
  ...approvalCheckpoints,
  ...brandToolkits,
  ...budgetPlans,
  ...campaigns,
  ...channelCredentials,
  ...chatMessages,
  ...chatSummaries,
  ...chatTabConfigs,
  ...chatThreads,
  ...conversationToolApprovals,
  ...conversationWorkflow,
  ...companyProfiles,
  ...companySettings,
  ...contentAssetPreviews,
  ...contentAssets,
  ...contentPlans,
  ...contentTemplates,
  ...socialPublishAttempts,
  ...policyPages,
  ...accountDeletionRequests,
  ...conversationThreads,
  ...icpData,
  ...leadGenCampaigns,
  ...leadInputs,
  ...leadGenerationProviderRuns,
  ...leadSettings,
  ...leads,
  ...messageSequences,
  ...notifications,
  ...adminNotifications,
  ...openaiUsages,
  ...aiUsageEvents,
  ...salesOutcomeEvents,
  ...apifyUsages,
  ...outreachCampaigns,
  ...outreachJobs,
  ...outreachSettings,
  ...performanceAdCampaigns,
  ...performanceMetrics,
  ...autonomousAds,
  ...posts,
  ...scrapingDetails,
  ...scrapingProgress,
  ...sentMessages,
  ...sequenceExecutions,
  ...strategyOptions,
  ...userPreferences,
  ...users,
  ...workflowSessions,
  ...workflows,
  ...mappingSchema,
  ...followupSequences,
  ...outreachConversations,
  ...smsQueueDeliveries,
  ...socialFollowUpSchedules,
  ...instagramWebhookEvents,
  ...systemIntegrations,
  ...knowledgeBase,
  ...knowledge,
  ...campaignPerformanceCache,
  ...workflowLogs,
  ...geminiUsages,
  ...zerobounceUsages,
  ...adminApiCredentials,
  ...intentClassifierCredentials,
  ...admins,
  ...userSuggestions,
  ...wallets,
  ...walletTransactions,
  ...creditPricing,
  ...creditEventLogs,
  ...systemLogs,
  ...apiPricing,
  ...pricingAudit,
  ...platformAccess,
  ...resendDomains,
  ...emailSenders,
  ...storagePlans,
  ...storageQuotas,
  ...storageFiles,
  ...storagePricing,
  ...embeddings,
  ...embeddingSettings,
  ...embeddingUsages,
  ...crmContacts,
  ...crmActivities,
  ...supportTickets,
  ...supportTicketMessages,
  ...proposals,
  ...proposalLineItems,
  ...proposalWorkspace,
  ...proposalTemplates,
  ...proposalReminders,
  ...crmActivityReminders,
  ...crmAlerts,
  ...crmAlertLogs,
  ...crmPipelineAutomations,
  ...crmAutomationLogs,
  ...crmAutomationRuntime,
  ...instagramAutomations,
  ...campaignCrmContacts,
  ...campaignManualFollowUps,
  ...proposalComments,
  ...crmContactImports,
  ...crmContactImportDetails,
  ...instagramFollowers,
  ...supportTeams,
  ...teamMembers,
  ...supportChatSessions,
  ...supportChatMessages,
  ...supportTicketReviews,
  ...enrichmentRuns,
  ...enrichmentSteps,
  ...businessProfileCategories,
  ...metaPageConnections,
  ...webhookEvents,
  ...whatsappTemplates,
  ...whatsappBilling,
  ...llmUsages,
  ...toolApprovals,
  ...widgetStates,
  ...systemAlerts,
  ...subAgentConfigs,
  ...handoffQueue,
  ...agentAuditLogs,
  ...supportOrchestration,
  ...supportMedia,
  ...contentApprovalWorkflows,
  ...providerVerificationRuns,
  ...providerCanaryRuns,
  ...youtubeAnalyticsSnapshots,
};
