import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intentWith } from './helpers/semanticIntent.js';

const history = [
  { id: 4, role: 'user', content: 'Latest message', userId: 1, threadId: 183 },
  { id: 3, role: 'assistant', content: 'Review card', metadata: { widgetId: 42 }, userId: 1, threadId: 183 },
  { id: 2, role: 'assistant', content: 'Old draft claim', agentType: 'content_studio', userId: 1, threadId: 183 },
  { id: 1, role: 'user', content: 'Old request', userId: 1, threadId: 183 },
];
const getSummary = jest.fn<any>();
const getMetadata = jest.fn<any>();
const findWidgets = jest.fn<any>().mockResolvedValue([
  { id: 42, toolName: 'generate_social_media_post', status: 'active', agentType: 'content_studio', runId: 'run1' },
]);
jest.unstable_mockModule('../services/ChatHistoryManager.js', () => ({
  chatHistoryManager: { getMessages: jest.fn<any>().mockResolvedValue(history) },
  contentWithAttachmentContext: (message: { content: string }) => message.content,
}));
jest.unstable_mockModule('../services/ConversationCompactionService.js', () => ({ conversationCompactionService: { getLatestSummary: getSummary } }));
jest.unstable_mockModule('../services/ICPGenerationService.js', () => ({ ICPGenerationService: class { async getICPForThread() { return { id: 137, revision: 2, approved: true, approvedRevision: 2 }; } } }));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({
  getChatThreadById: jest.fn(), getChatThreadMetadata: getMetadata, updateChatThreadMetadata: jest.fn(),
}));
jest.unstable_mockModule('../models/leadInputs/functions.js', () => ({ getLatestLeadInputsByThreadId: jest.fn() }));
jest.unstable_mockModule('../models/companySettings/functions.js', () => ({ getBusinessProfileContextByUserId: jest.fn(), getCompanySettingsById: jest.fn() }));
jest.unstable_mockModule('../models/users/functions.js', () => ({ getUserById: jest.fn() }));
jest.unstable_mockModule('../models/widgetStates/functions.js', () => ({ WidgetStateModel: { findByThreadForUser: findWidgets } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {} }));
jest.unstable_mockModule('../services/agents/ThreadMutex.js', () => ({ acquireConversationThreadMutex: jest.fn() }));
const { ThreadService } = await import('../services/agents/ThreadService.js');
const { buildAgentContext } = await import('../mastra/utils/contextManager.js');
const { summaryExecutionEvidence } = await import('../mastra/utils/conversationSummary.js');
const { enforceAdRequestConstraints } = await import('../mastra/utils/adRequestConstraints.js');

beforeEach(() => { getSummary.mockResolvedValue({ userId: 1, summaryText: 'Earlier draft claim', toMessageId: 2 }); getMetadata.mockResolvedValue({ workflowOutcome: 'cancelled' }); });
describe('live ThreadService compaction loading', () => {
  it('retains owned submitted media/count edits after original messages are compacted', async () => {
    const submittedValues = { number_of_variations: 2, ad_format: 'text', auto_generate_image: false,
      auto_generate_video: false, include_image_prompt: false, include_video_prompt: false };
    findWidgets.mockResolvedValueOnce([{ id: 42, toolName: 'generate_ad', status: 'draft',
      agentType: 'content_studio', runId: 'run1', formValues: { number_of_variations: 3, auto_generate_image: true }, submittedValues }]);
    const state = await ThreadService.loadThreadState(1, 183);
    expect(state.savedToolActions?.[0]).toMatchObject({ userId: 1, threadId: 183, submittedValues });
    expect(state.messages?.[0].metadata).toMatchObject({ widgetId: 42 });
    expect(enforceAdRequestConstraints('generate_ad', { number_of_variations: 1, auto_generate_image: true },
      [...(state.messages || []).slice(0, -1), { role: 'user', content: 'Make it shorter.' }],
      { userId: 1, threadId: 183, savedToolActions: state.savedToolActions,
        intentAnalysis: intentWith({ taskRelation: 'follow_up', generationReviewId: 42 }) })).toMatchObject(submittedValues);
  });
  it('does not inherit generation defaults from a completed review', async () => {
    findWidgets.mockResolvedValueOnce([{ id: 42, toolName: 'generate_ad', status: 'succeeded',
      agentType: 'content_studio', runId: 'run1', submittedValues: { number_of_variations: 2, auto_generate_image: false } }]);
    const state = await ThreadService.loadThreadState(1, 183);
    const args = { number_of_variations: 1, auto_generate_image: true };
    expect(enforceAdRequestConstraints('generate_ad', args, [{ role: 'user', content: 'Make it shorter.' }],
      { userId: 1, threadId: 183, savedToolActions: state.savedToolActions,
        intentAnalysis: intentWith({ taskRelation: 'follow_up', generationReviewId: 42 }) })).toEqual(args);
  });
  it('restores the pending review owner after a saved content or calendar reply', async () => {
    getMetadata.mockResolvedValue({ pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'lead-review-1' } });
    const state = await ThreadService.loadThreadState(1, 183);
    expect(state.currentAgent).toBe('lead_generation');
    expect(state.pendingApproval?.executionId).toBe('lead-review-1');
    expect(state.requiresApproval).toBe(true);
  });
  it('uses the request-bound saved owner for a tool shared by multiple agents', async () => {
    getMetadata.mockResolvedValue({ pendingApproval: { toolName: 'publish_social_post', executionId: 'publish-1' },
      pendingApprovalOwner: { requestId: 'publish-1', agentType: 'outreach' } });
    expect((await ThreadService.loadThreadState(1, 183)).currentAgent).toBe('outreach');
    getMetadata.mockResolvedValue({ pendingApproval: { toolName: 'publish_social_post', executionId: 'publish-1' },
      pendingApprovalOwner: { requestId: 'old-request', agentType: 'outreach' } });
    expect((await ThreadService.loadThreadState(1, 183)).currentAgent).toBe('content_studio');
  });
  it('omits covered turns, excludes this turn only once, and retains current saved action facts', async () => {
    const state = await ThreadService.loadThreadState(1, 183, { excludeMessageId: 4 });
    expect(state.messages?.map(message => message.content)).toEqual(['Review card']);
    expect(history[0].id).toBe(4);
    expect(state.contextSummary).toBe('Earlier draft claim');
    expect(state.currentAgent).toBe('content_studio');
    expect(state.savedToolActions).toEqual([{ widgetId: 42, toolName: 'generate_social_media_post', status: 'active', agentType: 'content_studio', runId: 'run1', formValues: {}, submittedValues: null, userId: 1, threadId: 183 }]);
    expect(findWidgets).toHaveBeenCalledWith(1, 183);
    const context = buildAgentContext(state as never);
    expect(context).toContain('approval=approved');
    expect(context).toContain('CURRENT WORKFLOW STATE: cancelled');
    expect(context).toContain('NOT generated content');
    expect(context).toContain('NEVER a content asset ID');
  });
  it('does not drop original history if summary loading fails or belongs to another user', async () => {
    getSummary.mockRejectedValueOnce(new Error('Unavailable'));
    expect((await ThreadService.loadThreadState(1, 183)).messages).toHaveLength(4);
    getSummary.mockResolvedValueOnce({ userId: 2, summaryText: 'Wrong user', toMessageId: 4 });
    const state = await ThreadService.loadThreadState(1, 183);
    expect(state.messages).toHaveLength(4);
    expect(state.contextSummary).toBeUndefined();
  });
  it('does not promote a nested ICP prose claim into content-generation evidence', () => {
    const facts = summaryExecutionEvidence([{ id: 5, metadata: { isToolResult: true, toolName: 'generate_icp', success: true,
      toolOutput: { icpId: 137, icp: { approved: false, revision: 1, response: 'I drafted the post and published it.' } },
    } }]);
    expect(facts).toEqual([{ messageId: 5, toolName: 'generate_icp', success: true, outcome: { icpId: 137, icp: { approved: false, revision: 1 } } }]);
  });
});
