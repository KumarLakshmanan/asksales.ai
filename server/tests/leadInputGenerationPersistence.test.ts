import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ToolContext } from '../mastra/tools/toolRegistry.js';

const createLeadInputs = jest.fn<any>();
const createChatMessage = jest.fn<any>();
const createChatCompletion = jest.fn<any>();
const executeProviderCallWithFallback = jest.fn<any>();
const emit = jest.fn();
const emitProgressStep = jest.fn();
const getLatestLeadStrategySelection = jest.fn<any>();
const createReviewedLeadInputSet = jest.fn<any>();
const transitionConversationWorkflowRun = jest.fn<any>();
const findLeadActorsWithoutKey = jest.fn<any>();
const NOT_CONNECTED = "Lead search isn't available right now because the lead data provider isn't connected.";
class LeadProviderUnavailableError extends Error { constructor() { super(NOT_CONNECTED); } }

jest.unstable_mockModule('../models/leadInputs/functions', () => ({ createLeadInputs }));
jest.unstable_mockModule('../models/conversationWorkflow/functions', () => ({
  getLatestLeadStrategySelection,
  createReviewedLeadInputSet,
  transitionConversationWorkflowRun,
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({
  LLMProviderFactory: {
    createProviderForUser: async () => ({ defaultModel: 'test', createChatCompletion }),
    executeProviderCallWithFallback,
  },
}));
jest.unstable_mockModule('../models/companySettings/functions', () => ({
  getCompanySettingsByUserId: async () => ({ city: 'Bengaluru' }),
}));
jest.unstable_mockModule('../models/leadSettings/functions', () => ({
  getLeadSettingsByUserId: async () => null,
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({
  webSocketEmitter: { emit, emitProgressStep, emitChatResponse: jest.fn() },
}));
jest.unstable_mockModule('../models/chatMessages/functions', () => ({
  createChatMessage,
}));
jest.unstable_mockModule('../services/apifyCredentialResolver.js', () => ({ findLeadActorsWithoutKey, LeadProviderUnavailableError }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Use the application's real workflow and actor JSON schemas. Only the LLM,
// persistence, and transport boundaries are fakes; no provider runs or DB writes.
const { executeGenerateLeadInputs } = await import('../mastra/tools/executors/leadExecutor.js');
const { LLMProviderResponseError } = await import('../services/agents/LLMProviderErrors.js');
const testProvider = {
  defaultModel: 'test',
  getProviderName: () => 'test-provider',
  createChatCompletion,
};
const context = {
  userId: 1, threadId: 42,
  icpProfile: { targetBusinessModel: 'B2B', primaryRegions: ['Bengaluru'] },
} as ToolContext;
const input = { selected_workflows: ['linkedin'], user_requirements: 'Find exactly 3 CTO leads in Bengaluru' };

describe('lead input generation persistence handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createChatCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ currentJobTitles: ['CTO'], locations: ['Bengaluru'], maxItems: 3 }),
    });
    executeProviderCallWithFallback.mockImplementation(async (_userId: number, call: (provider: typeof testProvider) => Promise<unknown>) => call(testProvider));
    createChatMessage.mockResolvedValue({ id: 1001 });
    createLeadInputs.mockImplementation(async (rows: Record<string, unknown>[]) =>
      rows.map((row, index) => ({ ...row, id: 901 + index })));
    createReviewedLeadInputSet.mockImplementation(async ({ leadInputs }: { leadInputs: Record<string, unknown>[] }) => ({
      inputs: leadInputs.map((row, index) => ({ ...row, id: 901 + index })),
      inputSet: { id: 'review-901', revision: 1 },
      run: { id: 'run-42', stage: 'lead_inputs_awaiting_approval' },
    }));
    transitionConversationWorkflowRun.mockResolvedValue({});
    findLeadActorsWithoutKey.mockResolvedValue(new Set());
  });

  it('says the data provider is not connected before preparing settings when no search has a key', async () => {
    findLeadActorsWithoutKey.mockImplementation(async (_userId: number, actorIds: string[]) => new Set(actorIds));
    const result = await executeGenerateLeadInputs(input, context);
    expect(result.success).toBe(false);
    expect(result.error).toBe(NOT_CONNECTED);
    expect(result.output).toMatchObject({ errorCode: 'LEAD_DATA_PROVIDER_NOT_CONNECTED' });
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(createLeadInputs).not.toHaveBeenCalled();
    expect(createChatMessage).toHaveBeenCalledWith(expect.objectContaining({ content: NOT_CONNECTED }));
  });

  it('returns the exact saved IDs and workflow IDs needed by the approval action', async () => {
    const result = await executeGenerateLeadInputs(input, context);
    expect(result.success).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(createLeadInputs).toHaveBeenCalledTimes(1);
    expect(result.output).toMatchObject({
      status: 'succeeded', inputIds: [901], workflowIds: ['linkedin_b2b'], count: 1,
    });
    expect(emit).toHaveBeenCalledWith(1, 'lead_inputs_generated', expect.objectContaining({
      inputIds: result.output?.inputIds, workflowIds: result.output?.workflowIds,
    }));
    const savedRows = createLeadInputs.mock.calls[0][0] as Record<string, unknown>[];
    expect(savedRows[0]).toMatchObject({ userId: 1, threadId: 42, platform: 'linkedin' });
    expect(emit).toHaveBeenCalledWith(1, 'open_tab', expect.any(Object));
  });

  it('does not claim completion or open a result tab when persistence returns no rows', async () => {
    createLeadInputs.mockResolvedValue([]);
    const result = await executeGenerateLeadInputs(input, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/persist|sav/i);
    expect(emit).not.toHaveBeenCalledWith(1, 'lead_inputs_generated', expect.anything());
    expect(emit).not.toHaveBeenCalledWith(1, 'open_tab', expect.anything());
    expect(emitProgressStep).not.toHaveBeenCalledWith(1, 42, 'lead_complete', expect.anything(), expect.anything());
  });

  it('does not claim ready when the model generates no search entries', async () => {
    createChatCompletion.mockResolvedValue({ success: true, content: '{"searches":[]}' });
    const result = await executeGenerateLeadInputs(input, context);
    expect(result.success).toBe(false);
    expect(createLeadInputs).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(1, 'lead_inputs_generated', expect.anything());
  });

  it('keeps Facebook Competitor Page Followers bound to its own saved workflow schema', async () => {
    createChatCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ startUrls: [{ url: 'https://www.facebook.com/ExampleCompetitor' }], resultsLimit: 5 }),
    });

    const result = await executeGenerateLeadInputs({
      platforms: ['facebook'],
      selected_workflows: ['facebook_competitor_pages'],
      user_requirements: 'Find followers of my competitor Facebook page https://www.facebook.com/ExampleCompetitor; cap results at 5.',
    }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      count: 1,
      workflowIds: ['facebook_competitor_pages'],
      schemas: [expect.objectContaining({
        platform: 'facebook_competitor_pages',
        workflowId: 'facebook_competitor_pages',
        category: 'Facebook Competitor Page Followers',
        inputs: {
          startUrls: [{ url: 'https://www.facebook.com/ExampleCompetitor' }],
          resultsLimit: 5,
          followType: 'follower',
        },
      })],
    });
    expect(createLeadInputs).toHaveBeenCalledTimes(1);
    expect((createLeadInputs.mock.calls[0][0] as Record<string, unknown>[])[0]).toMatchObject({
      platform: 'facebook_competitor_pages',
      inputs: expect.objectContaining({ followType: 'follower' }),
    });
  });

  it('uses the confirmed Facebook follower workflow and exact user URLs instead of model-selected post authors', async () => {
    createChatCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        query: 'HubSpot software revenue analytics',
        maxResults: 10,
        start_date: '2026-01-01',
        end_date: '2026-09-21',
      }),
    });
    const request = 'Prepare search settings for the selected strategy for my review only. Facebook Competitor Page Followers using competitor page URLs https://www.facebook.com/hubspot and https://www.facebook.com/salesforce, max 5 results. Do not approve or execute a search.';

    const result = await executeGenerateLeadInputs({
      platforms: ['facebook'],
      selected_workflows: ['facebook_post_authors'],
      user_requirements: request,
    }, {
      ...context,
      selectedWorkflows: ['facebook_competitor_pages'],
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ count: 1, workflowIds: ['facebook_competitor_pages'] });
    expect(result.output?.schemas?.[0]?.inputs).toMatchObject({
      startUrls: [
        { url: 'https://www.facebook.com/hubspot' },
        { url: 'https://www.facebook.com/salesforce' },
      ],
      resultsLimit: 5,
      followType: 'follower',
    });
    expect(createLeadInputs).toHaveBeenCalledTimes(1);
    expect((createLeadInputs.mock.calls[0][0] as Record<string, unknown>[])[0]).toMatchObject({
      platform: 'facebook_competitor_pages',
      inputs: {
        startUrls: [
          { url: 'https://www.facebook.com/hubspot' },
          { url: 'https://www.facebook.com/salesforce' },
        ],
        resultsLimit: 5,
        followType: 'follower',
      },
    });
  });

  it('deduplicates repeated selected workflow IDs before generating or saving settings', async () => {
    createChatCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ query: 'CTO OR VP Engineering Bengaluru', maxResults: 25 }),
    });

    const result = await executeGenerateLeadInputs({
      platforms: ['twitter'],
      selected_workflows: ['twitter_post_authors', 'twitter_post_authors'],
      user_requirements: 'Use the Twitter Post Author Profiles workflow and prepare settings for review.',
    }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ count: 1, workflowIds: ['twitter_post_authors'] });
    expect(createLeadInputs).toHaveBeenCalledTimes(1);
    expect((createLeadInputs.mock.calls[0][0] as Record<string, unknown>[])).toHaveLength(1);
  });

  it('does not save Facebook follower settings with an actor demo URL when the request has no page URL', async () => {
    createChatCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ startUrls: [{ url: 'https://www.facebook.com/LeonardoDiCaprio' }], resultsLimit: 5 }),
    });

    const result = await executeGenerateLeadInputs({
      platforms: ['facebook'],
      selected_workflows: ['facebook_competitor_pages'],
      user_requirements: 'Prepare Facebook Competitor Page Followers settings for review, max 5 results.',
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires one or more HTTPS Facebook page URLs/i);
    expect(createLeadInputs).not.toHaveBeenCalled();
  });

  it('regenerates unsolicited Twitter search variants as one input', async () => {
    createChatCompletion
      .mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({ searches: [
          { query: 'CTO Bengaluru', maxResults: 25 },
          { query: 'VP Engineering Bengaluru', maxResults: 25 },
        ] }),
      })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ query: 'CTO OR VP Engineering Bengaluru', maxResults: 25 }) });

    const result = await executeGenerateLeadInputs({
      platforms: ['twitter'], selected_workflows: ['twitter_post_authors'],
      user_requirements: 'Find technology decision makers in Bengaluru using Twitter.',
    }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ count: 1, workflowIds: ['twitter_post_authors'] });
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(createLeadInputs).toHaveBeenCalledTimes(1);
    expect((createLeadInputs.mock.calls[0][0] as Record<string, unknown>[])).toHaveLength(1);
    expect(result.output?.message).toContain('1 search input(s) for 1 selected workflow(s)');
  });

  it('allows multiple search inputs only when the user explicitly requests them', async () => {
    createChatCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ searches: [
        { query: 'CTO Bengaluru', maxResults: 25 },
        { query: 'CFO Bengaluru', maxResults: 25 },
      ] }),
    });

    const result = await executeGenerateLeadInputs({
      platforms: ['twitter'], selected_workflows: ['twitter_post_authors'],
      user_requirements: 'Run separate searches for CTOs and CFOs in Bengaluru.',
    }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ count: 2, workflowIds: ['twitter_post_authors', 'twitter_post_authors'] });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect((createLeadInputs.mock.calls[0][0] as Record<string, unknown>[])).toHaveLength(2);
  });

  it('fails closed when the model repeats unsolicited variants after correction', async () => {
    const twoVariants = JSON.stringify({ searches: [
      { query: 'CTO Bengaluru', maxResults: 25 },
      { query: 'VP Engineering Bengaluru', maxResults: 25 },
    ] });
    createChatCompletion.mockResolvedValue({ success: true, content: twoVariants });

    const result = await executeGenerateLeadInputs({
      platforms: ['twitter'], selected_workflows: ['twitter_post_authors'],
      user_requirements: 'Find technology decision makers in Bengaluru using Twitter.',
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multiple search variants.*none were requested/i);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(createLeadInputs).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(1, 'lead_inputs_generated', expect.anything());
  });

  it('recovers from a provider response error and saves only the successful settings', async () => {
    createChatCompletion
      .mockRejectedValueOnce(new LLMProviderResponseError('upstream 502', 'test-provider', 'test'));

    const result = await executeGenerateLeadInputs(input, context);

    expect(executeProviderCallWithFallback).toHaveBeenCalledTimes(2);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: true, requiresApproval: true, output: {
      status: 'succeeded', inputIds: [901], workflowIds: ['linkedin_b2b'], count: 1,
    } });
    expect(createLeadInputs).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(1, 'open_tab', expect.any(Object));
  });

  it('uses another configured provider when the first response is unsuccessful', async () => {
    createChatCompletion.mockResolvedValueOnce({ success: false, error: 'upstream 503' });
    executeProviderCallWithFallback.mockImplementation(async (_userId: number, call: (provider: typeof testProvider) => Promise<unknown>) => {
      try {
        return await call(testProvider);
      } catch (error) {
        expect(error).toBeInstanceOf(LLMProviderResponseError);
        return call({ ...testProvider, getProviderName: () => 'fallback-provider' });
      }
    });

    const result = await executeGenerateLeadInputs(input, context);

    expect(executeProviderCallWithFallback).toHaveBeenCalledTimes(1);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(createLeadInputs).toHaveBeenCalledTimes(1);
  });

  it('returns a structured retry path without saving or exposing provider internals when retries are exhausted', async () => {
    createChatCompletion.mockRejectedValue(new LLMProviderResponseError('secret upstream detail', 'test-provider', 'test'));

    const result = await executeGenerateLeadInputs(input, context);

    expect(executeProviderCallWithFallback).toHaveBeenCalledTimes(2);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: false, toolName: 'generate_lead_inputs', output: {
      status: 'failed', errorCode: 'LEAD_INPUT_PROVIDER_UNAVAILABLE', retryable: true,
      selectedWorkflows: ['linkedin'],
    } });
    expect(result.error).toContain('try preparing its settings again');
    expect(result.error).not.toContain('secret upstream detail');
    expect(createLeadInputs).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(1, 'open_tab', expect.anything());
    expect(createChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('try preparing its settings again'),
    }));
    expect(JSON.stringify(createChatMessage.mock.calls)).not.toContain('secret upstream detail');
    // Internal error codes stay out of the chat.
    expect(JSON.stringify(createChatMessage.mock.calls)).not.toContain('LEAD_INPUT_PROVIDER_UNAVAILABLE');
  });

  it('marks a durable run as needing attention instead of creating a review after provider exhaustion', async () => {
    getLatestLeadStrategySelection.mockResolvedValue({ id: 'strategy-42', workflowIds: ['linkedin'] });
    createChatCompletion.mockRejectedValue(new LLMProviderResponseError('provider failed', 'test-provider', 'test'));

    const result = await executeGenerateLeadInputs(input, {
      ...context, runContext: { runId: 'run-42', userId: 1, threadId: 42 },
    });

    expect(result.success).toBe(false);
    expect(transitionConversationWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-42', toStage: 'needs_attention', status: 'failed',
      contextPatch: { leadInputGenerationFailed: true, leadInputGenerationErrorCode: 'LEAD_INPUT_PROVIDER_UNAVAILABLE' },
    }));
    expect(createReviewedLeadInputSet).not.toHaveBeenCalled();
    expect(createLeadInputs).not.toHaveBeenCalled();
  });

  it('normalizes the historical profile-search name to the exact confirmed LinkedIn workflow', async () => {
    getLatestLeadStrategySelection.mockResolvedValue({ id: 'strategy-42', workflowIds: ['linkedin'] });
    const result = await executeGenerateLeadInputs({ ...input, selected_workflows: ['linkedin_profile_search'] }, {
      ...context, runContext: { runId: 'run-42', userId: 1, threadId: 42 },
    });
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ platforms: ['linkedin'], workflowIds: ['linkedin_b2b'] });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(createReviewedLeadInputSet).toHaveBeenCalledWith(expect.objectContaining({
      strategySelectionId: 'strategy-42', platforms: ['linkedin'], runId: 'run-42',
      leadInputs: [expect.objectContaining({ userId: 1, threadId: 42, platform: 'linkedin' })],
    }));
    expect(createLeadInputs).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({ leadInputSetId: 'review-901', leadInputSetRevision: 1, workflowRunId: 'run-42' });
  });

  it('does not fall back to standalone input rows when the atomic review transition fails', async () => {
    getLatestLeadStrategySelection.mockResolvedValue({ id: 'strategy-42', workflowIds: ['linkedin'] });
    createReviewedLeadInputSet.mockRejectedValue(new Error('Conversation workflow run changed; reload before retrying'));

    const result = await executeGenerateLeadInputs(input, {
      ...context, runContext: { runId: 'run-42', userId: 1, threadId: 42 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/workflow run changed/i);
    expect(createLeadInputs).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(1, 'lead_inputs_generated', expect.anything());
  });

  it('rejects an unknown selected workflow even when the broad platform is valid', async () => {
    const result = await executeGenerateLeadInputs({ ...input, platforms: ['linkedin'], selected_workflows: ['linkedin_unavailable'] }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no substitute/);
    expect(createLeadInputs).not.toHaveBeenCalled();
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it('uses the exact durable strategy when the model invents an unknown alias for the bound choice', async () => {
    getLatestLeadStrategySelection.mockResolvedValue({ id: 'strategy-42', workflowIds: ['linkedin'] });
    const result = await executeGenerateLeadInputs({
      ...input,
      selected_workflows: ['linkedin_profile_search_by_job_title'],
    }, {
      ...context, runContext: { runId: 'run-42', userId: 1, threadId: 42 },
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ platforms: ['linkedin'], workflowIds: ['linkedin_b2b'] });
    expect(createReviewedLeadInputSet).toHaveBeenCalledWith(expect.objectContaining({
      strategySelectionId: 'strategy-42', workflowIds: ['linkedin_b2b'],
    }));
  });

  it('rejects a different valid workflow rather than changing the approved strategy', async () => {
    getLatestLeadStrategySelection.mockResolvedValue({ workflowIds: ['linkedin'] });
    const result = await executeGenerateLeadInputs({ ...input, selected_workflows: ['linkedin_company_search_employees'] }, {
      ...context, runContext: { runId: 'run-42', userId: 1, threadId: 42 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/differ from the confirmed strategy/);
    expect(createLeadInputs).not.toHaveBeenCalled();
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(transitionConversationWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-42', userId: 1, threadId: 42,
      onlyFromStage: 'lead_inputs_generating', toStage: 'needs_attention', status: 'failed',
    }));
  });
});
