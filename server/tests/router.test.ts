/**
 * Test 3: Router – Hire Command Detection & Routing
 *
 * Tests detectHireCommand, detectMultipleHireCommands, matchKeywords,
 * isApprovalMessage, isRejectionMessage, and ICP-gated routing logic.
 *
 * Logic replicated exactly from:
 *   langgraph/graph.ts (routerNode, detectHireCommand, detectMultipleHireCommands)
 *   langgraph/utils/templateMatcher.ts (matchKeywords, isApprovalMessage, isRejectionMessage)
 */
import { describe, it, expect } from '@jest/globals';

// ─── matchKeywords (from templateMatcher.ts) ────────────────────────────
function matchKeywords(
  message: string,
  keywords: string[],
  options?: { caseSensitive?: boolean; requireAll?: boolean },
): boolean {
  if (!message || !keywords.length) return false;
  const caseSensitive = options?.caseSensitive ?? false;
  const requireAll = options?.requireAll ?? true;
  const m = caseSensitive ? message : message.toLowerCase();
  const kw = keywords.map(k => (caseSensitive ? k : k.toLowerCase()));
  return requireAll ? kw.every(k => m.includes(k)) : kw.some(k => m.includes(k));
}

function isApprovalMessage(message: string): boolean {
  const patterns = [
    'approve','approved','yes, proceed','go ahead','please proceed',
    'start searching','start the search','run the workflow','execute','confirm',
  ];
  const m = message.toLowerCase().trim();
  return patterns.some(p => m.includes(p));
}

function isRejectionMessage(message: string): boolean {
  const patterns = [
    'cancel','reject','stop',"don't",'do not','no, ','abort','nevermind','never mind',
  ];
  const m = message.toLowerCase().trim();
  return patterns.some(p => m.includes(p));
}

// ─── detectHireCommand (from graph.ts routerNode) ───────────────────────
type AgentType =
  | 'orchestrator' | 'supervisor' | 'icp_generation'
  | 'lead_generation' | 'content_studio' | 'outreach'
  | 'performance_marketing';

const hirePatterns = [
  'hire','switch to','use','work with','talk to','start with',
  'bring in','engage','get me','connect me with','i need',
  'let me talk to','can i talk to','i want','activate',
];

function detectHireCommand(message: string): AgentType | null {
  const lm = message.toLowerCase().trim();
  const hasHire = hirePatterns.some(p => lm.includes(p));
  if (hasHire) {
    if (matchKeywords(lm, ['marcus','lead gen','lead_generation','lead generation','find leads','find customers','discover leads'], { requireAll: false })) return 'lead_generation';
    if (matchKeywords(lm, ['alex','content','content_studio','content studio','create content','content creation','social media post'], { requireAll: false })) return 'content_studio';
    if (matchKeywords(lm, ['emily','outreach','send email','email campaign','send messages','sms campaign'], { requireAll: false })) return 'outreach';
    if (matchKeywords(lm, ['sarah','performance','marketing','ads','analytics','metrics','campaign performance','publish ads','run ads'], { requireAll: false })) return 'performance_marketing';
  }
  // Direct name (short messages)
  const directNames: [RegExp, AgentType][] = [
    [/\b(marcus|lead\s*gen)\b/, 'lead_generation'],
    [/\b(alex|content\s*studio)\b/, 'content_studio'],
    [/\b(emily|outreach)\b/, 'outreach'],
    [/\b(sarah|performance\s*market)\b/, 'performance_marketing'],
  ];
  if (lm.length < 50) {
    for (const [re, agent] of directNames) if (re.test(lm)) return agent;
  }
  // Name-based detection
  if (lm.includes('marcus') || lm.includes('lead generation')) return 'lead_generation';
  if (lm.includes('alex') || lm.includes('content studio') || lm.includes('content creation')) return 'content_studio';
  if (lm.includes('emily') || lm.includes('outreach')) return 'outreach';
  if (lm.includes('sarah') || lm.includes('performance marketing')) return 'performance_marketing';
  return null;
}

function detectMultipleHireCommands(message: string): AgentType[] {
  const lm = message.toLowerCase().trim();
  const agents: AgentType[] = [];
  const simplePatterns = ['hire','switch to','work with','bring in','engage','activate'];
  if (!simplePatterns.some(p => lm.includes(p))) return agents;
  const checks: [RegExp, AgentType][] = [
    [/\b(marcus|lead\s*gen)/i, 'lead_generation'],
    [/\b(alex|content\s*studio|content\s*creation)/i, 'content_studio'],
    [/\b(emily|outreach)/i, 'outreach'],
    [/\b(sarah|performance\s*market)/i, 'performance_marketing'],
  ];
  for (const [re, at] of checks) if (re.test(lm)) agents.push(at);
  return agents;
}

// isIcpComplete from icpAgent.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isIcpComplete(icpProfile: any): boolean {
  if (!icpProfile) return false;
  return (icpProfile.fitScore || 0) >= 50;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('matchKeywords', () => {
  it('all must match by default', () => {
    expect(matchKeywords('find leads on linkedin', ['find','leads','linkedin'])).toBe(true);
    expect(matchKeywords('find leads', ['find','leads','linkedin'])).toBe(false);
  });
  it('any can match with requireAll false', () => {
    expect(matchKeywords('find leads', ['find','leads','linkedin'], { requireAll: false })).toBe(true);
    expect(matchKeywords('hello', ['find','leads'], { requireAll: false })).toBe(false);
  });
  it('case insensitive by default', () => {
    expect(matchKeywords('Find LEADS', ['find','leads'])).toBe(true);
  });
  it('case sensitive when set', () => {
    expect(matchKeywords('Find LEADS', ['find','leads'], { caseSensitive: true })).toBe(false);
    expect(matchKeywords('find leads', ['find','leads'], { caseSensitive: true })).toBe(true);
  });
  it('empty message or empty keywords → false', () => {
    expect(matchKeywords('', ['find'])).toBe(false);
    expect(matchKeywords('find', [])).toBe(false);
  });
});

describe('isApprovalMessage', () => {
  it('detects approval phrases', () => {
    expect(isApprovalMessage('Yes, approved')).toBe(true);
    expect(isApprovalMessage('Go ahead')).toBe(true);
    expect(isApprovalMessage('please proceed')).toBe(true);
    expect(isApprovalMessage('Run the workflow')).toBe(true);
    expect(isApprovalMessage('Confirm')).toBe(true);
  });
  it('rejects non-approval', () => {
    expect(isApprovalMessage('Hello there')).toBe(false);
    expect(isApprovalMessage('No, cancel it')).toBe(false);
  });
});

describe('isRejectionMessage', () => {
  it('detects rejection phrases', () => {
    expect(isRejectionMessage('Cancel')).toBe(true);
    expect(isRejectionMessage('Stop the workflow')).toBe(true);
    expect(isRejectionMessage("Don't do that")).toBe(true);
    expect(isRejectionMessage('Abort')).toBe(true);
    expect(isRejectionMessage('Nevermind')).toBe(true);
  });
  it('rejects non-rejection', () => {
    expect(isRejectionMessage('Great job')).toBe(false);
  });
});

describe('detectHireCommand single agent', () => {
  it('Hire Marcus → lead_generation', () => {
    expect(detectHireCommand('Hire Marcus for lead generation')).toBe('lead_generation');
  });
  it('Hire Alex → content_studio', () => {
    expect(detectHireCommand('Hire Alex for content creation')).toBe('content_studio');
  });
  it('Hire Emily → outreach', () => {
    expect(detectHireCommand('Hire Emily for outreach')).toBe('outreach');
  });
  it('Hire Sarah → performance_marketing', () => {
    expect(detectHireCommand('Hire Sarah for performance marketing')).toBe('performance_marketing');
  });
  it('Switch to content studio', () => {
    expect(detectHireCommand('Switch to content studio')).toBe('content_studio');
  });
  it('I want to work with Marcus', () => {
    expect(detectHireCommand('I want to work with Marcus')).toBe('lead_generation');
  });
  it('Bring in Emily for email campaigns', () => {
    expect(detectHireCommand('Bring in Emily for email campaigns')).toBe('outreach');
  });
  it('I need lead generation help', () => {
    expect(detectHireCommand('I need lead generation help')).toBe('lead_generation');
  });
  it('Let me talk to Sarah', () => {
    expect(detectHireCommand('Let me talk to Sarah')).toBe('performance_marketing');
  });
  it('Activate outreach', () => {
    expect(detectHireCommand('Activate outreach')).toBe('outreach');
  });
  it('Get me Marcus', () => {
    expect(detectHireCommand('Get me Marcus')).toBe('lead_generation');
  });
  it('Connect me with Alex', () => {
    expect(detectHireCommand('Connect me with Alex')).toBe('content_studio');
  });
  it('Can I talk to Emily', () => {
    expect(detectHireCommand('Can I talk to Emily')).toBe('outreach');
  });

  // Direct name (short message)
  it('short "Marcus" → lead_generation', () => {
    expect(detectHireCommand('Marcus')).toBe('lead_generation');
  });
  it('short "Emily" → outreach', () => {
    expect(detectHireCommand('Emily')).toBe('outreach');
  });
  it('short "Alex" → content_studio', () => {
    expect(detectHireCommand('Alex')).toBe('content_studio');
  });
  it('short "Sarah" → performance_marketing', () => {
    expect(detectHireCommand('Sarah')).toBe('performance_marketing');
  });
  it('short "lead gen" → lead_generation', () => {
    expect(detectHireCommand('lead gen')).toBe('lead_generation');
  });

  // @ mentions
  it('@alex → content_studio', () => {
    expect(detectHireCommand('@alex create something')).toBe('content_studio');
  });
  it('@marcus → lead_generation', () => {
    expect(detectHireCommand('@marcus find leads')).toBe('lead_generation');
  });
  it('@emily → outreach', () => {
    expect(detectHireCommand('@emily send emails')).toBe('outreach');
  });
  it('@sarah → performance_marketing', () => {
    expect(detectHireCommand('@sarah show analytics')).toBe('performance_marketing');
  });

  // Non-hire
  it('null for "What can you do?"', () => {
    expect(detectHireCommand('What can you do?')).toBeNull();
  });
  it('null for empty', () => {
    expect(detectHireCommand('')).toBeNull();
  });
  it('null for "Hello how are you"', () => {
    expect(detectHireCommand('Hello how are you')).toBeNull();
  });
  it('null for long message without agent name', () => {
    expect(detectHireCommand('I would like to know more about your capabilities and what services you provide for my business')).toBeNull();
  });
});

describe('detectMultipleHireCommands', () => {
  it('Hire Alex and Sarah → 2 agents', () => {
    const a = detectMultipleHireCommands('Hire Alex and Sarah');
    expect(a).toHaveLength(2);
    expect(a).toContain('content_studio');
    expect(a).toContain('performance_marketing');
  });
  it('Hire Marcus and Emily → 2 agents', () => {
    const a = detectMultipleHireCommands('Hire Marcus and Emily');
    expect(a).toHaveLength(2);
    expect(a).toContain('lead_generation');
    expect(a).toContain('outreach');
  });
  it('Hire Alex, Marcus, and Emily → 3', () => {
    expect(detectMultipleHireCommands('Hire Alex, Marcus, and Emily')).toHaveLength(3);
  });
  it('all four', () => {
    expect(detectMultipleHireCommands('Hire Marcus, Alex, Emily and Sarah')).toHaveLength(4);
  });
  it('single → 1', () => {
    const a = detectMultipleHireCommands('Hire Alex');
    expect(a).toHaveLength(1);
    expect(a[0]).toBe('content_studio');
  });
  it('empty for non-hire message', () => {
    expect(detectMultipleHireCommands('Hello there')).toHaveLength(0);
  });
  it('empty without hire intent even with names', () => {
    expect(detectMultipleHireCommands('Alex and Sarah are great')).toHaveLength(0);
  });
  it('Bring in Marcus and Alex', () => {
    const a = detectMultipleHireCommands('Bring in Marcus and Alex');
    expect(a).toHaveLength(2);
    expect(a).toContain('lead_generation');
    expect(a).toContain('content_studio');
  });
  it('Activate Emily and Sarah', () => {
    const a = detectMultipleHireCommands('Activate Emily and Sarah');
    expect(a).toHaveLength(2);
    expect(a).toContain('outreach');
    expect(a).toContain('performance_marketing');
  });
});

describe('isIcpComplete', () => {
  it('false for null/undefined/empty', () => {
    expect(isIcpComplete(null)).toBe(false);
    expect(isIcpComplete(undefined)).toBe(false);
    expect(isIcpComplete({})).toBe(false);
  });
  it('false for fitScore < 50', () => {
    expect(isIcpComplete({ fitScore: 0 })).toBe(false);
    expect(isIcpComplete({ fitScore: 30 })).toBe(false);
    expect(isIcpComplete({ fitScore: 49 })).toBe(false);
  });
  it('true at 50', () => expect(isIcpComplete({ fitScore: 50 })).toBe(true));
  it('true above 50', () => {
    expect(isIcpComplete({ fitScore: 75 })).toBe(true);
    expect(isIcpComplete({ fitScore: 100 })).toBe(true);
  });
});

describe('ICP-gated routing logic', () => {
  // Replicates routerNode logic: hire is allowed when icpComplete OR hasIcpData
  function canHireAgent(icpFitScore: number, hasIcpData: boolean): boolean {
    const icpComplete = icpFitScore >= 50;
    return icpComplete || hasIcpData;
  }

  it('allows hire when ICP complete', () => {
    expect(canHireAgent(75, false)).toBe(true);
  });
  it('allows hire when ICP incomplete but has SOME data', () => {
    expect(canHireAgent(30, true)).toBe(true);
  });
  it('blocks hire when no ICP data at all', () => {
    expect(canHireAgent(0, false)).toBe(false);
  });
  it('allows hire at exact 50', () => {
    expect(canHireAgent(50, false)).toBe(true);
  });
});

describe('Router default routing rules', () => {
  // nextAgent set → use it
  // else ICP incomplete → icp_generation
  // else currentAgent not supervisor → stay
  // else → supervisor

  function routerDecision(opts: {
    nextAgent: AgentType | null;
    icpFitScore: number;
    hasIcpData: boolean;
    currentAgent: AgentType;
    hiredAgent: AgentType | null;
  }): AgentType {
    if (opts.nextAgent) return opts.nextAgent;
    const icpComplete = opts.icpFitScore >= 50;
    if (opts.hiredAgent && (icpComplete || opts.hasIcpData)) return opts.hiredAgent;
    if (!icpComplete) return 'icp_generation';
    if (opts.currentAgent !== 'supervisor') return opts.currentAgent;
    return 'supervisor';
  }

  it('nextAgent takes top priority', () => {
    expect(routerDecision({ nextAgent: 'outreach', icpFitScore: 0, hasIcpData: false, currentAgent: 'supervisor', hiredAgent: null })).toBe('outreach');
  });
  it('hire agent with ICP data', () => {
    expect(routerDecision({ nextAgent: null, icpFitScore: 30, hasIcpData: true, currentAgent: 'supervisor', hiredAgent: 'content_studio' })).toBe('content_studio');
  });
  it('icp_generation when no ICP and no hire', () => {
    expect(routerDecision({ nextAgent: null, icpFitScore: 20, hasIcpData: false, currentAgent: 'supervisor', hiredAgent: null })).toBe('icp_generation');
  });
  it('stays with current agent when ICP complete', () => {
    expect(routerDecision({ nextAgent: null, icpFitScore: 70, hasIcpData: true, currentAgent: 'lead_generation', hiredAgent: null })).toBe('lead_generation');
  });
  it('supervisor when ICP complete and currentAgent is supervisor', () => {
    expect(routerDecision({ nextAgent: null, icpFitScore: 70, hasIcpData: true, currentAgent: 'supervisor', hiredAgent: null })).toBe('supervisor');
  });
});
