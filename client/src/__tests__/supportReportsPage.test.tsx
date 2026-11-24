import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReportsPage from "@/app/dashboard/(main)/support-ai/reports/page";
import type { SupportReportData } from "@/lib/support-report";

const mocks = vi.hoisted(() => ({
  query: "tab=conversations",
  get: vi.fn(),
  workspace: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/support-ai/reports",
  useSearchParams: () => new URLSearchParams(mocks.query),
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: mocks.get },
}));
vi.mock("@/hooks/use-support-report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-support-report")>()),
  useSupportWorkspace: mocks.workspace,
}));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));
vi.mock("@/components/support/SupportConversationTranscript", () => ({
  SupportConversationTranscript: ({
    messages,
  }: {
    messages: { content: string }[];
  }) => (
    <div aria-label="Transcript">
      {messages.map((message, index) => (
        <p key={index}>{message.content}</p>
      ))}
    </div>
  ),
}));
function report(title = "Website invoice question"): SupportReportData {
  return {
    sessions: [
      {
        id: 10,
        title,
        memberName: "Customer service",
        messageCount: 2,
        leadId: null,
        leadInfo: null,
        metadata: { source: "widget" },
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:00:00Z",
      },
    ],
    leads: [],
    stats: {
      totalSessions: 26,
      widgetSessions: 20,
      totalMessages: 52,
      leadsGenerated: 0,
    },
    pagination: {
      sessions: { page: 1, limit: 25, total: 26, totalPages: 2 },
      leads: { page: 1, limit: 25, total: 0, totalPages: 0 },
    },
    filters: { teams: [], assistants: [] },
    metrics: {
      averageResponseSeconds: null,
      feedbackCount: 0,
      helpfulRate: null,
      csatCount: 0,
      satisfactionRate: null,
      handoffCount: 0,
      handoffRate: null,
      convertedLeads: 0,
      leadConversionRate: null,
    },
  };
}
function workspace(profileId = 1) {
  return {
    userId: 7,
    profileId,
    profiles: { isError: false, isLoading: false },
    ready: true,
    headers: { "X-Business-Profile-Id": String(profileId) },
  };
}
function mount() {
  window.history.replaceState(
    {
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: ["support-tree"],
      custom: "preserved",
    },
    "",
    `/dashboard/support-ai/reports${mocks.query ? `?${mocks.query}` : ""}`,
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ReportsPage />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderPage: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <ReportsPage />
        </QueryClientProvider>,
      ),
  };
}
beforeEach(() => {
  mocks.query = "tab=conversations";
  mocks.workspace.mockReturnValue(workspace());
  const nativeReplaceState = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, "replaceState").mockImplementation(
    (state, unused, url) => {
      // Simulate Next's native-history integration while retaining its markers.
      const current = window.history.state;
      const applied = {
        ...state,
        ...(current?.__NA
          ? {
              __NA: current.__NA,
              __PRIVATE_NEXTJS_INTERNALS_TREE:
                current.__PRIVATE_NEXTJS_INTERNALS_TREE,
            }
          : {}),
      };
      nativeReplaceState(applied, unused, url);
      mocks.query = window.location.search.slice(1);
    },
  );
  mocks.get.mockResolvedValue(report());
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("support reports", () => {
  it('describes recorded ai_active ownership without claiming internal chat readiness', async () => {
    mocks.query = 'source=internal&tab=conversations&sessionId=88';
    const value = report('Synthetic internal QA session');
    value.sessions[0] = { ...value.sessions[0], id: 88, metadata: { source: 'internal' }, automationMode: 'ai_active' };
    const detail = { ...value.sessions[0], messages: [{ id: 400, role: 'assistant', content: 'Historical failed reply', createdAt: '2026-10-01T10:00:00Z' }] };
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/88') ? detail : value);
    mount();
    expect(await screen.findByText('No human takeover')).toBeVisible();
    expect(screen.queryByText('Assistant active')).not.toBeInTheDocument();
    expect(screen.getByText(/Recorded handoff status does not verify AI reply readiness/)).toHaveTextContent('Replies require an enabled runtime and a ready, published assistant assigned to the account.');
    expect(await screen.findByText('Historical failed reply')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Conversation source' })).toHaveValue('internal');
    expect(mocks.get).toHaveBeenCalledWith('/api/support/ai/report', expect.objectContaining({ params: expect.objectContaining({ source: 'internal' }), headers: { 'X-Business-Profile-Id': '1' } }));
    expect(mocks.get.mock.calls.every(([url]) => url === '/api/support/ai/report' || url === '/api/support/ai/sessions/88')).toBe(true);
    expect(value.sessions[0].automationMode).toBe('ai_active');
  });

  it.each([
    ['human_owned', null, 'Human support active'],
    ['human_paused', null, 'Assistant paused for human support'],
    ['approval_pending', null, 'Awaiting staff approval'],
    ['resolved', null, 'Conversation closed'],
    ['closed', null, 'Conversation closed'],
    ['opted_out', null, 'Customer opted out'],
    ['ai_active', 367, 'Support ticket linked'],
    ['unrecognized', null, 'Recorded support status'],
  ] as const)('preserves recorded handoff status and ticket links for %s', async (automationMode, ticketId, label) => {
    mocks.query = 'tab=conversations&sessionId=10';
    const value = report();
    value.sessions[0] = { ...value.sessions[0], automationMode, ticketId };
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/10') ? { ...value.sessions[0], messages: [] } : value);
    mount();
    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.getByText(/Recorded handoff status does not verify AI reply readiness/)).toBeVisible();
    if (ticketId) expect(screen.getByRole('link', { name: /Open support ticket/ })).toHaveAttribute('href', '/dashboard/support/367');
  });

  it('preserves edited dates through refresh, rejection, retry and remount', async () => {
    const view = mount();
    await screen.findByRole('button', { name: 'Open conversation: Website invoice question' });
    expect(mocks.get.mock.calls[0][1].params.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mocks.get.mock.calls[0][1].params).not.toHaveProperty('teamId');
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-10-05' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    // Exhaust the one bounded query retry, then recover explicitly.
    mocks.get.mockRejectedValue(new Error('Report unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Refresh failed — showing the last loaded results');
    expect(screen.getByLabelText('From date')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To date')).toHaveValue('2026-10-05');
    mocks.get.mockResolvedValue(report());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Refresh failed — showing the last loaded results')).toBeNull());
    expect(mocks.get).toHaveBeenLastCalledWith('/api/support/ai/report', expect.objectContaining({ params: expect.objectContaining({ from: '2026-09-01', to: '2026-10-05' }) }));
    view.unmount();
    mount();
    expect(screen.getByLabelText('From date')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To date')).toHaveValue('2026-10-05');
  });
  it('does not request a reversed date range and preserves it for correction', async () => {
    mocks.query = 'from=2026-10-05&to=2026-09-01';
    mount();
    expect(await screen.findByText('From date must be on or before To date.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("merges rapid filter changes without losing selected tab or existing search", async () => {
    mocks.query =
      "tab=conversations&sessionSearch=invoice&sessionPage=3&leadPage=2";
    const view = mount();
    await screen.findByRole("button", {
      name: "Open conversation: Website invoice question",
    });
    fireEvent.change(screen.getByLabelText("From date"), {
      target: { value: "2026-09-01" },
    });
    const firstQuery = mocks.query;
    // A delayed render of the first URL must not overwrite a later edit.
    fireEvent.change(
      screen.getByRole("combobox", { name: "Conversation source" }),
      { target: { value: "widget" } },
    );
    mocks.query = firstQuery;
    view.rerenderPage();
    fireEvent.change(screen.getByLabelText("To date"), {
      target: { value: "2026-10-03" },
    });
    view.rerenderPage();
    const query = new URLSearchParams(window.location.search);
    expect(query.get("from")).toBe("2026-09-01");
    expect(query.get("to")).toBe("2026-10-03");
    expect(query.get("source")).toBe("widget");
    expect(query.get("tab")).toBe("conversations");
    expect(query.get("sessionSearch")).toBe("invoice");
    expect(query.has("sessionPage")).toBe(false);
    expect(query.has("leadPage")).toBe(false);
    expect(window.history.state).toEqual({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: ["support-tree"],
      custom: "preserved",
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(
      vi.mocked(window.history.replaceState).mock.calls.at(-1)?.[0],
    ).not.toHaveProperty("__NA");
    await waitFor(() =>
      expect(
        mocks.get.mock.calls.some(
          ([, options]) =>
            options.params?.from === "2026-09-01" &&
            options.params?.to === "2026-10-03" &&
            options.params?.source === "widget",
        ),
      ).toBe(true),
    );
  });
  it("requests server pages and debounces search across the full dataset", async () => {
    const view = mount();
    await screen.findByRole("button", {
      name: "Open conversation: Website invoice question",
    });
    expect(mocks.get.mock.calls[0][1].params).toMatchObject({
      sessionPage: 1,
      leadPage: 1,
      limit: 25,
    });
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search conversations" }),
      { target: { value: "invoice" } },
    );
    view.rerenderPage();
    expect(
      mocks.get.mock.calls.filter(
        ([, options]) => options.params?.sessionSearch === "invoice",
      ),
    ).toHaveLength(0);
    await waitFor(() =>
      expect(
        mocks.get.mock.calls.some(
          ([, options]) => options.params?.sessionSearch === "invoice",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    view.rerenderPage();
    await waitFor(() =>
      expect(
        mocks.get.mock.calls.some(
          ([, options]) => options.params?.sessionPage === 2,
        ),
      ).toBe(true),
    );
    expect(mocks.query).toContain("sessionSearch=invoice");
    expect(mocks.query).toContain("sessionPage=2");
  });
  it("restores a selected conversation even when it is outside the loaded list", async () => {
    mocks.query = "tab=conversations&sessionId=999&sessionPage=4";
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/999")
          ? {
              ...report("Older customer request").sessions[0],
              id: 999,
              messages: [
                {
                  id: 400,
                  role: "assistant",
                  content: "Restored reply from the older conversation",
                  createdAt: "2026-10-01T10:00:00Z",
                },
              ],
            }
          : report(),
      ),
    );
    mount();
    expect(
      await screen.findByText("Restored reply from the older conversation"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Older customer request" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Back to conversations" }),
    ).toBeInTheDocument();
    expect(
      mocks.get.mock.calls.find(([url]) => url.endsWith("/999"))?.[1].headers,
    ).toEqual({ "X-Business-Profile-Id": "1" });
  });
  it("opens captured leads through the virtual lead contact route", async () => {
    mocks.query = "tab=leads";
    const value = report();
    value.leads = [
      {
        id: 77,
        name: "Captured visitor",
        email: "visitor@example.com",
        phone: null,
        source: "support_widget",
        status: "new",
        createdAt: "2026-10-01T10:00:00Z",
      },
    ];
    value.pagination.leads = { page: 1, limit: 25, total: 1, totalPages: 1 };
    mocks.get.mockResolvedValue(value);
    mount();
    const links = await screen.findAllByRole("link", { name: /View contact/ });
    for (const link of links)
      expect(link).toHaveAttribute("href", "/dashboard/crm/contacts/-77");
  });
  it("clears selected sessions before fetching for a changed business", async () => {
    mocks.query = "tab=conversations&sessionId=999&teamId=22&assistantId=old";
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/999")
          ? { ...report().sessions[0], id: 999, messages: [] }
          : report(),
      ),
    );
    const view = mount();
    await screen.findByRole("heading", { name: "Website invoice question" });
    const count = mocks.get.mock.calls.length;
    mocks.workspace.mockReturnValue(workspace(2));
    view.rerenderPage();
    await waitFor(() =>
      expect(mocks.get.mock.calls.length).toBeGreaterThan(count),
    );
    for (const [url, options] of mocks.get.mock.calls.slice(count)) {
      expect(url).not.toContain("/999");
      expect(options.params).not.toHaveProperty('teamId');
      expect(options.params).not.toHaveProperty('assistantId');
    }
    expect(mocks.query).not.toContain("sessionId");
  });
  it("never shows the previous business results while a new business is loading", async () => {
    let resolveNew: (value: SupportReportData) => void = () => {};
    const pending = new Promise<SupportReportData>((resolve) => {
      resolveNew = resolve;
    });
    const view = mount();
    await screen.findByRole("button", {
      name: "Open conversation: Website invoice question",
    });
    mocks.workspace.mockReturnValue(workspace(2));
    mocks.get.mockReturnValue(pending);
    view.rerenderPage();
    expect(
      screen.queryByText("Website invoice question"),
    ).not.toBeInTheDocument();
    await act(async () => {
      resolveNew(report("Second business request"));
    });
    expect(
      await screen.findByRole("button", {
        name: "Open conversation: Second business request",
      }),
    ).toBeInTheDocument();
    expect(mocks.get.mock.calls.at(-1)?.[1].headers).toEqual({
      "X-Business-Profile-Id": "2",
    });
  });
});
