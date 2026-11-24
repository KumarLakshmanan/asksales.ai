import { beforeAll, afterAll, describe, it, expect, jest } from "@jest/globals";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { responseWrapper } from "../middleware/responseWrapper.js";
import { csrfProtection } from "../middleware/csrf.js";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { assertBusinessScopeSchema } from "../tenancy/schemaGuard.js";

const database = process.env.SETUP_CORRECTIONS_TEST_DATABASE;
const evidenceDirectory =
  process.env.SETUP_CORRECTIONS_EVIDENCE || "/tmp/setup-corrections-evidence";
const suite = database ? describe : describe.skip;
jest.setTimeout(20000);
let admin: Pool, pool: Pool, server: Server, base: string;
const executeDb = new Proxy(
  {},
  { get: (_target, key) => Reflect.get(drizzle(pool), key) },
);
const enqueue = jest
  .fn<(...args: unknown[]) => Promise<string>>()
  .mockResolvedValue("fixture-queue-job");
jest.unstable_mockModule("../models/db.js", () => ({ db: executeDb }));
jest.unstable_mockModule("../queues/index.js", () => ({
  QUEUE_NAMES: { GENERAL: "general" },
  QUEUE_LIMITERS: {},
  queueRegistry: { initialize: async () => undefined, addJob: enqueue },
}));
jest.unstable_mockModule("../services/SmartThrottlingService.js", () => ({
  SmartThrottlingService: {
    getInstance: () => ({
      isAllowed: async () => ({ allowed: true }),
      recordRequest: async () => undefined,
    }),
  },
}));
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: () => ({ get: async () => null }),
  getRedisSubscriber: () => ({}),
  isRedisAvailable: async () => false,
  closeRedisConnections: async () => undefined,
}));
jest.unstable_mockModule("../middleware/rateLimiter.js", () =>
  Object.fromEntries(
    [
      "globalRateLimiter",
      "authRateLimiter",
      "apiRateLimiter",
      "aiRateLimiter",
      "uploadRateLimiter",
      "credentialsRateLimiter",
      "publicReviewRateLimiter",
      "publicWidgetRateLimiter",
      "publicWidgetReadRateLimiter",
    ].map((name) => [
      name,
      (_req: unknown, _res: unknown, next: () => void) => next(),
    ]),
  ),
);
jest.unstable_mockModule("../utils/logger.js", () => ({
  createWorkerLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
// Provider behavior is simulated; requests still use real JWT auth, scope/billing middleware, HTTP and PostgreSQL.
jest.unstable_mockModule("../controllers/setupController.js", () => ({
  analyzeWebsite: async (
    _req: unknown,
    res: { json: (body: unknown) => unknown },
  ) => {
    const { updateSetupAnalysisProgress, withSetupAnalysisCommit } =
      await import("../services/setupAnalysisProgress.js");
    await updateSetupAnalysisProgress("crawling", "Reading website pages", {
      crawled: 1,
      totalPages: 2,
    });
    await withSetupAnalysisCommit(async (executor) => {
      const { saveWorkspaceWebsiteAnalysis } =
        await import("../services/workspaceWebsiteAnalysis.js");
      const { requireBusinessScope } =
        await import("../tenancy/businessContext.js");
      const scope = requireBusinessScope();
      await saveWorkspaceWebsiteAnalysis(
        scope.userId,
        scope.businessProfileId,
        "https://fixture.example/",
        { companyName: "Fixture" },
        null,
        { pages: 2, knowledgeSaved: false, warnings: [] },
        executor,
      );
    });
    return res.json({
      success: true,
      data: { companyName: "Fixture" },
      analysisSummary: { pages: 2, knowledgeSaved: false, warnings: [] },
    });
  },
}));
jest.unstable_mockModule("../utils/email.js", () => ({
  sendVerificationEmail: async () => undefined,
  sendResetPasswordEmail: async () => undefined,
  sendApprovalPendingEmail: async () => undefined,
  sendNewUserNotificationToAdmin: async () => undefined,
}));
const { authenticateToken } = await import("../middleware/auth.js");
const { generateToken } = await import("../utils/jwt.js");
const { setupDraft } = await import("../controllers/setupDraftController.js");
const { setupAnalysisJob } =
  await import("../controllers/setupAnalysisJobsController.js");
const { setupReadiness } =
  await import("../controllers/setupReadinessController.js");
const { objectStorage } = await import("../services/ObjectStorageService.js");
jest.spyOn(objectStorage, "delete").mockResolvedValue(undefined);
let owner: number,
  other: number,
  member: number,
  north: number,
  otherProfile: number;
let ownerToken: string, otherToken: string;
async function api(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    profile?: number;
  } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token !== ""
        ? { authorization: `Bearer ${options.token ?? ownerToken}` }
        : {}),
      "x-business-profile-id": String(options.profile ?? north),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wire = (await response.json()) as Record<string, any>;
  return {
    status: response.status,
    wire,
    body: wire.success === true && wire.data !== undefined ? wire.data : wire,
  };
}
suite("Setup recovery corrections", () => {
  beforeAll(async () => {
    if (!database?.startsWith("salesmarketing_workspace_recovery_qa_"))
      throw new Error("Use a disposable workspace recovery QA database.");
    admin = new Pool({ host: "/tmp", database, max: 1 });
    pool = createBusinessScopedPool(
      new Pool({ host: "/tmp", database, max: 4 }),
    );
    await assertBusinessScopeSchema(admin);
    const suffix = randomUUID();
    const users = await admin.query(
      "INSERT INTO users(email,password,name,is_setup_complete) VALUES($1,'fixture','Owner',false),($2,'fixture','Other',false),($3,'fixture','Member',true) RETURNING id",
      [
        `owner-${suffix}@example.invalid`,
        `other-${suffix}@example.invalid`,
        `member-${suffix}@example.invalid`,
      ],
    );
    [owner, other, member] = users.rows.map((row) => row.id);
    const profiles = await admin.query(
      "INSERT INTO company_settings(user_id,name,is_default) VALUES($1,'North',true),($1,'South',false),($2,'Other',true) RETURNING id",
      [owner, other],
    );
    [north, , otherProfile] = profiles.rows.map((row) => row.id);
    await admin.query(
      "INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",
      [north, member, `member-${suffix}@example.invalid`],
    );
    ownerToken = generateToken({
      userId: owner,
      email: `owner-${suffix}@example.invalid`,
    });
    otherToken = generateToken({
      userId: other,
      email: `other-${suffix}@example.invalid`,
    });
    const app = express();
    app.use(csrfProtection);
    app.use(express.json({ limit: "300kb" }));
    app.use("/api", responseWrapper);
    const { default: actualSettingsRoutes } =
      await import("../routes/settings.routes.js");
    const { default: actualAuthRoutes } =
      await import("../routes/auth.routes.js");
    const { default: actualContentRoutes } =
      await import("../routes/content.routes.js");
    app.use("/api/settings", actualSettingsRoutes);
    app.use("/api/auth", actualAuthRoutes);
    app.use("/api/content", actualContentRoutes);
    app.all("/api/setup/drafts/:draftKey", authenticateToken, setupDraft);
    app.post(
      "/api/setup/website-analysis/jobs",
      authenticateToken,
      setupAnalysisJob,
    );
    app.get(
      "/api/setup/website-analysis/jobs/:jobId",
      authenticateToken,
      setupAnalysisJob,
    );
    app.delete(
      "/api/setup/website-analysis/jobs/:jobId",
      authenticateToken,
      setupAnalysisJob,
    );
    app.post(
      "/api/setup/website-analysis/jobs/:jobId/retry",
      authenticateToken,
      setupAnalysisJob,
    );
    app.get("/api/setup/onboarding-status", authenticateToken, setupReadiness);
    if (process.env.WORKSPACE_AUDIT_BROWSER_URL)
      await mkdir(evidenceDirectory, { recursive: true });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30000);
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool?.end();
    await admin?.end();
  });
  it("rolls back preferences when the user timezone mirror fails", async () => {
    await admin.query("UPDATE users SET timezone='UTC' WHERE id=$1", [owner]);
    await admin.query(
      "INSERT INTO user_preferences(user_id,timezone) VALUES($1,'UTC') ON CONFLICT(user_id) DO UPDATE SET timezone='UTC'",
      [owner],
    );
    await admin.query(`CREATE FUNCTION audit2_fail_user_timezone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id=${owner} AND NEW.timezone='Europe/Paris' THEN RAISE EXCEPTION 'synthetic mirror failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER audit2_timezone_failure BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION audit2_fail_user_timezone();`);
    let result;
    try {
      result = await api("/api/settings/preferences", {
        method: "PUT",
        body: {
          language: "en",
          locale: "en-US",
          currency: "USD",
          theme: "light",
          timezone: "Europe/Paris",
          dateFormat: "MM/DD/YYYY",
          timeFormat: "12h",
        },
      });
    } finally {
      await admin.query(
        "DROP TRIGGER audit2_timezone_failure ON users; DROP FUNCTION audit2_fail_user_timezone()",
      );
    }
    const row = (
      await admin.query(
        "SELECT u.timezone AS user_timezone,p.timezone AS preference_timezone FROM users u JOIN user_preferences p ON p.user_id=u.id WHERE u.id=$1",
        [owner],
      )
    ).rows[0];
    expect(result.status).toBe(500);
    expect(row).toEqual({ user_timezone: "UTC", preference_timezone: "UTC" });
  });
  it("rolls back ordinary profile fields when the preference mirror fails", async () => {
    await admin.query(
      "UPDATE users SET timezone='UTC',name='Before fault' WHERE id=$1",
      [owner],
    );
    await admin.query(
      "INSERT INTO user_preferences(user_id,timezone) VALUES($1,'UTC') ON CONFLICT(user_id) DO UPDATE SET timezone='UTC'",
      [owner],
    );
    await admin.query(`CREATE FUNCTION audit2_fail_preference_timezone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.user_id=${owner} AND NEW.timezone='Europe/Paris' THEN RAISE EXCEPTION 'synthetic preference mirror failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER audit2_preference_failure BEFORE INSERT OR UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION audit2_fail_preference_timezone();`);
    try {
      const result = await api("/api/settings/profile", {
        method: "PUT",
        body: { name: "After fault", timezone: "Europe/Paris" },
      });
      expect(result.status).toBe(500);
      expect(
        (
          await admin.query(
            "SELECT u.name,u.timezone AS user_timezone,p.timezone AS preference_timezone FROM users u JOIN user_preferences p ON p.user_id=u.id WHERE u.id=$1",
            [owner],
          )
        ).rows[0],
      ).toEqual({
        name: "Before fault",
        user_timezone: "UTC",
        preference_timezone: "UTC",
      });
    } finally {
      await admin.query(
        "DROP TRIGGER audit2_preference_failure ON user_preferences;DROP FUNCTION audit2_fail_preference_timezone()",
      );
    }
  });
  it("commits both timezone directions and preserves ordinary fields", async () => {
    const prefs = {
      language: "hi",
      locale: "hi-IN",
      currency: "inr",
      theme: "dark",
      timezone: "Europe/Paris",
      dateFormat: "DD/MM/YYYY",
      timeFormat: "24h",
    };
    expect(
      (await api("/api/settings/preferences", { method: "PUT", body: prefs }))
        .status,
    ).toBe(200);
    expect(
      (
        await api("/api/settings/profile", {
          method: "PUT",
          body: { name: "Updated owner", timezone: "UTC" },
        })
      ).status,
    ).toBe(200);
    expect((await api("/api/settings/preferences")).body).toMatchObject({
      ...prefs,
      currency: "INR",
      timezone: "UTC",
    });
    expect((await api("/api/settings/profile")).body).toMatchObject({
      name: "Updated owner",
      timezone: "UTC",
    });
    expect(
      (
        await api("/api/settings/profile", {
          method: "PUT",
          token: otherToken,
          profile: otherProfile,
          body: { name: "Other unchanged owner" },
        })
      ).status,
    ).toBe(200);
    expect((await api("/api/settings/profile")).body.name).toBe(
      "Updated owner",
    );
  });
  it("serializes concurrent timezone writers without splitting the mirrors", async () => {
    const prefs = {
      language: "en",
      locale: "en-US",
      currency: "USD",
      theme: "system",
      timezone: "Europe/Paris",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "24h",
    };
    const responses = await Promise.all([
      api("/api/settings/preferences", { method: "PUT", body: prefs }),
      api("/api/settings/profile", {
        method: "PUT",
        body: { name: "Concurrent owner", timezone: "Asia/Tokyo" },
      }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const row = (
      await admin.query(
        "SELECT u.name,u.timezone AS user_timezone,p.timezone AS preference_timezone FROM users u JOIN user_preferences p ON p.user_id=u.id WHERE u.id=$1",
        [owner],
      )
    ).rows[0];
    expect(["Europe/Paris", "Asia/Tokyo"]).toContain(row.user_timezone);
    expect(row.preference_timezone).toBe(row.user_timezone);
    expect(row.name).toBe("Concurrent owner");
  });
  it("replays every accepted coalesced request key after completion and while another job is active", async () => {
    const { withBusinessScope } = await import("../tenancy/businessContext.js");
    const { processGeneralJob } = await import("../workers/index.js");
    const created = await api("/api/settings/business-profiles", {
      method: "POST",
      body: { name: "Receipt replay fixture" },
    });
    expect(created.status).toBe(201);
    const profile = created.body.id;
    const path = "/api/setup/website-analysis/jobs";
    const keys = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const submit = (
      key: string,
      url = "receipt-audit.example",
      forceRefresh = false,
    ) =>
      api(path, {
        method: "POST",
        profile,
        body: { url, forceRefresh, idempotencyKey: key },
      });
    const first = await submit(keys[0]);
    const coalesced = await Promise.all(
      keys.slice(1).map((key) => submit(key)),
    );
    expect([first, ...coalesced].map((r) => r.status)).toEqual([
      202, 202, 202, 202,
    ]);
    expect(coalesced.map((r) => r.body.job.id)).toEqual([
      first.body.job.id,
      first.body.job.id,
      first.body.job.id,
    ]);
    const payload = enqueue.mock.calls.find(
      (call) =>
        (call[2] as { analysisJobId: string })?.analysisJobId ===
        first.body.job.id,
    )?.[2];
    await withBusinessScope({ userId: owner, businessProfileId: profile }, () =>
      processGeneralJob({
        data: payload,
        opts: { attempts: 1 },
      } as import("bullmq").Job),
    );
    expect(
      (await api(`${path}/${first.body.job.id}`, { profile })).body.job.status,
    ).toBe("completed");
    const replay = await Promise.all(keys.map((key) => submit(key)));
    expect(replay.map((r) => r.body.job.id)).toEqual(
      keys.map(() => first.body.job.id),
    );
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS total FROM workspace_website_analysis_jobs WHERE business_profile_id=$1",
          [profile],
        )
      ).rows[0].total,
    ).toBe(1);
    expect((await submit(keys[1], "other-audit.example")).status).toBe(409);
    expect((await submit(keys[1], "receipt-audit.example", true)).status).toBe(
      409,
    );
    const next = await submit(randomUUID(), "next-audit.example");
    expect(next.status).toBe(202);
    expect((await submit(keys[0])).body.job.id).toBe(first.body.job.id);
    expect(
      (
        await api(`${path}/${first.body.job.id}`, {
          profile: otherProfile,
          token: otherToken,
        })
      ).status,
    ).toBe(404);
  });

  it("keeps a legacy primary request receipt without rewriting guarded rows", async () => {
    const { withBusinessScope } = await import("../tenancy/businessContext.js");
    const key = randomUUID(),
      id = randomUUID();
    await withBusinessScope({ userId: owner, businessProfileId: north }, () =>
      pool.query(
        "INSERT INTO workspace_website_analysis_jobs(id,user_id,business_profile_id,url,idempotency_key,status) VALUES($1,$2,$3,'https://legacy-receipt.example/',$4,'completed')",
        [id, owner, north, key],
      ),
    );
    const response = await api("/api/setup/website-analysis/jobs", {
      method: "POST",
      body: { url: "legacy-receipt.example", idempotencyKey: key },
    });
    expect(response.status).toBe(202);
    expect(response.body.job.id).toBe(id);
    expect(
      (
        await admin.query(
          "SELECT accepted_request_keys FROM workspace_website_analysis_jobs WHERE id=$1",
          [id],
        )
      ).rows[0].accepted_request_keys,
    ).toEqual([]);
  });
  // Data owns the global envelope. Enable this gate when composing its canonical contract.
  (process.env.SETUP_CANONICAL_ENVELOPE_TEST ? it : it.skip)(
    "CANONICAL draft cleanup receives tombstones and preserves genuine conflicts",
    async () => {
      const path = "/api/setup/drafts/workspace:first";
      const first = await api(path, {
        method: "PUT",
        body: {
          data: { name: "Original draft" },
          step: 1,
          expectedRevision: 0,
        },
      });
      expect(first.status).toBe(200);
      expect(
        (
          await api(path, {
            method: "DELETE",
            body: { expectedRevision: first.body.draft.revision },
          })
        ).status,
      ).toBe(200);
      const cleared = await api(path, {
        method: "DELETE",
        body: { expectedRevision: first.body.draft.revision },
      });
      expect(cleared.status).toBe(409);
      expect(cleared.wire).toMatchObject({
        success: false,
        code: "SETUP_DRAFT_CONFLICT",
        draft: null,
      });
      const newer = await api(path, {
        method: "PUT",
        body: { data: { name: "Newer draft" }, step: 2, expectedRevision: 0 },
      });
      expect(newer.status).toBe(200);
      const stale = await api(path, {
        method: "PUT",
        body: { data: { name: "Stale edit" }, step: 1, expectedRevision: 0 },
      });
      expect(stale.status).toBe(409);
      expect(stale.wire).toMatchObject({
        code: "SETUP_DRAFT_CONFLICT",
        draft: {
          data: { name: "Newer draft" },
          revision: newer.body.draft.revision,
        },
      });
    },
  );
  const browserTest = process.env.WORKSPACE_AUDIT_BROWSER_URL ? it : it.skip;
  browserTest.each([390, 768, 1440])(
    "BROWSER corrected setup and recovery at width %i",
    async (width) => {
      const origin = process.env.WORKSPACE_AUDIT_BROWSER_URL!;
      if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin))
        throw new Error("Only a local audit frontend is permitted.");
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({
        executablePath: "/usr/bin/chromium",
      });
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
      });
      // App-shell sockets are a synthetic boundary too. Leaving them native
      // sends the local API origin back through Next's own proxy indefinitely.
      // Keep Next's development socket available for normal asset updates.
      await page.addInitScript({
        content: `(() => {
        const Native = window.WebSocket;
        class AuditSocket extends EventTarget {
          static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
          CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
          readyState = 1; bufferedAmount = 0; extensions = ''; protocol = ''; binaryType = 'blob';
          constructor(url) { super(); this.url = String(url); queueMicrotask(() => {
            const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event);
          }); }
          send() {}
          close() { this.readyState = 3; }
        }
        class RoutedSocket {
          static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
          constructor(url, protocols) {
            const target = new URL(String(url), location.href);
            return target.pathname === '/_next/webpack-hmr' ? new Native(url, protocols) : new AuditSocket(url);
          }
        }
        window.WebSocket = RoutedSocket;
      })();`,
      });
      await page.context().addCookies([
        {
          name: "asksales_session",
          value: ownerToken,
          url: origin,
          httpOnly: true,
          sameSite: "Lax",
        },
        {
          name: "asksales_session",
          value: ownerToken,
          url: base,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const unexpectedMutations: string[] = [];
      const apiResponses: Array<{ path: string; status: number }> = [];
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith("/api/"))
          apiResponses.push({ path, status: response.status() });
      });
      try {
        // App-shell providers are synthetic. All setup/business/toolkit requests
        // below bridge to the actual authenticated HTTP application and database.
        await page.route("**/api/**", (route) => {
          if (!["GET", "HEAD"].includes(route.request().method()))
            unexpectedMutations.push(
              route.request().method() +
                " " +
                new URL(route.request().url()).pathname,
            );
          return route.fulfill({
            status: route.request().method() === "GET" ? 200 : 409,
            json: {},
          });
        });
        for (const [path, json] of Object.entries({
          "/api/platform/access": {
            maintenance: { enabled: false, message: "" },
            modules: [],
          },
          "/api/settings/preferences": {
            theme: "light",
            language: "en",
            timezone: "UTC",
          },
          "/api/organizations": { organizations: [] },
          "/api/wallet": { balance: 10000 },
          "/api/notifications/unread/count": { count: 0 },
        }))
          await page.route("**" + path, (route) => route.fulfill({ json }));
        await page.route("**/api/auth/me", (route) =>
          route.fulfill({
            json: {
              user: {
                id: owner,
                name: "Audit owner",
                email: "audit@example.invalid",
                isSetupComplete: true,
                isApproved: true,
                hasBusinessProfile: true,
                hasBrandToolkit: true,
              },
            },
          }),
        );
        await page.route("**/api/**", async (route) => {
          const url = new URL(route.request().url());
          if (
            !/^\/api\/(?:setup\/|settings\/business-profiles(?:\/|$)|content\/brand-toolkits(?:\/|$)|auth\/(?:me|csrf-token|mark-setup-complete)$)/.test(
              url.pathname,
            )
          )
            return route.fallback();
          const response = await route.fetch({
            url: base + url.pathname + url.search,
          });
          return route.fulfill({ response });
        });
        await admin.query(
          "UPDATE users SET is_approved=$1,is_setup_complete=$1 WHERE id=$2",
          [width === 1440, owner],
        );
        await admin.query(
          "UPDATE workspace_setup_drafts SET data=NULL,revision=revision+1 WHERE user_id=$1 AND draft_key='workspace:new'",
          [owner],
        );
        const name = `Audit browser ${width} ${randomUUID()}`;
        await page.goto(origin + "/setup/business-profile/new");
        await page.getByLabel("Website URL").focus();
        const websiteFieldId = await page
          .getByLabel("Website URL")
          .getAttribute("id");
        expect(websiteFieldId).toBeTruthy();
        expect(await page.evaluate<string>("document.activeElement?.id")).toBe(
          websiteFieldId,
        );
        expect(await page.evaluate("window.devicePixelRatio")).toBe(1);
        if (width === 390) {
          await page
            .getByLabel("Website URL")
            .fill("https://browser-audit.example");
          await page
            .getByRole("button", { name: "Analyze website", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Stop analysis", exact: true })
            .waitFor();
          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "DELETE" &&
                response.url().includes("/api/setup/website-analysis/jobs/"),
            ),
            page
              .getByRole("button", { name: "Stop analysis", exact: true })
              .click(),
          ]);
          const cancelled = (
            await admin.query(
              "SELECT status FROM workspace_website_analysis_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
              [owner],
            )
          ).rows[0];
          expect(cancelled.status).toBe("cancelled");
        }
        if (width === 768) {
          await page
            .getByLabel("Website URL")
            .fill("https://archive-browser-audit.example");
          await page
            .getByRole("button", { name: "Analyze website", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Stop analysis", exact: true })
            .waitFor();
          const current = (
            await admin.query(
              "SELECT j.id,j.business_profile_id,p.version FROM workspace_website_analysis_jobs j JOIN company_settings p ON p.id=j.business_profile_id WHERE j.user_id=$1 ORDER BY j.created_at DESC LIMIT 1",
              [owner],
            )
          ).rows[0];
          expect(
            (
              await api(
                `/api/settings/business-profiles/${current.business_profile_id}/archive`,
                {
                  method: "POST",
                  profile: current.business_profile_id,
                  body: { expectedVersion: current.version },
                },
              )
            ).status,
          ).toBe(200);
          await page
            .getByText(
              "This workspace or analysis is no longer available. Your saved details are preserved. Reload to check access.",
              { exact: true },
            )
            .waitFor();
          await page.waitForTimeout(5500);
          expect(
            apiResponses.filter(
              (r) => r.path.endsWith(current.id) && r.status === 403,
            ),
          ).toHaveLength(1);
          expect(
            await page
              .getByRole("button", { name: "Stop analysis", exact: true })
              .count(),
          ).toBe(0);
          expect(
            await page
              .getByRole("button", {
                name: "Reload workspace status",
                exact: true,
              })
              .isVisible(),
          ).toBe(true);
          const after = (
            await admin.query(
              "SELECT status FROM workspace_website_analysis_jobs WHERE id=$1",
              [current.id],
            )
          ).rows[0];
          await writeFile(
            `${evidenceDirectory}/archive-poll.json`,
            JSON.stringify(
              {
                job: current.id,
                status: after.status,
                message: await page
                  .getByText(
                    "This workspace or analysis is no longer available. Your saved details are preserved. Reload to check access.",
                    { exact: true },
                  )
                  .innerText(),
                stopVisible:
                  (await page
                    .getByRole("button", { name: "Stop analysis", exact: true })
                    .count()) > 0,
                responses: apiResponses.filter((r) =>
                  r.path.endsWith(current.id),
                ),
              },
              null,
              2,
            ),
          );
          expect(after.status).toBe("cancelled");
          const archived = (
            await admin.query(
              "SELECT version FROM company_settings WHERE id=$1",
              [current.business_profile_id],
            )
          ).rows[0];
          expect(
            (
              await api(
                `/api/settings/business-profiles/${current.business_profile_id}/restore`,
                {
                  method: "POST",
                  profile: current.business_profile_id,
                  body: { expectedVersion: archived.version },
                },
              )
            ).status,
          ).toBe(200);
          await page.reload();
          await page
            .getByRole("button", {
              name: "Use latest saved details",
              exact: true,
            })
            .waitFor();
          page.once("dialog", (dialog) => dialog.accept());
          await page
            .getByRole("button", {
              name: "Use latest saved details",
              exact: true,
            })
            .click();
          await page
            .getByRole("button", {
              name: "Use latest saved details",
              exact: true,
            })
            .waitFor({ state: "hidden" });
        }
        await page
          .getByRole("button", {
            name: /^(Enter details manually|Continue with saved details)$/,
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: "Individual", exact: true })
          .click();
        await page.getByLabel("Workspace name *").fill(name);
        await page.getByLabel("Country", { exact: true }).selectOption("India");
        await page.getByLabel("Time zone", { exact: true }).selectOption("UTC");
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page
          .getByLabel("Short description *")
          .fill("A synthetic workspace for local setup verification.");
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Personal productivity", exact: true })
          .click();
        await page
          .getByLabel("First goal (optional)")
          .fill("Preserve real database handoffs");
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Skip for now", exact: true })
          .click();
        await page.waitForURL(/\/setup\/brand-toolkit\/\d+$/);
        const id = Number(new URL(page.url()).pathname.split("/").at(-1));
        expect(
          (
            await admin.query(
              "SELECT name,workspace_type,setup_goal FROM company_settings WHERE id=$1 AND user_id=$2",
              [id, owner],
            )
          ).rows[0],
        ).toEqual({
          name,
          workspace_type: "individual",
          setup_goal: "Preserve real database handoffs",
        });
        await page.evaluate("sessionStorage.clear()");
        await page.reload();
        expect(
          await page.getByLabel("Your name or project name *").inputValue(),
        ).toBe(name);
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Friendly", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Review essentials", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Review your toolkit", exact: true })
          .waitFor();
        expect(
          await page.evaluate<boolean>(
            "document.documentElement.scrollWidth <= window.innerWidth + 1",
          ),
        ).toBe(true);
        await page.screenshot({
          path: `${evidenceDirectory}/browser-real-${width}.png`,
          fullPage: true,
        });
        await page
          .getByRole("button", { name: "Finish setup", exact: true })
          .click();
        await page.waitForURL(
          width !== 1440
            ? /\/setup\/account-verification(?:\?|$)/
            : /\/dashboard\/home(?:\?|$)/,
        );
        await writeFile(
          `${evidenceDirectory}/browser-completion-${width}.json`,
          JSON.stringify(
            {
              url: page.url(),
              viewport: page.viewportSize(),
              zoom: await page.evaluate("window.devicePixelRatio"),
              warnings: await page
                .getByText("An unfinished draft could not be cleared.", {
                  exact: false,
                })
                .allTextContents(),
              apiResponses,
            },
            null,
            2,
          ),
        );
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS total FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2",
              [owner, id],
            )
          ).rows[0].total,
        ).toBe(1);
        expect(
          (await api(`/api/setup/drafts/brand:${id}`)).body.draft,
        ).toBeNull();
        if (process.env.SETUP_CANONICAL_ENVELOPE_TEST) {
          expect(
            await page
              .getByText("An unfinished draft could not be cleared.", {
                exact: false,
              })
              .count(),
          ).toBe(0);
        }
        expect(unexpectedMutations).toEqual([]);
      } catch (error) {
        await page.screenshot({
          path: `${evidenceDirectory}/browser-real-failure-${width}.png`,
          fullPage: true,
        });
        await writeFile(
          `${evidenceDirectory}/browser-real-failure-${width}.json`,
          JSON.stringify(
            {
              url: page.url(),
              body: await page.locator("body").innerText(),
              apiResponses,
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await browser.close();
      }
    },
    90000,
  );
});
