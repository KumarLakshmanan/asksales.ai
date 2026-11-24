import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationActivityGroup } from "@/components/conversation/ConversationActivityGroup";
import { ConversationComposer } from "@/components/conversation/ConversationComposer";
import { ConversationMessageFrame } from "@/components/conversation/ConversationMessageFrame";
import { DraftRecommendationCard } from "@/components/conversation/DraftRecommendationCard";
import { InlineApprovalCard } from "@/components/conversation/InlineApprovalCard";
import { SourceTray } from "@/components/conversation/SourceTray";
import { ToolCallChip } from "@/components/conversation/ToolCallChip";
import { StreamingText } from "@/components/conversation/StreamingText";
import { getChannelCapabilities } from "@/components/outreach/channel-capabilities";

describe("AI-native conversation primitives", () => {
  it("renders a labelled assistant message surface", () => {
    render(
      <ConversationMessageFrame role="assistant" surface="support" name="Support Assistant" timestamp="just now">
        A grounded answer
      </ConversationMessageFrame>,
    );

    expect(screen.getByRole("listitem")).toHaveAttribute("data-conversation-surface", "support");
    expect(screen.getByText("Support Assistant")).toBeInTheDocument();
    expect(screen.getByText("A grounded answer")).toBeInTheDocument();
  });

  it("expands agent activity and exposes individual task states", () => {
    render(
      <ConversationActivityGroup
        agentName="Marcus"
        label="Building the lead list"
        status="running"
        steps={[
          { id: "search", label: "Searching LinkedIn", status: "completed" },
          { id: "score", label: "Scoring lead fit", status: "running" },
        ]}
      />,
    );

    expect(screen.getByText("Searching LinkedIn")).toBeInTheDocument();
    expect(screen.getByText("Scoring lead fit")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Marcus Building the lead list/i }));
    expect(screen.queryByText("Searching LinkedIn")).toBeNull();
  });

  it("keeps tool details collapsed until requested", () => {
    render(
      <ToolCallChip label="Generate ICP" status="completed" agentName="Coordinator" detail="completed">
        <p>Tool parameters</p>
      </ToolCallChip>,
    );

    expect(screen.queryByText("Tool parameters")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Generate ICP/i }));
    expect(screen.getByText("Tool parameters")).toBeInTheDocument();
  });

  it("presents grounding quality and expandable evidence", () => {
    render(
      <SourceTray
        confidence={0.91}
        sources={[{ id: 1, title: "Returns policy", excerpt: "Returns are accepted for 30 days.", similarity: 0.94 }]}
      />,
    );

    expect(screen.getByText("High grounding")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /1 Source/i }));
    expect(screen.getByText("Returns policy")).toBeInTheDocument();
  });

  it("submits inline approval choices", () => {
    const onSelect = vi.fn();
    render(
      <InlineApprovalCard
        title="Start outreach?"
        options={[
          { id: "approve", label: "Approve", tone: "primary" },
          { id: "revise", label: "Revise" },
        ]}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onSelect).toHaveBeenCalledWith("approve");
  });

  it("renders AI drafts as reviewable recommendations", () => {
    const onSend = vi.fn();
    render(
      <DraftRecommendationCard channel="linkedin" onSend={onSend}>
        Hello from AskSales
      </DraftRecommendationCard>,
    );

    expect(screen.getByText("Review before sending")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("keeps the composer controlled and disables empty sends", () => {
    const onValueChange = vi.fn();
    const onSend = vi.fn();
    render(
      <ConversationComposer value="" onValueChange={onValueChange} onSend={onSend} sendDisabled />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
    expect(onValueChange).toHaveBeenCalledWith("Hello");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("announces an active streaming response", () => {
    render(<StreamingText active>Partial response</StreamingText>);

    expect(screen.getByText("Partial response")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Response is streaming")).toBeInTheDocument();
  });

  it("keeps outreach constraints channel-specific", () => {
    expect(getChannelCapabilities("email")).toMatchObject({ supportsSubject: true, supportsAttachments: true });
    expect(getChannelCapabilities("sms")).toMatchObject({ supportsSubject: false, supportsAttachments: false, sendHint: "SMS segment estimate" });
    // Multi-segment SMS uses encoding-aware estimates instead of a 160-character cap.
    expect(getChannelCapabilities("sms").characterLimit).toBeUndefined();
    expect(getChannelCapabilities("whatsapp").characterLimit).toBe(4096);
    expect(getChannelCapabilities("linkedin").placeholder).toContain("LinkedIn");
  });
});
