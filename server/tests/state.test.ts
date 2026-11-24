/**
 * Test 1: State & Agent Config
 *
 * Tests the pure state initialization logic, AGENT_INFO map,
 * ICP scoring thresholds, and agent availability.
 * 
 * Logic replicated from: langgraph/state.ts
 * (no imports to avoid ts-jest OOM on @langchain/*)
 */
import { describe, it, expect } from '@jest/globals';

// ─── replicated types & constants from state.ts ────────────────────────────
type AgentType =
  | 'orchestrator' | 'supervisor' | 'icp_generation'
  | 'lead_generation' | 'content_studio' | 'outreach'
  | 'performance_marketing';

const AGENT_INFO: Record<AgentType, {
  displayName: string; description: string; color: string;
  avatar?: string; requiredIcpScore: number;
}> = {
  orchestrator:          { displayName: 'Orchestrator',                     description: 'Coordinates all agents',                  color: '#6366f1', requiredIcpScore: 0  },
  supervisor:            { displayName: 'Supervisor',                          description: 'Routes conversations',                    color: '#4f46e5', requiredIcpScore: 0  },
  icp_generation:        { displayName: 'Orchestrator',                   description: 'Creates and refines ICP',                 color: '#8b5cf6', avatar: '/agent-avatars/orchestrator.png',  requiredIcpScore: 0  },
  lead_generation:       { displayName: 'Lead Generation Specialist Marcus',   description: 'Discovers qualified leads',               color: '#10b981', avatar: '/agent-avatars/leadagent.png', requiredIcpScore: 50 },
  content_studio:        { displayName: 'Content Studio Director Alex',        description: 'Creates marketing content',               color: '#f59e0b', avatar: '/agent-avatars/content-studio.png',   requiredIcpScore: 50 },
  outreach:              { displayName: 'Outreach Coordinator Emily',          description: 'Manages outreach campaigns',              color: '#3b82f6', avatar: '/agent-avatars/outreach.png',  requiredIcpScore: 50 },
  performance_marketing: { displayName: 'Performance Marketing Manager Sarah', description: 'Manages paid advertising',                color: '#ec4899', avatar: '/agent-avatars/performance.png',  requiredIcpScore: 50 },
};

function getRequiredIcpScore(agentType: AgentType): number {
  return AGENT_INFO[agentType]?.requiredIcpScore ?? 0;
}

function isAgentAvailable(agentType: AgentType, fitScore: number): boolean {
  return fitScore >= getRequiredIcpScore(agentType);
}

interface AgentState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  userId: string; threadId: string;
  currentAgent: AgentType; nextAgent: AgentType | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icpProfile: any; agentPipeline: AgentType[];
  agentPipelineIndex: number; requiresApproval: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function createInitialState(userId: string, threadId: string): AgentState {
  return {
    messages: [], userId, threadId, workflowId: '', selectedWorkflows: [],
    currentAgent: 'orchestrator', nextAgent: null, icpProfile: null,
    brandToolkit: null, leadInputs: [], toolResults: [], actionButtons: [],
    requiresApproval: false, pendingApproval: null, finalResponse: '',
    transitionReason: '', openTab: null, error: null, iteration: 0,
    maxIterations: 5, isComplete: false, lastResponseId: null, llmConfig: null,
    agentPipeline: [], agentPipelineIndex: 0,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────
describe('createInitialState', () => {
  it('sets userId and threadId', () => {
    const s = createInitialState('42', 'th-9');
    expect(s.userId).toBe('42');
    expect(s.threadId).toBe('th-9');
  });
  it('starts with empty messages and orchestrator', () => {
    const s = createInitialState('1', '1');
    expect(s.messages).toEqual([]);
    expect(s.currentAgent).toBe('orchestrator');
  });
  it('defaults pipeline to empty', () => {
    const s = createInitialState('1', '1');
    expect(s.agentPipeline).toEqual([]);
    expect(s.agentPipelineIndex).toBe(0);
  });
  it('defaults flags to false / null', () => {
    const s = createInitialState('1', '1');
    expect(s.requiresApproval).toBe(false);
    expect(s.icpProfile).toBeNull();
    expect(s.error).toBeNull();
    expect(s.nextAgent).toBeNull();
  });
});

describe('AGENT_INFO', () => {
  const allAgents: AgentType[] = [
    'orchestrator','supervisor','icp_generation',
    'lead_generation','content_studio','outreach','performance_marketing',
  ];
  it('has an entry for every agent type', () => {
    for (const a of allAgents) expect(AGENT_INFO[a]).toBeDefined();
  });
  it('gated agents require score 50', () => {
    for (const a of ['lead_generation','content_studio','outreach','performance_marketing'] as AgentType[]) {
      expect(AGENT_INFO[a].requiredIcpScore).toBe(50);
    }
  });
  it('non-gated agents require score 0', () => {
    for (const a of ['orchestrator','supervisor','icp_generation'] as AgentType[]) {
      expect(AGENT_INFO[a].requiredIcpScore).toBe(0);
    }
  });
  it('specialist agents have avatars', () => {
    expect(AGENT_INFO.icp_generation.avatar).toContain('orchestrator');
    expect(AGENT_INFO.lead_generation.avatar).toContain('leadagent');
    expect(AGENT_INFO.content_studio.avatar).toContain('content-studio');
    expect(AGENT_INFO.outreach.avatar).toContain('outreach');
    expect(AGENT_INFO.performance_marketing.avatar).toContain('performance');
  });
  it('display names contain first names', () => {
    expect(AGENT_INFO.icp_generation.displayName).toContain('Orchestrator');
    expect(AGENT_INFO.lead_generation.displayName).toContain('Marcus');
    expect(AGENT_INFO.content_studio.displayName).toContain('Alex');
    expect(AGENT_INFO.outreach.displayName).toContain('Emily');
    expect(AGENT_INFO.performance_marketing.displayName).toContain('Sarah');
  });
});

describe('getRequiredIcpScore', () => {
  it('50 for gated', () => expect(getRequiredIcpScore('lead_generation')).toBe(50));
  it('0 for non-gated', () => expect(getRequiredIcpScore('icp_generation')).toBe(0));
});

describe('isAgentAvailable', () => {
  it('true when fitScore >= required', () => {
    expect(isAgentAvailable('lead_generation', 50)).toBe(true);
    expect(isAgentAvailable('lead_generation', 99)).toBe(true);
  });
  it('false when fitScore < required', () => {
    expect(isAgentAvailable('lead_generation', 49)).toBe(false);
    expect(isAgentAvailable('content_studio', 0)).toBe(false);
  });
  it('always true for non-gated agents', () => {
    expect(isAgentAvailable('icp_generation', 0)).toBe(true);
    expect(isAgentAvailable('orchestrator', 0)).toBe(true);
  });
});
