import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CampaignChatHeader from "@/components/CampaignChatHeader";
import MessageBubble from "@/components/MessageBubble";
import { WidgetProvider } from "@/components/widgets";
import type { Message } from "@/models/message";

describe("Conversation surface polish", () => {
  it('opens agent management from the campaign header', () => {
    const onManageAgents = vi.fn();
    render(<CampaignChatHeader onManageAgents={onManageAgents} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage agents' }));
    expect(onManageAgents).toHaveBeenCalledOnce();
  });

  it('keeps the speaker name in the title without repeating it in the reply', () => {
    const { container } = render(<WidgetProvider><MessageBubble message={{ id: 'self-label', role: 'agent', agentType: 'lead_generation',
      timestamp: Date.now(), content: '**Marcus:** Review the existing leads with Sarah.',
    }} /></WidgetProvider>);
    expect(screen.getByText('Marcus', { exact: true })).toBeInTheDocument();
    expect(container.querySelector('.prose')?.textContent).toBe('Review the existing leads with Sarah.');
  });

  it('labels a read-only handoff without claiming a campaign assignment', () => {
    render(<WidgetProvider><MessageBubble message={{ id: 'question-handoff', role: 'agent', timestamp: Date.now(),
      content: 'Asking Sarah', metadata: { isTransition: true, readOnlyHandoff: true, toAgent: 'performance_marketing', toAgentName: 'Sarah' },
    }} /></WidgetProvider>);
    expect(screen.getByText('Asking Sarah')).toBeInTheDocument();
    expect(screen.queryByText('Sarah assigned to campaign')).not.toBeInTheDocument();
  });

  it('recovers a chooser for an older approved ICP with empty agent choices', () => {
    const onActionClick = vi.fn();
    render(<WidgetProvider><MessageBubble message={{ id: '209', role: 'agent', timestamp: Date.now(),
      content: 'ICP approved. Choose the agent you want to run next.',
      metadata: { workflowStage: 'agent_selection', actionButtons: [] },
    }} onActionClick={onActionClick} /></WidgetProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Choose agent' }));
    expect(onActionClick).toHaveBeenCalledWith('OPEN_TAB', { tabType: 'agentchoose' }, expect.objectContaining({ oneShot: false }));
  });

  it('renders the outreach-only recommendation as a usable Emily choice', () => {
    const onActionClick = vi.fn();
    render(<WidgetProvider><MessageBubble message={{ id: 'outreach-choice', role: 'agent', timestamp: Date.now(), content: 'Choose an agent.',
      metadata: { actionButtons: [{ id: 'hire_outreach', action: 'HIRE_OUTREACH', label: 'Outreach', type: 'primary' }] },
    }} onActionClick={onActionClick} /></WidgetProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Hire Emily/ }));
    expect(onActionClick).toHaveBeenCalledWith('HIRE_OUTREACH', undefined, expect.objectContaining({ oneShot: true }));
  });

  it("preserves independent agent choices instead of silently combining them into a team", () => {
    const onActionClick = vi.fn();
    render(<WidgetProvider><MessageBubble
      message={{ id: 'choose-agent', role: 'agent', agentType: 'orchestrator', timestamp: Date.now(), content: 'Choose your next agent.', metadata: {
        actionButtons: [
          { id: 'lead', action: 'HIRE_LEAD_GEN', label: 'Lead Generation', type: 'primary' },
          { id: 'content', action: 'HIRE_CONTENT_STUDIO', label: 'Content Studio', type: 'secondary' },
          { id: 'ads', action: 'HIRE_PERFORMANCE', label: 'Performance Marketing', type: 'secondary' },
        ],
      } }}
      onActionClick={onActionClick} isLastMessage
    /></WidgetProvider>);
    expect(screen.queryByRole('button', { name: /Hire Team/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose Alex/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose Sarah/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Choose Marcus/ }));
    expect(onActionClick).toHaveBeenCalledWith('HIRE_LEAD_GEN', undefined, {
      sourceMessageId: 'choose-agent', buttonId: 'lead', oneShot: true,
    });
  });

  it("does not say ICP approval starts execution", () => {
    render(<WidgetProvider><MessageBubble
      message={{ id: 'icp', role: 'agent', timestamp: Date.now(), content: 'Review your ICP.', metadata: {
        actionButtons: [{ id: 'approve', action: 'APPROVE_ICP', label: 'Approve ICP', type: 'primary' }],
      } }}
      actionResolution={{ status: 'selected', selectedButtonId: 'approve', outcome: 'approved' }}
    /></WidgetProvider>);
    expect(screen.getByRole('status', { name: 'ICP approved' })).toBeInTheDocument();
    expect(screen.queryByText('Approved · Starting')).not.toBeInTheDocument();
  });

  it("renders a restored lead approval without offering another execution or inventing progress", () => {
    render(<WidgetProvider><MessageBubble
      message={{ id: 'lead-review', role: 'agent', timestamp: Date.now(), content: 'Review these inputs.', metadata: {
        actionButtons: [{ id: 'approve', action: 'LEAD_AGENT_APPROVE', label: 'Approve & Execute', type: 'primary' }],
      } }}
      onActionClick={vi.fn()}
      actionResolution={{ status: 'selected', selectedButtonId: 'approve', outcome: 'approved' }}
    /></WidgetProvider>);
    expect(screen.getByRole('status', { name: 'Approved' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & Execute' })).not.toBeInTheDocument();
    expect(screen.queryByText('Approved · Starting')).not.toBeInTheDocument();
  });

  it("wraps markdown table descriptions within the conversation and replaces action emoji with real icons", () => {
    const onActionClick = vi.fn();
    const message: Message = {
      id: "agent-result",
      role: "agent",
      agentType: "lead_generation",
      timestamp: Date.now(),
      content: "| Company | Contact | Region |\n| --- | --- | --- |\n| Acme | Priya | APAC |",
      metadata: {
        actionButtons: [
          {
            id: "send-email",
            label: "📧 Send Email",
            action: "OPEN_EMAIL_MODAL",
            type: "primary",
          },
          {
            id: "send-instagram",
            label: "📸 Instagram DM",
            action: "OPEN_INSTAGRAM_DM_MODAL",
            type: "secondary",
          },
        ],
      },
    };

    const { container } = render(
      <WidgetProvider>
        <MessageBubble message={message} onActionClick={onActionClick} isLastMessage />
      </WidgetProvider>,
    );

    const table = container.querySelector("table");
    const markdownSurface = table?.closest(".prose");
    expect(markdownSurface).toHaveClass("[&_table]:table-fixed", "[&_table]:max-w-full", "[&_td]:whitespace-normal");
    expect(markdownSurface).not.toHaveClass("[&_table]:whitespace-nowrap");

    const emailButton = screen.getByRole("button", { name: "Send Email" });
    const instagramButton = screen.getByRole("button", { name: "Instagram DM" });
    expect(emailButton.querySelector("svg")).not.toBeNull();
    expect(instagramButton.querySelector("svg")).not.toBeNull();
    expect(container.textContent).not.toContain("📧");
    expect(container.textContent).not.toContain("📸");

    fireEvent.click(emailButton);
    expect(onActionClick).toHaveBeenCalledWith("OPEN_EMAIL_MODAL", undefined, {
      sourceMessageId: "agent-result",
      buttonId: "send-email",
      oneShot: false,
    });
  });

  it("uses a circular keyboard focus target for agent avatars", () => {
    const onAgentClick = vi.fn();
    render(
      <CampaignChatHeader
        agents={[
          {
            id: "lead-generation",
            name: "Marcus",
            initials: "M",
            color: "bg-emerald-500",
            avatar: "/agent-avatars/leadagent.png",
          },
        ]}
        onAgentClick={onAgentClick}
      />,
    );

    const agentButton = screen.getByRole("button", { name: "Open Marcus" });
    expect(agentButton).toHaveClass("rounded-full", "focus-visible:ring-2");
    fireEvent.click(agentButton);
    expect(onAgentClick).toHaveBeenCalledOnce();
  });

  it("announces a campaign response while it is streaming", () => {
    const message: Message = {
      id: "streaming-response",
      role: "agent",
      agentType: "orchestrator",
      timestamp: Date.now(),
      content: "I’m coordinating the next campaign steps.",
      metadata: { streaming: true },
    };

    render(
      <WidgetProvider>
        <MessageBubble message={message} isLastMessage />
      </WidgetProvider>,
    );

    expect(screen.getByLabelText("Response is streaming")).toBeInTheDocument();
    expect(screen.getByLabelText("Responding")).toBeInTheDocument();
  });
});
