import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebsiteCrawlWidget } from "@/components/widgets/WebsiteCrawlWidget";
import { WidgetErrorBoundary } from "@/components/widgets/WidgetErrorBoundary";
import type { WidgetState } from "@/components/widgets/types";
import { ToolApprovalDialog } from "@/components/ToolApprovalDialog";

const websiteWidget: WidgetState = {
  id: 133,
  threadId: 133,
  messageId: 9,
  toolName: "crawl_website",
  widgetType: "website_crawl",
  formValues: { url: "https://example.com", extract_focus: "" },
  status: "active",
  agentType: "icp_generation",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("campaign widget review surface", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the website crawl auto-detect option without an empty SelectItem value", () => {
    const onFormChange = vi.fn();

    expect(() => render(
      <WebsiteCrawlWidget
        widget={websiteWidget}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        onFormChange={onFormChange}
      />,
    )).not.toThrow();

    expect(screen.getByText("Auto-detect (all pages)")).toBeInTheDocument();
    expect(onFormChange).toHaveBeenCalledWith({
      url: "https://example.com",
      extract_focus: "",
    });
  });

  it("contains a dynamic widget failure inside the task card boundary", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    function BrokenWidget(): React.ReactNode {
      throw new Error("Malformed widget data");
    }

    render(
      <div>
        <p>Conversation remains available</p>
        <WidgetErrorBoundary title="Analyze Website needs attention">
          <BrokenWidget />
        </WidgetErrorBoundary>
      </div>,
    );

    expect(screen.getByText("Conversation remains available")).toBeInTheDocument();
    expect(screen.getByText("Analyze Website needs attention")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry task" })).toBeInTheDocument();
  });

  it("keeps the error recovery control keyboard and click reachable", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldFail = true;

    function RecoverableWidget() {
      if (shouldFail) throw new Error("Temporary render error");
      return <p>Task restored</p>;
    }

    render(
      <WidgetErrorBoundary>
        <RecoverableWidget />
      </WidgetErrorBoundary>,
    );

    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry task" }));
    expect(screen.getByText("Task restored")).toBeInTheDocument();
  });

  it("presents tool approval as a compact non-modal card", () => {
    const onOpenChange = vi.fn();
    render(
      <ToolApprovalDialog
        open
        onOpenChange={onOpenChange}
        approvalData={{
          toolName: "custom_agent_action",
          toolDescription: "Review the generated operation.",
          parameters: { recordCount: 3 },
        }}
        isApproving={false}
        onApproval={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Approval required" })).toHaveClass("sm:w-[28rem]");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss approval" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the exact campaign proposal delivery before approval", () => {
    const onApproval = vi.fn();
    render(
      <ToolApprovalDialog
        open
        onOpenChange={vi.fn()}
        approvalData={{
          toolName: "send_proposal",
          parameters: {
            proposalId: 44,
            proposalTitle: "Customer growth program",
            proposalNumber: "PROP-0044",
            expectedRevision: 3,
            channel: "email",
            resolvedRecipient: "asha@example.test",
            currency: "USD",
            total: 2400,
            providerAccountId: "seller@example.test",
            providerVariant: "gmail",
            subject: "Proposal: Customer growth program",
            message: "Please review the agreed scope.",
            reviewUrl: "/dashboard/proposals/44",
          },
        }}
        isApproving={false}
        onApproval={onApproval}
      />,
    );

    const review = screen.getByRole("region", { name: "Approval required" });
    expect(review).toHaveClass("[&_button]:min-h-10");
    expect(screen.getByRole("heading", { name: "Send Proposal" })).toBeInTheDocument();
    expect(screen.getByText("Customer growth program")).toBeInTheDocument();
    expect(screen.getByText("PROP-0044 · revision 3")).toBeInTheDocument();
    expect(screen.getByText("asha@example.test")).toBeInTheDocument();
    expect(screen.getByText(/2,400\.00/)).toBeInTheDocument();
    expect(screen.getByText("seller@example.test")).toBeInTheDocument();
    expect(screen.getByText("Proposal: Customer growth program")).toBeInTheDocument();
    expect(screen.getByText("Please review the agreed scope.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open full proposal" })).toHaveAttribute("href", "/dashboard/proposals/44");
    expect(screen.getByText(/Approval is bound to this exact proposal revision/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve delivery" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApproval).toHaveBeenNthCalledWith(1, true, undefined);
    expect(onApproval).toHaveBeenNthCalledWith(2, false, undefined);
  });
});
