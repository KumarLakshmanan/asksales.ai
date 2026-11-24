/**
 * Test 4: Prompt Intent & Edge Cases
 *
 * Tests user-prompt → agent-intent classification, ICP fit-score
 * calculations, action-button logic, WebSocket event shapes,
 * and various edge cases.
 *
 * Logic replicated from:
 *   langgraph/nodes/supervisor.ts (SUPERVISOR_SYSTEM_PROMPT routing rules)
 *   langgraph/nodes/icpAgent.ts   (determineActionButtons, fitScore calculation)
 *   langgraph/graph.ts            (edge functions, pipeline map)
 */
import { describe, it, expect } from '@jest/globals';

type AgentType =
  | 'orchestrator' | 'supervisor' | 'icp_generation'
  | 'lead_generation' | 'content_studio' | 'outreach'
  | 'performance_marketing';

// ─── Intent detection (mirrors supervisor routing rules) ────────────────
const intentMap: Record<string, string[]> = {
  lead_generation: [
    'find leads','search for customers','linkedin','google maps','discover leads',
  ],
  content_studio: [
    'create content','social media','post','image','video','email template',
    'sms template','ad copy','create outreach campaign','create email',
    'create sms','create templates','create ads','ad creative','make ads',
  ],
  outreach: [
    'send email','send outreach','send sms','send messages','start outreach',
  ],
  performance_marketing: [
    'publish ads','launch ads','run ads','analytics','performance','metrics',
    'campaign performance','insights','set budget','facebook ads','meta ads',
  ],
};

function detectIntent(message: string): AgentType | 'unknown' {
  const l = message.toLowerCase();
  for (const [agent, kws] of Object.entries(intentMap)) {
    if (kws.some(kw => l.includes(kw))) return agent as AgentType;
  }
  return 'unknown';
}

// ─── ICP fit-score fallback (deterministic from icpAgent.ts) ────────────
function calculateFitScoreFallback(icp: Record<string, unknown>): number {
  const weights: Record<string, number> = {
    campaignName: 10, campaignObjective: 10, targetAudience: 15,
    targetBusinessModel: 10, industry: 10, primaryRegions: 10,
    primaryJobTitles: 10, targetCompanySizeRange: 5,
    primaryPainPoint: 10, primaryChannels: 10,
  };
  let total = 0;
  for (const [f, w] of Object.entries(weights)) {
    const v = icp[f];
    if (v !== undefined && v !== null && v !== '') {
      if (Array.isArray(v) && v.length > 0) total += w;
      else if (!Array.isArray(v)) total += w;
    }
  }
  return Math.min(Math.round(total), 100);
}

// ─── Action button logic (from icpAgent.ts determineActionButtons) ──────
interface ActionButton { id: string; label: string; action: string; type?: string; }

function determineActionButtons(
  hasBusinessProfile: boolean,
  icpFitScore: number,
  recommendedAgentScores: Record<string, number>,
): ActionButton[] {
  if (!hasBusinessProfile) return [];
  const buttons: ActionButton[] = [];

  if (icpFitScore >= 50) {
    // Top recommended hire button
    const sorted = Object.entries(recommendedAgentScores)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      const [topAgent] = sorted[0];
      const nameMap: Record<string, string> = {
        lead_generation: 'Hire Marcus (Lead Gen)',
        content_studio: 'Hire Alex Chen (Content)',
        outreach: 'Hire Emily (Outreach)',
        performance_marketing: 'Hire Sarah (Performance)',
      };
      buttons.push({
        id: `hire_${topAgent}`, label: nameMap[topAgent] || topAgent,
        action: `HIRE_${topAgent.toUpperCase()}`, type: 'primary',
      });
    }
    buttons.push({ id: 'improve_icp', label: 'Improve ICP', action: 'IMPROVE_ICP', type: 'secondary' });
  } else if (icpFitScore > 0) {
    buttons.push({ id: 'improve_icp', label: 'Improve ICP', action: 'IMPROVE_ICP', type: 'secondary' });
  }
  return buttons;
}

// ─── Supervisor pipeline map (from supervisor.ts supervisorNode) ────────
function getSupervisorPipeline(nextAgent: AgentType): AgentType[] {
  const pipelineMap: Record<string, AgentType[]> = {
    outreach: ['lead_generation', 'content_studio', 'outreach'],
    performance_marketing: ['content_studio', 'performance_marketing'],
    lead_generation: ['lead_generation'],
    content_studio: ['content_studio'],
  };
  return pipelineMap[nextAgent] || [nextAgent];
}

// ─── Edge functions (from graph.ts conditional edges) ────────────────────
function agentEdge(opts: {
  requiresApproval: boolean;
  tasksCompleted: boolean;
  pipeline: AgentType[];
  pipelineIndex: number;
  nextAgent: AgentType | null;
  currentAgent: AgentType;
}): 'supervisor' | 'end' | AgentType {
  if (opts.requiresApproval) return 'end';
  if (opts.tasksCompleted && opts.pipeline.length > 0) {
    const next = opts.pipelineIndex + 1;
    if (next < opts.pipeline.length) return 'supervisor';
  }
  if (opts.nextAgent && opts.nextAgent !== opts.currentAgent) return 'supervisor';
  return 'end';
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('User Prompt → Intent Classification', () => {
  describe('content studio prompts', () => {
    it('Create a social media post', () => expect(detectIntent('Create a social media post')).toBe('content_studio'));
    it('Generate an email template', () => expect(detectIntent('Generate an email template')).toBe('content_studio'));
    it('I need ad copy for Facebook', () => expect(detectIntent('I need ad copy for Facebook')).toBe('content_studio'));
    it('Make a video for Instagram', () => expect(detectIntent('Make a video for Instagram')).toBe('content_studio'));
    it('Create outreach campaign templates', () => expect(detectIntent('Create outreach campaign templates')).toBe('content_studio'));
    it('Create ads for my product', () => expect(detectIntent('Create ads for my store')).toBe('content_studio'));
    it('Create an image post', () => expect(detectIntent('Create an image post')).toBe('content_studio'));
    it('Write an sms template', () => expect(detectIntent('Write an sms template')).toBe('content_studio'));
  });

  describe('lead generation prompts', () => {
    it('Find leads on LinkedIn', () => expect(detectIntent('Find leads on LinkedIn')).toBe('lead_generation'));
    it('Search for customers on Google Maps', () => expect(detectIntent('Search for customers on Google Maps')).toBe('lead_generation'));
    it('Discover leads in Silicon Valley', () => expect(detectIntent('Discover leads in Silicon Valley')).toBe('lead_generation'));
  });

  describe('outreach prompts', () => {
    it('Send email to my leads', () => expect(detectIntent('Send email to my leads')).toBe('outreach'));
    it('Start outreach campaign', () => expect(detectIntent('Start outreach campaign')).toBe('outreach'));
    it('Send sms to contacts', () => expect(detectIntent('Send sms to contacts')).toBe('outreach'));
    it('Send messages to the list', () => expect(detectIntent('Send messages to the list')).toBe('outreach'));
  });

  describe('performance marketing prompts', () => {
    it('Publish ads on Facebook', () => expect(detectIntent('Publish ads on Facebook')).toBe('performance_marketing'));
    it('Show me campaign performance', () => expect(detectIntent('Show me campaign performance')).toBe('performance_marketing'));
    it('Run ads for my product', () => expect(detectIntent('Run ads for my product')).toBe('performance_marketing'));
    it('Show analytics and metrics', () => expect(detectIntent('Show analytics and metrics')).toBe('performance_marketing'));
    it('Launch ads on Meta', () => expect(detectIntent('Launch ads on Meta')).toBe('performance_marketing'));
    it('Set budget for my campaign', () => expect(detectIntent('Set budget for my campaign')).toBe('performance_marketing'));
  });

  describe('ambiguous / unknown prompts', () => {
    it('Hello there', () => expect(detectIntent('Hello there')).toBe('unknown'));
    it('Thank you', () => expect(detectIntent('Thank you')).toBe('unknown'));
    it('What can you do?', () => expect(detectIntent('What can you do?')).toBe('unknown'));
    it('How does this work?', () => expect(detectIntent('How does this work?')).toBe('unknown'));
  });
});

describe('ICP Fit Score Calculation', () => {
  it('empty → 0', () => expect(calculateFitScoreFallback({})).toBe(0));
  it('two fields → 25', () => {
    expect(calculateFitScoreFallback({ targetAudience: 'CTOs', industry: 'Tech' })).toBe(25);
  });
  it('all fields → 100', () => {
    expect(calculateFitScoreFallback({
      campaignName: 'Q1', campaignObjective: 'leads', targetAudience: 'CTOs',
      targetBusinessModel: 'B2B', industry: 'Tech', primaryRegions: ['US'],
      primaryJobTitles: ['CTO'], targetCompanySizeRange: '50-200',
      primaryPainPoint: 'Scaling', primaryChannels: ['linkedin'],
    })).toBe(100);
  });
  it('empty arrays count as missing', () => {
    expect(calculateFitScoreFallback({ campaignName: 'Q1', primaryRegions: [] })).toBe(10);
  });
  it('null values count as missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(calculateFitScoreFallback({ campaignName: null as any, industry: 'Tech' })).toBe(10);
  });
});

describe('Action Buttons Logic', () => {
  it('no buttons when no business profile', () => {
    expect(determineActionButtons(false, 70, { lead_generation: 90 })).toEqual([]);
  });
  it('fitScore < 50 and > 0: only improve ICP', () => {
    const b = determineActionButtons(true, 30, { lead_generation: 90 });
    expect(b).toHaveLength(1);
    expect(b[0].id).toBe('improve_icp');
  });
  it('fitScore 0: no buttons', () => {
    expect(determineActionButtons(true, 0, {})).toEqual([]);
  });
  it('fitScore >= 50: hire + improve', () => {
    const b = determineActionButtons(true, 70, { lead_generation: 90, content_studio: 80 });
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(b[0].type).toBe('primary');
    expect(b.some(x => x.id === 'improve_icp')).toBe(true);
  });
  it('top agent sorted by score', () => {
    const b = determineActionButtons(true, 60, { outreach: 100, lead_generation: 50 });
    expect(b[0].id).toBe('hire_outreach');
  });
});

describe('Supervisor Pipeline Map', () => {
  it('outreach → lead→content→outreach', () => {
    expect(getSupervisorPipeline('outreach')).toEqual(['lead_generation', 'content_studio', 'outreach']);
  });
  it('performance_marketing → content→perf', () => {
    expect(getSupervisorPipeline('performance_marketing')).toEqual(['content_studio', 'performance_marketing']);
  });
  it('lead_generation → solo', () => {
    expect(getSupervisorPipeline('lead_generation')).toEqual(['lead_generation']);
  });
  it('content_studio → solo', () => {
    expect(getSupervisorPipeline('content_studio')).toEqual(['content_studio']);
  });
});

describe('Agent Edge Functions', () => {
  it('end on approval required', () => {
    expect(agentEdge({ requiresApproval: true, tasksCompleted: false, pipeline: [], pipelineIndex: 0, nextAgent: null, currentAgent: 'lead_generation' })).toBe('end');
  });
  it('supervisor when pipeline advances', () => {
    expect(agentEdge({
      requiresApproval: false, tasksCompleted: true,
      pipeline: ['lead_generation', 'content_studio'], pipelineIndex: 0,
      nextAgent: null, currentAgent: 'lead_generation',
    })).toBe('supervisor');
  });
  it('end when pipeline exhausted', () => {
    expect(agentEdge({
      requiresApproval: false, tasksCompleted: true,
      pipeline: ['lead_generation', 'content_studio'], pipelineIndex: 1,
      nextAgent: null, currentAgent: 'content_studio',
    })).toBe('end');
  });
  it('supervisor when nextAgent differs', () => {
    expect(agentEdge({
      requiresApproval: false, tasksCompleted: false, pipeline: [],
      pipelineIndex: 0, nextAgent: 'outreach', currentAgent: 'content_studio',
    })).toBe('supervisor');
  });
  it('end when no pipeline and no nextAgent', () => {
    expect(agentEdge({
      requiresApproval: false, tasksCompleted: false, pipeline: [],
      pipelineIndex: 0, nextAgent: null, currentAgent: 'lead_generation',
    })).toBe('end');
  });
  it('pipeline not advanced without tasksCompleted', () => {
    expect(agentEdge({
      requiresApproval: false, tasksCompleted: false,
      pipeline: ['lead_generation', 'content_studio'], pipelineIndex: 0,
      nextAgent: null, currentAgent: 'lead_generation',
    })).toBe('end');
  });
});

describe('WebSocket Event Shapes', () => {
  it('chat_response_chunk has required fields', () => {
    const chunk = { responseId: 'r-1', role: 'assistant', agentType: 'content_studio', chunk: 'Hi', sequence: 1, done: false };
    expect(chunk.responseId).toBeTruthy();
    expect(typeof chunk.sequence).toBe('number');
    expect(typeof chunk.done).toBe('boolean');
  });
  it('done chunk includes metadata', () => {
    const done = {
      done: true,
      metadata: { responseId: 'r-1', actionButtons: [{ id: 'x', label: 'X', action: 'DO_X', type: 'primary' }] },
    };
    expect(done.done).toBe(true);
    expect(done.metadata.actionButtons).toHaveLength(1);
  });
  it('transition event has isTransition', () => {
    const t = { metadata: { isTransition: true, isTransitionMessage: true, fromAgent: 'router', toAgent: 'content_studio', toAgentName: 'Alex' } };
    expect(t.metadata.isTransition).toBe(true);
    expect(t.metadata.toAgentName).toBe('Alex');
  });
  it('pipeline transition includes step info', () => {
    const e = { metadata: { pipelineStep: 2, pipelineTotal: 3 } };
    expect(e.metadata.pipelineStep).toBe(2);
    expect(e.metadata.pipelineTotal).toBe(3);
  });
});

describe('Edge Cases', () => {
  it('should handle undefined pipeline in shouldContinue', () => {
    // replicated shouldContinue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function sc(pipeline: any, index: any): 'continue' | 'end' {
      if (pipeline && pipeline.length > 0) {
        const ci = index || 0;
        if (ci + 1 < pipeline.length) return 'continue';
      }
      return 'end';
    }
    expect(sc(undefined, 0)).toBe('end');
    expect(sc(null, 0)).toBe('end');
    expect(sc([], 0)).toBe('end');
  });

  it('special characters in keyword matching', () => {
    function matchKeywords(msg: string, kws: string[], opts?: { requireAll?: boolean }): boolean {
      if (!msg || !kws.length) return false;
      const m = msg.toLowerCase();
      const k = kws.map(x => x.toLowerCase());
      return (opts?.requireAll ?? true) ? k.every(x => m.includes(x)) : k.some(x => m.includes(x));
    }
    expect(matchKeywords('find $1000 leads', ['find', 'leads'])).toBe(true);
    expect(matchKeywords('email user@test.com', ['email'])).toBe(true);
  });
});
