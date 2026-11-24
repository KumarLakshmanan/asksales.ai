import { jest, it, expect, beforeEach, afterEach } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll } from "@jest/globals";
import { drizzle } from "drizzle-orm/node-postgres";
import { withBusinessScope } from "../tenancy/businessContext.js";
import { getAdSetMetrics } from "../controllers/campaignAnalyticsController.js";
// @ts-expect-error Deployment migrations use JavaScript.
import { up as widenCtr, down as narrowCtr } from "../migrations/370_reporting_metric_precision.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../models/db.js";
import { dashboardMoney } from "../services/ReportingMoneyService.js";
import { adLeadQuality } from "../services/ads/AdLeadQualityService.js";
import { AnalyticsIngestionService } from "../services/AnalyticsIngestionService.js";
import { adPerformanceService } from "../services/ads/AdPerformanceService.js";
import {
  getAdsDashboard,
  getCampaignTrends,
  compareAdCampaigns,
} from "../controllers/campaignAnalyticsController.js";
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: () => ({ get: async () => null, set: async () => "OK" }),
}));
const { getUserDashboardStats } =
  await import("../controllers/dashboardController.js");
const dialect = new PgDialect();
const container = `reporting-qa-${process.pid}`;
const postgres =
  process.env.REPORTING_LOCAL_QA === "1" ? describe : describe.skip;
let created = false;
function psql(sql: string) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "reporting_qa",
    ],
    {
      input: "SET timezone='UTC';\n" + sql,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  ).trim();
}
function literal(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw Error("invalid fixture");
    return String(v);
  }
  if (Array.isArray(v)) return `ARRAY[${v.map(literal).join(",")}]`;
  return (
    "'" +
    String(v instanceof Date ? v.toISOString() : v).replaceAll("'", "''") +
    "'"
  );
}
function execute(q: any) {
  const c = q?.sql && Array.isArray(q.params) ? q : dialect.sqlToQuery(q);
  const sql = c.sql.replace(/\$(\d+)/g, (_match: string, n: string) =>
    literal(c.params[Number(n) - 1]),
  );
  return /^(SELECT|WITH)\b/i.test(sql.trim())
    ? {
        rows: JSON.parse(
          psql(
            `SELECT COALESCE(json_agg(audit_row),'[]') FROM (${sql}) audit_row;`,
          ),
        ),
      }
    : (psql(sql), { rows: [] });
}
const response = () => {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setTimeout", "nextTick", "setImmediate"] });
  jest.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  jest.spyOn(db, "execute").mockImplementation(async (q: any) => execute(q));
  jest
    .spyOn(adPerformanceService, "dashboardSummary")
    .mockResolvedValue({ dataFreshnessAt: null } as any);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
postgres(
  "Reporting corrections against network-disabled disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      execFileSync("docker", [
        "run",
        "--detach",
        "--name",
        container,
        "--network",
        "none",
        "--tmpfs",
        "/var/lib/postgresql/data:rw",
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "-e",
        "POSTGRES_DB=reporting_qa",
        "pgvector/pgvector:pg16",
      ]);
      created = true;
      for (let attempt = 0; attempt < 30; attempt++) {
        const logs = execFileSync("docker", ["logs", container], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (
          logs.includes("PostgreSQL init process complete; ready for start up.")
        ) {
          try {
            psql("SELECT 1;");
            break;
          } catch {
            /* The initialization server may be restarting. */
          }
        }
        if (attempt === 29)
          throw new Error("Disposable reporting DB did not start");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      psql(
        readFileSync(
          new URL("./fixtures/reportingCorrections.sql", import.meta.url),
          "utf8",
        ),
      );
      await widenCtr({ query: async (q: string) => psql(q) });
      await narrowCtr({ query: async (q: string) => psql(q) });
      await widenCtr({ query: async (q: string) => psql(q) });
    }, 30000);
    afterAll(() => {
      if (created) {
        execFileSync("docker", ["stop", container]);
        execFileSync("docker", ["rm", container]);
      }
    }, 30000);

    it("keeps booked and won outcomes in independent currencies", async () => {
      const q = await adLeadQuality(9, {
        managedCampaignId: 1,
        providerCampaignId: "meta-1",
        start: "2026-09-06",
        end: "2026-09-12",
      });
      expect(q).toMatchObject({
        state: "available",
        matchedLeads: 2,
        bookings: 2,
        bookedRevenue: null,
        wonPipelineValue: null,
        currency: null,
        bookedRevenueByCurrency: { USD: 10, INR: 800 },
        wonPipelineValueByCurrency: { USD: 10, INR: 800 },
      });
    });
    it("explicit local campaign association wins over a conflicting provider string", async () => {
      psql(
        "INSERT INTO leads VALUES (3,9,NULL,'qualified','qualified'); INSERT INTO pixel_events(user_id,lead_id,campaign_id,timestamp,utm_campaign) VALUES (9,3,999,'2026-09-10','meta-1');",
      );
      const q = await adLeadQuality(9, {
        managedCampaignId: 1,
        providerCampaignId: "meta-1",
        start: "2026-09-06",
        end: "2026-09-12",
      });
      expect(q.matchedLeads).toBe(2);
    });
    it("Meta platform selector includes only Meta source facts", async () => {
      const res = response();
      await getAdsDashboard(
        {
          user: { id: 9 },
          query: { period: "7d", platform: "meta", currency: "USD" },
        } as any,
        res,
      );
      const b = res.json.mock.calls[0][0];
      expect(b.success).toBe(true);
      expect(b.summary.totalSpend).toBe(10);
      expect(b.campaigns).toHaveLength(1);
      expect(b.campaigns[0].metrics.spend).toBe(10);
    });
    it("compares valid arrays of IDs and preserves currency labels", async () => {
      const res = response();
      await compareAdCampaigns(
        { user: { id: 9 }, body: { campaignIds: [1, 2], period: "7d" } } as any,
        res,
      );
      const b = res.json.mock.calls[0][0];
      expect(b.success).toBe(true);
      expect(b.comparison).toHaveLength(2);
      expect(b.comparison.map((r: any) => r.currency).sort()).toEqual([
        "INR",
        "USD",
      ]);
      expect(b.comparison.map((r: any) => r.conversions)).toEqual([4, 1.75]);
    });
    it("stores 10 percent CTR after the real precision migration", async () => {
      const service = new AnalyticsIngestionService();
      await expect(
        (service as any).storeMetrics({
          campaignId: 98,
          userId: 9,
          platformCampaignId: "synthetic98",
          platform: "google",
          date: "2026-09-12",
          impressions: 100,
          clicks: 10,
          spend: 20,
          conversions: 1.75,
          cpc: 2,
          ctr: 10,
        }),
      ).resolves.toBeUndefined();
    });
    it("replays daily corrections idempotently and preserves fractional cache totals", async () => {
      psql(
        "INSERT INTO performance_ad_campaigns(id,user_id,name,ad_platform,currency) VALUES (99,9,'cache fixture','google','USD');",
      );
      const service = new AnalyticsIngestionService();
      const m = {
        campaignId: 99,
        userId: 9,
        platformCampaignId: "synthetic99",
        platform: "google",
        date: "2026-09-12",
        impressions: 1000,
        clicks: 20,
        spend: 20,
        conversions: 1.75,
        cpc: 1,
        ctr: 2,
      };
      await (service as any).storeMetrics(m);
      await (service as any).storeMetrics({ ...m, spend: 30 });
      const row = JSON.parse(
        psql(
          "SELECT json_build_object('rows',(SELECT COUNT(*) FROM performance_metrics WHERE campaign_id=99),'dailyConversions',(SELECT conversions FROM performance_metrics WHERE campaign_id=99),'cacheConversions',conversions,'spend',spent_amount) FROM performance_ad_campaigns WHERE id=99;",
        ),
      );
      expect(row).toEqual({
        rows: 1,
        dailyConversions: 1.75,
        cacheConversions: 1.75,
        spend: 30,
      });
    });
    it("seven-day trends excludes the eighth day and future facts", async () => {
      psql(
        "INSERT INTO performance_metrics(campaign_id,user_id,platform,platform_campaign_id,date,hour,impressions,clicks,spend,conversions,reach) VALUES (99,9,'google','synthetic99','2026-09-05',NULL,100,1,10,1,50),(99,9,'google','synthetic99','2026-09-13',NULL,100,1,20,2,50);",
      );
      const res = response();
      await getCampaignTrends(
        {
          user: { id: 9 },
          params: { campaignId: "99" },
          query: { period: "7d" },
        } as any,
        res,
      );
      const b = res.json.mock.calls[0][0];
      expect(b.success).toBe(true);
      expect(b.trends.map((r: any) => r.date)).toEqual(["2026-09-12"]);
    });
    it("pages real child metrics without duplicates or truncating the history", async () => {
      const first = response();
      await getAdSetMetrics(
        {
          user: { id: 9 },
          params: { campaignId: "1" },
          query: { limit: "100" },
        } as any,
        first,
      );
      const a = first.json.mock.calls[0][0];
      expect(a.metrics).toHaveLength(100);
      expect(a.nextOffset).toBe(100);
      const second = response();
      await getAdSetMetrics(
        {
          user: { id: 9 },
          params: { campaignId: "1" },
          query: { limit: "100", offset: "100" },
        } as any,
        second,
      );
      const b = second.json.mock.calls[0][0];
      expect(b.metrics).toHaveLength(10);
      expect(b.nextOffset).toBeNull();
      expect(
        new Set([...a.metrics, ...b.metrics].map((r: any) => r.target_key))
          .size,
      ).toBe(110);
    });

    it("home totals retain currencies and budget cadence independently", async () => {
      psql(
        "INSERT INTO performance_ad_campaigns(id,user_id,currency,budget_type,budget_amount,spent_amount) VALUES (201,29,'USD','daily',20,10),(202,29,'INR','lifetime',1000,800),(203,29,'USD','lifetime',100,5);",
      );
      const result = await dashboardMoney(29);
      expect(result.spendByCurrency).toEqual({ USD: 15, INR: 800 });
      expect(result.totalSpent).toBeNull();
      expect(result.totalBudget).toBeNull();
      expect(result.budgetByCurrencyAndType).toEqual(
        expect.arrayContaining([
          { currency: "USD", type: "lifetime", amount: 100 },
          { currency: "USD", type: "daily", amount: 20 },
          { currency: "INR", type: "lifetime", amount: 1000 },
        ]),
      );
    });

    it("home channel counts exclude queued, failed and incoming rows and preserve prior tracking evidence", async () => {
      const client = {
        query: async (config: any, params: any[]) => {
          const result = execute({ sql: config.text, params });
          return {
            rows:
              config.rowMode === "array"
                ? result.rows.map((row: any) => Object.values(row))
                : result.rows,
          };
        },
      };
      const actual = drizzle(client as never);
      jest
        .spyOn(db, "select")
        .mockImplementation((...args: any[]) => actual.select(...(args as [])));
      const res: any = { ...response(), setHeader: jest.fn() };
      await withBusinessScope({ userId: 9, businessProfileId: 42 }, () =>
        getUserDashboardStats({ user: { id: 9 } } as any, res),
      );
      expect(res.status).not.toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.messagesSent).toBe(3);
      expect(body.channelPerformance.email).toEqual({
        sent: 2,
        opened: 1,
        clicked: 2,
        replied: 1,
      });
      expect(body.channelPerformance.sms).toEqual({
        sent: 1,
        delivered: 1,
        replied: 0,
      });
    });
    it("refuses lossy CTR rollback instead of clamping or deleting facts", async () => {
      await (new AnalyticsIngestionService() as any).storeMetrics({
        campaignId: 98,
        userId: 9,
        platformCampaignId: "synthetic98",
        platform: "google",
        date: "2026-09-13",
        impressions: 100,
        clicks: 100,
        spend: 20,
        conversions: 1.75,
        cpc: 0.2,
        ctr: 100,
      });
      await expect(
        narrowCtr({ query: async (q: string) => psql(q) }),
      ).rejects.toThrow(/numeric field overflow/);
      const row = JSON.parse(
        psql(
          "SELECT json_build_object('ctr',ctr,'conversions',conversions) FROM performance_metrics WHERE campaign_id=98 AND date='2026-09-13';",
        ),
      );
      expect(row).toEqual({ ctr: 100, conversions: 1.75 });
      await widenCtr({ query: async (q: string) => psql(q) });
    });
  },
);
