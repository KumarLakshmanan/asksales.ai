import { describe, expect, it } from '@jest/globals';
import { bindApprovalActions, readMessageApprovalReference } from '../mastra/approvalActions.js';
import { createLeadAgent } from '../mastra/agents/leadAgent.js';
import { pendingApprovalMatchesRequest } from '../mastra/approvalRequest.js';
import type { ActionButton } from '../mastra/state.js';

describe('review-bound approval buttons', () => {
  const buttons: ActionButton[] = [
    { id: 'approve', label: 'Approve', action: 'approve_tool' },
    { id: 'reject', label: 'Cancel', action: 'reject_tool' },
    { id: 'view', label: 'View', action: 'OPEN_TAB', data: { tabType: 'leads' } },
  ];

  it.each(['execute_lead_workflow', 'send_outreach_messages', 'send_proposal', 'publish_google_ads', 'publish_social_post'])(
    'binds both approval and rejection to the exact %s request', toolName => {
      const oldPending = { toolName, args: {}, executionId: 'review-v1', message: 'Review' };
      const bound = bindApprovalActions(buttons, oldPending);
      expect(bound[0].data).toEqual({ requestId: 'review-v1', toolName });
      expect(bound[1].data).toEqual({ requestId: 'review-v1', toolName });
      expect(bound[2]).toBe(buttons[2]);
      expect(pendingApprovalMatchesRequest(oldPending, String(bound[0].data?.requestId), toolName)).toBe(true);
      expect(pendingApprovalMatchesRequest({ ...oldPending, executionId: 'review-v2' }, String(bound[0].data?.requestId), toolName)).toBe(false);
    },
  );

  it('omits unsafe approval buttons when no request identity exists', () => {
    expect(bindApprovalActions(buttons, null)).toEqual([buttons[2]]);
  });

  it('recovers a legacy button from its message without borrowing a newer thread approval', () => {
    const legacyButton = { id: 'lead_approve', action: 'LEAD_AGENT_APPROVE', label: 'Approve' };
    expect(readMessageApprovalReference({ pendingApproval: {
      toolName: 'execute_lead_workflow', executionId: 'old-review', args: {},
    } }, legacyButton)).toEqual({ requestId: 'old-review', toolName: 'execute_lead_workflow' });
    expect(readMessageApprovalReference({}, legacyButton)).toBeUndefined();
    expect(readMessageApprovalReference({ pendingApproval: { executionId: 123, toolName: 'execute_lead_workflow' } }, legacyButton)).toBeUndefined();
  });

  it('preserves the generated input review through agent state and actions', async () => {
    const agent = createLeadAgent() as any;
    const state = { userId: 7, threadId: 42, messages: [], leadInputs: [], selectedWorkflows: ['linkedin'] };
    await agent.preProcess(state);
    agent._handleToolResult('generate_lead_inputs', {
      success: true,
      output: {
        schemas: [{ platform: 'linkedin' }], inputIds: [123], workflowIds: ['linkedin'],
        leadInputSetId: 'review-2', leadInputSetRevision: 2, workflowRunId: 'run-1',
      },
    }, state, {});
    const returned = agent.buildReturnState(state, {});
    const action = agent.buildActionButtons(state, [])[0];
    expect(returned.pendingApproval.args).toEqual(expect.objectContaining({
      leadInputSetId: 'review-2', leadInputSetRevision: 2, workflowRunId: 'run-1',
    }));
    expect(action.action).toBe('approve_tool');
    expect(action.data).toEqual({
      requestId: 'lead-input-set:review-2:2', toolName: 'execute_lead_workflow', inputSetId: 'review-2', revision: 2,
    });
    expect(agent._handleToolCall('execute_lead_workflow', {}, state)).toBe(false);
  });
});
