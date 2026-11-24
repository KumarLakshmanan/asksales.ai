import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutreachRetryView } from "@/components/outreach/reports/OutreachRetryView";
import { selectBusinessProfile } from "@/lib/business-profile";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.params }));
const id = "10000000-0000-4000-8000-000000000001";
const preview = () => ({
  id,
  businessProfileId: 7,
  status: "ready",
  fingerprint: "a".repeat(64),
  checkedAt: new Date().toISOString(),
  reviewExpiresAt: new Date(Date.now() + 300000).toISOString(),
  filters: { messageKind: "outreach", channel: "whatsapp" },
  counts: {
    selected: 575,
    eligible: 72,
    waiting: 280,
    excluded: 223,
    registered: 0,
    changed: 0,
  },
  items: [],
  reasons: [
    {
      reason: "Waiting for Meta cooldown",
      count: 280,
      nextAttemptAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ],
  card: {
    title: "Retry decisions",
    status: "ready",
    businessProfileId: 7,
    metrics: [{ label: "Eligible", value: 72 }],
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem("user", JSON.stringify({ id: 9 }));
  sessionStorage.setItem("active-business-profile:9", "7");
  mocks.params = new URLSearchParams({ operationId: id });
  mocks.get.mockImplementation(async () => preview());
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
describe("dashboard retry confirmation", () => {
  it("shows cooldowns and sends the exact confirmed preview identity only after explicit selection", async () => {
    mocks.post.mockImplementation(async () => ({
      ...preview(),
      status: "completed",
      counts: { ...preview().counts, registered: 70, changed: 2 },
    }));
    render(<OutreachRetryView />);
    await screen.findByText(/Waiting for Meta cooldown/);
    const confirm = screen.getByRole("button", {
      name: "Confirm eligible retries",
    });
    expect(confirm).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        `/api/outreach/retries/${id}/apply`,
        { fingerprint: "a".repeat(64), confirmed: true },
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "70 existing intents registered",
    );
  });
  it("refuses an expired preview and hides the prior business after a scope change", async () => {
    mocks.get.mockImplementation(async () => ({
      ...preview(),
      reviewExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    render(<OutreachRetryView />);
    await screen.findByText(/This preview expired/);
    expect(
      screen.getByRole("button", { name: "Confirm eligible retries" }),
    ).toBeDisabled();
    selectBusinessProfile(8);
    await waitFor(() =>
      expect(
        screen.queryByText(/Waiting for Meta cooldown/),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
