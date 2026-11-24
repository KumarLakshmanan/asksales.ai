import { describe, expect, it } from "vitest";
import {
  paidAdsFilterUpdates,
  paidAdsPeriod,
  paidAdsProviderPreset,
  paidCampaignFreshness,
} from "@/lib/paid-ads-filters";
import { paidAdsDashboardQuery } from "@/hooks/usePaidAdsDashboard";
describe("paid campaign reporting and provider filters", () => {
  it("uses the same window when moving between inventory and provider workflows", () => {
    expect(paidAdsProviderPreset({ period: "7d" })).toBe("last_7d");
    expect(paidAdsPeriod({ date: "last_90d" })).toBe("90d");
    expect(paidAdsFilterUpdates({ period: "7d" })).toEqual({
      period: "7d",
      date: "last_7d",
    });
    expect(paidAdsFilterUpdates({ date: "last_90d" })).toEqual({
      date: "last_90d",
      period: "90d",
    });
    expect(paidAdsDashboardQuery({ date: "last_90d", status: "paused" })).toBe(
      "comparison=previous_period&period=90d&status=paused",
    );
    expect(paidAdsPeriod({ period: "7d", date: "last_90d" })).toBe("7d");
    expect(paidAdsProviderPreset({ period: "7d", date: "last_90d" })).toBe(
      "last_7d",
    );
  });
  it("preserves provider-only presets without sending unsupported reporting periods", () => {
    expect(paidAdsFilterUpdates({ date: "today" })).toEqual({
      date: "today",
      period: null,
    });
    expect(paidAdsProviderPreset({ date: "today" })).toBe("today");
    expect(paidAdsDashboardQuery({ period: "invalid" })).toContain(
      "period=30d",
    );
  });
  it("shows failed or missing measurements rather than false freshness", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(paidCampaignFreshness("2026-10-03T11:30:00Z", false, now)).toBe(
      "30m ago",
    );
    expect(paidCampaignFreshness("invalid", false, now)).toBe("No fresh data");
    expect(paidCampaignFreshness("2026-10-03T11:30:00Z", true, now)).toBe(
      "Refresh failed",
    );
  });
});
