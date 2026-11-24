import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupportPage from "@/app/dashboard/(main)/support/page";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/api", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/hooks/use-support-realtime-refresh", () => ({ useSupportRealtimeRefresh: () => ({ isRealtimeConnected: false }) }));

function ticket(id: number, fields = {}) {
  return { id, ticketNumber: `TKT-UX005-${id}`, subject: "Classification unavailable", description: "Invoice needs correcting",
    status: "open", priority: "high", customerName: "Example customer", channel: "web", unreadCount: 1,
    updatedAt: "2026-10-09T12:00:00Z", slaDeadline: "2026-10-01T12:00:00Z", ownershipMode: "human_owned",
    handoffReason: "Intent and risk classification is unavailable.", aiReplyEnabled: false,
    lastMessagePreview: "An automated acknowledgement", lastMessageDirection: "outbound", ...fields };
}

function mockQueue(tickets: ReturnType<typeof ticket>[]) {
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes("/analytics") ? null : { tickets, total: tickets.length, totalPages: 1 }));
}

describe("support queue presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/dashboard/support");
    mockQueue([]);
  });

  it('keeps automation ownership distinct from actual assistant readiness on the board', async () => {
    mockQueue([ticket(367, { subject: 'Synthetic resolved ticket', ownershipMode: 'ai_active', aiReplyEnabled: true,
      handoffId: null, handoffReason: null, status: 'resolved' })]);
    render(<SupportPage />);
    await screen.findByRole('heading', { name: 'Synthetic resolved ticket' });
    expect(screen.getByText('No human takeover', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('AI active', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText(/Ownership does not verify AI reply readiness/)).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('retains the canonical ownership filter value with the truthful visible label', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    mockQueue([ticket(1)]);
    render(<SupportPage />);
    await screen.findByRole('heading', { name: 'Invoice needs correcting' });
    screen.getByRole('combobox', { name: 'Ownership' }).focus();
    await userEvent.keyboard('[Space]');
    (await screen.findByRole('option', { name: 'No human takeover' })).focus();
    await userEvent.keyboard('[Enter]');
    await waitFor(() => expect(mocks.get.mock.calls.some(([path]) => String(path).includes('ownership=ai_active'))).toBe(true));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("distinguishes requests during classification unavailability and retains operational cues", async () => {
    mockQueue([ticket(1), ticket(2, { description: "Move my booking to Friday" })]);
    render(<SupportPage />);
    expect(await screen.findByRole("heading", { name: "Invoice needs correcting" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Move my booking to Friday" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Classification unavailable" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Classification unavailable", { exact: true })).toHaveLength(2);
    expect(screen.getAllByText(/Automatic classification could not assess this request/)).toHaveLength(2);
    expect(screen.getAllByText("Human owned", { exact: true })).toHaveLength(2);
    expect(screen.getAllByText(/overdue/)).toHaveLength(2);
    expect(screen.getAllByText("1 unread")).toHaveLength(2);
  });

  it("keeps actual and long subjects as headlines even with a classification notice", async () => {
    const subject = "Booking change ".repeat(30).trim();
    mockQueue([ticket(1, { subject })]);
    render(<SupportPage />);
    const heading = await screen.findByRole("heading", { name: subject });
    expect(heading).toHaveAttribute("title", subject);
    expect(screen.getByText("Classification unavailable", { exact: true })).toBeInTheDocument();
  });

  it("does not add classification status to ordinary tickets", async () => {
    mockQueue([ticket(1, { subject: "Invoice question", handoffReason: null })]);
    render(<SupportPage />);
    expect(await screen.findByRole("heading", { name: "Invoice question" })).toBeInTheDocument();
    expect(screen.queryByText("Classification unavailable", { exact: true })).not.toBeInTheDocument();
  });

  it("uses concise plain text for missing subjects and avoids outbound or internal message headlines", async () => {
    mockQueue([
      ticket(1, { subject: " ", description: "  Please\n change\t my booking  " }),
      ticket(2, { subject: null, description: null, lastMessageDirection: "inbound", lastMessagePreview: "Where is my invoice?" }),
      ticket(3, { description: null }),
      ticket(4, { description: null, lastMessageDirection: "inbound", lastMessageInternal: true, lastMessagePreview: "Internal operational note" }),
      ticket(5, { description: "A".repeat(250) }),
      ticket(6, { description: '<img src=x onerror="alert(1)"> Invoice question' }),
    ]);
    const { container } = render(<SupportPage />);
    expect(await screen.findByRole("heading", { name: "Please change my booking" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where is my invoice?" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Support request · TKT-UX005-3" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Support request · TKT-UX005-4" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: `${"A".repeat(139)}…` })).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it.each(["Enter", " "])("clears search and all active filters using %s, preserving sort and page size", async (key) => {
    window.history.replaceState(null, "", "/dashboard/support?search=zzqa-no-match-20261009&status=open&priority=high&channel=email&ownership=human_owned&sla=breached&unread=true&sort=updated&limit=50&page=2");
    mocks.get.mockImplementation((path: string) => {
      if (path.includes("/analytics")) return Promise.resolve(null);
      const query = new URL(path, "http://localhost").searchParams;
      const tickets = query.has("search") || query.has("status") ? [] : [ticket(1)];
      return Promise.resolve({ tickets, total: tickets.length, totalPages: 1 });
    });
    render(<SupportPage />);
    // Initial search debounce resets page 2 to page 1 and briefly replaces the
    // empty-state node with the loader. Query the settled, attached status.
    await waitFor(() => expect(window.location.search).toContain("page=1"));
    const reset = await waitFor(() => {
      const state = screen.getByRole("status");
      expect(state).toHaveTextContent("No tickets match this view");
      return within(state).getByRole("button", { name: "Clear filters" });
    });
    reset.focus();
    await userEvent.keyboard(key === " " ? "[Space]" : "[Enter]");
    await screen.findByRole("heading", { name: "Invoice needs correcting" });
    await waitFor(() => expect(window.location.search).toBe("?page=1&limit=50&sort=updated"));
    expect(screen.getByRole("searchbox", { name: "Search support tickets" })).toHaveValue("");
    expect(screen.getByRole("searchbox", { name: "Search support tickets" })).toHaveFocus();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("distinguishes an empty queue from no matching tickets", async () => {
    render(<SupportPage />);
    expect(await screen.findByText("No support tickets yet")).toBeInTheDocument();
    expect(screen.queryByText("No tickets match this view")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("keeps queue loading errors distinct from empty results", async () => {
    mocks.get.mockRejectedValue(new Error("Synthetic queue error"));
    render(<SupportPage />);
    expect(await screen.findByText("The queue could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("No support tickets yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No tickets match this view")).not.toBeInTheDocument();
  });
});
