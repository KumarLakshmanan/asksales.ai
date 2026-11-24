import {
  jest,
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
} from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../models/db.js";
import {
  AnalyticsIngestionService,
  analyticsIngestionService,
} from "../services/AnalyticsIngestionService.js";
import { MetaAdsService } from "../services/ads/MetaAdsService.js";
import { adPerformanceService } from "../services/ads/AdPerformanceService.js";
import {
  getAdsDashboard,
  getCampaignTrends,
  compareAdCampaigns,
  fetchMetricsNow,
  getAdSetMetrics,
} from "../controllers/campaignAnalyticsController.js";
import {
  providerReportingWindow,
  aggregateProviderReportingWindow,
} from "../services/ads/ProviderReportingWindow.js";
jest.unstable_mockModule("../services/agents/WebSocketEmitter", () => ({
  webSocketEmitter: { emit: jest.fn() },
}));
const {
  getSocialAnalyticsDashboard,
  selectCurrentSocialSnapshots,
  aggregateSocialSnapshots,
} = await import("../controllers/socialAnalyticsController.js");
const { executeAnalyticsQuery } =
  await import("../mastra/tools/executors/analyticsExecutor.js");
const dialect = new PgDialect();
const compile = (q: any) => dialect.sqlToQuery(q);
const response = () => {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};
let queries: any[] = [];
beforeEach(() => {
  queries = [];
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  jest.spyOn(db, "execute").mockImplementation(async (q: any) => {
    queries.push(compile(q));
    return { rows: [] };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const provider = (status = "ENABLED") => ({
  id: 1,
  platform: "google",
  status,
  platform_entity_id: "7",
  ad_account_id: "123",
  account_registry_id: 3,
  name: "Synthetic",
  last_refreshed_at: new Date(),
  raw_data: {
    campaign: { objective: "SEARCH" },
    accountIdentity: { currency: "INR", adAccountId: "123" },
    dailyInsights: [
      {
        date: "2026-09-12",
        impressions: 100,
        clicks: 10,
        spend: 2.5,
        conversions: 1.75,
      },
    ],
  },
});
async function dashboard() {
  const res = response();
  await getAdsDashboard(
    { user: { id: 9 }, query: { period: "7d" } } as any,
    res,
  );
  return res.json.mock.calls[0][0];
}
function setupDashboard() {
  jest.spyOn(db, "execute").mockImplementation(async (q: any) => {
    const c = compile(q);
    queries.push(c);
    if (c.sql.includes("SELECT DISTINCT UPPER"))
      return { rows: [{ currency: "INR" }] };
    if (c.sql.includes("SELECT cache.*")) return { rows: [provider()] };
    return { rows: [] };
  });
  jest
    .spyOn(adPerformanceService, "dashboardSummary")
    .mockResolvedValue({ dataFreshnessAt: null } as any);
}
describe("Reporting corrections preserve source facts and validated filters", () => {
  it("stores overlapping Meta refresh windows as corrected source-day facts", async () => {
    const service = new AnalyticsIngestionService();
    const rows = new Map<string, any>();
    jest
      .spyOn(MetaAdsService.prototype, "getCampaignMetricsByDateRange")
      .mockImplementation(async (_id, start) => ({
        success: true,
        metrics: Array.from({ length: 7 }, (_, i) => {
          const day = new Date(start);
          day.setUTCDate(day.getUTCDate() + i);
          return {
            campaignId: "meta-1",
            date: day.toISOString().slice(0, 10),
            impressions: 1000,
            clicks: 10,
            spend: 10,
            reach: 100,
            conversions: 1.75,
            conversionValue: 40,
            engagements: 1,
            installs: 0,
            source: { leads: 1, conversionValueAvailable: true },
          };
        }),
      }));
    jest
      .spyOn(MetaAdsService.prototype, "getAdSetMetricsByDateRange")
      .mockResolvedValue({ success: true, metrics: [] });
    jest
      .spyOn(MetaAdsService.prototype, "getAdMetricsByDateRange")
      .mockResolvedValue({ success: true, metrics: [] });
    jest
      .spyOn(service as any, "storeMetrics")
      .mockImplementation(async (m: any) => {
        rows.set(m.date, m);
      });
    jest.spyOn(service as any, "recordSyncRun").mockResolvedValue(undefined);
    const credentials = {
      accessToken: "SYNTHETIC-NOT-A-REAL-TOKEN",
      adAccountId: "123",
    };
    expect(
      await service.ingestMetaCampaign(
        1,
        9,
        "meta-1",
        credentials,
        "2026-09-06",
        "2026-09-12",
      ),
    ).toEqual({ success: true });
    expect(
      await service.ingestMetaCampaign(
        1,
        9,
        "meta-1",
        credentials,
        "2026-09-07",
        "2026-09-13",
      ),
    ).toEqual({ success: true });
    expect(rows.size).toBe(8);
    expect([...rows.values()].reduce((sum, m) => sum + m.spend, 0)).toBe(80);
    expect(rows.get("2026-09-12")).toMatchObject({
      conversions: 1.75,
      conversionValue: 40,
      leads: 1,
    });
  });
  it("preserves fractional conversions in cards, rows and chart", async () => {
    setupDashboard();
    const body = await dashboard();
    expect(body.success).toBe(true);
    expect(body.summary.totalConversions).toBe(1.75);
    expect(body.campaigns[0].metrics.conversions).toBe(1.75);
    expect(body.dailyTrends[0].conversions).toBe(1.75);
  });
  it("preserves Meta daily conversion value and fractional outcomes", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              date_start: "2026-09-12",
              impressions: "100",
              clicks: "10",
              spend: "20",
              actions: [
                {
                  action_type: "offsite_conversion.fb_pixel_purchase",
                  value: "1.75",
                },
              ],
              action_values: [
                {
                  action_type: "offsite_conversion.fb_pixel_purchase",
                  value: "80",
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await new MetaAdsService({
      accessToken: "SYNTHETIC",
      adAccountId: "123",
    }).getCampaignMetrics("7", "2026-09-06", "2026-09-12");
    expect(result.metrics?.conversions).toBe(1.75);
    expect((result.metrics as any)?.conversionValue).toBe(80);
    const url = new URL(String((globalThis.fetch as any).mock.calls[0][0]));
    expect(url.searchParams.get("fields")).toContain("action_values");
    expect(url.searchParams.get("time_increment")).toBe("1");
  });
  it("includes provider ENABLED in active count", async () => {
    setupDashboard();
    const b = await dashboard();
    expect(b.campaigns[0].providerStatus).toBe("ENABLED");
    expect(b.summary.activeCampaigns).toBe(1);
  });
  it("uses identical inclusive UTC windows across paid reports", async () => {
    setupDashboard();
    await dashboard();
    const dashboardSql = queries.find(
      (q) =>
        q.sql.includes("GROUP BY pac.id") &&
        q.sql.includes("total_impressions"),
    );
    expect(dashboardSql.params).toContain("2026-09-06");
    queries = [];
    const res = response();
    await getCampaignTrends(
      {
        user: { id: 9 },
        params: { campaignId: "1" },
        query: { period: "7d" },
      } as any,
      res,
    );
    expect(queries[0].params).toContain("2026-09-06");
    expect(queries[0].sql).toMatch(/pm\.date\s*<=/);
    queries = [];
    await compareAdCampaigns(
      { user: { id: 9 }, body: { campaignIds: [1, 2], period: "7d" } } as any,
      response(),
    );
    expect(queries[0].params).toContain("2026-09-06");
    expect(queries[0].sql).toMatch(/pm\.date\s*<=/);
  });
  it("rejects impossible calendar dates before ingestion", async () => {
    const ingest = jest
      .spyOn(analyticsIngestionService, "ingestAllCampaigns")
      .mockResolvedValue({ success: true, metricsIngested: 0 });
    const res = response();
    await fetchMetricsNow(
      {
        user: { id: 9 },
        body: { dateStart: "2026-02-30", dateStop: "2026-03-02" },
      } as any,
      res,
    );
    expect(ingest).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it("includes recorded zero scores in averages", async () => {
    jest.spyOn(db, "select").mockReturnValue({
      from: () => ({
        where: async () => [
          { id: 1, status: "new", leadScore: 0, icpScore: 0 },
          { id: 2, status: "new", leadScore: 100, icpScore: 0 },
        ],
      }),
    } as any);
    const result = await executeAnalyticsQuery(
      { query_type: "lead", scope: "all_owned" },
      { userId: 9, threadId: 1 } as any,
    );
    expect(result.success).toBe(true);
    expect((result.output as any).data).toMatchObject({
      totalLeads: 2,
      avgLeadScore: 50,
    });
  });
  it("filters multi-campaign facts by selected platform", async () => {
    setupDashboard();
    const res = response();
    await getAdsDashboard(
      { user: { id: 9 }, query: { period: "7d", platform: "meta" } } as any,
      res,
    );
    const q = queries.find(
      (q) =>
        q.sql.includes("GROUP BY pac.id") &&
        q.sql.includes("total_impressions"),
    );
    expect(q.sql).toContain("pac.ad_platform = 'multi'");
    expect(q.sql).toMatch(/pm\.platform\s*=/);
  });
  it("retains independent currency labels on comparisons", async () => {
    jest.spyOn(db, "execute").mockResolvedValue({
      rows: [
        { id: 1, name: "USD", spend: "10", currency: "USD" },
        { id: 2, name: "INR", spend: "800", currency: "INR" },
      ],
    });
    const res = response();
    await compareAdCampaigns(
      { user: { id: 9 }, body: { campaignIds: [1, 2] } } as any,
      res,
    );
    const rows = res.json.mock.calls[0][0].comparison;
    expect(rows.map((r: any) => r.spend)).toEqual([10, 800]);
    expect(rows.every((r: any) => Boolean(r.currency))).toBe(true);
  });
  it("returns paginated child daily identities instead of campaign totals", async () => {
    jest.spyOn(db, "execute").mockImplementation(async (q: any) => {
      queries.push(compile(q));
      return {
        rows: Array.from({ length: 101 }, (_, i) => ({
          target_key: String(i),
        })),
      };
    });
    const res = response();
    await getAdSetMetrics(
      { user: { id: 9 }, params: { campaignId: "1" }, query: {} } as any,
      res,
    );
    expect(queries[0].sql).toContain("FROM ad_unit_metrics unit");
    expect(queries[0].sql).toContain("unit.target_key");
    expect(res.json.mock.calls[0][0]).toMatchObject({
      grain: "child_daily",
      nextOffset: 100,
    });
    expect(res.json.mock.calls[0][0].metrics).toHaveLength(100);
  });
  it("preserves unavailable lead evidence outside history", () => {
    expect(
      aggregateProviderReportingWindow(
        { dailyInsights: [{ date: "2026-08-01", leads: 7 }] },
        "2026-09-01",
        "2026-09-02",
      ).leads,
    ).toBeNull();
  });
  it("does not count exact duplicated daily facts twice", () => {
    const r = { date: "2026-09-12", spend: 10, conversions: 1 };
    expect(
      aggregateProviderReportingWindow(
        { dailyInsights: [r, r] },
        "2026-09-12",
        "2026-09-12",
      ).spend,
    ).toBe(10);
  });
  it("uses UTC calendar months for allowed monthly presets", () => {
    expect(providerReportingWindow("this_month")).toEqual({
      start: "2026-09-01",
      end: "2026-09-12",
    });
    expect(providerReportingWindow("last_month")).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
    });
  });
  it("rejects malformed social dates before database reads", async () => {
    const res = response();
    await getSocialAnalyticsDashboard(
      { user: { id: 9 }, query: { start: "invalid-date" } } as any,
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(queries).toHaveLength(0);
  });
  it("PASS control: latest social correction replaces prior metric, complementary metrics survive", () => {
    const common = {
      platform: "instagram",
      account_identifier: "synthetic",
      metric_window_start: "2026-09-01T00:00:00Z",
      metric_window_end: "2026-09-01T23:59:59.999Z",
    };
    const rows = selectCurrentSocialSnapshots([
      {
        ...common,
        id: "new",
        captured_at: "2026-09-03",
        metrics: { views: 15 },
      },
      {
        ...common,
        id: "old",
        captured_at: "2026-09-02",
        metrics: { views: 10, reach: 8 },
      },
    ]);
    expect(aggregateSocialSnapshots(rows).totals).toEqual({
      views: 15,
      reach: 8,
    });
  });
});

it("uses identical deduplicated provider facts for dashboard cards and trends", async () => {
  setupDashboard();
  jest.spyOn(db, "execute").mockImplementation(async (q: any) => {
    const c = compile(q);
    if (c.sql.includes("SELECT DISTINCT UPPER"))
      return { rows: [{ currency: "INR" }] };
    if (c.sql.includes("SELECT cache.*")) {
      const row = provider();
      row.raw_data.dailyInsights.push({ ...row.raw_data.dailyInsights[0] });
      return { rows: [row] };
    }
    return { rows: [] };
  });
  const body = await dashboard();
  expect(body.summary.totalSpend).toBe(2.5);
  expect(body.dailyTrends[0].spend).toBe(2.5);
  expect(body.summary.totalConversions).toBe(1.75);
  expect(body.dailyTrends[0].conversions).toBe(1.75);
});
