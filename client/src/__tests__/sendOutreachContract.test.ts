import { describe, expect, it } from "vitest";
import {
  canonicalOutreachForm,
  toOutreachDateTimeLocal,
} from "@/components/widgets/SendOutreachWidget";
import { formatContentAssetDate } from "@/components/content-cards/ImageCard";

describe("send outreach widget contract", () => {
  const base = {
    lead_ids: [1154, 1155],
    channel: "email",
    template_id: 0,
    subject: "A quick idea",
    body: "Hello {{first_name}}",
    scheduled_for: "",
  };

  it("preserves exact IDs and omits an empty optional schedule", () => {
    expect(canonicalOutreachForm(base)).toEqual({
      lead_ids: [1154, 1155],
      channel: "email",
      subject: "A quick idea",
      body: "Hello {{first_name}}",
    });
  });

  it("converts a local schedule into the ISO value required by the server", () => {
    const result = canonicalOutreachForm({ ...base, scheduled_for: "2026-09-01T10:00" });
    expect(result.scheduled_for).toMatch(/^2026-09-01T/);
    expect(String(result.scheduled_for)).toMatch(/Z$/);
  });

  it("formats an ISO schedule for datetime-local editing", () => {
    expect(toOutreachDateTimeLocal("2026-09-01T10:00:00.000Z")).toMatch(/^2026-09-01T\d{2}:\d{2}$/);
  });

  it("preserves Twitter/X as the canonical server channel", () => {
    expect(canonicalOutreachForm({ ...base, channel: "twitter", lead_ids: [1168, 1169] })).toMatchObject({
      channel: "twitter",
      lead_ids: [1168, 1169],
    });
  });

  it("never renders an invalid content asset timestamp", () => {
    expect(formatContentAssetDate(undefined)).toBeNull();
    expect(formatContentAssetDate("not-a-date")).toBeNull();
    expect(formatContentAssetDate("2026-08-30T12:00:00.000Z")).toBeTruthy();
  });
});
