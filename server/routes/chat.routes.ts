import { conversationTurnHandler } from '../controllers/conversationTurnController.js';
/**
 * Chat Routes Module
 * Handles AI chat, threads, and LangGraph agent interactions
 */

import { Router } from 'express';
import { isPostgresIntegerId } from '../utils/postgresIntegerId.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { requireCredits } from '../middleware/creditCheck.js';
import { validateBody, validateParams } from '../middleware/validation.js';
import {
  sendMessageSchema,
  createThreadSchema,
  updateThreadSchema,
  idParamSchema,
  chatTabThreadParamSchema,
  chatTabParamSchema,
  threadIdParamSchema,
  threadIcpSchema,
  threadCompactSchema,
  saveChatTabSchema,
  replaceChatTabsSchema,
  chatTabsActiveSchema,
  langGraphApproveSchema,
  langGraphSwitchAgentSchema,
  langGraphActionSchema,
} from '../middleware/schemas.js';
import {
  getChatMessagesHandler,
  clearChatHistoryHandler,
  getAgentSuggestionsHandler,
  getChatThreadsHandler,
  getChatThreadHandler,
  getChatThreadStatsHandler,
  getChatThreadDetailsHandler,
  getChatThreadOverviewHandler,
  createChatThreadHandler,
  updateChatThreadHandler,
  deleteChatThreadHandler,
  getChatThreadMessagesHandler,
  generateICPFromThreadHandler,
  saveChatTabConfigHandler,
  getChatTabConfigsHandler,
  replaceChatTabConfigsHandler,
  deleteChatTabConfigHandler,
  updateActiveTabHandler,
  getLatestLeadInputsHandler,
  getLatestScrapingDetailsHandler,
  getChatTabsForLoadingHandler,
  updateLeadInputsHandler,
  deleteLeadInputsHandler,
  getContextWindowHandler,
  compactThreadHandler,
  getThreadSummaryHandler,
} from '../controllers/chatController.js';
import {
  langGraphMessageHandler,
  langGraphApproveHandler,
  langGraphSwitchAgentHandler,
  langGraphGetStateHandler,
  langGraphActionHandler,
} from '../mastra/chatController.js';

const router = Router();

router.use(authenticateToken, requireModuleAccess('campaigns'));

// The id/threadId parameters in this router name chat threads (INTEGER). Keep this
// bound local instead of restricting the common schema used by bigint routes.
for (const parameter of ['id', 'threadId']) {
  router.param(parameter, (_req, res, next, value) => {
    if (!isPostgresIntegerId(value)) { res.status(400).json({ error: 'Invalid thread ID' }); return; }
    next();
  });
}
router.use((req, res, next) => {
  // Preserve legacy omitted/falsy new-conversation IDs; positive references
  // must fit their column before any credit/approval/database work starts.
  if (req.body?.threadId && !isPostgresIntegerId(req.body.threadId)) {
    res.status(400).json({ error: 'Invalid thread ID' }); return;
  }
  next();
});

router.get('/threads/:id/turns', conversationTurnHandler('campaign', 'list'));
router.post('/threads/:id/stop', conversationTurnHandler('campaign', 'stop'));
router.post('/threads/:id/reconcile', conversationTurnHandler('campaign', 'reconcile'));

// ─── Chat Threads ───────────────────────────────────────────────────────────────
router.get('/threads', getChatThreadsHandler);
router.post('/threads', validateBody(createThreadSchema), createChatThreadHandler);
router.get('/threads/:id', validateParams(idParamSchema), getChatThreadHandler);
router.get('/threads/:id/stats', validateParams(idParamSchema), getChatThreadStatsHandler);
router.get('/threads/:id/details', validateParams(idParamSchema), getChatThreadDetailsHandler);
router.get('/threads/:id/overview', validateParams(idParamSchema), getChatThreadOverviewHandler);
router.put('/threads/:id', validateParams(idParamSchema), validateBody(updateThreadSchema), updateChatThreadHandler);
router.patch('/threads/:id', validateParams(idParamSchema), validateBody(updateThreadSchema), updateChatThreadHandler);
router.delete('/threads/:id', validateParams(idParamSchema), deleteChatThreadHandler);
router.get('/threads/:id/messages', validateParams(idParamSchema), getChatThreadMessagesHandler);
router.post('/threads/:id/icp', validateParams(idParamSchema), validateBody(threadIcpSchema), generateICPFromThreadHandler);
router.post('/threads/:id/generate-icp', validateParams(idParamSchema), validateBody(threadIcpSchema), generateICPFromThreadHandler);

// ─── Context Window / Compaction ────────────────────────────────────────────────
router.get('/threads/:id/context-window', validateParams(idParamSchema), getContextWindowHandler);
router.post('/threads/:id/compact', validateParams(idParamSchema), validateBody(threadCompactSchema), compactThreadHandler);
router.get('/threads/:id/summary', validateParams(idParamSchema), getThreadSummaryHandler);

// ─── Chat Messages ──────────────────────────────────────────────────────────────
router.get('/messages', getChatMessagesHandler);
router.delete('/messages/clear', clearChatHistoryHandler);
router.delete('/messages', clearChatHistoryHandler);
router.get('/suggestions', getAgentSuggestionsHandler);
router.get('/agent-suggestions', getAgentSuggestionsHandler);
router.post('/messages', requireCredits, validateBody(sendMessageSchema), langGraphMessageHandler);
router.post('/approve-tool', validateBody(langGraphApproveSchema), langGraphApproveHandler);
router.post('/cancel-tool', (req, _res, next) => {
  req.body = { ...req.body, approved: false };
  next();
}, validateBody(langGraphApproveSchema), langGraphApproveHandler);

// ─── Chat Tab Configs ───────────────────────────────────────────────────────────
router.get('/threads/:id/tabs', validateParams(chatTabThreadParamSchema), getChatTabConfigsHandler);
router.get('/threads/:id/tabs-loaded', validateParams(chatTabThreadParamSchema), getChatTabsForLoadingHandler);
router.post('/threads/:id/tabs', validateParams(chatTabThreadParamSchema), validateBody(saveChatTabSchema), saveChatTabConfigHandler);
router.put('/threads/:id/tabs', validateParams(chatTabThreadParamSchema), validateBody(replaceChatTabsSchema), replaceChatTabConfigsHandler);
router.put('/threads/:id/active-tab', validateParams(chatTabThreadParamSchema), validateBody(chatTabsActiveSchema), updateActiveTabHandler);
router.delete('/threads/:id/tabs/:tabId', validateParams(chatTabParamSchema), deleteChatTabConfigHandler);

// ─── Lead Inputs ────────────────────────────────────────────────────────────────
router.get('/threads/:threadId/lead-inputs/latest', validateParams(threadIdParamSchema), getLatestLeadInputsHandler);
router.put('/threads/:threadId/lead-inputs', updateLeadInputsHandler);
router.delete('/threads/:threadId/lead-inputs/:platform', deleteLeadInputsHandler);
router.get('/threads/:threadId/scraping-details/latest', validateParams(threadIdParamSchema), getLatestScrapingDetailsHandler);

// ─── Tool Approvals ─────────────────────────────────────────────────────────────
// Tool execution approve/cancel are handled below via /langgraph/approve and /langgraph/action
// (URL paths kept for backward client compatibility — handlers are served by Mastra)

// ─── Mastra Agent Messages (/langgraph/* URLs kept for client backward compatibility) ───
router.post('/langgraph/message', requireCredits, validateBody(sendMessageSchema), langGraphMessageHandler);
// Rejections must remain available at zero balance so users can clear a
// pending action. The handler performs a claim-time credit check only when the
// decision is approval.
router.post('/langgraph/approve', validateBody(langGraphApproveSchema), langGraphApproveHandler);
router.post('/langgraph/switch-agent', requireCredits, validateBody(langGraphSwitchAgentSchema), langGraphSwitchAgentHandler);
router.get('/langgraph/state/:threadId', langGraphGetStateHandler);
router.post(
  '/langgraph/action',
  validateBody(langGraphActionSchema),
  (req, res, next) => req.body.action === 'reject_tool' ? next() : requireCredits(req, res, next),
  langGraphActionHandler,
);

export default router;
