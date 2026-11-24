/**
 * Test 7: Tool Execution Logic & Approval Flows
 *
 * Tests tool execution return shapes, approval-required tool behavior,
 * switch_agent output, tasks_completed output, and the inline handler
 * logic for approval tools (execute_lead_workflow, send_outreach_messages,
 * publish_meta_ads).
 *
 * Logic replicated from: langgraph/tools/index.ts (func handlers)
 */
import { describe, it, expect } from '@jest/globals';

// ─── Replicated types ──────────────────────────────────────────────────
type AgentType =
  | 'orchestrator' | 'supervisor' | 'icp_generation'
  | 'lead_generation' | 'content_studio' | 'outreach'
  | 'performance_marketing';

// ─── Replicated inline handlers from createTools() ─────────────────────

/** execute_lead_workflow handler (inline, returns approval shape) */
function executeLeadWorkflowInline(input: { thread_id?: number; platforms?: string[] }): string {
  return JSON.stringify({
    requiresApproval: true,
    toolName: 'execute_lead_workflow',
    args: input,
    message: 'This tool requires your approval before execution. It will scrape leads from the configured platforms.',
  });
}

/** send_outreach_messages handler (inline, returns approval shape) */
function sendOutreachMessagesInline(input: { lead_ids?: number[]; channel?: string; template_id?: string }): string {
  return JSON.stringify({
    requiresApproval: true,
    toolName: 'send_outreach_messages',
    args: input,
    message: `This tool requires your approval before sending messages to ${input.lead_ids?.length || 0} leads via ${input.channel}.`,
  });
}

/** publish_meta_ads handler (inline, returns approval shape) */
function publishMetaAdsInline(input: { campaign_id?: string; budget?: number; placements?: string[] }): string {
  return JSON.stringify({
    requiresApproval: true,
    toolName: 'publish_meta_ads',
    args: input,
    message: `This tool requires your approval before publishing to Meta Ads with budget $${input.budget}/day.`,
  });
}

/** switch_agent handler (inline, returns switch shape) */
function switchAgentInline(input: { target_agent: string; reason: string }): string {
  return JSON.stringify({
    success: true,
    toolName: 'switch_agent',
    targetAgent: input.target_agent,
    reason: input.reason,
    switched: true,
  });
}

/** tasks_completed handler (inline, returns completion shape) */
function tasksCompletedInline(input: { summary: string }): string {
  return JSON.stringify({
    success: true,
    toolName: 'tasks_completed',
    summary: input.summary,
    completed: true,
  });
}

// ─── Approval State Machine Simulation ──────────────────────────────────
interface ApprovalState {
  requiresApproval: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingApproval: { toolName: string; args: any } | null;
  currentAgent: AgentType;
}

function handleToolResult(state: ApprovalState, toolOutput: string): ApprovalState {
  const parsed = JSON.parse(toolOutput);
  if (parsed.requiresApproval) {
    return {
      ...state,
      requiresApproval: true,
      pendingApproval: { toolName: parsed.toolName, args: parsed.args },
    };
  }
  if (parsed.switched && parsed.targetAgent) {
    return {
      ...state,
      requiresApproval: false,
      pendingApproval: null,
      currentAgent: parsed.targetAgent as AgentType,
    };
  }
  if (parsed.completed) {
    return {
      ...state,
      requiresApproval: false,
      pendingApproval: null,
    };
  }
  return state;
}

function handleApprovalDecision(state: ApprovalState, approved: boolean): ApprovalState {
  if (!state.pendingApproval) return state;
  if (approved) {
    // Proceed with execution (would call actual executor)
    return { ...state, requiresApproval: false, pendingApproval: null };
  }
  // Rejected — clear approval state
  return { ...state, requiresApproval: false, pendingApproval: null };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('execute_lead_workflow Handler', () => {
  it('returns valid JSON', () => {
    const result = executeLeadWorkflowInline({ thread_id: 5, platforms: ['linkedin'] });
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('always sets requiresApproval to true', () => {
    const parsed = JSON.parse(executeLeadWorkflowInline({}));
    expect(parsed.requiresApproval).toBe(true);
  });

  it('includes correct toolName', () => {
    const parsed = JSON.parse(executeLeadWorkflowInline({}));
    expect(parsed.toolName).toBe('execute_lead_workflow');
  });

  it('passes through input args', () => {
    const input = { thread_id: 10, platforms: ['linkedin', 'google_maps'] };
    const parsed = JSON.parse(executeLeadWorkflowInline(input));
    expect(parsed.args).toEqual(input);
  });

  it('includes human-readable approval message', () => {
    const parsed = JSON.parse(executeLeadWorkflowInline({}));
    expect(parsed.message).toContain('approval');
    expect(parsed.message).toContain('scrape leads');
  });
});

describe('send_outreach_messages Handler', () => {
  it('returns valid JSON', () => {
    const result = sendOutreachMessagesInline({ lead_ids: [1, 2], channel: 'email', template_id: 'tmpl-1' });
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('always sets requiresApproval to true', () => {
    const parsed = JSON.parse(sendOutreachMessagesInline({ lead_ids: [], channel: 'email', template_id: 'x' }));
    expect(parsed.requiresApproval).toBe(true);
  });

  it('includes correct toolName', () => {
    const parsed = JSON.parse(sendOutreachMessagesInline({ lead_ids: [1], channel: 'sms', template_id: 'x' }));
    expect(parsed.toolName).toBe('send_outreach_messages');
  });

  it('message includes lead count', () => {
    const parsed = JSON.parse(sendOutreachMessagesInline({ lead_ids: [1, 2, 3], channel: 'email', template_id: 'x' }));
    expect(parsed.message).toContain('3 leads');
  });

  it('message includes channel', () => {
    const parsed = JSON.parse(sendOutreachMessagesInline({ lead_ids: [1], channel: 'sms', template_id: 'x' }));
    expect(parsed.message).toContain('sms');
  });

  it('handles empty lead_ids gracefully', () => {
    const parsed = JSON.parse(sendOutreachMessagesInline({ lead_ids: [], channel: 'email', template_id: 'x' }));
    expect(parsed.message).toContain('0 leads');
  });

  it('handles undefined lead_ids gracefully', () => {
    const parsed = JSON.parse(sendOutreachMessagesInline({ channel: 'email', template_id: 'x' }));
    expect(parsed.message).toContain('0 leads');
  });
});

describe('publish_meta_ads Handler', () => {
  it('returns valid JSON', () => {
    const result = publishMetaAdsInline({ campaign_id: 'camp-1', budget: 50 });
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('always sets requiresApproval to true', () => {
    const parsed = JSON.parse(publishMetaAdsInline({ campaign_id: 'c1', budget: 25 }));
    expect(parsed.requiresApproval).toBe(true);
  });

  it('includes correct toolName', () => {
    const parsed = JSON.parse(publishMetaAdsInline({ campaign_id: 'c1', budget: 25 }));
    expect(parsed.toolName).toBe('publish_meta_ads');
  });

  it('message includes budget amount', () => {
    const parsed = JSON.parse(publishMetaAdsInline({ campaign_id: 'c1', budget: 75 }));
    expect(parsed.message).toContain('$75/day');
  });

  it('passes through args', () => {
    const input = { campaign_id: 'camp-99', budget: 100, placements: ['facebook_feed'] };
    const parsed = JSON.parse(publishMetaAdsInline(input));
    expect(parsed.args).toEqual(input);
  });
});

describe('switch_agent Handler', () => {
  it('returns valid JSON', () => {
    const result = switchAgentInline({ target_agent: 'content_studio', reason: 'User wants content' });
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('marks success true', () => {
    const parsed = JSON.parse(switchAgentInline({ target_agent: 'outreach', reason: 'test' }));
    expect(parsed.success).toBe(true);
  });

  it('marks switched true', () => {
    const parsed = JSON.parse(switchAgentInline({ target_agent: 'outreach', reason: 'test' }));
    expect(parsed.switched).toBe(true);
  });

  it('includes correct toolName', () => {
    const parsed = JSON.parse(switchAgentInline({ target_agent: 'outreach', reason: 'test' }));
    expect(parsed.toolName).toBe('switch_agent');
  });

  it('includes target agent', () => {
    const parsed = JSON.parse(switchAgentInline({ target_agent: 'lead_generation', reason: 'find leads' }));
    expect(parsed.targetAgent).toBe('lead_generation');
  });

  it('includes reason', () => {
    const parsed = JSON.parse(switchAgentInline({ target_agent: 'icp_generation', reason: 'Needs ICP first' }));
    expect(parsed.reason).toBe('Needs ICP first');
  });

  it('handles all 5 valid target agents', () => {
    const agents = ['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'];
    for (const a of agents) {
      const parsed = JSON.parse(switchAgentInline({ target_agent: a, reason: 'test' }));
      expect(parsed.targetAgent).toBe(a);
      expect(parsed.switched).toBe(true);
    }
  });
});

describe('tasks_completed Handler', () => {
  it('returns valid JSON', () => {
    const result = tasksCompletedInline({ summary: 'Generated ICP with 85% fit score' });
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('marks success true', () => {
    const parsed = JSON.parse(tasksCompletedInline({ summary: 'Done' }));
    expect(parsed.success).toBe(true);
  });

  it('marks completed true', () => {
    const parsed = JSON.parse(tasksCompletedInline({ summary: 'Done' }));
    expect(parsed.completed).toBe(true);
  });

  it('includes correct toolName', () => {
    const parsed = JSON.parse(tasksCompletedInline({ summary: 'Done' }));
    expect(parsed.toolName).toBe('tasks_completed');
  });

  it('passes through summary', () => {
    const parsed = JSON.parse(tasksCompletedInline({ summary: 'Created 5 social media posts' }));
    expect(parsed.summary).toBe('Created 5 social media posts');
  });
});

describe('Approval State Machine', () => {
  const initialState: ApprovalState = {
    requiresApproval: false,
    pendingApproval: null,
    currentAgent: 'lead_generation',
  };

  describe('execute_lead_workflow approval flow', () => {
    it('transitions to approval-required state', () => {
      const result = executeLeadWorkflowInline({ thread_id: 1 });
      const newState = handleToolResult(initialState, result);
      expect(newState.requiresApproval).toBe(true);
      expect(newState.pendingApproval?.toolName).toBe('execute_lead_workflow');
    });

    it('approval clears pending state', () => {
      const result = executeLeadWorkflowInline({ thread_id: 1 });
      const pendingState = handleToolResult(initialState, result);
      const approvedState = handleApprovalDecision(pendingState, true);
      expect(approvedState.requiresApproval).toBe(false);
      expect(approvedState.pendingApproval).toBeNull();
    });

    it('rejection clears pending state', () => {
      const result = executeLeadWorkflowInline({ thread_id: 1 });
      const pendingState = handleToolResult(initialState, result);
      const rejectedState = handleApprovalDecision(pendingState, false);
      expect(rejectedState.requiresApproval).toBe(false);
      expect(rejectedState.pendingApproval).toBeNull();
    });
  });

  describe('send_outreach_messages approval flow', () => {
    it('transitions to approval-required state with args', () => {
      const result = sendOutreachMessagesInline({ lead_ids: [1, 2, 3], channel: 'email', template_id: 'tmpl-1' });
      const newState = handleToolResult({ ...initialState, currentAgent: 'outreach' }, result);
      expect(newState.requiresApproval).toBe(true);
      expect(newState.pendingApproval?.toolName).toBe('send_outreach_messages');
      expect(newState.pendingApproval?.args.lead_ids).toEqual([1, 2, 3]);
    });
  });

  describe('publish_meta_ads approval flow', () => {
    it('transitions to approval-required state with budget', () => {
      const result = publishMetaAdsInline({ campaign_id: 'c1', budget: 100 });
      const newState = handleToolResult({ ...initialState, currentAgent: 'performance_marketing' }, result);
      expect(newState.requiresApproval).toBe(true);
      expect(newState.pendingApproval?.toolName).toBe('publish_meta_ads');
      expect(newState.pendingApproval?.args.budget).toBe(100);
    });
  });

  describe('switch_agent flow', () => {
    it('updates currentAgent on switch', () => {
      const result = switchAgentInline({ target_agent: 'content_studio', reason: 'Create content' });
      const newState = handleToolResult(initialState, result);
      expect(newState.currentAgent).toBe('content_studio');
      expect(newState.requiresApproval).toBe(false);
    });

    it('clears any pending approval on switch', () => {
      const approvalResult = executeLeadWorkflowInline({ thread_id: 1 });
      const pendingState = handleToolResult(initialState, approvalResult);
      expect(pendingState.requiresApproval).toBe(true);

      const switchResult = switchAgentInline({ target_agent: 'outreach', reason: 'switch' });
      const switchedState = handleToolResult(pendingState, switchResult);
      expect(switchedState.pendingApproval).toBeNull();
      expect(switchedState.requiresApproval).toBe(false);
    });
  });

  describe('tasks_completed flow', () => {
    it('clears state on completion', () => {
      const result = tasksCompletedInline({ summary: 'All done' });
      const newState = handleToolResult(initialState, result);
      expect(newState.requiresApproval).toBe(false);
      expect(newState.pendingApproval).toBeNull();
    });
  });

  describe('no-op on non-pending approval decision', () => {
    it('approval decision with no pending approval is identity', () => {
      const state = handleApprovalDecision(initialState, true);
      expect(state).toEqual(initialState);
    });
  });
});

describe('Tool Output JSON Structure Consistency', () => {
  it('all approval tools return {requiresApproval, toolName, args, message}', () => {
    const outputs = [
      JSON.parse(executeLeadWorkflowInline({ thread_id: 1 })),
      JSON.parse(sendOutreachMessagesInline({ lead_ids: [1], channel: 'email', template_id: 'x' })),
      JSON.parse(publishMetaAdsInline({ campaign_id: 'c1', budget: 50 })),
    ];
    for (const o of outputs) {
      expect(o).toHaveProperty('requiresApproval', true);
      expect(o).toHaveProperty('toolName');
      expect(o).toHaveProperty('args');
      expect(o).toHaveProperty('message');
      expect(typeof o.message).toBe('string');
    }
  });

  it('switch_agent returns {success, toolName, targetAgent, reason, switched}', () => {
    const o = JSON.parse(switchAgentInline({ target_agent: 'outreach', reason: 'r' }));
    expect(o).toHaveProperty('success', true);
    expect(o).toHaveProperty('toolName', 'switch_agent');
    expect(o).toHaveProperty('targetAgent');
    expect(o).toHaveProperty('reason');
    expect(o).toHaveProperty('switched', true);
  });

  it('tasks_completed returns {success, toolName, summary, completed}', () => {
    const o = JSON.parse(tasksCompletedInline({ summary: 'done' }));
    expect(o).toHaveProperty('success', true);
    expect(o).toHaveProperty('toolName', 'tasks_completed');
    expect(o).toHaveProperty('summary');
    expect(o).toHaveProperty('completed', true);
  });
});
