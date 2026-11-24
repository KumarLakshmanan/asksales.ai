import { withBusinessScope } from "../tenancy/businessContext.js";
import express from "express";
import request from "supertest";
import { writeFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Client, Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { campaignPublishFixture } from "./fixtures/campaignPublish.js";

// Explicit dedicated local opt-in. All writes use a synthetic shared schema;
// worker transactions use independent PostgreSQL pool connections. No RLS or
// real authentication claim is made. All provider IO is intercepted below.
const connectionString = process.env.AD_PUBLISH_QA_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
let dataPool: Pool;
const schema = `ads_pause_race_${process.pid}`;
const readiness = jest.fn<any>();
jest.unstable_mockModule("../models/db.js", () => ({
  db: {
    execute: (query: SQL) => database.execute(query),
    transaction: (callback: Parameters<typeof database.transaction>[0]) =>
      database.transaction(callback),
  },
}));
const metaCredentials = () => ({
  ...fixture.accounts.meta,
  accessToken: "synthetic-not-a-token",
  apiVersion: "v25.0",
});
const googleCredentials = () => ({
  ...fixture.accounts.google,
  refreshToken: "synthetic-not-a-token",
});
jest.unstable_mockModule("../models/metaPageConnections/functions.js", () => ({
  getMetaAdsCreds: metaCredentials,
}));
jest.unstable_mockModule("../controllers/integrationsController.js", () => ({
  getGoogleAdsCredentials: googleCredentials,
}));
jest.unstable_mockModule("../utils/metaApiVersion.js", () => ({
  getGraphApiBase: () => "https://graph.facebook.com/v25.0",
  getGraphApiVersion: async () => "v25.0",
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const cache: any[] = [];
jest.unstable_mockModule("../middleware/auth.js", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { id: 7 };
    return withBusinessScope(
      { userId: 7, actorUserId: 7, businessProfileId: 71 },
      next,
    );
  },
}));
jest.unstable_mockModule("../models/platformAccess/functions.js", () => ({
  getEffectiveModuleAccess: async () => [
    { key: "performance_marketing", enabled: true, status: "available" },
  ],
  getMaintenanceSettings: async () => ({ enabled: false }),
}));
jest.unstable_mockModule("../models/campaignPerformanceCache/index.js", () => ({
  CampaignPerformanceCacheModel: {
    updateStatus: async (...args: any[]) => {
      cache.push(args);
    },
  },
}));
let targetBlock: string | null = null;
let released: () => void = () => {};
let entered: () => void = () => {};
let hold = Promise.resolve();
let afterRawRequest: (() => Promise<void>) | undefined;
let pauseFailure: "none" | "reject" | "unknown" = "none";
let rawFailure = false;
let providerState = "PAUSED";
const events: any[] = [];
const observations: any[] = [];
const previousFetch = global.fetch;
global.fetch = jest.fn<any>(async (url: any, init: any = {}) => {
  const path = new URL(String(url)).pathname;
  const id = path.split("/").at(-1)!;
  if (!["10001", "20001", "30001"].includes(id))
    throw new Error("Unexpected provider target: " + path);
  if (init.method === "POST") {
    const raw = String(init.body).startsWith("{");
    const status = raw
      ? JSON.parse(init.body).status
      : new URLSearchParams(init.body).get("status");
    const source = raw ? "raw-http" : "retained-worker";
    events.push({ source, target: id, status, stage: "requested" });
    if (!raw && id === targetBlock && status === "ACTIVE") {
      entered();
      await hold;
    }
    if (raw && afterRawRequest) await afterRawRequest();
    if (raw && rawFailure)
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: "Synthetic raw pause rejected" },
        }),
      };
    if (
      !raw &&
      id === "10001" &&
      status === "PAUSED" &&
      pauseFailure === "reject"
    )
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Synthetic pause rejected" } }),
      };
    events.push({ source, target: id, status, stage: "applied" });
    if (id === "10001") providerState = status;
    if (
      !raw &&
      id === "10001" &&
      status === "PAUSED" &&
      pauseFailure === "unknown"
    )
      throw new Error("Synthetic lost pause response");
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }
  return { ok: true, status: 200, json: async () => ({ account_id: "12" }) };


});

const { AutonomousAdsService, autonomousAdsService } =
  await import("../services/ads/AutonomousAdsService.js");
const { AutonomousAdsActionProcessor } =
  await import("../services/ads/AutonomousAdsActionProcessor.js");
await import("../models/widgetStates/stopReconciliation.js");
const service = new AutonomousAdsService();
const worker = new AutonomousAdsActionProcessor() as any;
const { default: router } = await import("../routes/campaigns.routes.js");
const app = express();
app.use(express.json());
app.use("/api/campaigns", router);
const originalGate = process.env.AD_PROVIDER_MUTATIONS_ENABLED;
let fixture: ReturnType<typeof campaignPublishFixture>;

describePostgres(
  "raw manual pause versus the actual retained Meta activation lifecycle",
  () => {
    beforeAll(async () => {
      if (
        !connectionString ||
        !["localhost", "127.0.0.1", "[::1]"].includes(
          new URL(connectionString).hostname,
        ) ||
        new URL(connectionString).pathname !== "/ads_race"
      )
        throw new Error("Explicit local PostgreSQL is required.");
      client = new Client({ connectionString });
      await client.connect();
      // Shared synthetic schema and independent SQL transactions for overlapping
      // actual worker instances and HTTP; no inherited database is accepted.
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, pg_catalog`);
      dataPool = new Pool({
        connectionString,
        max: 6,
        options: `-c search_path=${schema},pg_catalog`,
      });
      database = drizzle(dataPool);
      await client.query(`
      CREATE TABLE widget_states (
        id integer PRIMARY KEY, user_id integer, tool_name text, status text, execution_result jsonb,
        execution_error text, execution_completed_at timestamptz, updated_at timestamptz
      );
      CREATE TABLE performance_ad_campaigns (
        id integer PRIMARY KEY, user_id integer, version integer, name text, objective text, ad_platform text,
        budget_type text, budget_amount numeric, currency text, spent_amount numeric, landing_page_url text,
        start_date timestamptz, end_date timestamptz, locations jsonb, targeting jsonb, auto_activate boolean,
        validation_errors jsonb, ad_creatives jsonb, settings jsonb, local_status text, status text,
        provider_status text, is_active boolean DEFAULT false, launched_at timestamptz,
        last_provider_error text, updated_at timestamptz
      );
      ALTER TABLE performance_ad_campaigns ADD COLUMN ad_account_id text,ADD COLUMN business_profile_id integer DEFAULT 71;
      CREATE TABLE paid_ad_accounts(id integer,user_id integer,platform text,provider_account_id text,is_active boolean,reporting_available boolean);
      CREATE TABLE ad_campaign_allocations (
        id serial PRIMARY KEY, campaign_id integer, user_id integer, child_key text, platform text,
        allocated_amount numeric, spent_amount numeric, status text, updated_at timestamptz
      );
      CREATE TABLE ad_settings (user_id integer PRIMARY KEY, live_provider_mutations_enabled boolean,
        default_lifetime_budget numeric DEFAULT 100,currency text DEFAULT 'USD',locations jsonb DEFAULT '[]',
        autonomous_optimization_enabled boolean DEFAULT false,analytics_sync_minutes integer DEFAULT 15);
      CREATE TABLE ad_action_queue (
        id serial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT 71,
        campaign_id integer, user_id integer, platform text, action_type text,
        idempotency_key text, status text DEFAULT 'pending', payload jsonb, provider_outcome jsonb,
        last_error text, metrics_snapshot jsonb, rationale text, budget_impact numeric,
        locked_by text, locked_at timestamptz, completed_at timestamptz, updated_at timestamptz,
        available_at timestamptz DEFAULT NOW(), UNIQUE(business_profile_id, user_id, idempotency_key)
      );
      ALTER TABLE ad_action_queue ADD COLUMN attempts integer DEFAULT 0,
        ADD COLUMN max_attempts integer DEFAULT 4, ADD COLUMN evaluation_id integer,
        ADD COLUMN target_type text, ADD COLUMN target_key text;
      CREATE TABLE ad_provider_resources (
        id serial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT 71,
        campaign_id integer, user_id integer, platform text,
        resource_type text, local_key text, status text, error text, cleanup_status text, updated_at timestamptz,
        provider_resource_id text,provider_resource_name text,idempotency_key text,metadata jsonb,
        UNIQUE(business_profile_id,user_id,platform,idempotency_key)
      );
      CREATE TABLE ad_action_notification_deliveries(id serial PRIMARY KEY,action_id integer,campaign_id integer,user_id integer,status text,available_at timestamp,attempts integer,max_attempts integer);
      CREATE TABLE ad_action_audit (
        id serial PRIMARY KEY, campaign_id integer, user_id integer, action_id integer,
        actor_type text, action_type text, rationale text, metrics_snapshot jsonb,
        budget_before numeric, budget_after numeric, provider_outcome jsonb
      );
    `);
      jest.spyOn(service, "getAccountReadiness").mockImplementation(readiness);
      jest
        .spyOn(autonomousAdsService, "getAccountReadiness")
        .mockImplementation(readiness);
    });
    beforeEach(async () => {
      fixture = campaignPublishFixture();
      Object.assign(fixture.campaign, { business_profile_id: 71 });
      process.env.AD_PROVIDER_MUTATIONS_ENABLED = "true";
      readiness
        .mockReset()
        .mockResolvedValue({
          meta: true,
          google: true,
          reasons: {},
          accounts: fixture.accounts,
        });
      afterRawRequest = undefined;
      pauseFailure = "none";
      rawFailure = false;
      cache.length = 0;
      events.length = 0;
      targetBlock = null;
      providerState = "PAUSED";
      hold = Promise.resolve();
      await client.query("TRUNCATE widget_states,paid_ad_accounts");
      await client.query("TRUNCATE ad_provider_resources");
      await client.query(
        "TRUNCATE ad_action_queue, ad_action_audit, performance_ad_campaigns, ad_campaign_allocations, ad_settings RESTART IDENTITY",
      );
      await client.query(
        "INSERT INTO performance_ad_campaigns SELECT * FROM jsonb_populate_record(NULL::performance_ad_campaigns, $1::jsonb)",
        [JSON.stringify(fixture.campaign)],
      );
      for (const allocation of fixture.allocations)
        await client.query(
          "INSERT INTO ad_campaign_allocations (campaign_id, user_id, child_key, platform, allocated_amount, spent_amount) VALUES (19, 7, $1, $2, $3, 0)",
          [allocation.key, allocation.platform, allocation.amount],
        );
      await client.query(
        "INSERT INTO ad_settings(user_id,live_provider_mutations_enabled) VALUES (7, true)",
      );
    });
    afterAll(async () => {
      global.fetch = previousFetch;
      writeFileSync(
        process.env.AD_RACE_OBSERVATIONS ||
          "/tmp/asksales-ads-race-observations.json",
        JSON.stringify(observations, null, 2),
      );
      await dataPool?.end();
      await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client?.end();
      jest.restoreAllMocks();
      if (originalGate === undefined)
        delete process.env.AD_PROVIDER_MUTATIONS_ENABLED;
      else process.env.AD_PROVIDER_MUTATIONS_ENABLED = originalGate;
    });

    async function retainedLaunch() {
      const queued = await service.queueExistingCampaignPlatform(
        7,
        19,
        "meta",
        "retained-launch",
        fixture.review.revision,
      );
      for (const [kind, key, id] of [
        ["campaign", "campaign", "10001"],
        ["ad_set", "meta-1", "20001"],
        ["ad", "meta-1:ad", "30001"],
      ]) {
        await client.query(
          `INSERT INTO ad_provider_resources(campaign_id,user_id,platform,resource_type,local_key,provider_resource_id,status,idempotency_key,metadata)
        VALUES(19,7,'meta',$1,$2,$3,'published',$4,$5::jsonb)`,
          [
            kind,
            key,
            id,
            `seed-${kind}`,
            JSON.stringify({ publishReviewRevision: fixture.review.revision }),
          ],
        );
      }
      return queued;
    }
    async function snapshot(name: string, result: any) {
      const actions = (
        await client.query(
          "SELECT id,action_type,status,last_error,provider_outcome,locked_by,locked_at FROM ad_action_queue ORDER BY id",
        )
      ).rows;
      const campaign = (
        await client.query(
          "SELECT status,local_status,is_active,settings FROM performance_ad_campaigns",
        )
      ).rows[0];
      const value = {
        name,
        result,
        providerState,
        cache: [...cache],
        events: [...events],
        actions,
        campaign,
      };
      observations.push(value);
      return value;
    }
    it("a successful raw pause prevents an older pending retained launch from activating", async () => {
      await retainedLaunch();
      const pause = await request(app)
        .post("/api/campaigns/meta/campaigns/10001/pause")
        .send({});
      expect(pause.status).toBe(200);
      expect(providerState).toBe("PAUSED");
      const result = await worker.processBatch(1);
      const observed = await snapshot("pending launch after raw pause", result);
      expect(observed.providerState).toBe("PAUSED");
      expect(observed.actions[0].status).toBe("cancelled");
      expect(
        events.every((event) =>
          ["10001", "20001", "30001"].includes(event.target),
        ),
      ).toBe(true);
    });
    it.each(["20001", "10001"])(
      "a raw pause remains final when retained activation is held at %s",
      async (target) => {
        await retainedLaunch();
        targetBlock = target;
        let unblock!: () => void;
        const blocked = new Promise<void>((r) => {
          entered = r;
        });
        hold = new Promise<void>((r) => {
          unblock = r;
        });
        released = unblock;
        const running = worker.processBatch(1);
        await blocked;
        let pause: any;
        try {
          pause = await request(app)
            .post("/api/campaigns/meta/campaigns/10001/pause")
            .send({});
          expect(pause.status).toBe(200);
          expect(providerState).toBe("PAUSED");
          await snapshot(
            `raw pause confirmed while ${target} activation was outstanding`,
            { httpStatus: pause.status },
          );
        } finally {
          released();
        }
        const observed = await snapshot(
          `raw pause with ${target === "20001" ? "child" : "campaign"} activation in flight`,
          await running,
        );
        expect(observed.providerState).toBe("PAUSED");
        expect(observed.actions[0].status).toBe("cancelled");
        expect(
          events.every((event) =>
            ["10001", "20001", "30001"].includes(event.target),
          ),
        ).toBe(true);
      },
      15000,
    );
    it.each(["20001", "10001"])(
      "canonical stop control revokes the retained launch held at %s",
      async (target) => {
        await retainedLaunch();
        targetBlock = target;
        let unblock!: () => void;
        const blocked = new Promise<void>((r) => {
          entered = r;
        });
        hold = new Promise<void>((r) => {
          unblock = r;
        });
        released = unblock;
        const running = worker.processBatch(1);
        await blocked;
        let stopped: any;
        try {
          stopped = await service.queueCampaignStop(
            7,
            19,
            ["meta"],
            "stop-during-retained-activation",
          );
        } finally {
          released();
        }
        const observed = await snapshot(
          `canonical stop with ${target === "20001" ? "child" : "campaign"} activation in flight`,
          await running,
        );
        expect(observed.actions[0].status).toBe("cancelled");
        // Execute the actual durable stop after the outstanding activation settles;
        // queued is not claimed to be provider-confirmed paused before this point.
        const result = await new AutonomousAdsActionProcessor().processBatch(1);
        const reconciled = await snapshot(
          `canonical stop consumer completes after ${target}`,
          result,
        );
        expect(reconciled.providerState).toBe("PAUSED");
        expect(reconciled.actions[1]).toMatchObject({
          status: "succeeded",
          provider_outcome: { status: "paused" },
        });
        expect(stopped.platforms[0].providerPauseConfirmed).toBe(false);
      },
      15000,
    );
    it("does not let a late activation overtake an already completed durable stop receipt", async () => {
      await retainedLaunch();
      targetBlock = "10001";
      let unblock!: () => void;
      const blocked = new Promise<void>((r) => {
        entered = r;
      });
      hold = new Promise<void>((r) => {
        unblock = r;
      });
      released = unblock;
      const running = worker.processBatch(1);
      await blocked;
      try {
        await service.queueCampaignStop(
          7,
          19,
          ["meta"],
          "concurrent-durable-stop",
        );
        await new AutonomousAdsActionProcessor().processBatch(1);
        const paused = await snapshot(
          "second consumer confirmed stop before outstanding activation settled",
          { success: true },
        );
        expect(paused.providerState).toBe("PAUSED");
        expect(paused.actions[1]).toMatchObject({
          status: "succeeded",
          provider_outcome: { status: "paused" },
        });
      } finally {
        released();
      }
      const observed = await snapshot(
        "late activation after a completed durable stop",
        await running,
      );
      expect(observed.providerState).toBe("PAUSED");
      expect(observed.actions[1].status).toBe("succeeded");
    }, 15000);

    it.each(["reject", "unknown"] as const)(
      "invalidates a completed stop when compensation is %s",
      async (mode) => {
        await retainedLaunch();
        targetBlock = "10001";
        let unblock!: () => void;
        const blocked = new Promise<void>((r) => {
          entered = r;
        });
        hold = new Promise<void>((r) => {
          unblock = r;
        });
        const running = worker.processBatch(1);
        await blocked;
        try {
          await service.queueCampaignStop(7, 19, ["meta"], "uncertain-stop");
          await new AutonomousAdsActionProcessor().processBatch(1);
          pauseFailure = mode;
        } finally {
          unblock();
        }
        await running;
        const observed = await snapshot(
          `compensation ${mode} after confirmed stop`,
          {},
        );
        expect(observed.actions[0]).toMatchObject({
          status: "cancelled",
          provider_outcome: {
            safelyPaused: false,
            requiresReconciliation: true,
          },
        });
        expect(observed.actions[1]).toMatchObject({
          status: "failed",
          provider_outcome: {
            providerPauseConfirmed: false,
            requiresReconciliation: true,
          },
        });
        expect(observed.campaign.local_status).toBe("uncertain");
        expect((await worker.processBatch(1)).processed).toBe(0);
      },
      15000,
    );
    it("retains revocation when raw pause fails and never records a paused cache receipt", async () => {
      await retainedLaunch();
      rawFailure = true;
      const response = await request(app)
        .post("/api/campaigns/meta/campaigns/10001/pause")
        .send({});
      expect(response.status).toBe(400);
      expect(cache).toEqual([]);
      expect(
        (await client.query("SELECT status FROM ad_action_queue")).rows[0]
          .status,
      ).toBe("cancelled");
      expect((await worker.processBatch(1)).processed).toBe(0);
    });
    it("rejects a saved managed account mismatch before any provider write", async () => {
      await retainedLaunch();
      await client.query(
        `UPDATE performance_ad_campaigns SET settings=jsonb_set(settings,'{accountSnapshot,meta,adAccountId}','"act_99"'::jsonb)`,
      );
      const response = await request(app)
        .post("/api/campaigns/meta/campaigns/10001/pause")
        .send({});
      expect(response.status).toBe(500);
      expect(events).toEqual([]);
      expect(
        (await client.query("SELECT status FROM ad_action_queue")).rows[0]
          .status,
      ).toBe("pending");
    });
    it.each(["owner", "business"])(
      "does not cancel a %s sibling row matched only by provider ID",
      async (dimension) => {
        await retainedLaunch();
        await client.query(
          dimension === "owner"
            ? "UPDATE performance_ad_campaigns SET user_id=8"
            : "UPDATE performance_ad_campaigns SET business_profile_id=72",
        );
        const response = await request(app)
          .post("/api/campaigns/meta/campaigns/10001/pause")
          .send({});
        expect(response.status).toBe(200);
        expect(
          (await client.query("SELECT status FROM ad_action_queue")).rows[0]
            .status,
        ).toBe("pending");
        expect(
          (
            await client.query(
              "SELECT status FROM ad_provider_resources WHERE resource_type='campaign'",
            )
          ).rows[0].status,
        ).toBe("published");
      },
    );
    it("retains the raw provider-only path without creating a managed queue receipt", async () => {
      const response = await request(app)
        .post("/api/campaigns/meta/campaigns/10001/pause")
        .send({});
      expect(response.status).toBe(200);
      expect(providerState).toBe("PAUSED");
      expect(
        (await client.query("SELECT id FROM ad_action_queue")).rows,
      ).toEqual([]);
    });
    it("preserves a replacement lease and prevents stale active finalization", async () => {
      await retainedLaunch();
      targetBlock = "10001";
      let unblock!: () => void;
      const blocked = new Promise<void>((r) => {
        entered = r;
      });
      hold = new Promise<void>((r) => {
        unblock = r;
      });
      const running = worker.processBatch(1);
      await blocked;
      try {
        await client.query(
          "UPDATE ad_action_queue SET locked_by='replacement-worker',locked_at=locked_at+INTERVAL '1 second'",
        );
      } finally {
        unblock();
      }
      await running;
      const row = (
        await client.query("SELECT status,locked_by FROM ad_action_queue")
      ).rows[0];
      expect(row).toEqual({
        status: "processing",
        locked_by: "replacement-worker",
      });
      expect(
        (
          await client.query(
            "SELECT id FROM ad_provider_resources WHERE status='active'",
          )
        ).rows,
      ).toEqual([]);
    }, 15000);
    it("blocks fresh approval while a cancelled activation is outstanding, then accepts an explicitly renewed review", async () => {
      await retainedLaunch();
      targetBlock = "10001";
      let unblock!: () => void;
      const blocked = new Promise<void>((r) => {
        entered = r;
      });
      hold = new Promise<void>((r) => {
        unblock = r;
      });
      const running = worker.processBatch(1);
      await blocked;
      let attempt: any;
      try {
        await service.queueCampaignStop(7, 19, ["meta"], "authority-stop");
        await new AutonomousAdsActionProcessor().processBatch(1);
        attempt = await service
          .queueExistingCampaignPlatform(
            7,
            19,
            "meta",
            "new-authority",
            fixture.review.revision,
          )
          .then(
            (value) => ({ value }),
            (error) => ({ error: error.message }),
          );
      } finally {
        unblock();
      }
      await running;
      expect(attempt.error).toMatch(/reconciled/);
      targetBlock = null;
      const approval = await service.queueExistingCampaignPlatform(
        7,
        19,
        "meta",
        "new-authority",
        fixture.review.revision,
      );
      expect(approval.queued).toBe(true);
      await worker.processBatch(1);
      const observed = await snapshot(
        "fresh approval after old activation reconciled",
        {},
      );
      expect(observed.providerState).toBe("ACTIVE");
      expect(observed.actions.at(-1).status).toBe("succeeded");
      expect(observed.actions[0].status).toBe("cancelled");
    }, 15000);

    it("rejects missing or mismatched managed business authority", async () => {
      await retainedLaunch();
      await expect(
        service.revokeManagedMetaLaunch(7, "10001", "act_12"),
      ).rejects.toThrow("business profile is required");
      await expect(
        withBusinessScope(
          { userId: 8, actorUserId: 8, businessProfileId: 71 },
          () => service.revokeManagedMetaLaunch(7, "10001", "act_12"),
        ),
      ).rejects.toThrow("ownership");
      expect(
        (await client.query("SELECT status FROM ad_action_queue")).rows[0]
          .status,
      ).toBe("pending");
    });
    it("does not confirm managed pause against a binding changed during provider IO", async () => {
      await retainedLaunch();
      afterRawRequest = async () => {
        await client.query(
          `UPDATE performance_ad_campaigns SET settings=jsonb_set(settings,'{accountSnapshot,meta,adAccountId}','"act_99"'::jsonb)`,
        );
      };
      const response = await request(app)
        .post("/api/campaigns/meta/campaigns/10001/pause")
        .send({});
      expect(response.status).toBe(500);
      expect(cache).toEqual([]);
      expect(
        (
          await client.query(
            "SELECT status FROM ad_provider_resources WHERE resource_type='campaign'",
          )
        ).rows[0].status,
      ).toBe("published");
    });
    it("fences local finalization when stop wins after the final post-response validation", async () => {
      await retainedLaunch();
      let injected = false;
      const original = worker.revalidatePublishApproval.bind(worker);
      const hook = jest
        .spyOn(worker, "revalidatePublishApproval")
        .mockImplementation(async (...args: any[]) => {
          const review = await original(...args);
          if (
            !injected &&
            events.some(
              (event) =>
                event.target === "10001" &&
                event.status === "ACTIVE" &&
                event.stage === "applied",
            )
          ) {
            injected = true;
            await service.queueCampaignStop(
              7,
              19,
              ["meta"],
              "stop-before-finalize",
            );
            await new AutonomousAdsActionProcessor().processBatch(1);
          }
          return review;
        });
      try {
        await worker.processBatch(1);
      } finally {
        hook.mockRestore();
      }
      expect(injected).toBe(true);
      const observed = await snapshot(
        "stop after validation before local finalization",
        {},
      );
      expect(observed.providerState).toBe("PAUSED");
      expect(observed.campaign.local_status).toBe("paused");
      expect(observed.actions[0].status).toBe("cancelled");
      expect(
        (
          await client.query(
            "SELECT id FROM ad_provider_resources WHERE status='active'",
          )
        ).rows,
      ).toEqual([]);
    });
  it('does not restore active local state from a retained finalized replay after manual pause',async()=>{
    await retainedLaunch();await client.query("UPDATE ad_provider_resources SET status='active'");let injected=false;
    const original=worker.updateLocalPublished.bind(worker);
    const hook=jest.spyOn(worker,'updateLocalPublished').mockImplementation(async(...args:any[])=>{
      if(!injected){injected=true;const response=await request(app).post('/api/campaigns/meta/campaigns/10001/pause').send({});expect(response.status).toBe(200);}
      return original(...args);
    });
    try{await worker.processBatch(1);}finally{hook.mockRestore();}
    const observed=await snapshot('retained finalized replay after manual pause',{});
    expect(injected).toBe(true);expect(observed.providerState).toBe('PAUSED');expect(observed.campaign.local_status).toBe('paused');expect(observed.actions[0].status).toBe('cancelled');
  });
  },
);
