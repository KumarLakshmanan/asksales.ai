import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { intentWith, semanticRequest } from './helpers/semanticIntent.js';

// Mock LLMProviderFactory and other dependencies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateChatCompletion = jest.fn<any>();
const mockExecuteProviderCallWithFallback = jest.fn<any>(async (
  _userId: number,
  callFn: (provider: { createChatCompletion: typeof mockCreateChatCompletion; defaultModel: string; getProviderName: () => string }) => unknown,
) => callFn({
  createChatCompletion: mockCreateChatCompletion,
  defaultModel: 'test-model',
  getProviderName: () => 'test',
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createProviderForUser: jest.fn<any>().mockResolvedValue({
      createChatCompletion: mockCreateChatCompletion,
      defaultModel: 'test-model',
    }),
    executeProviderCallWithFallback: mockExecuteProviderCallWithFallback,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isRateLimitError: jest.fn<any>().mockReturnValue(false),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({
  webSocketEmitter: {
    emitAgentStatus: jest.fn(),
    emitChatResponseChunk: jest.fn(),
    emitChatResponse: jest.fn(),
    emitOpenTab: jest.fn(),
  },
}));

const {
  buildIcpPrerequisiteState,
  pauseForSavedIcpApproval,
  getIcpApprovalContinuationAgent,
  getHandoffMessage,
  detectHiredAgentsWithLLM,
  filterExplicitlyExcludedAgents,
  getPendingPipelineAgentAfterCompletion,
  getNextReadOnlyTeamAgent,
  getPendingPipelineAgent,
  getWidgetContinuationAgent,
  getUnifiedMessageAnalysis,
  routerLogic,
  runAndMergeSpecialistTurn,
  shouldAdvancePipelineIndex,
} = await import('../mastra/orchestrator.js');
const { buildIcpSystemPrompt } = await import('../mastra/agents/icpAgent.js');
const { webSocketEmitter } = await import('../services/agents/WebSocketEmitter.js');

describe('Orchestrator LLM Router Logic', () => {
  it.each([0, 0.999])('does not promise execution when handing off a review-only request (variant %s)', random => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(random);
    try {
      expect(getHandoffMessage('outreach')).not.toMatch(/launch|sent|sending now/i);
      expect(getHandoffMessage('outreach')).toMatch(/does not send|separate review and approval/);
      expect(getHandoffMessage('lead_generation')).not.toContain('pull some high-quality prospects');
      expect(getHandoffMessage('icp_generation', true)).toContain('does not authorize');
    } finally { spy.mockRestore(); }
  });
  it.each(['supervisor', 'icp_generation', 'outreach'])('answers planning questions without hiring or resuming %s', async currentAgent => {
    const response = 'For Oro Circle corporate offsites, which city and company size should we target? Nothing will be sent.';
    const state = {
      userId: 1, threadId: 210, currentAgent, nextAgent: null,
      messages: [{ role: 'assistant', content: 'We can plan your corporate offsite campaign.' },
        { role: 'user', content: 'What do you need from me first? Please only plan; do not run anything.' }],
      requiresApproval: true, pendingApproval: { toolName: 'send_outreach_messages', executionId: 'keep-pending' },
      agentPipeline: ['icp_generation', 'outreach'], agentPipelineIndex: 1,
      intentAnalysis: intentWith({}, { action: 'question', hiredAgents: [], nextAgent: null, mode: 'none', response }),
    };
    expect(await routerLogic(state as never)).toEqual({ nextAgent: null, stateUpdates: {} });
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', content: response });
    expect(state.pendingApproval.executionId).toBe('keep-pending');
    expect(state.agentPipelineIndex).toBe(1);
    expect(webSocketEmitter.emitChatResponse).not.toHaveBeenCalled();
    expect(mockCreateChatCompletion).not.toHaveBeenCalled();
  });

  it.each(['question', 'new_task'])('keeps a first-turn contextual answer with no selected specialist (%s)', async action => {
    const response = 'To plan corporate offsites for Oro Circle, which audience and city should we start with?';
    const state = { userId: 1, threadId: 210, currentAgent: 'supervisor', nextAgent: null,
      messages: [{ role: 'user', content: 'I want more corporate offsite bookings. What do you need first?' }],
      intentAnalysis: intentWith({}, { action, hiredAgents: [], nextAgent: null, mode: 'none', response }),
    };
    expect(await routerLogic(state as never)).toEqual({ nextAgent: null, stateUpdates: {} });
    expect(state.messages).toHaveLength(2);
    expect(state.messages.at(-1)?.content).toBe(response);
    expect(webSocketEmitter.emitChatResponse).not.toHaveBeenCalled();
    expect(mockCreateChatCompletion).not.toHaveBeenCalled();
  });

  it.each([
    { hiredAgents: ['content_studio'], nextAgent: 'content_studio', expected: ['icp_generation', 'content_studio'] },
    { hiredAgents: ['content_studio', 'performance_marketing'], nextAgent: 'content_studio', expected: ['icp_generation', 'content_studio', 'performance_marketing'] },
    { hiredAgents: [], nextAgent: 'performance_marketing', expected: ['icp_generation', 'performance_marketing'] },
  ])('retains the semantic specialist plan while pausing for saved ICP approval: $expected', async ({ hiredAgents, nextAgent, expected }) => {
    const state = {
      userId: 1, threadId: 208, currentAgent: 'outreach', nextAgent: null,
      messages: [{ role: 'user', content: 'Prepare the requested drafts for review only.' }],
      icpProfile: { id: 128, fitScore: 69, revision: 2, approved: false, approvedRevision: null },
      intentAnalysis: intentWith({}, { hiredAgents, nextAgent }),
    };
    const result = await routerLogic(state as never);
    expect(result.nextAgent).toBeNull();
    expect(result.stateUpdates).toMatchObject({ agentPipeline: expected, workflowOutcome: 'awaiting_approval', tasksCompleted: false });
    expect(state.messages).toHaveLength(2);
    expect(mockCreateChatCompletion).not.toHaveBeenCalled();
    expect(webSocketEmitter.emitChatResponse).not.toHaveBeenCalled();
  });

  it('allows a read-only specialist question without asking for ICP approval', async () => {
    const state = {
      userId: 1, threadId: 208, currentAgent: 'outreach', nextAgent: null,
      messages: [{ role: 'user', content: 'Explain existing campaign performance only.' }],
      icpProfile: { id: 128, fitScore: 69, revision: 2, approved: false, approvedRevision: null },
      intentAnalysis: intentWith({}, { action: 'question', hiredAgents: ['performance_marketing'], nextAgent: 'performance_marketing' }),
    };
    const result = await routerLogic(state as never);
    expect(result.nextAgent).toBe('performance_marketing');
    expect(state.messages).toHaveLength(1);
    expect(state.icpProfile.approved).toBe(false);
  });

  it('runs each specialist in a read-only team question without changing the saved pipeline', async () => {
    const state: any = {
      userId: 1, threadId: 208, currentAgent: 'content_studio',
      messages: [{ role: 'user', content: '@marcus @sarah Give one answer each.' }],
      agentPipeline: ['icp_generation', 'content_studio'], agentPipelineIndex: 1,
      tasksCompleted: false, workflowOutcome: 'awaiting_approval',
      intentAnalysis: intentWith({}, { action: 'question', hiredAgents: ['lead_generation', 'performance_marketing'], nextAgent: 'lead_generation' }),
    };
    expect((await routerLogic(state)).nextAgent).toBe('lead_generation');
    const update = await runAndMergeSpecialistTurn(state, async input => {
      expect(input.messages.at(-1)?.content).toContain('Answer only the part');
      input.agentPipeline!.push('outreach');
      input.tasksCompleted = true;
      return { messages: [{ role: 'assistant', agentType: 'lead_generation', content: 'Existing lead criterion.' }],
        agentPipeline: ['outreach'], agentPipelineIndex: 0, tasksCompleted: true };
    }, 'lead_generation');
    expect(update.messages).toHaveLength(1);
    expect(state.agentPipeline).toEqual(['icp_generation', 'content_studio']);
    expect(state.agentPipelineIndex).toBe(1);
    expect(state.tasksCompleted).toBe(false);
    expect(getNextReadOnlyTeamAgent(state, 'lead_generation')).toBe('performance_marketing');
    expect(getNextReadOnlyTeamAgent(state, 'performance_marketing')).toBeNull();
    expect(state.messages.at(-1)?.content).toBe('Existing lead criterion.');
    expect(state.messages[0].content).toBe('@marcus @sarah Give one answer each.');
  });

  it.each(['outreach', 'content_studio', 'performance_marketing', 'icp_generation', 'lead_generation'])(
    'answers a read-only %s side question without changing a pending review or its owner', async target => {
      const state: any = {
        userId: 1, threadId: 210, currentAgent: 'lead_generation', nextAgent: null,
        messages: [{ role: 'user', content: 'Answer only; leave the search review unapproved.' }],
        requiresApproval: true, pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'pending-search' },
        agentPipeline: ['lead_generation', 'outreach'], agentPipelineIndex: 0,
        pipelineRequest: 'Prepare search settings', selectedLeadIds: [], leadInputs: [{ maxItems: 3 }],
        actionButtons: [{ id: 'approve-search' }], workflowOutcome: 'awaiting_approval', tasksCompleted: false,
        intentAnalysis: intentWith({}, { action: 'question', hiredAgents: [target], nextAgent: target }),
      };
      const original = structuredClone(state);
      expect(await routerLogic(state)).toEqual({ nextAgent: target, stateUpdates: {} });
      const update = await runAndMergeSpecialistTurn(state, async input => {
        input.pendingApproval = null;
        input.agentPipeline!.push('content_studio');
        input.selectedLeadIds!.push(99);
        input.messages.push({ role: 'assistant', content: 'internal mutation must not leak' });
        return { messages: [{ role: 'assistant', content: 'Read-only answer', agentType: target as never }],
          currentAgent: target as never, requiresApproval: false, pendingApproval: null,
          tasksCompleted: true, workflowOutcome: 'succeeded', actionButtons: [],
          toolResults: [], lastResponseId: 'side-answer' };
      });
      expect(state).toEqual({ ...original,
        messages: [...original.messages, { role: 'assistant', content: 'Read-only answer', agentType: target }],
        toolResults: [], lastResponseId: 'side-answer' });
      expect(update.currentAgent).toBe(target); // response attribution, not review ownership
    },
  );

  it('answers Alex, Emily and Sarah in order while retaining the exact pending Marcus review', async () => {
    const agents = ['content_studio', 'outreach', 'performance_marketing'] as const;
    const state: any = { userId: 1, threadId: 221, currentAgent: 'lead_generation',
      messages: [{ role: 'user', content: 'Advice in chat only; leave this search pending.' }],
      requiresApproval: true, pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'five-lead-review' },
      agentPipeline: ['icp_generation', 'lead_generation'], agentPipelineIndex: 1,
      leadInputs: [{ city: 'Coimbatore', maxCrawledPlacesPerSearch: 5 }],
      intentAnalysis: intentWith({}, { action: 'question', hiredAgents: [...agents], nextAgent: agents[0] }) };
    const before = structuredClone(state);
    expect((await routerLogic(state)).nextAgent).toBe(agents[0]);
    for (const [index, agent] of agents.entries()) {
      await runAndMergeSpecialistTurn(state, async input => {
        expect([...input.messages].reverse().find(message => message.role === 'user')?.content).toContain('Answer only the part');
        return { messages: [{ role: 'assistant', agentType: agent, content: `${agent} advice` }],
          pendingApproval: null, requiresApproval: false, leadInputs: [], tasksCompleted: true };
      }, agent);
      expect(getNextReadOnlyTeamAgent(state, agent)).toBe(agents[index + 1] ?? null);
    }
    expect(state).toEqual({ ...before, messages: [...before.messages,
      ...agents.map(agent => ({ role: 'assistant', agentType: agent, content: `${agent} advice` }))] });
  });

  it.each(['new_task', 'switch_agent', 'revise', 'continue'])(
    'still blocks a mutating cross-agent %s while a review is pending', async action => {
      const state: any = { userId: 1, threadId: 210, currentAgent: 'lead_generation', nextAgent: null,
        messages: [{ role: 'user', content: 'Prepare an outreach review.' }],
        requiresApproval: true, pendingApproval: { executionId: 'pending-search' },
        intentAnalysis: intentWith({}, { action, nextAgent: 'outreach', hiredAgents: ['outreach'] }) };
      expect((await routerLogic(state)).nextAgent).toBeNull();
      expect(state.pendingApproval.executionId).toBe('pending-search');
      expect(state.messages.at(-1).content).toContain('unfinished review');
    },
  );

  it('pauses on a saved draft without invoking the ICP model or losing the intended specialist', async () => {
    const state = {
      userId: 1, threadId: 208, currentAgent: 'outreach', nextAgent: null,
      messages: [{ role: 'user', content: 'Draft captions only; do not publish.' }],
      icpProfile: { id: 128, fitScore: 69, revision: 2, approved: false, approvedRevision: null },
    };
    const result = await routerLogic(state as never, undefined, 'content_studio');
    expect(result.nextAgent).toBeNull();
    expect(result.stateUpdates).toMatchObject({
      agentPipeline: ['icp_generation', 'content_studio'], agentPipelineIndex: 0,
      pipelineRequest: 'Draft captions only; do not publish.', workflowOutcome: 'awaiting_approval', tasksCompleted: false,
    });
    expect(result.stateUpdates.actionButtons).toContainEqual(expect.objectContaining({ action: 'APPROVE_ICP', data: { icpId: 128, revision: 2 } }));
    expect(state.messages).toHaveLength(2);
    expect(state.messages.at(-1)?.content).toContain('review and approve');
    expect(mockCreateChatCompletion).not.toHaveBeenCalled();
    expect(state.icpProfile.approved).toBe(false);
  });

  it('does not confuse missing, incomplete or approved profiles with an outstanding saved-draft review', () => {
    const base = { id: 128, fitScore: 69, revision: 2, approved: false, approvedRevision: null };
    for (const icpProfile of [null, { ...base, id: undefined }, { ...base, revision: undefined },
      { ...base, fitScore: 40 }, { ...base, fitScore: Number.NaN }, { ...base, approved: true, approvedRevision: 2 }]) {
      const state = { messages: [], icpProfile };
      expect(pauseForSavedIcpApproval(state as never, buildIcpPrerequisiteState('content_studio', 'draft'))).toBeNull();
      expect(state.messages).toHaveLength(0);
    }
    const stale = { messages: [], icpProfile: { ...base, approved: true, approvedRevision: 1 } };
    expect(pauseForSavedIcpApproval(stale as never, buildIcpPrerequisiteState('content_studio', 'draft'))?.nextAgent).toBeNull();
    expect(stale.messages).toHaveLength(1);
  });
  it('routes a lead-specific retry directly to Marcus without asking the general router to choose', async () => {
    const state = {
      userId: 1,
      threadId: 77,
      currentAgent: 'supervisor',
      nextAgent: null,
      requiresApproval: false,
      pendingApproval: null,
      messages: [{ role: 'user', content: 'Marcus, retry only lead settings.' }],
      icpProfile: { id: 128, fitScore: 81, revision: 1, approved: true, approvedRevision: 1 },
    };

    await expect(routerLogic(state as never, undefined, 'lead_generation')).resolves.toEqual({
      nextAgent: 'lead_generation', stateUpdates: {},
    });
    expect(mockCreateChatCompletion).not.toHaveBeenCalled();
  });

  it('does not force a lead retry across a different pending approval', async () => {
    const state = {
      userId: 1,
      threadId: 77,
      currentAgent: 'outreach',
      nextAgent: null,
      requiresApproval: true,
      pendingApproval: { toolName: 'send_outreach_messages' },
      messages: [{ role: 'user', content: 'Retry lead settings.' }],
      icpProfile: { id: 128, fitScore: 81, revision: 1, approved: true, approvedRevision: 1 },
    };

    const result = await routerLogic(state as never, undefined, 'lead_generation');
    expect(result.nextAgent).toBeNull();
    expect(state.messages.at(-1)?.content).toMatch(/unfinished review/i);
  });

  it('routes an internal ICP continuation only for the exact approved profile and selected specialist', () => {
    const state = {
      icpProfile: { id: 128, fitScore: 81, revision: 1, approved: true, approvedRevision: 1 },
      icpApprovalContinuation: { agent: 'performance_marketing', icpId: 128, revision: 1 },
      agentPipeline: ['icp_generation', 'performance_marketing'], agentPipelineIndex: 1,
    };
    expect(getIcpApprovalContinuationAgent(state as never)).toBe('performance_marketing');
    expect(getIcpApprovalContinuationAgent({ ...state, icpApprovalContinuation: undefined } as never)).toBeNull();
    expect(getIcpApprovalContinuationAgent({ ...state, agentPipelineIndex: 0 } as never)).toBeNull();
    expect(getIcpApprovalContinuationAgent({ ...state, icpProfile: { ...state.icpProfile, approved: false } } as never)).toBeNull();
    expect(getIcpApprovalContinuationAgent({ ...state, icpProfile: { ...state.icpProfile, revision: 2 } } as never)).toBeNull();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateChatCompletion.mockReset();
    mockExecuteProviderCallWithFallback.mockClear();
  });

  it('preserves the requested specialist while ICP is generated as a prerequisite', () => {
    const prerequisite = buildIcpPrerequisiteState('content_studio', 'Create ad copy for Meta and Google');
    expect(prerequisite).toEqual({
      agentPipeline: ['icp_generation', 'content_studio'],
      agentPipelineIndex: 0,
      pipelineRequest: 'Create ad copy for Meta and Google',
    });

    const prompt = buildIcpSystemPrompt({
      userId: 1,
      threadId: 77,
      messages: [{ role: 'user', content: 'Create ad copy for Meta and Google' }],
      currentAgent: 'icp_generation',
      nextAgent: null,
      agentPipeline: prerequisite.agentPipeline,
      agentPipelineIndex: 0,
      icpProfile: null,
      companyProfile: { name: 'Aimplify AI' },
    } as never);

    expect(prompt).toContain('PREREQUISITE MODE (MANDATORY)');
    expect(prompt).toContain('"content_studio"');
    expect(prompt).toContain('Do NOT refuse the request');
  });

  it('removes specialists explicitly excluded from a scoped lead request', () => {
    expect(filterExplicitlyExcludedAgents(
      ['outreach', 'content_studio'],
      ['lead_generation', 'content_studio', 'outreach'],
    )).toEqual(['lead_generation']);
  });

  it('asks for existing ICP approval instead of regeneration while retaining the ad request', () => {
    const prerequisite = buildIcpPrerequisiteState('performance_marketing', 'Prepare a review using only asset 114; do not activate');
    const prompt = buildIcpSystemPrompt({
      userId: 1, threadId: 171, messages: [], currentAgent: 'icp_generation', nextAgent: null,
      ...prerequisite,
      icpProfile: { id: 128, fitScore: 81, revision: 1, approved: false, approvedRevision: null },
      companyProfile: { name: 'Aimplify AI' },
    } as never);
    expect(prerequisite.pipelineRequest).toContain('only asset 114; do not activate');
    expect(prompt).toContain('do not crawl or regenerate it merely because approval is missing');
    expect(prompt).toContain('Only revise it when the user requests changes');
    expect(prompt).toContain('Do NOT call suggest_switch_agents or resume the requested specialist before the ICP approval gate succeeds');
  });

  it('selects the pending pipeline specialist deterministically after a prerequisite completes', () => {
    expect(getPendingPipelineAgent({
      agentPipeline: ['icp_generation', 'lead_generation', 'outreach'],
      agentPipelineIndex: 1,
      currentAgent: 'icp_generation',
      messages: [{ role: 'assistant', content: 'ICP complete' }],
    } as never)).toBe('lead_generation');
    expect(getPendingPipelineAgent({
      agentPipeline: ['icp_generation', 'lead_generation', 'outreach'],
      agentPipelineIndex: 2,
      currentAgent: 'lead_generation',
      messages: [{ role: 'assistant', content: 'Lead review complete' }],
    } as never)).toBe('outreach');
    expect(getPendingPipelineAgent({
      agentPipeline: ['icp_generation', 'lead_generation'],
      agentPipelineIndex: 1,
      currentAgent: 'icp_generation',
      messages: [{ role: 'user', content: 'Actually, stop here' }],
    } as never)).toBeNull();
  });

  it('preserves a pending pipeline step when an off-pipeline prerequisite completes', () => {
    expect(shouldAdvancePipelineIndex({
      agentPipeline: ['icp_generation', 'outreach'],
      agentPipelineIndex: 1,
    }, 'lead_generation')).toBe(false);

    expect(shouldAdvancePipelineIndex({
      agentPipeline: ['icp_generation', 'lead_generation', 'outreach'],
      agentPipelineIndex: 1,
    }, 'lead_generation')).toBe(true);

    expect(getPendingPipelineAgentAfterCompletion({
      agentPipeline: ['icp_generation', 'outreach'],
      agentPipelineIndex: 1,
    }, 'lead_generation')).toBe('outreach');

    expect(getPendingPipelineAgentAfterCompletion({
      agentPipeline: ['icp_generation', 'lead_generation', 'outreach'],
      agentPipelineIndex: 1,
    }, 'lead_generation')).toBeNull();
  });

  it('resumes widget completion on the exact paused pipeline step', () => {
    const continuation = [
      '[WIDGET_EXECUTION_COMPLETE — INTERNAL WORKFLOW CONTINUATION]',
      'The user-approved generate_email_template action succeeded.',
      'Generated copy mentions ad performance, Meta, Google, and outreach.',
    ].join('\n');

    expect(getWidgetContinuationAgent({
      messages: [{ role: 'user', content: continuation }],
      agentPipeline: ['content_studio', 'outreach'],
      agentPipelineIndex: 0,
      widgetContinuation: { widgetId: 50, toolName: 'generate_email_template', success: true },
    } as never)).toBe('content_studio');

    expect(getWidgetContinuationAgent({
      messages: [{ role: 'user', content: 'Generate ad performance copy for Meta.' }],
      agentPipeline: ['content_studio', 'outreach'],
      agentPipelineIndex: 0,
    } as never)).toBeNull();

    expect(getWidgetContinuationAgent({
      messages: [{ role: 'user', content: continuation }],
      agentPipeline: ['content_studio', 'outreach'],
      agentPipelineIndex: 0,
    } as never)).toBeNull();
  });

  it('should detect leads and content when requested positively', async () => {
    mockCreateChatCompletion.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({
        semanticRequest: semanticRequest(),
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
        hiredAgents: ['lead_generation', 'content_studio'],
        mode: 'hire_team',
      }),
    });

    const result = await detectHiredAgentsWithLLM('only the leads and content is enough', 1);
    expect(result.hiredAgents).toContain('lead_generation');
    expect(result.hiredAgents).toContain('content_studio');
    expect(result.hiredAgents).not.toContain('outreach');
    expect(result.mode).toBe('hire_team');
  });

  it('should exclude outreach when negated in the message', async () => {
    mockCreateChatCompletion.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({
        semanticRequest: semanticRequest(),
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
        hiredAgents: ['lead_generation', 'content_studio'],
        mode: 'hire_team',
      }),
    });

    const result = await detectHiredAgentsWithLLM('i dont need the outreach agent now. only the leads and content is enough', 1);
    expect(result.hiredAgents).toContain('lead_generation');
    expect(result.hiredAgents).toContain('content_studio');
    expect(result.hiredAgents).not.toContain('outreach');
    expect(result.mode).toBe('hire_team');
  });

  it('should handle none mode when no agent is hired', async () => {
    mockCreateChatCompletion.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({
        semanticRequest: semanticRequest(),
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
        hiredAgents: [],
        mode: 'none',
      }),
    });

    const result = await detectHiredAgentsWithLLM('just checking in', 1);
    expect(result.hiredAgents).toHaveLength(0);
    expect(result.mode).toBe('none');
  });

  describe('getUnifiedMessageAnalysis for navigation', () => {
    it('uses model navigation even when a specialist is active', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({ success: true, content: JSON.stringify({
        semanticRequest: semanticRequest(),
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
        intent: 'navigation', action: 'question', hiredAgents: [], mode: 'none',
        isAffirmative: false, isDomainMatch: false, response: 'Open leads',
        nextAgent: null, suggestAgents: false, recommendedAgents: [],
        navigationTarget: { tabType: 'leads', tabLabel: 'Leads' },
      }) });
      const result = await getUnifiedMessageAnalysis('Open the leads page.', 'performance_marketing', 1001);

      expect(result.intent).toBe('navigation');
      expect(result.navigationTarget).toEqual({ tabType: 'leads', tabLabel: 'Leads' });
      expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
    });

    it('should parse navigation intent and target', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({
        semanticRequest: semanticRequest(),
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
          intent: 'navigation',
          hiredAgents: [],
          mode: 'none',
          isAffirmative: false,
          isDomainMatch: false,
          navigationTarget: {
            tabType: 'leads',
            tabLabel: 'Leads'
          }
        }),
      });

      const result = await getUnifiedMessageAnalysis('Show me the list of leads', undefined, 1);
      expect(result.intent).toBe('navigation');
      expect(result.navigationTarget).toEqual({
        tabType: 'leads',
        tabLabel: 'Leads'
      });
    });

    it('should return null navigationTarget for task intents', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({
        semanticRequest: semanticRequest(),
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
          intent: 'task',
          hiredAgents: ['lead_generation'],
          mode: 'hire_agent',
          isAffirmative: false,
          isDomainMatch: false,
          navigationTarget: null
        }),
      });

      const result = await getUnifiedMessageAnalysis('scrape leads', undefined, 1);
      expect(result.intent).toBe('task');
      expect(result.navigationTarget).toBeNull();
    });
  });

  describe('getUnifiedMessageAnalysis for meta', () => {
    it('should parse meta intent for capabilities request', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({
        semanticRequest: semanticRequest(),
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
          intent: 'meta',
          hiredAgents: [],
          mode: 'none',
          isAffirmative: false,
          isDomainMatch: false,
          navigationTarget: null
        }),
      });

      const result = await getUnifiedMessageAnalysis('what can you do?', undefined, 1);
      expect(result.intent).toBe('meta');
      expect(result.navigationTarget).toBeNull();
    });

    it('should parse meta intent for reset/cancellation commands', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({
        semanticRequest: semanticRequest(),
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
          intent: 'meta',
          hiredAgents: [],
          mode: 'none',
          isAffirmative: true,
          isDomainMatch: false,
          navigationTarget: null
        }),
      });

      const result = await getUnifiedMessageAnalysis('reset conversation', undefined, 1);
      expect(result.intent).toBe('meta');
      expect(result.isAffirmative).toBe(true);
    });
  });

  describe('provider failure safety', () => {
    it('leaves the campaign unchanged when the configured model is unavailable', async () => {
      mockCreateChatCompletion.mockRejectedValueOnce(new Error('provider unavailable'));

      const result = await getUnifiedMessageAnalysis('I want to get leads for my website', undefined, 91);

      expect(result.needsClarification).toBe(true);
      expect(result.nextAgent).toBeNull();
      expect(result.mode).toBe('none');
    });

    it('does not guess a specialist when the model returns malformed output', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({ success: true, content: 'not-json' });

      const result = await getUnifiedMessageAnalysis('Generate a content plan for LinkedIn', undefined, 92);

      expect(result.needsClarification).toBe(true);
      expect(result.nextAgent).toBeNull();
      expect(result.mode).toBe('none');
    });
  });

  it('keeps routing analysis side-effect free so coordinator replies are not duplicated', async () => {
    mockCreateChatCompletion.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({
        ...{ intent: 'task', action: 'new_task', isAffirmative: false, isDomainMatch: false,
        navigationTarget: null, response: 'Understood', nextAgent: null, suggestAgents: false, recommendedAgents: [] },
        intent: 'conversational',
        hiredAgents: [],
        mode: 'none',
        isAffirmative: false,
        isDomainMatch: false,
        navigationTarget: null,
        response: 'Hello! How can I help?',
        nextAgent: null,
        suggestAgents: false,
        recommendedAgents: [],
      }),
    });

    await getUnifiedMessageAnalysis('hello there', undefined, 93);

    expect(webSocketEmitter.emitChatResponseChunk).not.toHaveBeenCalled();
    expect(webSocketEmitter.emitChatResponse).not.toHaveBeenCalled();
  });
});
