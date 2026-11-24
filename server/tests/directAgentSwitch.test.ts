import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const switchAgent = jest.fn<any>();
const loadThreadState = jest.fn<any>();
const release = jest.fn();
const saveMessage = jest.fn<any>();
const updateMetadata = jest.fn<any>();
const updateThread = jest.fn<any>();
const findThread = jest.fn<any>();
jest.unstable_mockModule('../mastra/index.js', () => ({
  processMessage: jest.fn(), handleApproval: jest.fn(), switchAgent, getConversationState: jest.fn(),
  createInitialState: () => ({ messages: [], toolResults: [] }), getAgentDisplayName: (name: string) => name,
}));
jest.unstable_mockModule('../services/agents/ThreadService.js', () => ({ ThreadService: {
  loadThreadState, acquireThreadMutex: async () => ({ release }),
} }));
jest.unstable_mockModule('../services/agents/MessageService.js', () => ({ MessageService: { saveMessage } }));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({
  getChatThreadById: findThread, createChatThread: jest.fn(), updateChatThread: updateThread, updateChatThreadTimestamp: jest.fn(),
  getChatThreadMetadata: async () => ({}), updateChatThreadMetadata: updateMetadata, clearPendingApprovalIfMatches: jest.fn(),
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {
  emit: jest.fn(), emitChatMessage: jest.fn(), emitAgentStatus: jest.fn(),
} }));
const { langGraphSwitchAgentHandler } = await import('../mastra/chatController.js');
const initial = () => ({ userId: 1, threadId: 42, currentAgent: 'content_studio', messages: [],
  icpProfile: { id: 1, fitScore: 80, approved: true, revision: 1, approvedRevision: 1 },
  savedToolActions: [{ widgetId: 9, toolName: 'generate_social_media_post', status: 'active' }],
});
const request = () => ({ user: { id: 1 }, body: { threadId: 42, targetAgent: 'outreach' } }) as any;
const response = () => {
  const res: any = { statusCode: 200 };
  res.status = jest.fn((value: number) => { res.statusCode = value; return res; });
  res.json = jest.fn((body: unknown) => { res.body = body; return res; });
  return res;
};
beforeEach(() => {
  jest.clearAllMocks();
  findThread.mockResolvedValue({ id: 42, userId: 1, title: 'Campaign' });
  loadThreadState.mockResolvedValue(initial());
  switchAgent.mockImplementation(async (_u: number, _t: number, target: string, state: any) => ({ ...state,
    currentAgent: target, agentPipeline: [target], agentPipelineIndex: 0, pipelineRequest: 'Prepare outreach',
    messages: [{ role: 'user', content: 'Switch agent' }, { role: 'assistant', content: 'Review recipients with Emily.', agentType: target }],
  }));
});
describe('direct specialist handoff', () => {
  it('preserves active draft cards and persists the actual new pipeline', async () => {
    const res = response();
    await langGraphSwitchAgentHandler(request(), res);
    expect(res.body).toMatchObject({ success: true, currentAgent: 'outreach' });
    expect(switchAgent.mock.calls[0][3]).toEqual(expect.objectContaining({ savedToolActions: initial().savedToolActions }));
    expect(updateMetadata).toHaveBeenCalledWith(42, expect.objectContaining({ agentPipeline: ['outreach'], pipelineRequest: 'Prepare outreach' }));
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('reports a pending execution approval before emitting or claiming a handoff', async () => {
    loadThreadState.mockResolvedValue({ ...initial(), requiresApproval: true, pendingApproval: { executionId: 'approval-1' } });
    const res = response();
    await langGraphSwitchAgentHandler(request(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, currentAgent: 'content_studio' });
    expect(switchAgent).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not return a successful target agent when the orchestrator could not switch', async () => {
    switchAgent.mockResolvedValue({ ...initial(), error: 'Provider unavailable', messages: [{ role: 'assistant', content: 'Unable to switch.' }] });
    const res = response();
    await langGraphSwitchAgentHandler(request(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, currentAgent: 'content_studio' });
    expect(updateThread).not.toHaveBeenCalled();
  });
  it('rejects a foreign conversation without invoking an agent', async () => {
    findThread.mockResolvedValue({ id: 42, userId: 2 });
    const res = response();
    await langGraphSwitchAgentHandler(request(), res);
    expect(res.statusCode).toBe(403);
    expect(switchAgent).not.toHaveBeenCalled();
  });
});
