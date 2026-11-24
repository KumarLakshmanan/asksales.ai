import { describe, expect, it } from '@jest/globals';
import { createOutreachAgent } from '../mastra/agents/outreachAgent.js';
import type { ActionButton, AgentState, ToolResult } from '../mastra/state.js';

type TestableOutreachAgent = {
  _handleToolResult(toolName: string, result: ToolResult): void;
  _handleToolCall(toolName: string): boolean;
  buildReturnState(state: AgentState, result: unknown): Partial<AgentState>;
  buildActionButtons(state: AgentState, results: unknown[]): ActionButton[];
};

const emptyState = {} as AgentState;

describe('campaign proposal agent handoff', () => {
  it('instructs the agent to surface missing requirements, sources, and assumptions', () => {
    const prompt = createOutreachAgent().buildSystemPrompt({
      messages: [],
      selectedLeadIds: [101],
    } as unknown as AgentState);
    expect(prompt).toContain('objectives, deliverables and exclusions, timeline, responsibilities, and budget');
    expect(prompt).toContain('requirementQuestions');
    expect(prompt).toContain('sources and assumptions');
  });

  it('preserves the frozen send review as the exact pending approval', () => {
    const frozen = {
      proposalId: 44,
      proposalTitle: 'Customer growth program',
      proposalNumber: 'PROP-0044',
      expectedRevision: 3,
      leadId: 101,
      channel: 'email',
      resolvedRecipient: 'asha@example.test',
      providerAccountId: 'seller@example.test',
      subject: 'Proposal: Customer growth program',
      message: 'Please review the agreed scope.',
      expectedTargetFingerprint: 'a'.repeat(64),
      expectedReviewFingerprint: 'b'.repeat(64),
      idempotencyKey: 'campaign-proposal-send-90-turn-proposal-1',
    };
    const agent = createOutreachAgent() as unknown as TestableOutreachAgent;

    agent._handleToolResult('send_proposal', {
      success: true,
      toolName: 'send_proposal',
      requiresApproval: true,
      output: {
        status: 'approval_pending',
        message: 'Review PROP-0044 for Asha Rao and approve this exact email delivery.',
        args: frozen,
      },
    });

    const returned = agent.buildReturnState(emptyState, {});
    expect(returned).toMatchObject({
      requiresApproval: true,
      pendingApproval: {
        toolName: 'send_proposal',
        args: frozen,
        message: 'Review PROP-0044 for Asha Rao and approve this exact email delivery.',
        executionId: expect.stringMatching(/^proposal-\d+-/),
        createdAt: expect.any(Number),
      },
    });
    expect(agent.buildActionButtons(emptyState, [])).toEqual([
      expect.objectContaining({ action: 'approve_tool', label: 'Approve & Send' }),
      expect.objectContaining({ action: 'reject_tool', label: 'Cancel' }),
    ]);
    expect(agent._handleToolCall('tasks_completed')).toBe(false);
  });

  it('allows the campaign pipeline to continue after a confirmed proposal send', () => {
    const agent = createOutreachAgent() as unknown as TestableOutreachAgent;

    agent._handleToolResult('send_proposal', {
      success: true,
      toolName: 'send_proposal',
      output: { status: 'sent', delivery: { state: 'sent', messageId: 'provider-message-1' } },
    });

    expect(agent._handleToolCall('tasks_completed')).toBe(true);
  });
});
