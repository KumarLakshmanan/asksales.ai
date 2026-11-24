import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: mocks }));
import { SocialReportsPanel } from "@/components/social-insights/SocialReportsPanel";
import { SocialListeningPanel } from "@/components/social-insights/SocialListeningPanel";
const props = {
  platform: "instagram",
  accountIdentifier: "ig-owned",
  accountName: "My Brand",
  startDate: "2026-08-20",
  endDate: "2026-09-18",
  timezone: "Asia/Kolkata",
  revision: 0,
};
describe("Social Insights management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    mocks.get.mockResolvedValue([]);
    mocks.post.mockResolvedValue({});
    mocks.patch.mockResolvedValue({});
  });
  it("creates a rolling report without freezing dashboard dates", async () => {
    render(<SocialReportsPanel {...props} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Create report" }),
    );
    fireEvent.change(screen.getByLabelText("Report name"), {
      target: { value: "Weekly report" },
    });
    fireEvent.change(screen.getByLabelText("Frequency"), {
      target: { value: "weekly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        "/api/social-analytics/reports",
        expect.objectContaining({
          filters: {
            platform: "instagram",
            accountIdentifier: "ig-owned",
            relativeDays: 30,
            timezone: "Asia/Kolkata",
          },
          schedule: expect.objectContaining({ frequency: "weekly" }),
        }),
      ),
    );
  });
  it("renames a report while preserving its saved date range", async () => {
    mocks.get.mockResolvedValue([
      {
        id: "report-1",
        name: "Saved",
        filters: {
          platform: "instagram",
          accountIdentifier: "ig-owned",
          start: "2026-07-01T00:00:00.000Z",
          end: "2026-07-31T23:59:59.999Z",
        },
      },
    ]);
    render(<SocialReportsPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Report name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        "/api/social-analytics/reports/report-1",
        expect.objectContaining({
          name: "Renamed",
          filters: expect.objectContaining({
            start: "2026-07-01T00:00:00.000Z",
            end: "2026-07-31T23:59:59.999Z",
          }),
        }),
      ),
    );
  });
  it("appends listening pages and persists manual sentiment review", async () => {
    const event = {
      id: "event-1",
      body: "First comment",
      sentiment: "unknown",
      source: "official_api",
      occurred_at: "2026-09-01T12:00:00Z",
    };
    mocks.get.mockImplementation(async (url: string) =>
      url.includes("offset=50")
        ? {
            items: [{ ...event, id: "event-2", body: "Second comment" }],
            total: 51,
            nextOffset: null,
            summary: { unknown: 51 },
          }
        : {
            items: [event],
            total: 51,
            nextOffset: 50,
            summary: { unknown: 51 },
          },
    );
    render(
      <SocialListeningPanel
        platform="instagram"
        credentialId="22"
        startDate="2026-08-20"
        endDate="2026-09-18"
        revision={0}
      />,
    );
    await screen.findByText("First comment");
    fireEvent.click(screen.getByRole("button", { name: "Load more evidence" }));
    await screen.findByText("Second comment");
    expect(screen.getByText("First comment")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Sentiment for event-1"), {
      target: { value: "positive" },
    });
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        "/api/social-analytics/listening/event-1",
        { sentiment: "positive" },
      ),
    );
  });
});
