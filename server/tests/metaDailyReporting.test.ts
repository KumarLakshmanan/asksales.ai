import { afterEach, expect, it, jest } from "@jest/globals";
jest.unstable_mockModule("../utils/metaApiVersion.js", () => ({
  getGraphApiVersion: async () => "v25.0",
  getGraphApiBase: () => "https://graph.example/v25.0",
}));
const { MetaAdsService } = await import("../services/ads/MetaAdsService.js");
const service = () =>
  new MetaAdsService({ accessToken: "synthetic-only", adAccountId: "123" });
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
const day = (date: string, spend: string, count: string) => ({
  date_start: date,
  impressions: String(Number(spend) * 100),
  clicks: spend,
  spend,
  actions: [
    { action_type: "lead", value: "100" },
    { action_type: "purchase", value: count },
    { action_type: "offsite_conversion.fb_pixel_purchase", value: count },
  ],
  action_values: [
    { action_type: "purchase", value: String(Number(spend) * 4) },
    {
      action_type: "offsite_conversion.fb_pixel_purchase",
      value: String(Number(spend) * 4),
    },
  ],
});
afterEach(() => { jest.restoreAllMocks(); });
it("fully paginates source days and uses weighted rates and objective-specific aliases", async () => {
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      ok({
        data: [day("2026-09-01", "1", "0.5")],
        paging: { next: "https://graph.example/v25.0/page2" },
      }),
    )
    .mockResolvedValueOnce(ok({ data: [day("2026-09-02", "9", "1.25")] }));
  const result = await service().getCampaignMetrics(
    "7",
    "2026-09-01",
    "2026-09-02",
    "sales",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    success: true,
    metrics: {
      spend: 10,
      clicks: 10,
      impressions: 1000,
      conversions: 1.75,
      conversionValue: 40,
      cpc: 1,
      ctr: 1,
    },
  });
});
it("returns no partial metrics when a later page fails", async () => {
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      ok({
        data: [day("2026-09-01", "1", "0.5")],
        paging: { next: "https://graph.example/v25.0/page2" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Quota exhausted" } }), {
        status: 429,
      }),
    );
  const result = await service().getCampaignMetricsByDateRange(
    "7",
    "2026-09-01",
    "2026-09-02",
    "sales",
  );
  expect(result.success).toBe(false);
  expect(result).not.toHaveProperty("metrics");
});
it("rejects impossible dates before any provider call", async () => {
  const fetch = jest.spyOn(globalThis, "fetch");
  expect(
    (
      await service().getCampaignMetricsByDateRange(
        "7",
        "2026-02-30",
        "2026-03-02",
      )
    ).success,
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects repeated pages and mismatched daily facts instead of silently truncating", async () => {
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      ok({ data: [], paging: { next: "https://graph.example/v25.0/page2" } }),
    );
  expect(
    (
      await service().getCampaignMetricsByDateRange(
        "7",
        "2026-09-01",
        "2026-09-02",
      )
    ).success,
  ).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValue(ok({ data: [day("2026-08-31", "1", "1")] }));
  expect(
    (
      await service().getCampaignMetricsByDateRange(
        "7",
        "2026-09-01",
        "2026-09-02",
      )
    ).success,
  ).toBe(false);
});
it("deduplicates identical source days and fails on conflicting duplicates", async () => {
  const row = day("2026-09-01", "1", "0.5");
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(ok({ data: [row, row] }));
  expect(
    await service().getCampaignMetrics(
      "7",
      "2026-09-01",
      "2026-09-02",
      "sales",
    ),
  ).toMatchObject({ success: true, metrics: { spend: 1, conversions: 0.5 } });
  fetch.mockResolvedValue(ok({ data: [row, { ...row, spend: "2" }] }));
  expect(
    (
      await service().getCampaignMetricsByDateRange(
        "7",
        "2026-09-01",
        "2026-09-02",
      )
    ).success,
  ).toBe(false);
});
