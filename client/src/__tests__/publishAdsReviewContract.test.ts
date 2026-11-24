import { describe, expect, it } from "vitest";
import {
  canonicalCampaignReviewForm,
  defaultCampaignSchedule,
  toCampaignDateTimeLocal,
} from "@/components/widgets/PublishAdsWidget";

describe("publish ads review contract", () => {
  it("proposes an explicit seven-day schedule before approval", () => {
    const now = new Date("2026-08-21T03:00:00.000Z");
    const schedule = defaultCampaignSchedule(now);
    const start = new Date(schedule.start_date);
    const end = new Date(schedule.end_date);

    expect(schedule.start_date).toMatch(/^2026-08-21T/);
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("uses explicit automatic placements and serializes the reviewed schedule", () => {
    expect(canonicalCampaignReviewForm({
      placements: [],
      start_date: "2026-08-22T09:00",
      end_date: "2026-08-29T09:00",
    })).toMatchObject({
      placements: ["Automatic"],
      start_date: "2026-08-22T09:00:00.000Z",
      end_date: "2026-08-29T09:00:00.000Z",
    });
  });

  it("formats stored ISO dates for datetime-local review fields", () => {
    expect(toCampaignDateTimeLocal("2026-08-22T03:30:00.000Z")).toBe("2026-08-22T03:30");
  });

  it('preserves UTC midnight and explicit offset instants through the editor', () => {
    expect(canonicalCampaignReviewForm({ start_date: toCampaignDateTimeLocal('2026-09-08T00:00:00Z') }).start_date).toBe('2026-09-08T00:00:00.000Z');
    expect(toCampaignDateTimeLocal('2026-09-08T05:30:00+05:30')).toBe('2026-09-08T00:00');
    expect(toCampaignDateTimeLocal('2026-09-08T00:00')).toBe('2026-09-08T00:00');
  });
});
