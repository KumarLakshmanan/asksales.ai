import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findByThreadForUser = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateFormValuesForUser = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const closeForUser = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const claimSubmissionForUser = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findByIdForUser = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const completeExecutionForUser = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reopenForUser = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deleteForUser = jest.fn<any>();
const expireStaleRunning = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const executeCanonicalWidgetTool = jest.fn<any>();
const validateCanonicalWidgetToolInput = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getChatThreadById = jest.fn<any>();
const getChatThreadMetadata = jest.fn<any>();
const updateChatThreadMetadata = jest.fn<any>();
const resumeWorkflowAfterWidgetCompletion = jest.fn<any>();
const getBalance = jest.fn<any>();

jest.unstable_mockModule('../middleware/auth', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 7, email: 'owner@example.com' };
    next();
  },
}));

jest.unstable_mockModule('../models/widgetStates/functions', () => ({
  WidgetStateModel: {
    findByThreadForUser,
    updateFormValuesForUser,
    closeForUser,
    claimSubmissionForUser,
    findByIdForUser,
    completeExecutionForUser,
    reopenForUser,
    deleteForUser,
    expireStaleRunning,
  },
}));

jest.unstable_mockModule('../mastra/tools/canonicalToolRegistry.js', () => ({
  executeCanonicalWidgetTool,
  validateCanonicalWidgetToolInput,
}));

jest.unstable_mockModule('../models/chatMessages/functions', () => ({
  createChatMessage: jest.fn(),
}));

jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({
  webSocketEmitter: {
    emitChatResponse: jest.fn(),
    emit: jest.fn(),
  },
}));

jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({
  getChatThreadById,
  getChatThreadMetadata,
  updateChatThreadMetadata,
}));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({
  getEffectiveModuleAccess: jest.fn(async () => [
    { key: 'outreach', enabled: true, status: 'available' },
    { key: 'performance_marketing', enabled: true, status: 'available' },
  ]),
}));
jest.unstable_mockModule('../models/wallets/functions.js', () => ({
  getBalance,
}));
jest.unstable_mockModule('../services/agents/ThreadService.js', () => ({
  ThreadService: {
    loadThreadState: jest.fn(async () => ({})),
  },
}));
jest.unstable_mockModule('../shared/toolWidgetMap.js', () => ({
  getWidgetTypeForTool: (toolName: string) => toolName === 'send_outreach_messages' ? 'send_outreach' : toolName === 'stop_ads' ? 'stop_ads' : undefined,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../mastra/chatController.js', () => ({
  resumeWorkflowAfterWidgetCompletion,
}));

const widgetRoutes = (await import('../routes/widget.routes.js')).default;

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', widgetRoutes);
  return app;
}

const widget = {
  id: 11,
  userId: 7,
  threadId: 21,
  messageId: null,
  toolName: 'send_outreach_messages',
  widgetType: 'send_outreach',
  formValues: {},
  submittedValues: {},
  submittedAt: new Date(),
  status: 'running',
  executionResult: {},
  executionError: null,
  executionStartedAt: new Date(),
  executionCompletedAt: new Date(),
  executionLeaseToken: 'widget-lease-1',
  agentType: 'outreach',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('widget routes', () => {
  beforeEach(() => {
    getBalance.mockReset().mockResolvedValue(100);
    jest.clearAllMocks();
    getChatThreadById.mockResolvedValue({ id: 21, userId: 7 });
    findByThreadForUser.mockResolvedValue([]);
    findByIdForUser.mockResolvedValue({ ...widget, status: 'active' });
    executeCanonicalWidgetTool.mockResolvedValue({ success: true, output: {} });
    completeExecutionForUser.mockResolvedValue({ ...widget, status: 'succeeded' });
    expireStaleRunning.mockResolvedValue(0);
    validateCanonicalWidgetToolInput.mockImplementation(
      (_toolName: string, values: Record<string, unknown>) => values,
    );
    resumeWorkflowAfterWidgetCompletion.mockResolvedValue(true);
  });

  it('autosaves a personalized outreach batch above the ordinary widget limit', async () => {
    updateFormValuesForUser.mockResolvedValue({ ...widget, status: 'active' });
    const formValues = { outreach_review: { messages: Array.from({ length: 100 }, (_, index) => ({ leadId: index + 1, message: 'Personalized outreach '.repeat(100), followUps: [] })) } };
    expect(Buffer.byteLength(JSON.stringify(formValues))).toBeGreaterThan(100_000);
    expect((await request(createApp()).patch('/11').send({ formValues })).status).toBe(200);
    findByIdForUser.mockResolvedValueOnce({ ...widget, toolName: 'generate_image' });
    expect((await request(createApp()).patch('/11').send({ formValues })).status).toBe(400);
  });

  it('scopes thread reads to the authenticated owner', async () => {
    const response = await request(createApp()).get('/').query({ threadId: 21 });

    expect(response.status).toBe(200);
    expect(findByThreadForUser).toHaveBeenCalledWith(7, 21);
  });

  it('does not expose widgets from another user thread', async () => {
    getChatThreadById.mockResolvedValue({ id: 21, userId: 99 });

    const response = await request(createApp()).get('/').query({ threadId: 21 });

    expect(response.status).toBe(404);
    expect(findByThreadForUser).not.toHaveBeenCalled();
  });

  it('does not provide a browser route for creating arbitrary tool widgets', async () => {
    const response = await request(createApp()).post('/').send({
      threadId: 21,
      toolName: 'publish_meta_ads',
      widgetType: 'publish_ads',
    });

    expect(response.status).toBe(404);
  });

  it('executes only the request that atomically claims submission', async () => {
    claimSubmissionForUser.mockResolvedValue({ widget, claimed: true });

    const response = await request(createApp()).post('/11/submit').send({ values: { leadIds: [1] } });

    expect(response.status).toBe(202);
    expect(claimSubmissionForUser).toHaveBeenCalledWith(11, 7, { leadIds: [1] });
    expect(executeCanonicalWidgetTool).toHaveBeenCalledTimes(1);
    expect(executeCanonicalWidgetTool).toHaveBeenCalledWith(
      'send_outreach_messages',
      { leadIds: [1] },
      expect.objectContaining({ userId: 7, threadId: 21, widgetId: 11 }),
    );
  });

  it('accepts a durable stop without a positive credit balance and keeps it queued', async () => {
    const stopWidget = { ...widget, toolName: 'stop_ads', widgetType: 'stop_ads' };
    findByIdForUser.mockResolvedValue(stopWidget);
    claimSubmissionForUser.mockResolvedValue({ widget: stopWidget, claimed: true });
    completeExecutionForUser.mockResolvedValue({ ...stopWidget, status: 'queued' });
    getBalance.mockResolvedValue(0);
    executeCanonicalWidgetTool.mockResolvedValue({ success: true, output: { status: 'queued', message: 'Pause not confirmed', platforms: [{ platform: 'meta', actionId: 8, status: 'gated' }] } });
    const response = await request(createApp()).post('/11/submit').send({ values: { campaignId: 19, platforms: ['meta'] } });
    await new Promise(resolve => setImmediate(resolve));
    expect(response.status).toBe(202);
    expect(getBalance).not.toHaveBeenCalled();
    expect(executeCanonicalWidgetTool).toHaveBeenCalledWith('stop_ads', { campaignId: 19, platforms: ['meta'] }, expect.objectContaining({ widgetId: 11, userId: 7 }));
    expect(completeExecutionForUser.mock.calls.at(-1)?.[6]).toBe('queued');
    expect(resumeWorkflowAfterWidgetCompletion).not.toHaveBeenCalled();
  });

  it('resumes the waiting workflow after a terminal widget execution', async () => {
    claimSubmissionForUser.mockResolvedValue({ widget, claimed: true });

    const response = await request(createApp()).post('/11/submit').send({ values: { leadIds: [1] } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.status).toBe(202);
    expect(resumeWorkflowAfterWidgetCompletion).toHaveBeenCalledWith(expect.objectContaining({
      widgetId: 11,
      userId: 7,
      threadId: 21,
      toolName: 'send_outreach_messages',
      success: true,
    }));
  });

  it('replays a completed submission without repeating its tool side effect', async () => {
    claimSubmissionForUser.mockResolvedValue({ widget: { ...widget, status: 'succeeded' }, claimed: false });

    const response = await request(createApp()).post('/11/submit').send({ values: { leadIds: [1] } });

    expect(response.status).toBe(200);
    expect(response.body.replayed).toBe(true);
    expect(executeCanonicalWidgetTool).not.toHaveBeenCalled();
  });

  it('persists a failed canonical execution instead of reporting completion', async () => {
    claimSubmissionForUser.mockResolvedValue({
      widget: { ...widget, status: 'running' },
      claimed: true,
    });
    executeCanonicalWidgetTool.mockResolvedValue({
      success: false,
      error: 'provider rejected request',
    });
    completeExecutionForUser.mockResolvedValue({
      ...widget,
      status: 'failed',
      executionError: 'provider rejected request',
    });

    const response = await request(createApp()).post('/11/submit').send({ values: { leadIds: [1] } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.status).toBe(202);
    expect(completeExecutionForUser).toHaveBeenCalledWith(
      11,
      7,
      'widget-lease-1',
      false,
      expect.objectContaining({ success: false }),
      'provider rejected request',
      'failed',
    );
  });

  it.each([undefined, {}, [], { error: true, message: 'Tool output validation failed' }])(
    'does not publish a successful completion for an invalid tool envelope (%j)', async invalid => {
      claimSubmissionForUser.mockResolvedValue({ widget, claimed: true });
      executeCanonicalWidgetTool.mockResolvedValue(invalid);
      completeExecutionForUser.mockResolvedValue({ ...widget, status: 'failed' });
      const response = await request(createApp()).post('/11/submit').send({ values: { leadIds: [1] } });
      await new Promise(resolve => setImmediate(resolve));
      expect(response.status).toBe(202);
      expect(completeExecutionForUser).toHaveBeenCalledWith(11, 7, 'widget-lease-1', false,
        expect.objectContaining({ success: false, code: 'invalid_tool_result' }), expect.any(String), 'failed');
    },
  );

  it.each(['QUEUED', 'needs_attention'])('keeps %s outreach execution queued until durable reconciliation', async status => {
    claimSubmissionForUser.mockResolvedValue({
      widget: { ...widget, status: 'running' },
      claimed: true,
    });
    executeCanonicalWidgetTool.mockResolvedValue({
      success: true,
      output: { status, campaignId: 88 },
    });
    completeExecutionForUser.mockResolvedValue({
      ...widget,
      status: 'queued',
    });

    const response = await request(createApp()).post('/11/submit').send({ values: { leadIds: [1] } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.status).toBe(202);
    expect(completeExecutionForUser).toHaveBeenCalledWith(
      11,
      7,
      'widget-lease-1',
      true,
      expect.objectContaining({ output: expect.objectContaining({ status }) }),
      undefined,
      'queued',
    );
  });

  it('validates the tenant-owned tool binding before claiming execution', async () => {
    findByIdForUser.mockResolvedValue({ ...widget, widgetType: 'tampered_widget', status: 'active' });

    const response = await request(createApp()).post('/11/submit').send({ values: { leadIds: [1] } });

    expect(response.status).toBe(409);
    expect(claimSubmissionForUser).not.toHaveBeenCalled();
    expect(executeCanonicalWidgetTool).not.toHaveBeenCalled();
  });
});
