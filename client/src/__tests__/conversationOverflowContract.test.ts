import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readClientSource = (path: string) =>
  // LF text, so the contracts also hold on Windows (CRLF) checkouts.
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");

describe("conversation overflow containment", () => {
  it("forces the vertical message viewport to follow the split-pane width", () => {
    const chatInterface = readClientSource("src/components/ChatInterface.tsx");

    expect(chatInterface).toContain(
      'className="min-h-0 min-w-0 max-w-full flex-1 overflow-clip bg-background"',
    );
    expect(chatInterface).toContain(
      'viewportClassName="absolute inset-0 box-border max-w-full touch-pan-y overscroll-contain overflow-x-hidden px-6 py-5 [&>div]:!block [&>div]:min-w-0 [&>div]:max-w-full"',
    );
    expect(chatInterface).toContain(
      'className="mx-auto w-full min-w-0 max-w-3xl space-y-6"',
    );
  });

  it("keeps a live response pinned while its rendered height changes", () => {
    const chatInterface = readClientSource("src/components/ChatInterface.tsx");

    expect(chatInterface).toContain("messages.at(-1)?.role === 'user'");
    expect(chatInterface).toContain("new ResizeObserver");
    expect(chatInterface).toContain("observer.observe(list)");
    expect(chatInterface).toContain("[isProcessing, messages, pinMessagesToBottom, toolLogs]");
  });

  it("keeps spacing inside a pinned viewport and makes the root non-scrollable", () => {
    const chatInterface = readClientSource("src/components/ChatInterface.tsx");

    expect(chatInterface).not.toContain(
      'flex-1 overflow-x-hidden bg-background px-6 py-5',
    );
    expect(chatInterface).toContain(
      'viewportClassName="absolute inset-0 box-border max-w-full touch-pan-y overscroll-contain overflow-x-hidden px-6 py-5',
    );
    expect(chatInterface).toContain('flex-1 overflow-clip bg-background');
    expect(chatInterface).not.toContain('flex-1 overflow-x-hidden bg-background');
    expect(chatInterface).toContain('flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden');
  });

  it("uses the dashboard sidebar as the only campaign-history navigation", () => {
    const chatInterface = readClientSource("src/components/ChatInterface.tsx");
    const conversationPage = readClientSource(
      "src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx",
    );

    expect(chatInterface).not.toContain("ChatHistoryDrawer");
    expect(chatInterface).not.toContain("Open campaign history");
    expect(chatInterface).not.toContain("onHistoryClick");
    expect(conversationPage).not.toContain("onThreadSelect={handleThreadSelect}");
    expect(conversationPage).not.toContain("onNewThread={handleNewThread}");
  });

  it("keeps both resizable siblings from leaking intrinsic width", () => {
    const panel = readClientSource("src/components/ResizablePanel.tsx");
    const conversationPage = readClientSource(
      "src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx",
    );

    expect(panel).toContain("group/panel relative min-w-0 max-w-full");
    expect(panel).toContain("h-full min-w-0 max-w-full overflow-hidden");
    expect(conversationPage).toContain(
      "min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-border bg-card",
    );
    expect(conversationPage).not.toContain("max-md:!h-[45%]");
    expect(conversationPage).toContain('aria-label="Conversation workspace pane"');
    expect(conversationPage).toContain("asksales:conversation-chat-width:v3");
    expect(panel).toContain("rawStored === null ? Number.NaN : Number(rawStored)");
    expect(panel).toContain("clampWidth(defaultWidth)");
    expect(panel).not.toContain("if (nextWidth !== currentWidth) persistWidth(nextWidth)");
    expect(conversationPage).toContain("const compact = width < 900;");
    expect(conversationPage).toContain("if (compact) {\n        setChatPanelOpen(true);\n        return;");
    expect(conversationPage).toContain("new ResizeObserver");
  });

  it("stacks the lead empty-state actions while the result pane is narrow", () => {
    const leadsTab = readClientSource("src/components/tabs/LeadsTab.tsx");

    const emptyState = leadsTab.slice(leadsTab.indexOf(') : leads.length === 0 ? ('), leadsTab.indexOf('{(displayProgress?.platforms || []).map'));
    expect(emptyState).toContain('flex min-w-0 flex-col gap-6');
    expect(emptyState).toContain('flex min-w-0 flex-col items-start gap-3');
    expect(emptyState).toContain('flex min-w-0 flex-wrap items-center gap-3 self-start');
    expect(emptyState).not.toMatch(/(?:xl|lg|md):flex-row/);
    expect(emptyState).toContain('Add Lead Manually');
    expect(emptyState).toContain('Import CSV/Excel');
  });

  it("wraps approval actions without shrinking button content", () => {
    const widgetCard = readClientSource(
      "src/components/widgets/InlineWidgetCard.tsx",
    );

    expect(widgetCard).toContain(
      'className="flex flex-col items-stretch gap-3 border-t border-border p-3 @md/review:flex-row @md/review:items-center @md/review:px-5"',
    );
    expect(widgetCard).toContain(
      'className="grid w-full min-w-0 grid-cols-1 gap-2 @xs/review:grid-cols-2 @md/review:ml-auto @md/review:w-auto"',
    );
    expect(widgetCard).toContain("min-w-0 whitespace-nowrap");
  });

  it("contains long provider errors inside the lead result pane", () => {
    const leadsTab = readClientSource("src/components/tabs/LeadsTab.tsx");

    expect(leadsTab).toContain(
      "flex min-w-0 flex-col items-center space-y-4 overflow-hidden",
    );
    expect(leadsTab).toContain(
      "w-full break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]",
    );
    expect(leadsTab).not.toContain(
      'className="text-sm text-muted-foreground max-w-sm leading-relaxed"',
    );
  });

  it("gives campaign charts a non-negative initial size during pane switches", () => {
    const campaignDashboard = readClientSource(
      "src/components/CampaignDashboardView.tsx",
    );

    expect(
      campaignDashboard.match(
        /minWidth=\{0\} initialDimension=\{\{ width: 1, height: 1 \}\}/g,
      ) ?? [],
    ).toHaveLength(4);
  });

  it("keeps outreach conversations inside the dashboard viewport", () => {
    const dashboardLayout = readClientSource("src/components/DashboardLayout.tsx");
    const inbox = readClientSource("src/components/outreach/inbox/OutreachInbox.tsx");

    expect(dashboardLayout).toContain("usesFixedOutreachWorkspace");
    expect(dashboardLayout).toContain("usesFixedConversationWorkspace");
    expect(dashboardLayout).toContain(
      'usesFixedWorkspace ? "overflow-y-hidden" : "overflow-y-auto"',
    );
    expect(dashboardLayout).toContain("ref={mainContentRef}");
    expect(dashboardLayout).toContain("mainContent.scrollTop = 0");
    expect(dashboardLayout).toContain(
      "requestAnimationFrame(resetWorkspaceScroll)",
    );

    expect(inbox).toContain("h-full min-h-0");
    expect(inbox).toContain("overflow-y-auto overscroll-contain");
    expect(inbox).not.toContain('h-[calc(100vh-64px)]');
    expect(inbox).not.toContain('h-[calc(100svh-64px)]');

  });

  it("keeps message auto-scroll inside the nearest outreach viewport", () => {
    const inbox = readClientSource("src/components/outreach/inbox/OutreachInbox.tsx");
    expect(inbox).toContain("timeline.current.scrollTop = timeline.current.scrollHeight");
    expect(inbox).not.toContain("scrollIntoView(");

  });
});
