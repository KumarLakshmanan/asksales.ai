/**
 * Test 2: Supervisor Logic
 *
 * Tests shouldContinue, routeToAgent, getAgentDisplayName —
 * the pure routing functions from nodes/supervisor.ts
 * 
 * Logic replicated exactly from: langgraph/nodes/supervisor.ts
 */
import { describe, it, expect } from '@jest/globals';

// ─── Replicated types ──────────────────────────────────────────────────
type AgentType =
  | 'orchestrator' | 'supervisor' | 'icp_generation'
  | 'lead_generation' | 'content_studio' | 'outreach'
  | 'performance_marketing';

interface MinState {
  currentAgent: AgentType;
  nextAgent: AgentType | null;
  requiresApproval: boolean;
  agentPipeline?: AgentType[];
  agentPipelineIndex?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icpProfile?: { fitScore?: number; [k: string]: any } | null;
}

// ─── Exact logic from supervisor.ts ────────────────────────────────────
function shouldContinue(state: MinState): 'continue' | 'end' {
  if (state.requiresApproval) return 'end';
  if (state.nextAgent && state.nextAgent !== state.currentAgent) return 'continue';
  if (state.agentPipeline && state.agentPipeline.length > 0) {
    const currentIndex = state.agentPipelineIndex || 0;
    if (currentIndex + 1 < state.agentPipeline.length) return 'continue';
  }
  return 'end';
}

function routeToAgent(state: MinState): AgentType {
  if (state.nextAgent) return state.nextAgent;
  if (!state.icpProfile || (state.icpProfile.fitScore || 0) < 50) return 'icp_generation';
  if (state.currentAgent && state.currentAgent !== 'supervisor') return state.currentAgent;
  return 'supervisor';
}

function getAgentDisplayName(agentType: AgentType): string {
  const names: Record<AgentType, string> = {
    orchestrator: 'Orchestrator',
    supervisor: 'Assistant',
    icp_generation: 'Orchestrator',
    lead_generation: 'Marcus (Lead Generation)',
    content_studio: 'Alex (Content Studio)',
    outreach: 'Emily (Outreach)',
    performance_marketing: 'Sarah (Performance Marketing & Analytics)',
  };
  return names[agentType] || 'Assistant';
}

// helper
function s(overrides: Partial<MinState> = {}): MinState {
  return {
    currentAgent: 'supervisor',
    nextAgent: null,
    requiresApproval: false,
    agentPipeline: [],
    agentPipelineIndex: 0,
    icpProfile: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────
describe('shouldContinue', () => {
  it('end when requiresApproval', () => {
    expect(shouldContinue(s({ requiresApproval: true }))).toBe('end');
  });
  it('continue when nextAgent differs from currentAgent', () => {
    expect(shouldContinue(s({ nextAgent: 'content_studio', currentAgent: 'supervisor' }))).toBe('continue');
  });
  it('end when nextAgent equals currentAgent', () => {
    expect(shouldContinue(s({ nextAgent: 'content_studio', currentAgent: 'content_studio' }))).toBe('end');
  });
  it('end when nextAgent null and pipeline empty', () => {
    expect(shouldContinue(s())).toBe('end');
  });
  it('continue when pipeline has more agents', () => {
    expect(shouldContinue(s({
      agentPipeline: ['lead_generation', 'content_studio', 'outreach'],
      agentPipelineIndex: 0,
    }))).toBe('continue');
  });
  it('continue at pipeline middle', () => {
    expect(shouldContinue(s({
      agentPipeline: ['lead_generation', 'content_studio', 'outreach'],
      agentPipelineIndex: 1,
    }))).toBe('continue');
  });
  it('end when pipeline exhausted', () => {
    expect(shouldContinue(s({
      agentPipeline: ['lead_generation', 'content_studio', 'outreach'],
      agentPipelineIndex: 2,
    }))).toBe('end');
  });
  it('end when pipeline has 1 agent and index 0', () => {
    expect(shouldContinue(s({
      agentPipeline: ['lead_generation'],
      agentPipelineIndex: 0,
    }))).toBe('end');
  });
  it('approval overrides pipeline continuation', () => {
    expect(shouldContinue(s({
      agentPipeline: ['lead_generation', 'content_studio'],
      agentPipelineIndex: 0,
      requiresApproval: true,
    }))).toBe('end');
  });
});

describe('routeToAgent', () => {
  it('returns nextAgent when set', () => {
    expect(routeToAgent(s({ nextAgent: 'content_studio' }))).toBe('content_studio');
  });
  it('ICP generation when no ICP', () => {
    expect(routeToAgent(s({ icpProfile: null }))).toBe('icp_generation');
  });
  it('ICP generation when fitScore < 50', () => {
    expect(routeToAgent(s({ icpProfile: { fitScore: 30 } }))).toBe('icp_generation');
  });
  it('ICP generation when fitScore is 49', () => {
    expect(routeToAgent(s({ icpProfile: { fitScore: 49 } }))).toBe('icp_generation');
  });
  it('stays with current agent when ICP complete and not supervisor', () => {
    expect(routeToAgent(s({ icpProfile: { fitScore: 70 }, currentAgent: 'content_studio' }))).toBe('content_studio');
  });
  it('supervisor when ICP complete and currentAgent is supervisor', () => {
    expect(routeToAgent(s({ icpProfile: { fitScore: 70 }, currentAgent: 'supervisor' }))).toBe('supervisor');
  });
  it('stays with current when fitScore exactly 50', () => {
    expect(routeToAgent(s({ icpProfile: { fitScore: 50 }, currentAgent: 'lead_generation' }))).toBe('lead_generation');
  });
  it('nextAgent takes priority over ICP check', () => {
    expect(routeToAgent(s({ nextAgent: 'outreach', icpProfile: { fitScore: 10 } }))).toBe('outreach');
  });
  it('ICP generation when fitScore undefined', () => {
    expect(routeToAgent(s({ icpProfile: { targetAudience: 'CTOs' } }))).toBe('icp_generation');
  });
});

describe('getAgentDisplayName', () => {
  it('orchestrator', () => expect(getAgentDisplayName('orchestrator')).toBe('Orchestrator'));
  it('supervisor', () => expect(getAgentDisplayName('supervisor')).toBe('Assistant'));
  it('ICP generation (Orchestrator)', () => expect(getAgentDisplayName('icp_generation')).toContain('Orchestrator'));
  it('lead gen (Marcus)', () => expect(getAgentDisplayName('lead_generation')).toContain('Marcus'));
  it('content (Alex)', () => expect(getAgentDisplayName('content_studio')).toContain('Alex'));
  it('outreach (Emily)', () => expect(getAgentDisplayName('outreach')).toContain('Emily'));
  it('performance (Sarah)', () => expect(getAgentDisplayName('performance_marketing')).toContain('Sarah'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it('fallback for unknown', () => expect(getAgentDisplayName('unknown' as any)).toBe('Assistant'));
});

describe('Pipeline Progression Scenarios', () => {
  it('content + perf marketing: continues then ends', () => {
    const pipeline: AgentType[] = ['content_studio', 'performance_marketing'];
    expect(shouldContinue(s({ agentPipeline: pipeline, agentPipelineIndex: 0 }))).toBe('continue');
    expect(shouldContinue(s({ agentPipeline: pipeline, agentPipelineIndex: 1 }))).toBe('end');
  });
  it('lead → content → outreach: three steps', () => {
    const pipeline: AgentType[] = ['lead_generation', 'content_studio', 'outreach'];
    expect(shouldContinue(s({ agentPipeline: pipeline, agentPipelineIndex: 0 }))).toBe('continue');
    expect(shouldContinue(s({ agentPipeline: pipeline, agentPipelineIndex: 1 }))).toBe('continue');
    expect(shouldContinue(s({ agentPipeline: pipeline, agentPipelineIndex: 2 }))).toBe('end');
  });
  it('all four agents pipeline', () => {
    const pipeline: AgentType[] = ['lead_generation', 'content_studio', 'outreach', 'performance_marketing'];
    for (let i = 0; i < 3; i++) {
      expect(shouldContinue(s({ agentPipeline: pipeline, agentPipelineIndex: i }))).toBe('continue');
    }
    expect(shouldContinue(s({ agentPipeline: pipeline, agentPipelineIndex: 3 }))).toBe('end');
  });
});
