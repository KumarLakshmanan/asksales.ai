import { beforeAll, afterAll, describe, it, expect, jest } from "@jest/globals";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { assertBusinessScopeSchema } from "../tenancy/schemaGuard.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

const database = process.env.WORKSPACE_RECOVERY_TEST_DATABASE;
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
let workerMode: "success" | "cancel" = "success";
let releaseProvider: (() => void) | undefined,
  providerEntered: (() => void) | undefined;
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
    if (workerMode === "cancel") {
      providerEntered?.();
      await new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
    }
    await withSetupAnalysisCommit(async (executor) => {
      const { saveWorkspaceWebsiteAnalysis } = await import("../services/workspaceWebsiteAnalysis.js");
      const { requireBusinessScope } = await import("../tenancy/businessContext.js");
      const scope = requireBusinessScope();
      await saveWorkspaceWebsiteAnalysis(scope.userId, scope.businessProfileId, "https://fixture.example/", { companyName: "Fixture" }, null, { pages: 2, knowledgeSaved: false, warnings: [] }, executor);
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
const { processGeneralJob } = await import("../workers/index.js");
const {
  getBusinessProfiles,
  getBusinessProfile,
  setDefaultBusinessProfile,
  archiveBusinessProfile,
  createBusinessProfile,
  updateBusinessProfile,
  deleteBusinessProfile,
} = await import("../controllers/businessProfilesController.js");
const { markSetupComplete } = await import("../controllers/authController.js");
const { setupReadiness } =
  await import("../controllers/setupReadinessController.js");
const { getNotificationPreferencesHandler, updateNotificationPreferencesHandler, getUserProfileHandler, updateUserProfileHandler } =
  await import("../controllers/userProfileController.js");
const { getUserPreferences, updateUserPreferences } = await import("../controllers/settingsController.js");
const { objectStorage } = await import("../services/ObjectStorageService.js");
const removeObject = jest.spyOn(objectStorage, "delete").mockResolvedValue(undefined);
const { runBusinessJob } = await import("../tenancy/jobBusinessScope.js");
const { createBrandToolkit, updateBrandToolkit, getBrandToolkits } =
  await import("../controllers/brandToolkitController.js");
const { validateBody } = await import("../middleware/validation.js");
const { brandToolkitSchema } = await import("../middleware/schemas.js");
let owner: number,
  other: number,
  member: number,
  north: number,
  south: number,
  otherProfile: number;
let ownerToken: string, otherToken: string, memberToken: string;
function queuedPayload(id: string) {
  const call = enqueue.mock.calls.find(
    (call) => (call[2] as { analysisJobId: string })?.analysisJobId === id,
  );
  expect(call?.[0]).toBe("general");
  expect((call?.[2] as { type: string })?.type).toBe(
    "workspace-website-analysis",
  );
  return call?.[2];
}
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
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}
suite(
  "workspace recovery APIs through real authenticated HTTP and PostgreSQL",
  () => {
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
      [north, south, otherProfile] = profiles.rows.map((row) => row.id);
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
      memberToken = generateToken({
        userId: member,
        email: `member-${suffix}@example.invalid`,
      });
      const app = express();
      app.use(express.json({ limit: "300kb" }));
      app.get("/api/settings/profile/notification-preferences", authenticateToken, getNotificationPreferencesHandler);
      app.put("/api/settings/profile/notification-preferences", authenticateToken, updateNotificationPreferencesHandler);
      app.get("/api/settings/profile", authenticateToken, getUserProfileHandler);
      app.put("/api/settings/profile", authenticateToken, updateUserProfileHandler);
      app.get("/api/settings/preferences", authenticateToken, getUserPreferences);
      app.put("/api/settings/preferences", authenticateToken, updateUserPreferences);
      app.all("/api/setup/drafts/:draftKey", authenticateToken, setupDraft);
      app.post(
        "/api/auth/mark-setup-complete",
        authenticateToken,
        markSetupComplete,
      );
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
      app.get(
        "/api/setup/onboarding-status",
        authenticateToken,
        setupReadiness,
      );
      app.post(
        "/api/content/brand-toolkits",
        authenticateToken,
        validateBody(brandToolkitSchema),
        createBrandToolkit,
      );
      app.get("/api/content/brand-toolkits", authenticateToken, getBrandToolkits);
      app.put(
        "/api/content/brand-toolkits/:id",
        authenticateToken,
        validateBody(brandToolkitSchema.partial()),
        updateBrandToolkit,
      );
      app.get(
        "/api/settings/business-profiles",
        authenticateToken,
        getBusinessProfiles,
      );
      app.get("/api/settings/business-profiles/:id", authenticateToken, getBusinessProfile);
      app.post("/api/settings/business-profiles/:id/default", authenticateToken, setDefaultBusinessProfile);
      app.post(
        "/api/settings/business-profiles",
        authenticateToken,
        createBusinessProfile,
      );
      app.put(
        "/api/settings/business-profiles/:id",
        authenticateToken,
        updateBusinessProfile,
      );
      app.delete(
        "/api/settings/business-profiles/:id",
        authenticateToken,
        deleteBusinessProfile,
      );
      app.post(
        "/api/settings/business-profiles/:id/archive",
        authenticateToken,
        archiveBusinessProfile,
      );
      app.post(
        "/api/settings/business-profiles/:id/restore",
        authenticateToken,
        archiveBusinessProfile,
      );
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
    it("deletes an empty owned profile from the chooser while a different business is selected", async () => {
      const created = await api("/api/settings/business-profiles", {
        method: "POST", body: { name: "Disposable empty workspace" },
      });
      expect(created.status).toBe(201);
      const removed = await api(`/api/settings/business-profiles/${created.body.id}`, { method: "DELETE" });
      expect(removed).toEqual({ status: 200, body: { success: true } });
      expect((await admin.query("SELECT id FROM company_settings WHERE id=$1", [created.body.id])).rowCount).toBe(0);
    });
    async function disposableProfile() {
      const created = await api("/api/settings/business-profiles", {method: "POST", body: {name: "Disposable setup workspace"}});
      expect(created.status).toBe(201);
      const id = Number(created.body.id), key = `${owner}/brand_asset/${randomUUID()}.png`;
      await withBusinessScope({userId: owner, businessProfileId: id}, async () => {
        await pool.query("INSERT INTO storage_files(user_id,business_profile_id,file_name,storage_key,storage_backend,category,reference_type,file_size_bytes) VALUES($1,$2,'fixture.png',$3,'local','brand_asset','website_screenshot',10)", [owner,id,key]);
        await pool.query("INSERT INTO storage_quotas(user_id,storage_used_bytes,file_count) VALUES($1,10,1) ON CONFLICT(user_id) DO UPDATE SET storage_used_bytes=storage_quotas.storage_used_bytes+10,file_count=storage_quotas.file_count+1", [owner]);
        await pool.query("INSERT INTO brand_toolkits(user_id,business_profile_id,name) VALUES($1,$2,'Fixture toolkit')", [owner,id]);
        await pool.query("INSERT INTO workspace_website_analysis_jobs(id,user_id,business_profile_id,url,status) VALUES($1,$2,$3,'https://fixture.example','queued')", [randomUUID(),owner,id]);
        await pool.query("INSERT INTO workspace_setup_drafts(user_id,draft_key,data) VALUES($1,$2,$3)", [owner,`brand:${id}`,JSON.stringify({profileId:id})]);
      });
      return {id,key};
    }
    it("removes setup screenshots, toolkits, drafts and queued analysis in the target workspace", async () => {
      const {id,key} = await disposableProfile();
      const quota = (await admin.query("SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1",[owner])).rows[0];
      removeObject.mockClear();
      const removed = await api(`/api/settings/business-profiles/${id}`, {method: "DELETE"});
      expect(removed).toEqual({status: 200, body: {success:true}});
      expect(removeObject).toHaveBeenCalledWith(key);
      const afterQuota = (await admin.query("SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1",[owner])).rows[0];
      expect(Number(afterQuota.storage_used_bytes)).toBe(Number(quota.storage_used_bytes)-10);
      expect(afterQuota.file_count).toBe(quota.file_count-1);
      expect((await admin.query("SELECT id FROM storage_files WHERE business_profile_id=$1", [id])).rowCount).toBe(0);
      expect((await admin.query("SELECT id FROM brand_toolkits WHERE business_profile_id=$1", [id])).rowCount).toBe(0);
      expect((await admin.query("SELECT id FROM workspace_website_analysis_jobs WHERE business_profile_id=$1", [id])).rowCount).toBe(0);
      const draft=(await admin.query("SELECT data,revision FROM workspace_setup_drafts WHERE user_id=$1 AND draft_key=$2", [owner,`brand:${id}`])).rows[0];
      expect(draft).toMatchObject({data:null,revision:2});
      expect((await admin.query("SELECT id FROM company_settings WHERE id=ANY($1::integer[])", [[north,south,otherProfile]])).rowCount).toBe(3);
    });
    it("returns an actionable conflict and rolls back setup cleanup when other records exist", async () => {
      const {id,key} = await disposableProfile();
      await withBusinessScope({userId:owner,businessProfileId:id}, () => pool.query("INSERT INTO storage_files(user_id,business_profile_id,file_name,storage_key,category) VALUES($1,$2,'document.txt',$3,'document')",[owner,id,`${owner}/document/${randomUUID()}`]));
      removeObject.mockClear();
      const blocked = await api(`/api/settings/business-profiles/${id}`, {method:"DELETE"});
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("BUSINESS_PROFILE_HAS_RECORDS");
      expect(blocked.body.error).toContain("Archive");
      expect(removeObject).not.toHaveBeenCalled();
      expect((await admin.query("SELECT id FROM storage_files WHERE business_profile_id=$1",[id])).rowCount).toBe(2);
      expect((await admin.query("SELECT id FROM brand_toolkits WHERE business_profile_id=$1",[id])).rowCount).toBe(1);
      expect((await admin.query("SELECT status FROM workspace_website_analysis_jobs WHERE business_profile_id=$1",[id])).rows[0].status).toBe("queued");
      expect((await admin.query("SELECT id FROM business_profile_asset_cleanup WHERE storage_key=$1",[key])).rowCount).toBe(0);
    });
    it("retains failed object cleanup for the standalone cron even without a live target profile", async () => {
      const {id,key} = await disposableProfile();
      removeObject.mockRejectedValueOnce(new Error("Storage unavailable"));
      expect((await api(`/api/settings/business-profiles/${id}`,{method:"DELETE"})).status).toBe(200);
      expect((await admin.query("SELECT attempts FROM business_profile_asset_cleanup WHERE storage_key=$1",[key])).rows[0].attempts).toBe(1);
      await runBusinessJob({systemJob:true,type:"cron-storage-object-cleanup"}, async()=>undefined);
      expect((await admin.query("SELECT id FROM business_profile_asset_cleanup WHERE storage_key=$1",[key])).rowCount).toBe(0);
    });
    it("does not allow another owner or a staff member to delete a profile", async () => {
      const {id,key} = await disposableProfile();
      removeObject.mockClear();
      expect((await api(`/api/settings/business-profiles/${id}`,{method:"DELETE",token:otherToken,profile:otherProfile})).status).toBe(404);
      expect((await api(`/api/settings/business-profiles/${north}`,{method:"DELETE",token:memberToken})).status).toBe(404);
      expect((await admin.query("SELECT id FROM storage_files WHERE storage_key=$1",[key])).rowCount).toBe(1);
      expect(removeObject).not.toHaveBeenCalled();
    });
    it("deletes the final profile and replaces defaults with active profiles rather than archives", async () => {
      const email=`delete-default-${randomUUID()}@example.invalid`;
      const actor=Number((await admin.query("INSERT INTO users(email,password,name) VALUES($1,'fixture','Delete fixture') RETURNING id",[email])).rows[0].id);
      const token=generateToken({userId:actor,email});
      const first=await api("/api/settings/business-profiles",{method:"POST",token,body:{name:"Default"}});
      const second=await api("/api/settings/business-profiles",{method:"POST",token,body:{name:"Active replacement"}});
      const archived=await api("/api/settings/business-profiles",{method:"POST",token,body:{name:"Archive"}});
      await admin.query("UPDATE company_settings SET archived_at=now(),updated_at=now()+interval '1 day' WHERE id=$1",[archived.body.id]);
      expect((await api(`/api/settings/business-profiles/${first.body.id}`,{method:"DELETE",token})).status).toBe(200);
      expect((await admin.query("SELECT default_business_profile_id FROM business_profile_preferences WHERE user_id=$1",[actor])).rows[0].default_business_profile_id).toBe(second.body.id);
      expect((await api(`/api/settings/business-profiles/${archived.body.id}`,{method:"DELETE",token})).status).toBe(200);
      expect((await api(`/api/settings/business-profiles/${second.body.id}`,{method:"DELETE",token,profile:first.body.id})).status).toBe(200);
      expect((await api("/api/settings/business-profiles",{token,profile:second.body.id})).body).toEqual([]);
      expect((await admin.query("SELECT default_business_profile_id FROM business_profile_preferences WHERE user_id=$1",[actor])).rows[0].default_business_profile_id).toBeNull();
    });
    it("requires real authentication and rejects invalid/foreign/member draft keys", async () => {
      expect(
        (await api("/api/setup/drafts/workspace:first", { token: "" })).status,
      ).toBe(401);
      expect(
        (await api("/api/setup/drafts/workspace:first", { token: "invalid" }))
          .status,
      ).toBe(401);
      expect((await api("/api/setup/drafts/not-valid")).status).toBe(400);
      expect(
        (await api(`/api/setup/drafts/brand:${north}`, { token: memberToken }))
          .status,
      ).toBe(403);
      expect(
        (await api(`/api/setup/drafts/brand:${otherProfile}`)).status,
      ).toBe(403);
    });
    it("selects an accessible default while another business is active and rejects a foreign default", async () => {
      expect((await api(`/api/settings/business-profiles/${south}/default`, { method: "POST" })).status).toBe(200);
      const selected = await api("/api/settings/business-profiles");
      expect(selected.body.filter((profile: { isDefault: boolean }) => profile.isDefault).map((profile: { id: number }) => profile.id)).toEqual([south]);
      expect((await api(`/api/settings/business-profiles/${otherProfile}/default`, { method: "POST" })).status).toBe(403);
      expect((await api(`/api/settings/business-profiles/${north}/default`, { method: "POST" })).status).toBe(200);
    });
    it("preserves concurrent changes to different ordinary notification preferences", async () => {
      const path = "/api/settings/profile/notification-preferences";
      await admin.query("UPDATE users SET notification_preferences=$1 WHERE id=$2", [JSON.stringify({ leadAlerts: true, campaignUpdates: true, weeklyReports: true }), owner]);
      const lock = await admin.connect();
      const observer = new Pool({ host: "/tmp", database, max: 1 });
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const first = api(path, { method: "PUT", body: { leadAlerts: false } });
      const second = api(path, { method: "PUT", body: { campaignUpdates: false } });
      try {
        // Hold the real row lock until both updates have reached PostgreSQL.
        // The old read/merge/write implementation then deterministically loses
        // one edit; an atomic JSONB merge preserves both after serialization.
        let waiting = 0;
        const deadline = Date.now() + 5000;
        while (waiting < 2 && Date.now() < deadline) {
          const result = await observer.query("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'update \"users\"%'");
          waiting = result.rows[0].waiting;
          if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(2);
      } finally {
        await lock.query("COMMIT");
        lock.release();
        await observer.end();
      }
      expect((await Promise.all([first, second])).map(result => result.status)).toEqual([200, 200]);
      expect((await api(path)).body).toMatchObject({ leadAlerts: false, campaignUpdates: false, weeklyReports: true });
      expect((await api(path, { method: "PUT", body: { leadAlerts: "false" } })).status).toBe(400);
      expect((await api(path, { token: otherToken, profile: otherProfile })).body).toMatchObject({ leadAlerts: true, campaignUpdates: true });
    });
    it("persists only the actor's ordinary profile and formatting preferences with timezone mirrors", async () => {
      expect((await api("/api/settings/profile", { method: "PUT", body: { phone: "invalid phone" } })).status).toBe(400);
      const profile = await api("/api/settings/profile", { method: "PUT", body: { name: "Revised synthetic owner", bio: "Local audit biography", phone: "+1 555 010 2000", timezone: "UTC" } });
      expect(profile.status).toBe(200);
      expect((await api("/api/settings/profile")).body).toMatchObject({ name: "Revised synthetic owner", bio: "Local audit biography", timezone: "UTC" });
      const preferences = { language: "hi", locale: "hi-IN", currency: "inr", theme: "dark", timezone: "Europe/Paris", dateFormat: "DD/MM/YYYY", timeFormat: "24h" };
      const saved = await api("/api/settings/preferences", { method: "PUT", body: preferences });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ ...preferences, currency: "INR" });
      expect((await api("/api/settings/preferences")).body).toEqual(saved.body);
      expect((await admin.query("SELECT timezone FROM users WHERE id=$1", [owner])).rows[0].timezone).toBe("Europe/Paris");
      expect((await admin.query("SELECT timezone,dark_mode FROM user_preferences WHERE user_id=$1", [owner])).rows[0]).toEqual({ timezone: "Europe/Paris", dark_mode: true });
      expect((await api("/api/settings/preferences", { method: "PUT", body: { ...preferences, timezone: "Mars/Olympus" } })).status).toBe(400);
      expect((await api("/api/settings/profile", { token: otherToken, profile: otherProfile })).body.name).toBe("Other");
      expect((await api("/api/settings/preferences", { token: otherToken, profile: otherProfile })).body.currency).toBe("USD");
    });
    const browserTest = process.env.WORKSPACE_AUDIT_BROWSER_URL ? it : it.skip;
    browserTest.each([390, 1440])("creates a workspace and toolkit through Chromium, real HTTP and PostgreSQL at width %i", async width => {
      const origin = process.env.WORKSPACE_AUDIT_BROWSER_URL!;
      if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error("Only a local audit frontend is permitted.");
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      // App-shell sockets are a synthetic boundary too. Leaving them native
      // sends the local API origin back through Next's own proxy indefinitely.
      // Keep Next's development socket available for normal asset updates.
      await page.addInitScript({ content: `(() => {
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
      })();` });
      await page.context().addCookies([
        { name: "asksales_session", value: ownerToken, url: origin, httpOnly: true, sameSite: "Lax" },
        { name: "asksales_session", value: ownerToken, url: base, httpOnly: true, sameSite: "Lax" },
      ]);
      const unexpectedMutations: string[] = [];
      const apiResponses: Array<{ path: string; status: number }> = [];
      page.on("response", response => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith("/api/")) apiResponses.push({ path, status: response.status() });
      });
      try {
        // App-shell providers are synthetic. All setup/business/toolkit requests
        // below bridge to the actual authenticated HTTP application and database.
        await page.route("**/api/**", route => {
          if (!["GET", "HEAD"].includes(route.request().method())) unexpectedMutations.push(route.request().method() + " " + new URL(route.request().url()).pathname);
          return route.fulfill({ status: route.request().method() === "GET" ? 200 : 409, json: {} });
        });
        for (const [path, json] of Object.entries({
          "/api/platform/access": { maintenance: { enabled: false, message: "" }, modules: [] },
          "/api/settings/preferences": { theme: "light", language: "en", timezone: "UTC" },
          "/api/organizations": { organizations: [] },
          "/api/wallet": { balance: 10000 },
          "/api/notifications/unread/count": { count: 0 },
        })) await page.route("**" + path, route => route.fulfill({ json }));
        await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: owner, name: "Audit owner", email: "audit@example.invalid", isSetupComplete: true, isApproved: true, hasBusinessProfile: true, hasBrandToolkit: true } } }));
        await page.route("**/api/**", async route => {
          const url = new URL(route.request().url());
          if (!/^\/api\/(?:setup\/|settings\/business-profiles(?:\/|$)|content\/brand-toolkits(?:\/|$)|auth\/mark-setup-complete$)/.test(url.pathname)) return route.fallback();
          const response = await route.fetch({ url: base + url.pathname + url.search });
          return route.fulfill({ response });
        });
        await admin.query("UPDATE workspace_setup_drafts SET data=NULL,revision=revision+1 WHERE user_id=$1 AND draft_key='workspace:new'", [owner]);
        const name = `Browser workspace ${width} ${randomUUID()}`;
        await page.goto(origin + "/setup/business-profile/new");
        await page.getByRole("button", { name: "Enter details manually", exact: true }).click();
        await page.getByRole("button", { name: "Individual", exact: true }).click();
        await page.getByLabel("Workspace name *").fill(name);
        await page.getByLabel("Country", { exact: true }).selectOption("India");
        await page.getByLabel("Time zone", { exact: true }).selectOption("UTC");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByLabel("Short description *").fill("A synthetic workspace for local setup verification.");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("button", { name: "Personal productivity", exact: true }).click();
        await page.getByLabel("First goal (optional)").fill("Preserve real database handoffs");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("button", { name: "Skip for now", exact: true }).click();
        await page.waitForURL(/\/setup\/brand-toolkit\/\d+$/);
        const id = Number(new URL(page.url()).pathname.split("/").at(-1));
        expect((await admin.query("SELECT name,workspace_type,setup_goal FROM company_settings WHERE id=$1 AND user_id=$2", [id, owner])).rows[0]).toEqual({ name, workspace_type: "individual", setup_goal: "Preserve real database handoffs" });
        await page.evaluate("sessionStorage.clear()");
        await page.reload();
        expect(await page.getByLabel("Your name or project name *").inputValue()).toBe(name);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("button", { name: "Friendly", exact: true }).click();
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("button", { name: "Review essentials", exact: true }).click();
        await page.getByRole("heading", { name: "Review your toolkit", exact: true }).waitFor();
        expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
        await page.screenshot({ path: `/tmp/setup-audit-tools/browser-real-${width}.png`, fullPage: true });
        await page.getByRole("button", { name: "Finish setup", exact: true }).click();
        await page.waitForURL(/\/dashboard\/home(?:\?|$)/);
        expect((await admin.query("SELECT count(*)::int AS total FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2", [owner, id])).rows[0].total).toBe(1);
        expect((await api(`/api/setup/drafts/brand:${id}`)).body.draft).toBeNull();
        expect(unexpectedMutations).toEqual([]);
      } catch (error) {
        await page.screenshot({ path: `/tmp/setup-audit-tools/browser-real-failure-${width}.png`, fullPage: true });
        await writeFile(`/tmp/setup-audit-tools/browser-real-failure-${width}.json`, JSON.stringify({ url: page.url(), body: await page.locator("body").innerText(), apiResponses }, null, 2));
        throw error;
      } finally { await browser.close(); }
    }, 90000);
    it("isolates accounts, rejects stale revisions and retains monotonic revisions after deletion", async () => {
      const path = "/api/setup/drafts/workspace:first";
      const first = await api(path, {
        method: "PUT",
        body: {
          data: { profileId: north, name: "draft" },
          step: 2,
          expectedRevision: 0,
        },
      });
      expect(first.status).toBe(200);
      expect(first.body.draft.revision).toBe(1);
      expect((await api(path, { profile: 2147483647 })).status).toBe(200);
      expect(
        (await api(path, { token: otherToken, profile: otherProfile })).body
          .draft,
      ).toBeNull();
      expect(
        (
          await api(path, {
            method: "PUT",
            body: { data: { name: "stale" }, step: 2, expectedRevision: 0 },
          })
        ).status,
      ).toBe(409);
      const saved = await api(path, {
        method: "PUT",
        body: {
          data: { profileId: north, name: "new" },
          step: 3,
          expectedRevision: 1,
        },
      });
      expect(saved.body.draft.revision).toBe(2);
      expect(
        (await api(path, { method: "DELETE", body: { expectedRevision: 1 } }))
          .status,
      ).toBe(409);
      expect(
        (await api(path, { method: "DELETE", body: { expectedRevision: 2 } }))
          .status,
      ).toBe(200);
      expect((await api(path)).body.draft).toBeNull();
      const recreated = await api(path, {
        method: "PUT",
        body: {
          data: { profileId: north, name: "restart" },
          step: 0,
          expectedRevision: 0,
        },
      });
      expect(recreated.body.draft.revision).toBe(4);
      expect(
        (
          await api(path, {
            method: "PUT",
            body: { data: { name: "stale" }, step: 0, expectedRevision: 2 },
          })
        ).status,
      ).toBe(409);
    });
    it("validates draft objects, payload size, steps and referenced workspace ownership", async () => {
      for (const body of [
        { data: [], step: 0, expectedRevision: 0 },
        { data: "x", step: 0, expectedRevision: 0 },
        { data: { x: "x".repeat(270000) }, step: 0, expectedRevision: 0 },
        { data: {}, step: -1, expectedRevision: 0 },
        { data: {}, step: 1 },
      ])
        expect(
          (
            await api("/api/setup/drafts/workspace:new", {
              method: "PUT",
              body,
            })
          ).status,
        ).toBe(400);
      expect(
        (
          await api("/api/setup/drafts/workspace:new", {
            method: "PUT",
            body: {
              data: { profileId: otherProfile },
              step: 1,
              expectedRevision: 0,
            },
          })
        ).status,
      ).toBe(403);
    });
    it("allows exactly one concurrent save of a loaded draft revision", async () => {
      const path = `/api/setup/drafts/brand:${south}`;
      const created = await api(path, { method: "PUT", body: { data: { name: "Concurrent draft" }, step: 1, expectedRevision: 0 } });
      expect(created.status).toBe(200);
      const revision = created.body.draft.revision;
      const responses = await Promise.all(Array.from({ length: 8 }, (_, attempt) => api(path, { method: "PUT", body: { data: { attempt }, step: 2, expectedRevision: revision } })));
      expect(responses.filter(result => result.status === 200)).toHaveLength(1);
      expect(responses.filter(result => result.status === 409)).toHaveLength(7);
      const current = await api(path);
      expect(current.body.draft.revision).toBe(revision + 1);
      expect(current.body.draft.data).toEqual(responses.find(result => result.status === 200)!.body.draft.data);
      expect((await api(path, { method: "DELETE", body: { expectedRevision: current.body.draft.revision } })).status).toBe(200);
    });
    it("deduplicates concurrent analysis submissions in PostgreSQL before queue delivery", async () => {
      const path = "/api/setup/website-analysis/jobs";
      const responses = await Promise.all(Array.from({ length: 8 }, (_, attempt) => api(path, { method: "POST", body: { url: "concurrent.example", idempotencyKey: `concurrent-${attempt}` } })));
      expect(responses.every(result => result.status === 202)).toBe(true);
      const ids = new Set(responses.map(result => result.body.job.id));
      expect(ids.size).toBe(1);
      const id = responses[0].body.job.id;
      expect((await admin.query("SELECT count(*)::int AS total FROM workspace_website_analysis_jobs WHERE business_profile_id=$1 AND status IN('queued','running')", [north])).rows[0].total).toBe(1);
      expect((await api(`${path}/${id}`, { method: "DELETE" })).body.job.status).toBe("cancelled");
    });
    it("deduplicates analysis, isolates job IDs, exposes progress, cancels and retries", async () => {
      const path = "/api/setup/website-analysis/jobs";
      expect(
        (
          await api(path, {
            method: "POST",
            token: memberToken,
            body: { url: "fixture.example" },
          })
        ).status,
      ).toBe(403);
      const created = await api(path, {
        method: "POST",
        body: { url: "fixture.example", idempotencyKey: "fixture-1" },
      });
      expect(created.status).toBe(202);
      const id = created.body.job.id;
      expect(
        (
          await api(path, {
            method: "POST",
            body: { url: "fixture.example", idempotencyKey: "fixture-1" },
          })
        ).body.job.id,
      ).toBe(id);
      expect(
        (
          await api(path, {
            method: "POST",
            body: { url: "different.example" },
          })
        ).status,
      ).toBe(409);
      expect((await api(`${path}/${id}`, { profile: south })).status).toBe(404);
      expect((await api(`${path}/latest`)).body.job.id).toBe(id);
      expect(
        (await api(`${path}/${id}`, { method: "DELETE" })).body.job.status,
      ).toBe("cancelled");
      const retried = await api(`${path}/${id}/retry`, { method: "POST" });
      expect(retried.status).toBe(202);
      expect(retried.body.job.id).not.toBe(id);
      await withBusinessScope({ userId: owner, businessProfileId: north }, () =>
        processGeneralJob({
          data: queuedPayload(retried.body.job.id),
          opts: { attempts: 1 },
        } as import("bullmq").Job),
      );
      const completed = await api(`${path}/${retried.body.job.id}`);
      expect(completed.body.job.status).toBe("completed");
      expect(completed.body.job.progress.crawled).toBe(1);
      expect(completed.body.job.result.data.companyName).toBe("Fixture");
    });
    it("does not commit late provider results after cancellation", async () => {
      workerMode = "cancel";
      const created = await api("/api/setup/website-analysis/jobs", {
          method: "POST",
          body: { url: "late.example" },
        }),
        id = created.body.job.id;
      await admin.query(
        "UPDATE company_settings SET website_analysis=NULL WHERE id=$1",
        [north],
      );
      const entered = new Promise<void>((resolve) => {
        providerEntered = resolve;
      });
      const work = withBusinessScope(
        { userId: owner, businessProfileId: north },
        () =>
          processGeneralJob({
            data: queuedPayload(id),
            opts: { attempts: 1 },
          } as import("bullmq").Job),
      );
      await entered;
      expect(
        (
          await api(`/api/setup/website-analysis/jobs/${id}`, {
            method: "DELETE",
          })
        ).body.job.status,
      ).toBe("cancelled");
      releaseProvider?.();
      await work;
      expect(
        (
          await admin.query(
            "SELECT website_analysis FROM company_settings WHERE id=$1",
            [north],
          )
        ).rows[0].website_analysis,
      ).toBeNull();
      workerMode = "success";
    });
    it("persists queue failures and makes them retryable", async () => {
      enqueue.mockRejectedValueOnce(new Error("Fixture queue unavailable"));
      const created = await api("/api/setup/website-analysis/jobs", {
        method: "POST",
        body: { url: "queue-failure.example" },
      });
      expect(created.status).toBe(503);
      const latest = await api("/api/setup/website-analysis/jobs/latest");
      expect(latest.body.job.status).toBe("failed");
      const retry = await api(
        `/api/setup/website-analysis/jobs/${latest.body.job.id}/retry`,
        { method: "POST" },
      );
      expect(retry.status).toBe(202);
      await api(`/api/setup/website-analysis/jobs/${retry.body.job.id}`, {
        method: "DELETE",
      });
    });
    it("protects profile edits and repeated workspace creation", async () => {
      const path = "/api/settings/business-profiles";
      const key = randomUUID();
      const data = { name: "Retry workspace", idempotencyKey: key };
      const first = await api(path, { method: "POST", body: data });
      expect(first.status).toBe(201);
      const retry = await api(path, { method: "POST", body: data });
      expect(retry.body.id).toBe(first.body.id);
      expect(
        (
          await api(path, {
            method: "POST",
            body: { ...data, name: "Changed" },
          })
        ).status,
      ).toBe(409);
      const edit = await api(`${path}/${first.body.id}`, {
        method: "PUT",
        body: { name: "Updated", expectedVersion: first.body.version },
      });
      expect(edit.status).toBe(200);
      expect(
        (
          await api(`${path}/${first.body.id}`, {
            method: "PUT",
            body: { name: "Stale", expectedVersion: first.body.version },
          })
        ).status,
      ).toBe(409);
    });
    it("retains validated image metadata and protects toolkit retries and edits", async () => {
      const path = "/api/content/brand-toolkits",
        key = randomUUID();
      const asset = {
        url: "/uploads/fixture.png",
        alt: "A product photo",
        width: 1200,
        height: 800,
        source: "upload",
        originalName: "photo.png",
        sizeBytes: 1024,
      };
      const data = {
        name: "Fixture brand",
        imageAssets: [asset],
        idempotencyKey: key,
      };
      const first = await api(path, { method: "POST", body: data });
      expect(first.status).toBe(201);
      expect(first.body.imageAssets).toEqual([asset]);
      const retry = await api(path, { method: "POST", body: data });
      expect(retry.body.id).toBe(first.body.id);
      expect(
        (
          await api(path, {
            method: "POST",
            body: { ...data, name: "Different" },
          })
        ).status,
      ).toBe(409);
      const edited = await api(`${path}/${first.body.id}`, {
        method: "PUT",
        body: { name: "Updated toolkit", expectedVersion: first.body.version },
      });
      expect(edited.status).toBe(200);
      expect(edited.body.version).toBe(2);
      expect(
        (
          await api(`${path}/${first.body.id}`, {
            method: "PUT",
            body: { name: "Stale", expectedVersion: first.body.version },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await api(path, {
            method: "POST",
            body: {
              name: "Invalid images",
              imageAssets: [{ ...asset, width: -1 }],
            },
          })
        ).status,
      ).toBe(400);
      const readiness = await api("/api/setup/onboarding-status");
      expect(readiness.body.completedTasks).toContain("brand");
      expect(readiness.body.connectionsAvailable).toBe(false);
    });
    it("completes setup once and clears only drafts for the completed workspace", async () => {
      await api(`/api/setup/drafts/brand:${north}`, {
        method: "PUT",
        body: {
          data: { name: "Finished brand" },
          step: 6,
          expectedRevision: 0,
        },
      });
      await api("/api/setup/drafts/workspace:new", {
        method: "PUT",
        body: {
          data: { profileId: south, name: "Other unfinished workspace" },
          step: 2,
          expectedRevision: 0,
        },
      });
      const completed = await api("/api/auth/mark-setup-complete", {
        method: "POST",
        body: {},
      });
      expect(completed.status).toBe(200);
      expect(
        (await api("/api/setup/drafts/workspace:first")).body.draft,
      ).toBeNull();
      expect(
        (await api(`/api/setup/drafts/brand:${north}`)).body.draft,
      ).toBeNull();
      expect(
        (await api("/api/setup/drafts/workspace:new")).body.draft.data
          .profileId,
      ).toBe(south);
      await api("/api/setup/drafts/workspace:first", {
        method: "PUT",
        body: {
          data: { profileId: south, name: "Different draft" },
          step: 2,
          expectedRevision: 0,
        },
      });
      expect(
        (
          await api("/api/auth/mark-setup-complete", {
            method: "POST",
            body: {},
          })
        ).status,
      ).toBe(200);
      expect(
        (await api("/api/setup/drafts/workspace:first")).body.draft.data
          .profileId,
      ).toBe(south);
    });
    it("prevents archiving the final active owned workspace", async () => {
      const response = await api(
        `/api/settings/business-profiles/${otherProfile}/archive`,
        {
          method: "POST",
          token: otherToken,
          profile: otherProfile,
          body: { expectedVersion: 1 },
        },
      );
      expect(response.status).toBe(409);
      expect(
        (
          await admin.query(
            "SELECT archived_at FROM company_settings WHERE id=$1",
            [otherProfile],
          )
        ).rows[0].archived_at,
      ).toBeNull();
      expect(
        (
          await api("/api/setup/onboarding-status", {
            token: otherToken,
            profile: otherProfile,
          })
        ).status,
      ).toBe(200);
    });
    it("archives without deleting linked records and restores safely", async () => {
      const queued = await api("/api/setup/website-analysis/jobs", { method: "POST", profile: south, body: { url: "archive.example" } });
      expect(queued.status).toBe(202);
      await withBusinessScope({ userId: owner, businessProfileId: south }, () =>
        pool.query(
          "INSERT INTO chat_threads(user_id,title) VALUES($1,'Keep linked history')",
          [owner],
        ),
      );
      expect(
        (
          await api(`/api/settings/business-profiles/${south}/archive`, {
            method: "POST",
            body: { expectedVersion: 1 },
          })
        ).status,
      ).toBe(200);
      expect((await admin.query("SELECT status FROM workspace_website_analysis_jobs WHERE id=$1", [queued.body.job.id])).rows[0].status).toBe("cancelled");
      const active = await api("/api/settings/business-profiles");
      expect(active.body.some((p: { id: number }) => p.id === south)).toBe(
        false,
      );
      const all = await api(
        "/api/settings/business-profiles?includeArchived=1",
      );
      const archived = all.body.find((p: { id: number }) => p.id === south);
      expect(archived.archivedAt).toBeTruthy();
      expect(
        (await api("/api/setup/onboarding-status", { profile: south })).status,
      ).toBe(403);
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM chat_threads WHERE business_profile_id=$1",
            [south],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await api(`/api/settings/business-profiles/${south}/restore`, {
            method: "POST",
            body: { expectedVersion: archived.version },
          })
        ).status,
      ).toBe(200);
    });
  },
);
