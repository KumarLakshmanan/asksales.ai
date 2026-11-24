import { describe, expect, it } from '@jest/globals';
import {
  InvalidWorkflowTransitionError,
  assertWorkflowTransition,
  canTransitionWorkflow,
  isCurrentIcpRevisionApproved,
  isTerminalWorkflowStatus,
  workflowAfterRecipientSelection,
} from '../models/conversationWorkflow/stateMachine.js';

describe('conversation campaign workflow state machine', () => {
  it.each(['ad_draft', 'ad_awaiting_approval', 'ad_publishing', 'outreach_running', 'lead_executing'] as const)('records recipients without abandoning %s', (stage) => {
    const next = workflowAfterRecipientSelection(stage, 'awaiting_approval');
    expect(next).toEqual({ toStage: stage, status: 'awaiting_approval' });
    expect(() => assertWorkflowTransition(stage, next.toStage)).not.toThrow();
  });
  it('advances a reviewed lead selection through its normal outreach gate', () => {
    expect(workflowAfterRecipientSelection('leads_awaiting_review', 'awaiting_input')).toEqual({ toStage: 'outreach_ready', status: 'awaiting_input' });
  });
  it('allows replacing pre-execution strategy settings without bypassing execution approval', () => {
    expect(canTransitionWorkflow('lead_inputs_generating', 'lead_strategy_awaiting_approval')).toBe(true);
    expect(canTransitionWorkflow('lead_inputs_generating', 'lead_executing')).toBe(false);
    expect(canTransitionWorkflow('lead_executing', 'lead_strategy_awaiting_approval')).toBe(false);
  });
  it('allows a completed lead review to be replaced by a fresh input review', () => {
    expect(canTransitionWorkflow('leads_awaiting_review', 'lead_inputs_generating')).toBe(true);
    expect(canTransitionWorkflow('leads_awaiting_review', 'lead_inputs_awaiting_approval')).toBe(true);
    expect(canTransitionWorkflow('leads_awaiting_review', 'lead_executing')).toBe(true);
  });
  it('enforces the required lead-generation approval order', () => {
    const path = [
      ['icp_draft', 'icp_awaiting_approval'],
      ['icp_awaiting_approval', 'agent_selection'],
      ['agent_selection', 'lead_strategy_awaiting_approval'],
      ['lead_strategy_awaiting_approval', 'lead_inputs_generating'],
      ['lead_inputs_generating', 'lead_inputs_awaiting_approval'],
      ['lead_inputs_awaiting_approval', 'lead_executing'],
      ['lead_executing', 'leads_awaiting_review'],
      ['leads_awaiting_review', 'outreach_ready'],
      ['outreach_ready', 'outreach_awaiting_approval'],
      ['outreach_awaiting_approval', 'outreach_running'],
      ['outreach_running', 'completed'],
    ] as const;

    for (const [from, to] of path) {
      expect(canTransitionWorkflow(from, to)).toBe(true);
      expect(() => assertWorkflowTransition(from, to)).not.toThrow();
    }
  });

  it('blocks skipping from ICP review directly to lead execution', () => {
    expect(canTransitionWorkflow('icp_awaiting_approval', 'lead_executing')).toBe(false);
    expect(() => assertWorkflowTransition('icp_awaiting_approval', 'lead_executing'))
      .toThrow(InvalidWorkflowTransitionError);
  });

  it('allows an executed lead search with no matches to finish without a recipient-review gate', () => {
    expect(() => assertWorkflowTransition('lead_executing', 'completed')).not.toThrow();
    expect(isTerminalWorkflowStatus('succeeded_empty')).toBe(true);
    expect(canTransitionWorkflow('lead_inputs_awaiting_approval', 'completed')).toBe(false);
  });

  it('treats approval as valid only for the exact current ICP revision', () => {
    expect(isCurrentIcpRevisionApproved({ approved: true, revision: 3, approvedRevision: 3 })).toBe(true);
    expect(isCurrentIcpRevisionApproved({ approved: true, revision: 4, approvedRevision: 3 })).toBe(false);
    expect(isCurrentIcpRevisionApproved({ approved: false, revision: 3, approvedRevision: 3 })).toBe(false);
    expect(isCurrentIcpRevisionApproved({ approved: true })).toBe(false);
  });

  it('does not report queued or awaiting work as terminal success', () => {
    expect(isTerminalWorkflowStatus('queued')).toBe(false);
    expect(isTerminalWorkflowStatus('awaiting_approval')).toBe(false);
    expect(isTerminalWorkflowStatus('succeeded')).toBe(true);
    expect(isTerminalWorkflowStatus('succeeded_empty')).toBe(true);
    expect(isTerminalWorkflowStatus('failed')).toBe(true);
    expect(isTerminalWorkflowStatus('gated')).toBe(true);
  });
});
