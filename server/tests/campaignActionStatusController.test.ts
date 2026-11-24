import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intentWith, semanticRequest } from './helpers/semanticIntent.js';
import type { Request, Response } from 'express';
import type { AgentState } from '../mastra/index.js';
import type { OutreachDeliveryReport, OutreachReview } from '../mastra/campaignActionDeliveryState.js';

// Exercise the real HTTP handler and semantic status dispatch while keeping all storage,
// workflow execution, billing, websocket transport and LLM/provider IO isolated.
const classify = jest.fn<any>();
jest.unstable_mockModule('../mastra/unifiedRouter.js', () => ({ runUnifiedRouter: classify }));
const processMessage = jest.fn<(userId: number, threadId: number, content: string, state: AgentState, options?: unknown) => Promise<AgentState>>();
const findThread = jest.fn<(id: number) => Promise<{ id: number; userId: number } | undefined>>();
const getThreadMetadata = jest.fn<(threadId: number) => Promise<unknown>>();
const findReviews = jest.fn<(userId: number, threadId: number) => Promise<OutreachReview[]>>();
const queryStatus = jest.fn<(userId: number, threadId: number, widgetIds: readonly number[]) => Promise<OutreachDeliveryReport>>();
const getConfig = jest.fn<(userId: number) => Promise<Record<string, unknown> | null>>();
const loadState = jest.fn<(userId: number, threadId: number, options?: unknown) => Promise<AgentState>>();
const release = jest.fn<() => void>();
const createStrategy = jest.fn<any>();
const transitionRun = jest.fn<any>();
const retireStrategy = jest.fn<any>();
const updateMetadata = jest.fn<any>();
jest.unstable_mockModule('../mastra/cancelCampaignReviews.js', () => ({ retireLeadStrategyApproval: retireStrategy }));
const acquireMutex = jest.fn<(...args: number[]) => Promise<{ release: typeof release }>>();
type SavedMessage = Record<string, unknown> & { id: number; createdAt: Date };
const saveMessage = jest.fn<(input: Record<string, unknown>) => Promise<SavedMessage>>();
const emitChatMessage = jest.fn();
const createState = (userId = 12, threadId = 42) => ({
  userId, threadId, currentAgent: 'outreach', messages: [], toolResults: [], requiresApproval: false,
}) as unknown as AgentState;

jest.unstable_mockModule('../services/ConversationRequestCoordinator.js', () => ({
  currentConversationRequest: () => undefined,
  bindConversationRequest: jest.fn(), bindConversationWorkflow: jest.fn(), checkpointConversationRequest: jest.fn(),
  ConversationRequestError: class extends Error {},
  conversationRequests: { run: async (_request: unknown, execute: () => Promise<unknown>) => execute() },
}));
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../mastra/index.js', () => ({
  processMessage, handleApproval: jest.fn(), switchAgent: jest.fn(), getConversationState: jest.fn(),
  createInitialState: createState, getAgentDisplayName: (name: string) => name,
}));
jest.unstable_mockModule('../services/agents/ThreadService.js', () => ({ ThreadService: {
  loadThreadState: loadState, acquireThreadMutex: acquireMutex, scheduleAutoCompaction: jest.fn(),
} }));
jest.unstable_mockModule('../services/agents/MessageService.js', () => ({ MessageService: {
  saveMessage, resolveExplicitLeadSelection: async () => [], resolvePendingApprovalDecision: jest.fn(),
} }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {
  emit: jest.fn(), emitChatMessage, emitAgentStatus: jest.fn(),
} }));
jest.unstable_mockModule('../services/LLMConfigService.js', () => ({ getUserLLMConfig: getConfig, getModelFallbackConfig: jest.fn() }));
jest.unstable_mockModule('../middleware/creditCheck.js', () => ({ checkUserCredits: async () => ({ allowed: true }) }));
jest.unstable_mockModule('../mastra/utils/contextManager.js', () => ({
  shouldCompactBeforeProcessing: () => false, compactMessagesWithAI: jest.fn(), estimateTokens: jest.fn(),
}));
jest.unstable_mockModule('../mastra/approvalRequest.js', () => ({
  pendingApprovalMatchesRequest: jest.fn(), mergePendingApprovalArguments: jest.fn(),
  requiredModuleForApprovalTool: jest.fn(), validatePendingApprovalArguments: jest.fn(),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} }));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({
  getChatThreadById: findThread, createChatThread: jest.fn(), updateChatThread: jest.fn(), updateChatThreadTimestamp: jest.fn(),
  getChatThreadMetadata: getThreadMetadata, updateChatThreadMetadata: updateMetadata, clearPendingApprovalIfMatches: jest.fn(),
}));
jest.unstable_mockModule('../models/chatMessages/functions.js', () => ({
  hasUserMessageInThread: async () => true, getChatMessagesByThreadId: async () => [],
  claimChatMessageAction: jest.fn(), finalizeChatMessageAction: jest.fn(),
}));
jest.unstable_mockModule('../models/chatTabConfigs/functions.js', () => ({ getChatTabConfigs: jest.fn(), saveChatTabConfig: jest.fn() }));
jest.unstable_mockModule('../models/companySettings/functions.js', () => ({ getCompanySettingsByUserId: jest.fn(), getCompanySettingsById: jest.fn() }));
jest.unstable_mockModule('../models/leads/functions.js', () => ({ LeadModel: { findByIdForUser: jest.fn() } }));
jest.unstable_mockModule('../models/conversationToolApprovals/functions.js', () => ({
  ConversationToolApprovalModel: {}, isRetrySafeExecutionResult: () => false,
}));
jest.unstable_mockModule('../models/widgetStates/functions.js', () => ({ WidgetStateModel: { findByThreadForUser: findReviews } }));
jest.unstable_mockModule('../mastra/campaignActionDelivery.js', () => ({ storedOutreachStatusForReviews: queryStatus }));
jest.unstable_mockModule('../services/ConversationAttachmentService.js', () => ({
  prepareConversationAttachments: async () => [], appendConversationAttachmentContext: (content: string) => content,
  persistConversationUserMessageWithAttachments: jest.fn(), publicConversationMessage: (message: unknown) => message,
}));
jest.unstable_mockModule('../models/conversationWorkflow/functions.js', () => ({
  ensureConversationWorkflowRun: async () => ({ id: 'isolated-run' }), transitionConversationWorkflowRun: transitionRun,
  approveIcpRevision: jest.fn(), approveLeadInputSet: jest.fn(), createLeadSelectionSnapshot: jest.fn(),
  createLeadStrategySelection: createStrategy, createConversationWorkflowAction: jest.fn(), setConversationWorkflowActionStatus: jest.fn(),
}));

const { langGraphMessageHandler } = await import('../mastra/chatController.js');

const widgets: OutreachReview[] = [
  { id: 62, userId: 12, threadId: 42, toolName: 'send_outreach_messages', status: 'queued',
    submittedValues: { channel: 'email', lead_ids: [8801, 8802] } },
  { id: 60, userId: 12, threadId: 42, toolName: 'generate_email_template', status: 'active',
    formValues: { lead_ids: [9901] } },
  { id: 61, userId: 12, threadId: 42, toolName: 'send_outreach_messages', status: 'active',
    formValues: { channel: 'whatsapp', lead_ids: [8803] } },
];
const request = (content: string) => ({
  user: { id: 12 }, headers: {},
  // Client-supplied user/recipient/review IDs must not override the owned ledger.
  body: { content, threadId: '42', userId: 999, widgetIds: [999], lead_ids: [777] },
}) as unknown as Request;
const response = () => {
  const status = jest.fn<(code: number) => unknown>();
  const json = jest.fn<(body: unknown) => unknown>();
  const res = { status, json };
  status.mockReturnValue(res);
  json.mockReturnValue(res);
  return { res: res as unknown as Response, status, json };
};

beforeEach(() => {
  jest.clearAllMocks();
  createStrategy.mockResolvedValue({ id: 'selection-new', revision: 2 });
  transitionRun.mockResolvedValue({ id: 'isolated-run' });
  retireStrategy.mockResolvedValue(null);
  classify.mockResolvedValue(intentWith({ status: 'campaign_actions' }, { action: 'question', hiredAgents: [], nextAgent: null }));
  findThread.mockResolvedValue({ id: 42, userId: 12 });
  getThreadMetadata.mockReset().mockResolvedValue({});
  findReviews.mockResolvedValue(widgets);
  acquireMutex.mockResolvedValue({ release });
  loadState.mockResolvedValue(createState());
  getConfig.mockResolvedValue({ modelName: 'isolated-test-model' });
  let messageId = 100;
  saveMessage.mockImplementation(async input => ({ ...input, id: ++messageId, createdAt: new Date('2026-09-22T00:00:00Z') }));
  queryStatus.mockResolvedValue({ source: 'review_correlations', reviews: [{
    reviewId: 62, channel: 'email',
    counts: { queued: 1, sent: 0, delivered: 1, failed: 0, cancelled: 0, unavailable: 0 },
    recipients: [
      { leadId: 8801, state: 'queued', evidence: 'Persisted queue acknowledgement' },
      { leadId: 8802, state: 'delivered', evidence: 'Exact provider receipt records delivery' },
    ],
  }] });
  processMessage.mockImplementation(async (userId, threadId, content, state) => ({ ...state, userId, threadId,
    messages: [{ role: 'user', content }, { role: 'assistant', content: 'Normal routing received the complete request.', agentType: 'outreach' }],
  }) as AgentState);
});

describe('semantic strategy selection HTTP handoff', () => {
  const strategyIntent = () => intentWith({ lead: { ...semanticRequest().lead,
    requirements: 'Chennai HR managers, 50–200 employees, five saved leads. No execution.',
    limit: 5, location: 'Chennai',
    strategySelection: { status: 'selected', workflowIds: ['linkedin_company_search_employees'] },
  } }, { action: 'revise', leadSettingsRequested: true, nextAgent: 'lead_generation', hiredAgents: ['lead_generation'], leadChannels: ['linkedin'] });
  const approvedState = () => ({ ...createState(), currentAgent: 'lead_generation',
    icpProfile: { id: 128, revision: 2, approvedRevision: 2, approved: true, fitScore: 75 },
    selectedWorkflows: ['linkedin_company_search_employees', 'google_maps'],
  }) as AgentState;

  it('persists the narrowed exact choice in the current owned run before specialist dispatch', async () => {
    classify.mockResolvedValue(strategyIntent());
    loadState.mockResolvedValue(approvedState());
    const { res, status } = response();
    await langGraphMessageHandler(request('Use only LinkedIn Company Employee Extraction, not Google Maps. Prepare five leads for review only.'), res);
    expect(status).toHaveBeenCalledWith(201);
    expect(createStrategy).toHaveBeenCalledWith({
      runId: 'isolated-run', userId: 12, threadId: 42, platforms: ['linkedin'],
      workflowIds: ['linkedin_company_search_employees'], selection: { source: 'semantic_conversation' },
    });
    expect(createStrategy.mock.invocationCallOrder[0]).toBeLessThan(processMessage.mock.invocationCallOrder[0]);
    expect(processMessage).toHaveBeenCalledWith(12, 42, expect.any(String), expect.objectContaining({
      selectedWorkflows: ['linkedin_company_search_employees'],
      runContext: expect.objectContaining({ runId: 'isolated-run', userId: 12, threadId: 42 }),
    }), expect.objectContaining({ turnIntent: expect.objectContaining({ leadSettingsRequested: true, action: 'revise' }) }));
    expect(updateMetadata).toHaveBeenCalledWith(42, expect.objectContaining({ selectedWorkflows: ['linkedin_company_search_employees'] }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retires an old search review without treating strategy selection as execution approval', async () => {
    classify.mockResolvedValue(strategyIntent());
    loadState.mockResolvedValue({ ...approvedState(), requiresApproval: true,
      pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'old-search', args: {} },
    } as AgentState);
    retireStrategy.mockResolvedValue({ requestId: 'old-search', toolName: 'execute_lead_workflow' });
    const { res, status } = response();
    await langGraphMessageHandler(request('Replace the previous search with LinkedIn settings only; do not execute.'), res);
    expect(status).toHaveBeenCalledWith(201);
    expect(retireStrategy).toHaveBeenCalledWith(12, 42, expect.objectContaining({ executionId: 'old-search' }));
    expect(processMessage).toHaveBeenCalledWith(12, 42, expect.any(String), expect.objectContaining({
      requiresApproval: false, pendingApproval: null,
    }), expect.anything());
  });

  it('cannot replace the strategy of an already accepted search', async () => {
    classify.mockResolvedValue(strategyIntent());
    loadState.mockResolvedValue(approvedState());
    retireStrategy.mockRejectedValueOnce(new Error('The previous search has already been accepted and is running.'));
    const { res } = response();
    await langGraphMessageHandler(request('Change the strategy.'), res);
    expect(createStrategy).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('does not persist a choice against an unapproved ICP revision', async () => {
    classify.mockResolvedValue(strategyIntent());
    const state = approvedState();
    state.icpProfile!.approved = false;
    loadState.mockResolvedValue(state);
    const { res } = response();
    await langGraphMessageHandler(request('Prepare the selected strategy.'), res);
    expect(createStrategy).not.toHaveBeenCalled();
    expect(retireStrategy).not.toHaveBeenCalled();
  });

  it('does not retire an unrelated pending outreach approval', async () => {
    classify.mockResolvedValue(strategyIntent());
    loadState.mockResolvedValue({ ...approvedState(), requiresApproval: true,
      pendingApproval: { toolName: 'send_outreach_messages', executionId: 'email-review', args: {} },
    } as AgentState);
    const { res } = response();
    await langGraphMessageHandler(request('Select the LinkedIn strategy.'), res);
    expect(createStrategy).not.toHaveBeenCalled();
    expect(retireStrategy).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });
});

describe('controller model-classified campaign status', () => {
  it('stops on unclear/model-unavailable intent without creating work or reading a guessed status scope', async () => {
    classify.mockResolvedValue(intentWith({}, { action: 'clarify', needsClarification: true,
      hiredAgents: [], nextAgent: null, response: 'Which review do you mean? Nothing has changed.' }));
    const { res, status, json } = response();
    await langGraphMessageHandler(request('Yes, that one.'), res);
    expect(status).toHaveBeenCalledWith(201);
    expect(processMessage).not.toHaveBeenCalled();
    expect(findReviews).not.toHaveBeenCalled();
    expect(queryStatus).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ response: expect.objectContaining({
      content: 'Which review do you mean? Nothing has changed.',
    }) }));
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each([
    'Have any emails been sent?', 'What has been delivered?', 'Show pending reviews',
    'What actions are currently waiting for my approval, and confirm that no email or WhatsApp message has been sent?',
    'What review actions are pending, and confirm that no provider mutation, ad publication, or budget spend has happened?',
    'Show pending reviews and confirm whether any messages have been delivered. Do not send, publish, or execute anything.',
  ])(
    'passes authenticated user, normalized conversation and exact review IDs for: %s', async content => {
      const { res, status, json } = response();
      await langGraphMessageHandler(request(content), res);

      expect(status).toHaveBeenCalledWith(201);
      expect(findReviews).toHaveBeenCalledWith(12, 42);
      expect(queryStatus).toHaveBeenCalledTimes(1);
      expect(queryStatus).toHaveBeenCalledWith(12, 42, [62, 61]);
      expect(queryStatus.mock.calls[0][2]).not.toEqual([8801, 8802, 8803]);
      expect(acquireMutex).toHaveBeenCalledWith(12, 42);
      expect(saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        userId: 12, threadId: 42, role: 'assistant',
        metadata: { statusSource: 'durable_widgets', widgetIds: [62, 60, 61] },
      }));
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ threadId: 42, response: expect.objectContaining({
        content: expect.stringContaining('lead #8802: delivered'),
      }) }));
      expect(emitChatMessage).toHaveBeenCalledWith(12, 42, expect.objectContaining({ role: 'assistant' }));
      expect(getConfig).toHaveBeenCalledWith(12);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(processMessage).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'Show pending reviews and cancel #42',
    'What has been delivered? Send the remaining emails.',
    'Show pending reviews and refund #42',
    'Show pending reviews and confirm review #42',
    'Show pending reviews. Do not send, but publish the post.',
    'Show pending reviews and confirm that no email has been sent; cancel #42',
  ])('passes the entire compound mutation to normal orchestration: %s', async content => {
    classify.mockResolvedValue(intentWith({}, { action: 'new_task' }));
    const { res, status, json } = response();
    await langGraphMessageHandler(request(content), res);

    expect(status).toHaveBeenCalledWith(201);
    expect(getConfig).toHaveBeenCalledWith(12);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledWith(12, 42, content, expect.objectContaining({ userId: 12, threadId: 42 }), expect.objectContaining({ turnIntent: expect.any(Object) }));
    expect(findReviews).not.toHaveBeenCalled();
    expect(queryStatus).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ response: expect.objectContaining({
      content: 'Normal routing received the complete request.',
    }) }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not query delivery for template-only reviews', async () => {
    findReviews.mockResolvedValue([widgets[1]]);
    const { res, status, json } = response();
    await langGraphMessageHandler(request('Have any emails been sent?'), res);
    expect(status).toHaveBeenCalledWith(201);
    expect(queryStatus).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ response: expect.objectContaining({
      content: expect.stringContaining('Outreach delivery counts unavailable'),
    }) }));
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('rejects a foreign conversation before fetching widgets or delivery receipts', async () => {
    findThread.mockResolvedValue({ id: 42, userId: 999 });
    const { res, status } = response();
    await langGraphMessageHandler(request('What has been delivered?'), res);
    expect(status).toHaveBeenCalledWith(404);
    expect(acquireMutex).not.toHaveBeenCalled();
    expect(findReviews).not.toHaveBeenCalled();
    expect(queryStatus).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
    expect(getThreadMetadata).not.toHaveBeenCalled();
  });

  it('includes the fresh legacy execution approval even with zero widget cards', async () => {
    findReviews.mockResolvedValue([]);
    getThreadMetadata.mockResolvedValue({
      pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'approval-223', args: { secret: 'PRIVATE_ARGS' } },
      pendingApprovalOwner: { requestId: 'approval-223', agentType: 'lead_generation' },
    });
    const { res, status, json } = response();
    await langGraphMessageHandler(request('What actions are waiting for my approval?'), res);
    expect(status).toHaveBeenCalledWith(201);
    expect(getThreadMetadata).toHaveBeenCalledWith(42);
    expect(getThreadMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(acquireMutex.mock.invocationCallOrder[0]);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ response: expect.objectContaining({
      content: expect.stringContaining('tool execute_lead_workflow, request ID approval-223, owner lead_generation'),
    }) }));
    expect(JSON.stringify(json.mock.calls)).not.toContain('PRIVATE_ARGS');
    expect(queryStatus).not.toHaveBeenCalled();
    expect(loadState).toHaveBeenCalledWith(12, 42, expect.any(Object));
    expect(processMessage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps status available while reporting an unreadable approval ledger as unavailable', async () => {
    findReviews.mockResolvedValue([]);
    getThreadMetadata.mockRejectedValueOnce(new Error('PRIVATE_DATABASE_ERROR'));
    const { res, status, json } = response();
    await langGraphMessageHandler(request('Show pending reviews'), res);
    expect(status).toHaveBeenCalledWith(201);
    expect(getThreadMetadata).toHaveBeenCalledWith(42);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ response: expect.objectContaining({
      content: expect.stringContaining('Pending execution approval ledger unavailable'),
    }) }));
    expect(JSON.stringify(json.mock.calls)).not.toContain('No pending execution approval');
    expect(JSON.stringify(json.mock.calls)).not.toContain('PRIVATE_DATABASE_ERROR');
    expect(processMessage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
