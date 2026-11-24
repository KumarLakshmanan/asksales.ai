import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AgentState } from '../mastra/state.js';

type ProposalDeliveryResult = {
  success: boolean;
  toolName: string;
  output: { status: string; publicUrl?: string; retrySafe: boolean };
};
const executeApprovedProposalDelivery = jest.fn<(
  input: unknown,
  context: unknown,
) => Promise<ProposalDeliveryResult>>();

jest.unstable_mockModule('../mastra/tools/proposalTools.js', () => ({ executeApprovedProposalDelivery }));
jest.unstable_mockModule('../mastra/tools/executors/leadExecutor.js', () => ({ executeLeadWorkflow: jest.fn() }));
jest.unstable_mockModule('../mastra/tools/executors/outreachExecutor.js', () => ({ executeSendOutreachMessages: jest.fn() }));
jest.unstable_mockModule('../mastra/tools/executors/adsExecutor.js', () => ({
  executePublishMetaAds: jest.fn(),
  executePublishGoogleAds: jest.fn(),
}));
jest.unstable_mockModule('../mastra/tools/executors/contentExecutor.js', () => ({ executePublishSocialPost: jest.fn() }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {} }));
jest.unstable_mockModule('../models/chatMessages/functions.js', () => ({ createChatMessage: jest.fn() }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ isRateLimitError: jest.fn(() => false) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../models/conversationWorkflow/stateMachine.js', () => ({ isCurrentIcpRevisionApproved: jest.fn(() => true) }));

const { handleProposalApproval } = await import('../mastra/approvalHandlers.js');

const frozenArgs = {
  proposalId: 44,
  expectedRevision: 3,
  channel: 'email',
  outreachConversationId: 61,
  leadId: 101,
  providerAccountId: 'seller@example.test',
  providerVariant: 'gmail',
  recipientName: 'Asha Rao',
  recipientEmail: 'asha@example.test',
  subject: 'Proposal: Customer growth program',
  message: 'Please review the agreed scope.',
  expectedTargetFingerprint: 'a'.repeat(64),
  expectedReviewFingerprint: 'b'.repeat(64),
  idempotencyKey: 'campaign-proposal-send-90-turn-proposal-1',
};

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userId: 7,
    threadId: 90,
    workflowId: 'campaign-90',
    messages: [],
    selectedWorkflows: [],
    currentAgent: 'outreach',
    nextAgent: null,
    icpProfile: null,
    brandToolkit: null,
    companyProfile: null,
    leadInputs: [],
    selectedLeadIds: [101],
    toolResults: [],
    actionButtons: [],
    requiresApproval: true,
    pendingApproval: {
      toolName: 'send_proposal',
      args: frozenArgs,
      executionId: 'proposal-review-44-3',
      message: 'Review this exact proposal delivery.',
    },
    finalResponse: '',
    transitionReason: '',
    openTab: null,
    error: null,
    iteration: 1,
    maxIterations: 10,
    isComplete: false,
    lastResponseId: null,
    llmConfig: null,
    runContext: {
      userId: 7,
      threadId: 90,
      runId: 'run-proposal-1',
      turnId: 'turn-proposal-1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  executeApprovedProposalDelivery.mockResolvedValue({
    success: true,
    toolName: 'send_proposal',
    output: {
      status: 'sent',
      publicUrl: 'https://seller.example.test/proposal/public-token',
      retrySafe: false,
    },
  });
});

describe('campaign proposal approval handler', () => {
  it('executes the exact reviewed payload with the campaign selection and clears approval state', async () => {
    const result = await handleProposalApproval(state(), true);

    expect(executeApprovedProposalDelivery).toHaveBeenCalledTimes(1);
    expect(executeApprovedProposalDelivery).toHaveBeenCalledWith(frozenArgs, expect.objectContaining({
      userId: 7,
      threadId: 90,
      selectedLeadIds: [101],
      workflowId: 'run-proposal-1',
      runContext: expect.objectContaining({ runId: 'run-proposal-1', turnId: 'turn-proposal-1' }),
    }));
    expect(result).toMatchObject({
      messages: [{ role: 'assistant', content: expect.stringContaining('confirmed provider receipt') }],
      toolResults: [{ success: true, toolName: 'send_proposal', output: expect.objectContaining({ status: 'sent' }) }],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    });
  });

  it('rejects without invoking delivery and leaves the saved proposal unchanged', async () => {
    const result = await handleProposalApproval(state(), false);

    expect(executeApprovedProposalDelivery).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messages: [{ role: 'assistant', content: expect.stringContaining('not sent') }],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    });
  });
});
