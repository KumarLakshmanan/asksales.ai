import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const processMessage = jest.fn<any>();
const loadThreadState = jest.fn<any>();
const release = jest.fn();
const createAction = jest.fn<any>();
const setAction = jest.fn<any>();
const transition = jest.fn<any>();
const saveMessage = jest.fn<any>();
const updateMetadata = jest.fn<any>();
const emit = jest.fn();
const findWidgets = jest.fn<any>();
const findThread = jest.fn<any>();
const approveIcp = jest.fn<any>();
const openTab = jest.fn();
jest.unstable_mockModule('../models/widgetStates/functions.js', () => ({ WidgetStateModel: { findByThreadForUser: findWidgets } }));
const metadata: Record<string, unknown> = {};
jest.unstable_mockModule('../mastra/index.js', () => ({
  processMessage, handleApproval: jest.fn(), switchAgent: jest.fn(), getConversationState: jest.fn(),
  createInitialState: jest.fn(), getAgentDisplayName: (name: string) => name,
}));
jest.unstable_mockModule('../services/agents/ThreadService.js', () => ({ ThreadService: {
  loadThreadState, acquireThreadMutex: async () => ({ release }),
} }));
jest.unstable_mockModule('../services/agents/MessageService.js', () => ({ MessageService: { saveMessage } }));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({
  getChatThreadById: findThread, createChatThread: jest.fn(), updateChatThread: jest.fn(), updateChatThreadTimestamp: jest.fn(),
  getChatThreadMetadata: async () => metadata, updateChatThreadMetadata: updateMetadata, clearPendingApprovalIfMatches: jest.fn(),
}));
jest.unstable_mockModule('../models/conversationWorkflow/functions.js', () => ({
  approveIcpRevision: approveIcp, approveLeadInputSet: jest.fn(), createLeadSelectionSnapshot: jest.fn(),
  createLeadStrategySelection: jest.fn(), ensureConversationWorkflowRun: jest.fn(),
  transitionConversationWorkflowRun: transition, createConversationWorkflowAction: createAction,
  setConversationWorkflowActionStatus: setAction,
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {
  emit, emitChatMessage: emit, emitAgentStatus: emit, emitOpenTab: openTab,
} }));
const { resumeAfterIcpApproval, resumeWorkflowAfterWidgetCompletion, langGraphActionHandler } = await import('../mastra/chatController.js');
const input = { userId: 1, threadId: 171, runId: 'run-1', icpId: 128, revision: 1 };
const state = () => ({
  userId: 1, threadId: 171, messages: [], currentAgent: 'icp_generation',
  agentPipeline: ['icp_generation', 'performance_marketing'], agentPipelineIndex: 0,
  pipelineRequest: 'Prepare only asset 114; do not activate or spend.',
  icpProfile: { id: 128, fitScore: 81, revision: 1, approved: true, approvedRevision: 1 },
  runContext: { runId: 'run-1', threadId: 171, userId: 1 },
});

describe('approved ICP agent choice HTTP handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findThread.mockResolvedValue({ id: 171, userId: 1 });
    loadThreadState.mockResolvedValue({ ...state(), agentPipeline: ['icp_generation', 'outreach'] });
    approveIcp.mockResolvedValue({ replayed: false, run: { id: 'run-1', stage: 'agent_selection', status: 'awaiting_input' } });
    saveMessage.mockImplementation(async (args: any) => ({ ...args, id: 501, createdAt: new Date() }));
  });
  const invoke = async () => {
    const res: any = { statusCode: 200, status: jest.fn(function(this: any, code: number) { this.statusCode = code; return this; }), json: jest.fn() };
    await langGraphActionHandler({ user: { id: 1 }, body: { threadId: 171, action: 'APPROVE_ICP', data: { icpId: 128, revision: 1 } } } as any, res);
    return res;
  };
  it('persists an Emily choice and opens the chooser without executing outreach', async () => {
    const res = await invoke();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agent_selection', recommendedAgents: ['outreach'] }));
    expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({
      actionButtons: expect.arrayContaining([expect.objectContaining({ action: 'HIRE_OUTREACH' })]),
    }) }));
    expect(openTab).toHaveBeenCalledWith(1, 'agentchoose', expect.any(String), expect.objectContaining({ recommendedAgents: ['outreach'] }), 171);
    expect(processMessage).not.toHaveBeenCalled();
  });
  it('does not reopen the chooser for an already completed replay', async () => {
    approveIcp.mockResolvedValue({ replayed: true, run: { id: 'run-1', stage: 'completed', status: 'completed' } });
    await invoke();
    expect(openTab).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });
  it('does not open a chooser after failed revision approval', async () => {
    approveIcp.mockRejectedValue(new Error('Stale revision'));
    expect((await invoke()).statusCode).toBe(409);
    expect(openTab).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });
});

describe('widget continuation durable scope', () => {
  const completion = { widgetId: 40, userId: 1, threadId: 171, runId: 'run-1', toolName: 'stop_ads', success: true, result: {} };
  const widget = { id: 40, userId: 1, threadId: 171, runId: 'run-1', toolName: 'stop_ads', status: 'succeeded', executionResult: { success: true } };
  beforeEach(() => {
    jest.clearAllMocks();
    findWidgets.mockResolvedValue([widget]);
    loadThreadState.mockResolvedValue(state());
  });
  it('does not resume a newer request when an old job completes', async () => {
    loadThreadState.mockResolvedValue({ ...state(), runContext: { runId: 'new-run' } });
    expect(await resumeWorkflowAfterWidgetCompletion(completion)).toBe(false);
    expect(processMessage).not.toHaveBeenCalled();
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: 'queued' }, { runId: 'other-run' }, { userId: 2 },
    { threadId: 172 }, { toolName: 'publish_ads' },
  ])('rejects a mismatched or nonterminal durable widget: %j', async (override) => {
    findWidgets.mockResolvedValue([{ ...widget, ...override }]);
    expect(await resumeWorkflowAfterWidgetCompletion(completion)).toBe(false);
    expect(processMessage).not.toHaveBeenCalled();
    expect(updateMetadata).not.toHaveBeenCalled();
  });
  it('uses the stored failure rather than an optimistic callback success', async () => {
    findWidgets.mockResolvedValue([{ ...widget, status: 'failed', executionResult: { error: 'Provider refused pause' } }]);
    processMessage.mockResolvedValue({ ...state(), messages: [], toolResults: [] });
    await resumeWorkflowAfterWidgetCompletion({ ...completion, result: { message: 'Ads stopped' } });
    expect(processMessage).toHaveBeenCalledWith(1, 171,
      expect.stringContaining('Provider refused pause'),
      expect.objectContaining({ widgetContinuation: expect.objectContaining({ success: false }) }));
    expect(processMessage.mock.calls[0][2]).not.toContain('Ads stopped');
  });
});
describe('post-ICP workflow continuation orchestration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadThreadState.mockResolvedValue(state());
    createAction.mockImplementation(async (args: any) => ({ id: args.actionId, status: 'running' }));
    processMessage.mockImplementation(async (_u: number, _t: number, _message: string, current: any) => ({
      ...current, messages: [{ role: 'assistant', content: 'Review is ready.' }],
      toolResults: [], requiresApproval: true, workflowOutcome: 'awaiting_approval',
    }));
    saveMessage.mockImplementation(async (args: any) => ({ ...args, id: 501, createdAt: new Date() }));
  });
  it('continues the exact request, persists assistant-only output, and releases the lock', async () => {
    expect(await resumeAfterIcpApproval(input)).toBe(true);
    expect(processMessage).toHaveBeenCalledWith(1, 171, expect.stringContaining('Prepare only asset 114'), expect.objectContaining({
      agentPipelineIndex: 1, currentAgent: 'performance_marketing',
      icpApprovalContinuation: { agent: 'performance_marketing', icpId: 128, revision: 1 },
    }));
    expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant' }));
    expect(setAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
    expect(transition).toHaveBeenLastCalledWith(expect.objectContaining({ onlyFromStage: 'agent_running', toStage: 'ad_draft', status: 'awaiting_approval' }));
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not execute an existing continuation twice', async () => {
    createAction.mockResolvedValue({ id: 'already-claimed', status: 'running' });
    expect(await resumeAfterIcpApproval(input)).toBe(true);
    expect(processMessage).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not resume another run or an unapproved revision', async () => {
    loadThreadState.mockResolvedValue({ ...state(), runContext: { runId: 'other-run' } });
    expect(await resumeAfterIcpApproval(input)).toBe(false);
    loadThreadState.mockResolvedValue({ ...state(), icpProfile: { ...state().icpProfile, approved: false } });
    expect(await resumeAfterIcpApproval(input)).toBe(false);
    expect(createAction).not.toHaveBeenCalled();
  });
  it('records execution failure without emitting a successful assistant response', async () => {
    processMessage.mockRejectedValue(new Error('test provider failure'));
    await expect(resumeAfterIcpApproval(input)).rejects.toThrow('test provider failure');
    expect(setAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(transition).toHaveBeenLastCalledWith(expect.objectContaining({ onlyFromStage: 'agent_running', toStage: 'needs_attention', status: 'failed' }));
    expect(saveMessage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not label a returned failed outcome as successful continuation', async () => {
    processMessage.mockResolvedValue({ ...state(), messages: [{ role: 'assistant', content: 'The provider failed.' }],
      currentAgent: 'performance_marketing', toolResults: [], workflowOutcome: 'failed' });
    await resumeAfterIcpApproval(input);
    expect(setAction).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(transition).toHaveBeenLastCalledWith(expect.objectContaining({ toStage: 'needs_attention' }));
  });
});
