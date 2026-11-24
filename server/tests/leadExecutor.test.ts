import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetLatestLeadInputsByThreadId = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecuteWorkflow = jest.fn<any>();
const mockGetApprovedLeadInputRecords = jest.fn<any>();
const mockWebSocketEmitter = {
  emit: jest.fn(),
  emitToolExecution: jest.fn(),
  emitChatResponse: jest.fn(),
  emitChatResponseChunk: jest.fn(),
  emitWorkflowCompleted: jest.fn(),
  emitWorkflowError: jest.fn(),
  emitExecutionSummary: jest.fn(),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateChatMessage = jest.fn<any>().mockResolvedValue({ id: 500 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReadFile = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateScrapingDetail = jest.fn<any>().mockResolvedValue({ id: 1 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetScrapingDetailsByExecutionId = jest.fn<any>().mockResolvedValue([]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdateScrapingDetailByExecutionAndPlatform = jest.fn<any>().mockResolvedValue(null);

// Mock ESM files (paths are relative to this test file)
jest.unstable_mockModule('../models/leadInputs/functions', () => ({
  getLatestLeadInputsByThreadId: mockGetLatestLeadInputsByThreadId,
}));

jest.unstable_mockModule('../models/conversationWorkflow/functions', () => ({
  getApprovedLeadInputRecords: mockGetApprovedLeadInputRecords,
}));

jest.unstable_mockModule('../services/WorkflowExecutorService', () => ({
  WorkflowExecutorService: {
    executeWorkflow: mockExecuteWorkflow,
  },
}));

jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({
  webSocketEmitter: mockWebSocketEmitter,
}));

jest.unstable_mockModule('../models/chatMessages/functions', () => ({
  createChatMessage: mockCreateChatMessage,
}));

jest.unstable_mockModule('../models/scrapingDetails/functions', () => ({
  createScrapingDetail: mockCreateScrapingDetail,
  getScrapingDetailsByExecutionId: mockGetScrapingDetailsByExecutionId,
  updateScrapingDetailByExecutionAndPlatform: mockUpdateScrapingDetailByExecutionAndPlatform,
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('fs/promises', () => ({
  default: {
    readFile: mockReadFile,
  },
}));

jest.unstable_mockModule('../utils/dataPathResolver.js', () => ({
  resolveWorkflowPath: (platform: string) => `/mock/path/${platform}.json`,
  resolveActorsDir: () => '/mock/actors',
  resolveWorkflowsDir: () => '/mock/workflows',
}));

const approvedExecution = (overrides: Record<string, unknown> = {}) => ({
  leadInputSetId: 'approved-review',
  leadInputSetRevision: 1,
  workflowRunId: 'approved-run',
  ...overrides,
});

describe('executeLeadWorkflow Deduplication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetApprovedLeadInputRecords.mockImplementation(() => mockGetLatestLeadInputsByThreadId());
  });

  it('executes the approved snapshot even when current inputs and selected workflows differ', async () => {
    mockGetApprovedLeadInputRecords.mockResolvedValue([
      { id: 81, platform: 'linkedin', inputs: { currentJobTitles: ['CTO'], maxItems: 3 }, schema: { requestedLeadTotal: 3 } },
    ]);
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 82, platform: 'twitter', inputs: { query: 'unreviewed', maxItems: 1000 } },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      workflow_id: 'linkedin_b2b', platform: 'linkedin', nodes: [{ type: 'actor', data: { actorId: 'actor' } }],
    }));
    mockExecuteWorkflow.mockResolvedValue({ status: 'succeeded_empty', results: { db_save_results: { leadsCount: 0, leadIds: [] } } });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');
    const result = await executeLeadWorkflow({
      leadInputSetId: 'review-81', leadInputSetRevision: 1, workflowRunId: 'run-42', selected_workflows: ['twitter'],
    }, { userId: 1, threadId: 42, selectedWorkflows: ['twitter'], icpProfile: { id: 147 } } as any);
    expect(result.success).toBe(true);
    expect(mockGetLatestLeadInputsByThreadId).not.toHaveBeenCalled();
    expect(mockGetApprovedLeadInputRecords).toHaveBeenCalledWith({ id: 'review-81', revision: 1, runId: 'run-42', userId: 1, threadId: 42 });
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0][1]).toMatchObject({ currentJobTitles: ['CTO'], maxItems: 3, __leadInputId: 81 });
    expect(mockExecuteWorkflow.mock.calls[0][5]).toBe(147);
  });

  it('does not fall back to current inputs when the approval snapshot is missing', async () => {
    mockGetApprovedLeadInputRecords.mockRejectedValue(new Error('Approve the exact lead input revision before running a search.'));
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');
    const result = await executeLeadWorkflow({
      leadInputSetId: 'missing', leadInputSetRevision: 1, workflowRunId: 'run-42',
    }, { userId: 1, threadId: 42 } as any);
    expect(result.success).toBe(false);
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockGetLatestLeadInputsByThreadId).not.toHaveBeenCalled();
  });

  it('refuses an unbound execution request before reading any current input batch', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 152, platform: 'linkedin_company_search_employees', inputs: { maxItems: 1 } },
    ]);
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow({}, { userId: 1, threadId: 42 } as any);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exact lead input revision/i);
    expect(mockGetApprovedLeadInputRecords).not.toHaveBeenCalled();
    expect(mockGetLatestLeadInputsByThreadId).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('executes every row in an approved multi-search review snapshot', async () => {
    // 1. Setup mock lead inputs (including two reviewed searches on one platform)
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      {
        id: 1,
        platform: 'instagram_post_authors',
        inputs: { query: 'test1' },
        createdAt: new Date(),
      },
      {
        id: 2,
        platform: 'instagram_post_authors',
        inputs: { query: 'test2' },
        createdAt: new Date(),
      },
      {
        id: 3,
        platform: 'linkedin_profile_search',
        inputs: { query: 'test3' },
        createdAt: new Date(),
      },
    ]);

    // 2. Setup mock workflow file contents
    mockReadFile.mockResolvedValue(JSON.stringify({
      platform: 'instagram',
      title: 'Instagram Post Authors',
      nodes: [{ type: 'actor', data: { actorId: 'instagram-scraper' } }],
    }));

    // 3. Setup executeWorkflow response
    mockExecuteWorkflow.mockResolvedValue({
      results: {
        db_save_results: {
          leadsCount: 5,
          leadIds: [101, 102, 103, 104, 105],
        },
      },
    });

    // 4. Dynamically import the function under test
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context: any = {
      userId: '1',
      threadId: '100',
      workflowId: 'wf-1',
      icpProfile: { id: 1 },
      selectedWorkflows: [], // forces fallback behavior
    };

    const result = await executeLeadWorkflow(approvedExecution(), context);

    // Verify it succeeded
    expect(result).toBeDefined();

    // Every reviewed row is a distinct search, even when platform IDs repeat.
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent execution requests for the same campaign across payload shapes', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      {
        id: 166,
        platform: 'instagram_post_search',
        inputs: { hashtags: ['boutiquehotelsbengaluru'], resultsLimit: 1 },
        schema: { requestedLeadTotal: 1 },
      },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      workflow_id: 'instagram-post-search',
      platform: 'instagram_post_search',
      title: 'Instagram Post Search',
      nodes: [{ type: 'actor', data: { actorId: 'apify/instagram-hashtag-scraper' } }],
    }));
    let finishExecution!: (value: unknown) => void;
    mockExecuteWorkflow.mockImplementation(() => new Promise((resolve) => { finishExecution = resolve; }));
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context = { userId: 1, threadId: 178, selectedWorkflows: ['instagram_post_search'] } as any;

    const first = executeLeadWorkflow(
      approvedExecution({ selected_workflows: [], platforms: ['instagram_post_search'] }),
      { ...context, selectedWorkflows: [] },
    );
    const second = executeLeadWorkflow(
      approvedExecution({ selected_workflows: ['facebook_post_search'] }),
      { ...context, selectedWorkflows: ['facebook_post_search'] },
    );
    for (let attempt = 0; attempt < 20 && mockExecuteWorkflow.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);

    finishExecution({ status: 'succeeded_empty', results: { db_save_results: { leadsCount: 0 } } });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(mockWebSocketEmitter.emitToolExecution).toHaveBeenCalledTimes(2);
  });

  it('reports failed when every configured source fails', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 1, platform: 'linkedin_profile_search', inputs: { query: 'test' } },
      { id: 2, platform: 'instagram_post_authors', inputs: { query: 'test' } },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({ platform: 'test', nodes: [{ type: 'actor', data: { actorId: 'actor' } }] }));
    mockExecuteWorkflow.mockRejectedValue(new Error('provider unavailable'));
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(approvedExecution(), { userId: 1, threadId: 100, selectedWorkflows: [] } as any);

    expect(result.success).toBe(false);
    expect(result.output?.status).toBe('failed');
    expect(result.error).toContain('provider unavailable');
    expect(result.error).not.toContain('undefined');
    expect(mockWebSocketEmitter.emitExecutionSummary).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed', successful_platforms: 0, failed_platforms: 2 }),
      undefined,
      100,
    );
  });

  it.each([false, true])('rejects a positive count without saved identities (explicit selection: %s)', async (explicit) => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 1, platform: 'linkedin_profile_search', inputs: { query: 'test' } },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({ platform: 'linkedin', nodes: [{ type: 'actor', data: { actorId: 'actor' } }] }));
    mockExecuteWorkflow.mockResolvedValue({ status: 'succeeded', results: { db_save_results: { leadsCount: 5 } } });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');
    const selected = explicit ? ['linkedin_profile_search'] : [];
    const result = await executeLeadWorkflow(
      approvedExecution(explicit ? { selected_workflows: selected } : {}),
      { userId: 1, threadId: 100, selectedWorkflows: selected } as any,
    );
    expect(result.success).toBe(false);
    expect(result.output?.status).toBe('failed');
    expect(result.error).toContain('without saved lead IDs');
  });

  it.each([false, true])('counts overlapping provider receipts once (explicit selection: %s)', async (explicit) => {
    const selected = ['linkedin_profile_search', 'instagram_post_authors'];
    mockGetLatestLeadInputsByThreadId.mockResolvedValue(selected.map((platform, index) => ({ id: index + 1, platform, inputs: { query: 'test' } })));
    mockReadFile.mockResolvedValue(JSON.stringify({ platform: 'test', nodes: [{ type: 'actor', data: { actorId: 'actor' } }] }));
    mockExecuteWorkflow
      .mockResolvedValueOnce({ status: 'succeeded', results: { db_save_results: { leadsCount: 3, leadIds: [101, 101, 102] } } })
      .mockResolvedValueOnce({ status: 'succeeded', results: { db_save_results: { leadsCount: 2, leadIds: [102, 103] } } });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');
    const result = await executeLeadWorkflow(
      approvedExecution(explicit ? { selected_workflows: selected } : {}),
      { userId: 1, threadId: 100, selectedWorkflows: explicit ? selected : [] } as any,
    );
    expect(result.output?.status).toBe('succeeded');
    expect(result.output?.totalLeads).toBe(3);
    expect(result.output?.leadIds).toEqual([101, 102, 103]);
  });

  it('distinguishes a successful empty run from provider failure', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 1, platform: 'linkedin_profile_search', inputs: { query: 'narrow' } },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({ platform: 'linkedin', nodes: [{ type: 'actor', data: { actorId: 'actor' } }] }));
    mockExecuteWorkflow.mockResolvedValue({ results: { db_save_results: { leadsCount: 0 } } });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(approvedExecution(), { userId: 1, threadId: 100, selectedWorkflows: [] } as any);

    expect(result.success).toBe(true);
    expect(result.output?.status).toBe('succeeded_empty');
    expect(result.output?.totalLeads).toBe(0);

    const toolMessages = mockCreateChatMessage.mock.calls
      .map(([message]) => message as { metadata?: { isToolCall?: boolean; isToolResult?: boolean; toolCallId?: string } })
      .filter((message) => message.metadata?.isToolCall || message.metadata?.isToolResult);
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]!.metadata!.toolCallId).toBeTruthy();
    expect(toolMessages[1]!.metadata!.toolCallId).toBe(toolMessages[0]!.metadata!.toolCallId);
    expect(mockCreateChatMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ isProgressMessage: true }) }),
    );
    expect(mockWebSocketEmitter.emitChatResponseChunk).not.toHaveBeenCalled();
  });

  it.each([
    ['succeeded', false, 'failed'],
    ['succeeded_empty', true, 'succeeded_empty'],
  ])('reconciles a missing save node from workflow outcome %s', async (workflowStatus, success, expectedStatus) => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 1, platform: 'linkedin_profile_search', inputs: { query: 'test' } },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({ platform: 'linkedin', nodes: [{ type: 'actor', data: { actorId: 'actor' } }] }));
    mockExecuteWorkflow.mockResolvedValue({ status: workflowStatus, results: {} });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');
    const result = await executeLeadWorkflow(approvedExecution(), { userId: 1, threadId: 100, selectedWorkflows: [] } as any);
    expect(result.success).toBe(success);
    expect(result.output?.status).toBe(expectedStatus);
    if (!success) expect(result.error).toContain('no verifiable save receipt');
    else expect(result.output?.totalLeads).toBe(0);
  });

  it('reports partial success when at least one source persists leads and another fails', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 1, platform: 'linkedin_profile_search', inputs: { query: 'test' } },
      { id: 2, platform: 'instagram_post_authors', inputs: { query: 'test' } },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({ platform: 'test', nodes: [{ type: 'actor', data: { actorId: 'actor' } }] }));
    mockExecuteWorkflow
      .mockResolvedValueOnce({ results: { db_save_results: { leadsCount: 4, leadIds: [101, 102, 103, 104] } } })
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(approvedExecution(), { userId: 1, threadId: 100, selectedWorkflows: [] } as any);

    expect(result.success).toBe(true);
    expect(result.output?.status).toBe('partial_success');
    expect(result.output?.totalLeads).toBe(4);
  });

  it('executes every reviewed input row for one explicitly selected workflow', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 10, platform: 'facebook_post_search', inputs: { query: 'Austin', maxResults: 1 } },
      { id: 11, platform: 'facebook_post_search', inputs: { query: 'Dallas', maxResults: 1 } },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      platform: 'facebook_post_search',
      title: 'Facebook Post Search',
      nodes: [{ type: 'actor', data: { actorId: 'powerai/facebook-post-search-scraper' } }],
    }));
    mockExecuteWorkflow
      .mockResolvedValueOnce({ results: { db_save_results: { leadsCount: 1, leadIds: [101] } } })
      .mockResolvedValueOnce({ results: { db_save_results: { leadsCount: 1, leadIds: [102] } } });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(
      approvedExecution({ selected_workflows: ['facebook_post_search'] }),
      { userId: 1, threadId: 100, selectedWorkflows: ['facebook_post_search'] } as any,
    );

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(2);
    expect(mockExecuteWorkflow.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ query: 'Austin', maxResults: 1 }));
    expect(mockExecuteWorkflow.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ query: 'Dallas', maxResults: 1 }));
    expect(result.output?.status).toBe('succeeded');
    expect(result.output?.totalLeads).toBe(2);
  });

  it('enforces one reviewed total across providers and uses deterministic execution IDs', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      {
        id: 21,
        platform: 'google_maps',
        inputs: { searchStringsArray: ['boutique hotels'] },
        schema: { requestedLeadTotal: 3, reviewedConstraints: { regions: ['Bengaluru'] } },
      },
      {
        id: 22,
        platform: 'justdial',
        inputs: { search: 'boutique hotels' },
        schema: { requestedLeadTotal: 3, reviewedConstraints: { regions: ['Bengaluru'] } },
      },
    ]);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ workflow_id: 'google-maps', platform: 'google_maps', nodes: [{ type: 'actor', data: { actorId: 'google' } }] }))
      .mockResolvedValueOnce(JSON.stringify({ workflow_id: 'justdial', platform: 'justdial', nodes: [{ type: 'actor', data: { actorId: 'justdial' } }] }));
    mockExecuteWorkflow
      .mockResolvedValueOnce({ status: 'succeeded', results: { db_save_results: { leadsCount: 2, leadIds: [854, 855] } } })
      .mockResolvedValueOnce({ status: 'succeeded', results: { db_save_results: { leadsCount: 1, leadIds: [856, 855] } } });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(approvedExecution(), { userId: 1, threadId: 100, selectedWorkflows: [] } as any);

    expect(result.output?.totalLeads).toBe(3);
    expect(result.output?.leadIds).toEqual([854, 855, 856]);
    expect(mockExecuteWorkflow.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      __leadInputId: 21,
      __requestedLeadLimit: 3,
      __leadReviewConstraints: { regions: ['Bengaluru'] },
    }));
    expect(mockExecuteWorkflow.mock.calls[0]?.[4]).toBe('lead:100:21:google-maps');
    expect(mockExecuteWorkflow.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      __leadInputId: 22,
      __requestedLeadLimit: 1,
      __leadReviewConstraints: { regions: ['Bengaluru'] },
    }));
    expect(mockExecuteWorkflow.mock.calls[1]?.[4]).toBe('lead:100:22:justdial');
  });

  it('records later selected providers as skipped when the first provider fills the global limit', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      {
        id: 31,
        platform: 'google_maps',
        inputs: { searchStringsArray: ['boutique hotels'] },
        schema: { requestedLeadTotal: 3, reviewedConstraints: { regions: ['Bengaluru'] } },
      },
      {
        id: 32,
        platform: 'justdial',
        inputs: { search: 'boutique hotels' },
        schema: { requestedLeadTotal: 3, reviewedConstraints: { regions: ['Bengaluru'] } },
      },
    ]);
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      workflow_id: 'google-maps',
      platform: 'google_maps',
      title: 'Google Maps Business Search',
      nodes: [{ type: 'actor', data: { actorId: 'google' } }],
    }));
    mockExecuteWorkflow.mockResolvedValueOnce({
      status: 'succeeded',
      results: { db_save_results: { leadsCount: 3, leadIds: [101, 102, 103] } },
    });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(approvedExecution(), { userId: 1, threadId: 100, selectedWorkflows: [] } as any);

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(result.output?.totalLeads).toBe(3);
    expect(result.output?.platformResults).toEqual([
      expect.objectContaining({ workflow: 'google_maps', leadsCount: 3, status: 'succeeded' }),
      expect.objectContaining({
        workflow: 'justdial',
        leadsCount: 0,
        status: 'skipped',
        reason: 'global_limit_reached',
      }),
    ]);
    expect(mockCreateScrapingDetail).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 500,
      threadId: 100,
      executionId: 'lead:100:32:skipped',
      platform: 'justdial',
      totalLeadsNeeded: 3,
      totalLeadsFound: 0,
      status: 'skipped',
    }));
    expect(mockWebSocketEmitter.emitExecutionSummary).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'succeeded',
        total_leads: 3,
        successful_platforms: 1,
        failed_platforms: 0,
        skipped_platforms: 1,
      }),
      undefined,
      100,
    );
  });

  it('reports an explicitly selected provider as skipped after another selected provider fills the cap', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      {
        id: 41,
        platform: 'google_maps',
        inputs: { searchStringsArray: ['corporate travel planners'] },
        schema: { requestedLeadTotal: 2, reviewedConstraints: { regions: ['Bengaluru'] } },
      },
      {
        id: 42,
        platform: 'justdial',
        inputs: { search: 'corporate travel planners' },
        schema: { requestedLeadTotal: 2, reviewedConstraints: { regions: ['Bengaluru'] } },
      },
    ]);
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      workflow_id: 'google-maps',
      platform: 'google_maps',
      title: 'Google Maps Business Search',
      nodes: [{ type: 'actor', data: { actorId: 'google' } }],
    }));
    mockExecuteWorkflow.mockResolvedValueOnce({
      status: 'succeeded',
      results: { db_save_results: { leadsCount: 2, leadIds: [101, 102] } },
    });
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(
      approvedExecution({ selected_workflows: ['google_maps', 'justdial'] }),
      { userId: 1, threadId: 100, selectedWorkflows: ['google_maps', 'justdial'] } as any,
    );

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(result.output?.platformResults).toEqual([
      expect.objectContaining({ workflow: 'google_maps', leadsCount: 2, status: 'succeeded' }),
      expect.objectContaining({
        workflow: 'justdial',
        leadsCount: 0,
        status: 'skipped',
        reason: 'global_limit_reached',
      }),
    ]);
    expect(mockCreateScrapingDetail).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'lead:100:42:skipped',
      platform: 'justdial',
      totalLeadsNeeded: 2,
      status: 'skipped',
    }));
  });

  it('reports cancellation truthfully and does not start the next provider', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      { id: 51, platform: 'google_maps', inputs: { query: 'travel' } },
      { id: 52, platform: 'justdial', inputs: { query: 'travel' } },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      workflow_id: 'lead-search',
      platform: 'lead-search',
      nodes: [{ type: 'actor', data: { actorId: 'provider' } }],
    }));
    const { executeLeadWorkflow, stoppedThreads } = await import('../mastra/tools/executors/leadExecutor');
    mockExecuteWorkflow.mockImplementationOnce(async () => {
      stoppedThreads.add(100);
      return { status: 'succeeded', results: { db_save_results: { leadsCount: 1, leadIds: [101] } } };
    });

    const result = await executeLeadWorkflow(approvedExecution(), { userId: 1, threadId: 100, selectedWorkflows: [] } as any);

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.output).toEqual(expect.objectContaining({
      status: 'cancelled',
      totalLeads: 1,
    }));
    expect(mockWebSocketEmitter.emitExecutionSummary).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'cancelled', total_leads: 1 }),
      undefined,
      100,
    );
    stoppedThreads.delete(100);
  });

  it('infers an exact named workflow from reviewed user requirements', async () => {
    const { inferExplicitCatalogWorkflowId, inferExplicitWorkflowIds } = await import('../mastra/tools/executors/leadExecutor');
    expect(inferExplicitWorkflowIds(
      'Use only LinkedIn Company Search for exactly one lead.',
      ['linkedin', 'linkedin_b2b', 'linkedin_company_search', 'linkedin_profile_search'],
    )).toEqual(['linkedin_company_search']);
    expect(inferExplicitWorkflowIds(
      'Do not use LinkedIn Company Search. Use LinkedIn Profile Search.',
      ['linkedin_company_search', 'linkedin_profile_search'],
    )).toEqual(['linkedin_profile_search']);
    const catalog = [
      { fileName: 'linkedin', workflowId: 'linkedin_b2b', title: 'LinkedIn Profile Search' },
      { fileName: 'linkedin_profile_by_name', workflowId: 'linkedin_profile_by_name', title: 'LinkedIn Profile Search by Name' },
      { fileName: 'linkedin_posts_commenters', workflowId: 'linkedin_posts_commenters', title: 'LinkedIn Post Commenters by Profile' },
    ];
    expect(inferExplicitCatalogWorkflowId(
      'Use only LinkedIn Post Commenters by Profile. Find one public profile matching Satya Nadella.',
      catalog,
    )).toBe('linkedin_posts_commenters');
    expect(inferExplicitCatalogWorkflowId(
      'Do not use LinkedIn Profile Search by Name. Use LinkedIn Profile Search.',
      catalog,
    )).toBe('linkedin');
  });

  it('does not execute a selected workflow with stale inputs from another workflow', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      {
        id: 61,
        platform: 'linkedin',
        workflowId: 'linkedin_b2b',
        actorId: 'harvestapi/linkedin-profile-search',
        inputs: { searchQuery: 'AI software companies', maxItems: 1 },
      },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      workflow_id: 'linkedin-company-search',
      platform: 'linkedin_company_search',
      title: 'LinkedIn Company Search',
      nodes: [{ type: 'actor', data: { actorId: 'harvestapi/linkedin-company-search' } }],
    }));
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(
      approvedExecution({ selected_workflows: ['linkedin_company_search'] }),
      { userId: 1, threadId: 100, selectedWorkflows: ['linkedin_company_search'] } as any,
    );

    expect(result.success).toBe(false);
    expect(result.output?.status).toBe('failed');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('does not execute reviewed inputs when their actor differs from the selected workflow', async () => {
    mockGetLatestLeadInputsByThreadId.mockResolvedValue([
      {
        id: 62,
        platform: 'linkedin_company_search',
        workflowId: 'linkedin-company-search',
        actorId: 'harvestapi/linkedin-profile-search',
        inputs: { searchQuery: 'AI software companies', maxItems: 1 },
      },
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      workflow_id: 'linkedin-company-search',
      platform: 'linkedin_company_search',
      title: 'LinkedIn Company Search',
      nodes: [{ type: 'actor', data: { actorId: 'harvestapi/linkedin-company-search' } }],
    }));
    const { executeLeadWorkflow } = await import('../mastra/tools/executors/leadExecutor');

    const result = await executeLeadWorkflow(
      approvedExecution({ selected_workflows: ['linkedin_company_search'] }),
      { userId: 1, threadId: 100, selectedWorkflows: ['linkedin_company_search'] } as any,
    );

    expect(result.success).toBe(false);
    expect(result.output?.status).toBe('failed');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });
});

describe('generated lead input cleanup', () => {
  it('omits null and blank optional fields while preserving intentional false, zero, and empty arrays', async () => {
    const { stripEmptyGeneratedInputs } = await import('../mastra/tools/executors/leadExecutor');
    expect(stripEmptyGeneratedInputs({
      query: 'enterprise AI automation',
      start_date: null,
      end_date: '   ',
      location_uid: undefined,
      recent_posts: false,
      maxResults: 0,
      departments: [],
    })).toEqual({
      query: 'enterprise AI automation',
      recent_posts: false,
      maxResults: 0,
      departments: [],
    });
  });
});
