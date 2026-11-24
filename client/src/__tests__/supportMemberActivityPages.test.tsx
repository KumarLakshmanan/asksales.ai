import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemberTicketsPage from "@/app/dashboard/(main)/support/teams/[id]/members/[memberId]/page";
import MemberActivityPage from "@/app/dashboard/(main)/support/teams/[id]/members/[memberId]/activity/page";

const mocks = vi.hoisted(() => ({ get: vi.fn(), router: { push: vi.fn() } }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "2", memberId: "5" }), useRouter: () => mocks.router }));
vi.mock("@/lib/api", () => ({ api: { get: mocks.get } }));
vi.mock("@/hooks/use-support-realtime-refresh", () => ({ useSupportRealtimeRefresh: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const team = { id: 2, name: "Reservations", members: [{ id: 5, name: "QA Member", email: "qa@example.com", role: "member", isActive: true, presenceState: "away" }] };
describe("member access and activity pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes("/presence?")
      ? { timezone: "Asia/Kolkata", presenceState: "away", daily: [], unrepliedWorkload: 1 }
      : path.endsWith("/tickets") ? [] : path.endsWith("notification-settings") ? { recipients: [] } : team));
  });

  it("does not confuse enabled access with live presence", async () => {
    render(<MemberTicketsPage />);
    await screen.findByRole("heading", { name: "QA Member" });
    expect(screen.getByText("Enabled", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Away", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Active", { exact: true })).not.toBeInTheDocument();
  });

  it("requests the supported 365-day range and keeps empty days inspectable", async () => {
    render(<MemberActivityPage />);
    fireEvent.click(await screen.findByRole("button", { name: "365 days" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("/api/support/teams/2/members/5/presence?days=365"));
    expect(await screen.findByText("Activity calendar · last 365 days")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /active minutes, 0 replies/ })).toHaveLength(365);
    expect(screen.getByText("No presence intervals were recorded for this day.")).toBeInTheDocument();
  });
});
