import { describe, expect, it } from '@jest/globals';
import {
  WORKFLOW_STAGES,
  canTransitionWorkflow,
  campaignStepLockedMessage,
  InvalidWorkflowTransitionError,
  type ConversationWorkflowStage,
} from '../models/conversationWorkflow/stateMachine.js';

// Steps that are sending, searching or publishing must never be left mid-way:
// a change of direction there could send twice or spend twice.
const LOCKED: ConversationWorkflowStage[] = ['lead_executing', 'outreach_running', 'ad_publishing', 'completed', 'cancelled'];

/** How a new lead search starts from each step (see recordConfirmedLeadStrategy). */
function newLeadSearchRoute(from: ConversationWorkflowStage): 'direct' | 'via agent selection' | 'refused' {
  if (canTransitionWorkflow(from, 'lead_strategy_awaiting_approval')) return 'direct';
  if (canTransitionWorkflow(from, 'agent_selection') && canTransitionWorkflow('agent_selection', 'lead_strategy_awaiting_approval')) return 'via agent selection';
  return 'refused';
}

describe('changing direction from every campaign step', () => {
  it.each(WORKFLOW_STAGES.map(stage => [stage]))('%s: a new lead search is allowed or refused in plain words', from => {
    const route = newLeadSearchRoute(from);
    if (LOCKED.includes(from)) expect(route).toBe('refused');
    if (route === 'refused') {
      const error = new InvalidWorkflowTransitionError(from, 'lead_strategy_awaiting_approval');
      expect(error.message).toBe(campaignStepLockedMessage(from));
      expect(error.message).not.toMatch(/_|->|transition|workflow/i);
      expect(error.detail).toContain(`${from} -> lead_strategy_awaiting_approval`);
    }
  });

  it('lets a retry from a ready outreach step start a new lead search', () => {
    expect(newLeadSearchRoute('outreach_ready')).toBe('via agent selection');
    expect(newLeadSearchRoute('leads_awaiting_review')).toBe('direct');
    expect(newLeadSearchRoute('needs_attention')).toBe('direct');
  });

  it('never words a locked step as something the user can skip', () => {
    for (const stage of LOCKED) expect(campaignStepLockedMessage(stage)).not.toMatch(/cancel it first/i);
  });
});
