import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QualityPage from "@/app/dashboard/(main)/support-ai/quality/page";
import type { SupportQualityData } from "@/lib/support-report";
const mocks = vi.hoisted(() => ({
  query: "",
  get: vi.fn(),
  put: vi.fn(),
  workspace: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/support-ai/quality",
  useSearchParams: () => new URLSearchParams(mocks.query),
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: mocks.get, put: mocks.put },
}));
vi.mock("@/hooks/use-support-report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-support-report")>()),
  useSupportWorkspace: mocks.workspace,
}));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/support/SupportConversationTranscript", () => ({
  SupportConversationTranscript: ({
    messages,
  }: {
    messages: { content: string }[];
  }) => (
    <div>
      {messages.map((message, index) => (
        <p key={index}>{message.content}</p>
      ))}
    </div>
  ),
}));
const data: SupportQualityData = {
  items: [
    {
      messageId: 80,
      sessionId: 42,
      sessionTitle: "Shipping question",
      question: "When does delivery arrive?",
      answer: "Within one day",
      sources: [],
      confidence: null,
      createdAt: "2026-10-01T10:00:00Z",
      teamName: "Customer service",
      feedback: {
        rating: "needs_review",
        reason: "outdated",
        notes: "Check delivery policy",
        status: "open",
        updatedAt: "2026-10-01T11:00:00Z",
      },
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  summary: { open: 1, reviewed: 0, helpful: 0 },
  filters: { teams: [], assistants: [] },
};
function mount() {
  window.history.replaceState(
    {
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: ["support-tree"],
      custom: "preserved",
    },
    "",
    `/dashboard/support-ai/quality${mocks.query ? `?${mocks.query}` : ""}`,
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <QualityPage />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.query = "";
  mocks.workspace.mockReturnValue({
    userId: 7,
    profileId: 10,
    profiles: { isError: false },
    ready: true,
    headers: { "X-Business-Profile-Id": "10" },
  });
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
  mocks.get.mockResolvedValue(data);
  mocks.put.mockResolvedValue({});
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
describe("answer quality review", () => {
  it("saves the review reason and notes to the selected business", async () => {
    mount();
    await screen.findByText("When does delivery arrive?");
    expect(mocks.get.mock.calls[0][1].params).toMatchObject({
      status: "open",
      page: 1,
      limit: 25,
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Correction reason for answer 80" }),
      { target: { value: "missing_information" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Review notes for answer 80" }),
      {
        target: { value: "Added delivery regions and updated transit times." },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith(
        "/api/support/ai/messages/80/feedback",
        {
          rating: "needs_review",
          reason: "missing_information",
          notes: "Added delivery regions and updated transit times.",
          status: "reviewed",
        },
        { headers: { "X-Business-Profile-Id": "10" } },
      ),
    );
    expect(
      screen.getByRole("link", { name: "Improve knowledge" }),
    ).toHaveAttribute("href", "/dashboard/knowledge-base");
    expect(
      screen.getByRole("link", { name: "Full conversation" }),
    ).toHaveAttribute(
      "href",
      "/dashboard/support-ai/reports?tab=conversations&sessionId=42",
    );
  });
  it("keeps a failed save visible and lets the user retry without losing notes", async () => {
    mocks.put.mockRejectedValue(new Error("The review could not be stored"));
    mount();
    await screen.findByRole("button", { name: "Mark reviewed" });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Review notes for answer 80" }),
      { target: { value: "Keep this correction" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(
      await screen.findByText("The review could not be stored"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Review notes for answer 80" }),
    ).toHaveValue("Keep this correction");
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeEnabled();
  });
});
