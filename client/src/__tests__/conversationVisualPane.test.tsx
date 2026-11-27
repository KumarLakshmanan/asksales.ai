import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import ChromeTabs, { type Tab } from "@/components/ChromeTabs";
import ResizablePanel from "@/components/ResizablePanel";
import SearchTab from "@/components/tabs/SearchTab";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
});

const tabs: Tab[] = [
  { id: "overview", type: "overview", label: "Overview", closeable: false },
  { id: "leads", type: "leads", label: "Leads" },
  { id: "analytics", type: "analytics", label: "Analytics" },
];

describe("Conversation visual pane navigation", () => {
  it("exposes tabs with roving keyboard navigation and labelled controls", () => {
    const onTabClick = vi.fn();
    const onTabClose = vi.fn();
    const onMinimize = vi.fn();

    render(
      <ChromeTabs
        tabs={tabs}
        activeTab="overview"
        onTabClick={onTabClick}
        onTabClose={onTabClose}
        onAddTab={vi.fn()}
        onMinimize={onMinimize}
      />,
    );

    expect(screen.getByRole("tablist", { name: "Conversation result views" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Add result view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Minimize result panel" })).toHaveAttribute(
      "aria-controls",
      "conversation-result-panel",
    );
    expect(screen.getByRole("button", { name: "Close Leads tab" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Minimize result panel" }));
    expect(onMinimize).toHaveBeenCalledOnce();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowRight" });
    expect(onTabClick).toHaveBeenCalledWith("leads");
    expect(screen.getByRole("tab", { name: "Leads" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Leads" }), { key: "Delete" });
    expect(onTabClose).toHaveBeenCalledWith("leads");
  });

  it("offers keyboard resizing and a truthful collapse control", () => {
    const onOpenChange = vi.fn();
    render(
      <ResizablePanel
        position="left"
        defaultWidth={320}
        minWidth={300}
        maxWidth={500}
        onOpenChange={onOpenChange}
      >
        <p>Chat content</p>
      </ResizablePanel>,
    );

    const separator = screen.getByRole("separator", { name: "Resize left panel" });
    expect(separator).toHaveAttribute("aria-valuenow", "320");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "330");

    fireEvent.click(screen.getByRole("button", { name: "Close left panel" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "Open left panel" })).toBeInTheDocument();
  });

  it("removes resize controls when the companion panel is hidden", () => {
    render(
      <ResizablePanel position="left" resizable={false}>
        <p>Full-width chat content</p>
      </ResizablePanel>,
    );

    expect(screen.queryByRole("separator", { name: "Resize left panel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /left panel/i })).not.toBeInTheDocument();
    expect(screen.getByText("Full-width chat content")).toBeInTheDocument();
  });

  it("routes every searchable workspace to a canonical tab type without nested buttons", () => {
    const onAddTab = vi.fn();
    const { container } = render(<SearchTab onAddTab={onAddTab} />);

    fireEvent.click(screen.getByRole("button", { name: /Search Settings/i }));
    expect(onAddTab).toHaveBeenCalledWith("lead-inputs");
    expect(screen.queryByRole("button", { name: /Lead Config/i })).not.toBeInTheDocument();

    for (const label of ["CRM", "Support", "Proposals"]) {
      expect(screen.getByRole("button", { name: new RegExp(label, "i") })).toBeInTheDocument();
    }

    expect(container.querySelector("button button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Content Studio" }));
    expect(onAddTab).toHaveBeenCalledWith("content-studio");
  });
});
