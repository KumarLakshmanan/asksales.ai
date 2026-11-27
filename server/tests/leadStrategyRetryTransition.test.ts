import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const transition = jest.fn<any>();
const ensureRun = jest.fn<any>();
const createSelection = jest.fn<any>();
const loadThreadState = jest.fn<any>();
jest.unstable_mockModule('../mastra/index.js', () => ({
  processMessage: jest.fn(), handleApproval: jest.fn(), switchAgent: jest.fn(), getConversationState: jest.fn(),
  createInitialState: jest.fn(), getAgentDisplayName: (name: string) => name,
}));
jest.unstable_mockModule('../services/agents/ThreadService.js', () => ({ ThreadService: {
  loadThreadState, acquireThreadMutex: async () => ({ release: jest.fn() }),
} }));
jest.unstable_mockModule('../services/agents/MessageService.js', () => ({ MessageService: { saveMessage: jest.fn() } }));
jest.unstable_mockModule('../mastra/cancelCampaignReviews.js', () => ({ retireLeadStrategyApproval: async () => null }));
jest.unstable_mockModule('../models/conversationWorkflow/functions.js', () => ({
  approveIcpRevision: jest.fn(), approveLeadInputSet: jest.fn(), createLeadSelectionSnapshot: jest.fn(),
  createLeadStrategySelection: createSelection, ensureConversationWorkflowRun: ensureRun,
  transitionConversationWorkflowRun: transition, createConversationWorkflowAction: jest.fn(),
  setConversationWorkflowActionStatus: jest.fn(),
}));
const { InvalidWorkflowTransitionError } = await import('../models/conversationWorkflow/stateMachine.js');
const { recordConfirmedLeadStrategy } = await import('../mastra/chatController.js');

const approvedIcp = { id: 9, revision: 2, approved: true, approvedRevision: 2 };
const retry = () => recordConfirmedLeadStrategy({
  userId: 1, threadId: 237, workflowIds: ['linkedin_company_search'], platforms: ['linkedin_company_search'],
  state: { icpProfile: approvedIcp } as any,
});

describe('lead search retry after the campaign moved to outreach', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ensureRun.mockResolvedValue({ id: 'run-1', stage: 'outreach_ready', status: 'awaiting_input' });
    createSelection.mockResolvedValue({ id: 31, revision: 1 });
  });

  it('returns to agent selection first instead of failing the retry', async () => {
    transition
      .mockRejectedValueOnce(new InvalidWorkflowTransitionError('outreach_ready', 'lead_strategy_awaiting_approval'))
      .mockResolvedValue({ id: 'run-1' });
    await expect(retry()).resolves.toBe(false);
    expect(transition.mock.calls.map(([call]) => (call as { toStage: string }).toStage)).toEqual([
      'lead_strategy_awaiting_approval', 'agent_selection', 'lead_strategy_awaiting_approval', 'lead_inputs_generating',
    ]);
    expect(createSelection).toHaveBeenCalledWith(expect.objectContaining({ workflowIds: ['linkedin_company_search'] }));
  });

  it('explains in plain words when the current step cannot be left', async () => {
    transition
      .mockRejectedValueOnce(new InvalidWorkflowTransitionError('outreach_running', 'lead_strategy_awaiting_approval'))
      .mockRejectedValueOnce(new InvalidWorkflowTransitionError('outreach_running', 'agent_selection'));
    await expect(retry()).rejects.toThrow('Your messages are being sent. Wait for sending to finish before changing this campaign.');
    expect(createSelection).not.toHaveBeenCalled();
  });

  it('does not hide other failures', async () => {
    transition.mockRejectedValueOnce(new Error('Conversation workflow run changed; reload before retrying'));
    await expect(retry()).rejects.toThrow('Conversation workflow run changed');
    expect(transition).toHaveBeenCalledTimes(1);
  });
});
