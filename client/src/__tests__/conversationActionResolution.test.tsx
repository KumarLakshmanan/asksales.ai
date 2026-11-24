import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MessageBubble from "@/components/MessageBubble";
import { WidgetProvider } from "@/components/widgets";
import {
  isOneShotConversationAction,
  resolveConversationAction,
  resolveDisplayedConversationAction,
} from "@/lib/conversation-action-resolution";
import type { Message } from "@/models/message";

const strategyMessage: Message = {
  id: "strategy-message",
  role: "agent",
  agentType: "lead_generation",
  timestamp: Date.now(),
  content: "Do you approve this strategy?",
  metadata: {
    actionButtons: [
      {
        id: "lead_proceed_strategies",
        label: "Proceed with Recommended",
        action: "LEAD_AGENT_START",
        type: "primary",
        data: { message: "Yes, Proceed" },
      },
      {
        id: "lead_show_all_strategies",
        label: "Show All Strategies",
        action: "LEAD_AGENT_USE_WORKFLOW",
        type: "secondary",
        data: { message: "Show me all available strategies for each channel" },
      },
    ],
  },
};

describe("conversation action resolution", () => {
  it("shows the latest retry failure over stale persisted card metadata", () => {
    const persisted = {
      status: "failed_retryable" as const,
      selectedButtonId: "retry-instagram",
      action: "LEAD_AGENT_USE_WORKFLOW",
      outcome: "selected" as const,
      failure: "The action failed before it was accepted. You can retry safely.",
    };
    const latest = {
      ...persisted,
      failure: "Approve the current ICP revision before selecting lead platforms",
    };

    expect(resolveDisplayedConversationAction(persisted, latest)).toEqual(latest);
  });

  it("keeps a durable superseded result ahead of a stale local override", () => {
    expect(resolveDisplayedConversationAction(
      { status: "superseded" },
      { status: "failed_retryable", selectedButtonId: "retry", failure: "Stale failure" },
    )).toEqual({ status: "superseded" });
  });

  it.each(['APPROVE_ICP', 'approve_tool', 'reject_tool'])('does not infer %s outcomes from an explanation request or casual yes', action => {
    const message = { metadata: { actionButtons: [{ id: 'review', action }] } };
    expect(resolveConversationAction(message, [{ role: 'user', content: 'Yes, explain why first. Do not run it.' }])).toEqual({ status: 'pending' });
  });

  it('keeps only the latest surface for the same pending tool request', () => {
    const message = { role: 'assistant' as const, content: 'Review', metadata: { actionButtons: [
      { id: 'approve-r1', action: 'approve_tool', data: { requestId: 'r1', toolName: 'execute_lead_workflow' } },
      { id: 'edit', action: 'OPEN_TAB' },
    ] } };
    expect(resolveConversationAction(message, [message])).toEqual({ status: 'superseded' });
    expect(resolveConversationAction(message, [])).toEqual({ status: 'pending' });
  });
  it('retires only the exact pending tool approval after a structured campaign cancellation', () => {
    const message = { metadata: { actionButtons: [
      { id: 'approve', action: 'approve_tool', data: { requestId: 'r-1', toolName: 'execute_lead_workflow' } },
      { id: 'reject', action: 'reject_tool', data: { requestId: 'r-1', toolName: 'execute_lead_workflow' } },
    ] } };
    const cancellation = { role: 'assistant' as const, content: 'Stopped', metadata: { cancelledApproval: { requestId: 'r-1', toolName: 'execute_lead_workflow' } } };
    expect(resolveConversationAction(message, [cancellation])).toMatchObject({ status: 'selected', selectedButtonId: 'reject', outcome: 'rejected' });
    cancellation.metadata.cancelledApproval.requestId = 'r-2';
    expect(resolveConversationAction(message, [cancellation])).toEqual({ status: 'pending' });
  });
  const icpReview = (revision: number) => ({ role: 'assistant' as const, content: 'Review ICP', metadata: {
    actionButtons: [
      { id: 'improve_icp', action: 'IMPROVE_ICP' },
      { id: `approve_icp_137_${revision}`, action: 'APPROVE_ICP', data: { icpId: 137, revision } },
    ],
  } });

  it('keeps only one approval control for a duplicated ICP review', () => {
    expect(resolveConversationAction(icpReview(1), [icpReview(1)])).toEqual({ status: 'superseded' });
    expect(resolveConversationAction(icpReview(1), [])).toEqual({ status: 'pending' });
  });

  it('retires an old revision and its stale retry when a newer revision is presented', () => {
    const old = icpReview(1);
    expect(resolveConversationAction({ metadata: { ...old.metadata, actionResolution: {
      status: 'failed_retryable', selectedButtonId: 'approve_icp_137_1', action: 'APPROVE_ICP',
    } } }, [icpReview(2)])).toEqual({ status: 'superseded' });
  });

  it('does not retire a pending ICP merely because the user asks a question', () => {
    expect(resolveConversationAction(icpReview(2), [{ role: 'user', content: 'Why this score? Do not approve.' }])).toEqual({ status: 'pending' });
  });

  it('does not resolve another resource or hide a recorded approval receipt', () => {
    const other = icpReview(2);
    other.metadata.actionButtons[1].data = { icpId: 138, revision: 2 };
    expect(resolveConversationAction(icpReview(1), [other])).toEqual({ status: 'pending' });
    expect(resolveConversationAction({ metadata: { ...icpReview(1).metadata, actionResolution: {
      status: 'selected', selectedButtonId: 'approve_icp_137_1', action: 'APPROVE_ICP', outcome: 'approved',
    } } }, [icpReview(2)])).toMatchObject({ status: 'selected', outcome: 'approved' });
  });
  it("selects the exact strategy choice recorded by a later user message", () => {
    expect(
      resolveConversationAction(strategyMessage, [
        { role: "user", content: "Yes, Proceed" },
        { role: "agent", content: "Generating lead inputs now." },
      ]),
    ).toEqual({ status: "selected", selectedButtonId: "lead_proceed_strategies" });
  });

  it("waits for a durable receipt instead of treating lead-generation approval prose as proof", () => {
    const approvalMessage: Message = {
      ...strategyMessage,
      id: "approval-message",
      metadata: {
        actionButtons: [
          {
            id: "run-leads-123",
            label: "Approve & Run Lead Generation",
            action: "LEAD_AGENT_APPROVE",
            type: "primary",
          },
        ],
      },
    };

    expect(
      resolveConversationAction(approvalMessage, [
        { role: "user", content: "Approved. Starting lead generation on: justdial" },
      ]),
    ).toEqual({ status: "pending" });
  });

  it("expires a one-shot prompt when the conversation moves on without selecting it", () => {
    expect(
      resolveConversationAction(strategyMessage, [{ role: "user", content: "Use LinkedIn instead." }]),
    ).toEqual({ status: "superseded" });
  });

  it("keeps persistent navigation actions active", () => {
    const navigationMessage: Message = {
      ...strategyMessage,
      metadata: {
        actionButtons: [
          {
            id: "open-email",
            label: "Open Email",
            action: "OPEN_EMAIL_MODAL",
            type: "secondary",
          },
        ],
      },
    };

    expect(
      resolveConversationAction(navigationMessage, [{ role: "user", content: "Thanks" }]),
    ).toEqual({ status: "pending" });
  });

  it("keeps lowercase export navigation reusable", () => {
    expect(isOneShotConversationAction({
      id: "export",
      action: "export_ad",
      data: { message: "Export this campaign" },
    })).toBe(false);
  });

  it("uses persisted structured resolution before legacy reply inference", () => {
    expect(
      resolveConversationAction({
        ...strategyMessage,
        metadata: {
          ...strategyMessage.metadata,
          actionResolution: {
            status: "processing",
            selectedButtonId: "lead_proceed_strategies",
            action: "LEAD_AGENT_START",
            outcome: "selected",
          },
        },
      }, []),
    ).toEqual({
      status: "processing",
      selectedButtonId: "lead_proceed_strategies",
      action: "LEAD_AGENT_START",
      outcome: "selected",
    });
  });

  it("restores a retryable failure from message metadata", () => {
    expect(
      resolveConversationAction({
        ...strategyMessage,
        metadata: {
          ...strategyMessage.metadata,
          actionResolution: {
            status: "failed_retryable",
            selectedButtonId: "lead_proceed_strategies",
            action: "LEAD_AGENT_START",
            outcome: "selected",
            failure: "Provider was unavailable.",
          },
        },
      }, []),
    ).toEqual({
      status: "failed_retryable",
      selectedButtonId: "lead_proceed_strategies",
      action: "LEAD_AGENT_START",
      outcome: "selected",
      failure: "Provider was unavailable.",
    });
  });

  it("renders only the selected choice as a non-clickable status", () => {
    const onActionClick = vi.fn();
    render(
      <WidgetProvider>
        <MessageBubble
          message={strategyMessage}
          onActionClick={onActionClick}
          actionResolution={{ status: "selected", selectedButtonId: "lead_proceed_strategies" }}
        />
      </WidgetProvider>,
    );

    expect(screen.getByRole("status", { name: "Recommended strategy selected" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Proceed with Recommended" })).not.toBeInTheDocument();
    expect(screen.queryByText("Show All Strategies")).not.toBeInTheDocument();
    expect(onActionClick).not.toHaveBeenCalled();
  });

  it('renders the specific retryable action failure without losing the Retry control', () => {
    const failure = 'Approve the current ICP revision before selecting lead platforms.';
    const onActionClick = vi.fn();
    render(
      <WidgetProvider>
        <MessageBubble
          message={strategyMessage}
          onActionClick={onActionClick}
          actionResolution={{
            status: 'failed_retryable',
            selectedButtonId: 'lead_proceed_strategies',
            action: 'LEAD_AGENT_START',
            failure,
          }}
        />
      </WidgetProvider>,
    );

    expect(screen.getByRole('status', { name: 'Proceed with Recommended failed' })).toHaveTextContent(failure);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(onActionClick).not.toHaveBeenCalled();
  });
});
