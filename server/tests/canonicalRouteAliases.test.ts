import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { z } from 'zod';

const handler: RequestHandler = (req, res) => { res.json({ body: req.body, params: req.params, query: req.query }); };
const handlers = (names: string) => Object.fromEntries(names.split(' ').map(name => [name, handler]));
// Route contracts use synthetic controllers; importing a new route must not
// initialize real database, credentials or delivery services in this suite.
jest.unstable_mockModule('../models/db.js', () => { throw new Error('Route alias fixtures must not load the application database'); });
jest.unstable_mockModule('../controllers/campaignReportController.js', () => handlers('campaignReport'));
jest.unstable_mockModule('../controllers/preparedOutreachController.js', () => handlers('preparedOutreach'));
jest.unstable_mockModule('../controllers/outreachRetryController.js', () => handlers('outreachRetries'));
jest.unstable_mockModule('../controllers/campaignEngagementController.js', () => handlers('campaignEngagement'));
jest.unstable_mockModule('../controllers/campaignExportController.js', () => handlers('campaignExport'));
jest.unstable_mockModule('../controllers/campaignManualFollowUpController.js', () => handlers('campaignManualFollowUps'));
jest.unstable_mockModule('../controllers/outreachTrackingController.js', () => handlers('outreachBatchDaily outreachBatchExport outreachBatchFailures outreachBatchList outreachBatchRecipients outreachBatchRename outreachBatchSummary outreachBatchUpcoming outreachDaily outreachTemplatePerformance outreachUpcoming'));
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticateToken: ((req, res, next) => {
  if (!req.get('x-user')) return res.status(401).json({ error: 'Unauthorized' }); next();
}) as RequestHandler }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireModuleAccess: () => ((req, res, next) => {
  if (req.get('x-module-disabled')) return res.status(403).json({ error: 'Module disabled' }); next();
}) as RequestHandler }));
jest.unstable_mockModule('../middleware/creditCheck.js', () => ({ requireCredits: ((req, res, next) => {
  if (req.get('x-credits') === '0') return res.status(402).json({ error: 'Credits required' }); next();
}) as RequestHandler }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('../middleware/schemas.js', () => ({
  ...Object.fromEntries('sendOutreachSchema startOutreachSchema createThreadSchema updateThreadSchema idParamSchema chatTabThreadParamSchema chatTabParamSchema threadIdParamSchema threadIcpSchema threadCompactSchema saveChatTabSchema replaceChatTabsSchema chatTabsActiveSchema langGraphSwitchAgentSchema langGraphActionSchema'.split(' ').map(name => [name, z.object({}).passthrough()])),
  sendMessageSchema: z.object({ threadId: z.number().int().positive(), message: z.string().min(1) }),
  langGraphApproveSchema: z.object({ threadId: z.number().int().positive(), approved: z.boolean(), requestId: z.string(), toolName: z.string() }),
}));
jest.unstable_mockModule('../controllers/outreachController.js', () => handlers('getOutreachMessages getOutreachStats getOutreachProgress sendOutreachMessage startOutreachHandler'));
jest.unstable_mockModule('../controllers/outreachAgentController.js', () => handlers('uploadLeads uploadLeadsFile generateEmailSequence generateSMSSequence createCampaign previewCampaign scheduleCampaign getCampaigns getCampaignById getSequences cancelCampaign retryFailedCampaign'));
jest.unstable_mockModule('../controllers/sentMessageController.js', () => handlers('getSentMessages getSentMessagesByLeadId'));
jest.unstable_mockModule('../controllers/outreachConversationsController.js', () => handlers('deleteOutreachMessageHandler uploadAttachments attachmentUploadMiddleware downloadAttachment'));
jest.unstable_mockModule('../controllers/chatController.js', () => handlers('getChatMessagesHandler clearChatHistoryHandler getAgentSuggestionsHandler getChatThreadsHandler getChatThreadHandler getChatThreadStatsHandler getChatThreadDetailsHandler getChatThreadOverviewHandler createChatThreadHandler updateChatThreadHandler deleteChatThreadHandler getChatThreadMessagesHandler generateICPFromThreadHandler saveChatTabConfigHandler getChatTabConfigsHandler replaceChatTabConfigsHandler deleteChatTabConfigHandler updateActiveTabHandler getLatestLeadInputsHandler getLatestScrapingDetailsHandler getChatTabsForLoadingHandler updateLeadInputsHandler deleteLeadInputsHandler getContextWindowHandler compactThreadHandler getThreadSummaryHandler'));
jest.unstable_mockModule('../controllers/conversationTurnController.js', () => ({ conversationTurnHandler: () => handler }));
jest.unstable_mockModule('../mastra/chatController.js', () => handlers('langGraphMessageHandler langGraphApproveHandler langGraphSwitchAgentHandler langGraphGetStateHandler langGraphActionHandler'));

const { default: outreach, legacyOutreachAgentRoutes } = await import('../routes/outreach.routes.js');
const { default: chat } = await import('../routes/chat.routes.js');
const app = express();
app.use(express.json());
app.use('/api/outreach', outreach);
app.use('/api/outreach-agent', legacyOutreachAgentRoutes);
app.use('/api/chat', chat);

describe('canonical router compatibility', () => {
  it.each(['/api/outreach/campaigns', '/api/outreach-agent/create-campaign'])('enforces auth, module and credits for %s', async url => {
    expect((await request(app).post(url).send({})).status).toBe(401);
    expect((await request(app).post(url).set('x-user', '1').set('x-module-disabled', 'true').send({})).status).toBe(403);
    expect((await request(app).post(url).set('x-user', '1').set('x-credits', '0').send({})).status).toBe(402);
  });
  it('preserves query strings and route parameters across aliases', async () => {
    const list = await request(app).get('/api/outreach-agent/sequences?icp_id=3').set('x-user', '1');
    expect(list.body.query).toEqual({ icp_id: '3' });
    const schedule = await request(app).post('/api/outreach-agent/schedule-campaign/7').set('x-user', '1').send({ start_date: 'reviewed' });
    expect(schedule.body.params).toEqual({ id: '7' });
    expect(schedule.body.body.start_date).toBe('reviewed');
    expect((await request(app).get('/api/outreach-agent/unmapped').set('x-user', '1')).status).toBe(404);
  });
  it('retains Express trailing slash compatibility on legacy aliases', async () => {
    const list = await request(app).get('/api/outreach-agent/campaigns/').set('x-user', '1');
    expect(list.status).toBe(200);
    const schedule = await request(app).post('/api/outreach-agent/schedule-campaign/7/').set('x-user', '1').send({});
    expect(schedule.status).toBe(200);
    expect(schedule.body.params).toEqual({ id: '7' });
  });
  it.each(['/api/chat/messages', '/api/chat/langgraph/message'])('keeps generation credit and validation gates for %s', async url => {
    expect((await request(app).post(url).set('x-user', '1').set('x-credits', '0').send({ threadId: 1, message: 'Hello' })).status).toBe(402);
    expect((await request(app).post(url).set('x-user', '1').send({ threadId: -1, message: 'Hello' })).status).toBe(400);
  });
  it('allows rejecting an existing tool at zero credits and forces approved=false', async () => {
    const result = await request(app).post('/api/chat/cancel-tool').set('x-user', '1').set('x-credits', '0')
      .send({ threadId: 1, requestId: 'reviewed-tool', toolName: 'generate_email', approved: true });
    expect(result.status).toBe(200);
    expect(result.body.body.approved).toBe(false);
  });
});
