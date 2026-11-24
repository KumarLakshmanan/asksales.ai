import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AGENT_TYPES, type AgentType } from '../shared/agents/state.js';
import { agentToolMapping, toolMetadata } from '../mastra/tools/toolRegistry.js';

const route = jest.fn<any>();
jest.unstable_mockModule('../mastra/unifiedRouter.js', () => ({ runUnifiedRouter: route }));
jest.unstable_mockModule('../mastra/cancelCampaignReviews.js', () => ({
  cancelCampaignReviews: jest.fn<any>().mockResolvedValue([]),
  cancelPendingCampaignApproval: jest.fn<any>().mockResolvedValue(null),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {
  emitAgentStatus: jest.fn(), emitChatResponse: jest.fn(), emitOpenTab: jest.fn(),
} }));
jest.unstable_mockModule('../models/chatMessages/functions.js', () => ({
  createChatMessage: jest.fn<any>().mockResolvedValue({ id: 1 }),
}));

const { routerLogic } = await import('../mastra/orchestrator.js');
const { routerOutputSchema } = await import('../mastra/routerSchema.js');

const specialists = AGENT_TYPES.filter((agent): agent is Exclude<AgentType, 'orchestrator' | 'supervisor'> =>
  agent !== 'orchestrator' && agent !== 'supervisor');

function decision(agent: typeof specialists[number], action: 'new_task' | 'continue') {
  return routerOutputSchema.parse({
    intent: 'task', action, hiredAgents: [agent], mode: 'hire_agent',
    isAffirmative: action === 'continue', isDomainMatch: action === 'continue',
    nextAgent: agent, navigationTarget: null, response: 'Continue safely.',
    suggestAgents: false, recommendedAgents: [],
  });
}

function state() {
  return {
    userId: 7, threadId: 42, currentAgent: 'supervisor',
    messages: [{ role: 'user', content: 'Start the requested specialist review. Do not execute.' }],
    icpProfile: { fitScore: 80, revision: 2, approvedRevision: 2, approved: true },
    agentPipeline: [], agentPipelineIndex: 0, savedToolActions: [],
  } as any;
}

describe('two-message acceptance coverage for every campaign agent', () => {
  beforeEach(() => {
    route.mockReset();
  });

  it.each(specialists)('%s retains ownership and context across two messages', async agent => {
    const conversation = state();
    route.mockResolvedValueOnce(decision(agent, 'new_task'));
    const first = await routerLogic(conversation);
    expect(first.nextAgent).toBe(agent);
    Object.assign(conversation, first.stateUpdates, { currentAgent: agent });
    conversation.messages.push(
      { role: 'assistant', content: 'The review prerequisite is ready.' },
      { role: 'user', content: 'Continue this same review, preserving the previous constraints.' },
    );

    route.mockResolvedValueOnce(decision(agent, 'continue'));
    const second = await routerLogic(conversation);
    expect(second.nextAgent).toBe(agent);
    expect(conversation.agentPipeline).toContain(agent);
    expect(conversation.messages.at(-2)?.content).toContain('prerequisite');
  });

  it('keeps orchestrator and supervisor as two-turn coordinator surfaces', async () => {
    const conversation = state();
    const coordinatorDecision = routerOutputSchema.parse({
      intent: 'meta', action: 'question', hiredAgents: [], mode: 'none',
      isAffirmative: false, isDomainMatch: true, nextAgent: null,
      navigationTarget: null, response: 'Here are the available agents.',
      suggestAgents: true, recommendedAgents: specialists,
    });
    route.mockResolvedValue(coordinatorDecision);
    expect((await routerLogic(conversation)).nextAgent).toBe('supervisor');
    conversation.messages.push(
      { role: 'assistant', content: 'Here are the available agents.' },
      { role: 'user', content: 'Explain the approval flow before I choose one.' },
    );
    expect((await routerLogic(conversation)).nextAgent).toBe('supervisor');
    expect(conversation.agentPipeline).toEqual([]);
  });

  it('assigns every registered toolkit to an authorized agent surface', () => {
    expect(Object.keys(agentToolMapping).sort()).toEqual([...AGENT_TYPES].sort());
    const assigned = new Set<string>();
    for (const [agent, tools] of Object.entries(agentToolMapping) as Array<[AgentType, string[]]>) {
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        assigned.add(tool);
        expect(toolMetadata[tool]?.agents).toContain(agent);
      }
    }
    expect([...assigned].sort()).toEqual(Object.keys(toolMetadata).sort());
  });
});
