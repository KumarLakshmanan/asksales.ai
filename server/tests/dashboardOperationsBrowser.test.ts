/** Opt-in loopback acceptance harness. Real Next pages, controllers, reporting,
 * operation workers, parser and PostgreSQL/RLS; synthetic session, provider
 * catalog and CRM import adapter. The real CRM importer has separate native
 * acceptance tests. No provider delivery function is available in this harness. */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, types as pgTypes, type Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import express from "express";
import multer from "multer";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import * as XLSX from "@e965/xlsx";
import {
  withBusinessScope,
  requireBusinessScope,
} from "../tenancy/businessContext.js";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import {
  localBusinessFunctions,
  localBusinessIsolation,
} from "./helpers/localBusinessPostgres.js";
import { installReportingFixture } from "./helpers/outreachReportingFixture.js";
// @ts-expect-error JavaScript migration is executed by the application's runner.
const migration = await import("../migrations/580_dashboard_operations.js");
const run =
  process.env.OUTREACH_BROWSER_LOCAL_QA === "1" ? describe : describe.skip;
const browserOrigin = "http://127.0.0.1:55442";
const artifactDirectory = resolve(
  process.cwd(),
  "../.local/dashboard-agent-operations/browser",
);
let database: NodePgDatabase,
  fixture: Pool,
  runtime: Pool,
  admin: Pool,
  schema: string,
  server: Server,
  sockets: WebSocketServer,
  browser: Browser,
  context: BrowserContext,
  page: Page;
const workerErrors: unknown[] = [],
  requests: Array<{ method: string; path: string; status: number }> = [],
  unexpected: string[] = [];
const browserErrors: string[] = [];
const workerTasks = new Set<Promise<unknown>>();
let deliveryDispatches = 0;
const account = {
  id: "qa-account",
  providerAccountId: "qa-account",
  label: "QA WhatsApp",
  ready: true,
  reason: null,
};
const templates = [
  {
    id: "qa-template",
    name: "qa_approved_stay",
    language: "en",
    body: "Hello {{1}}, this is a synthetic two-night stay offer.",
  },
];
const origin = {
  userId: 991,
  businessProfileId: 1,
  businessActorUserId: 991,
  billingActorUserId: 991,
  billingOrganizationId: 8,
};
const scope = <T>(work: () => T, profile = 1) =>
  withBusinessScope(
    { userId: 991, businessProfileId: profile, actorUserId: 991 },
    work,
  );
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        const value = Reflect.get(database, key);
        return typeof value === "function" ? value.bind(database) : value;
      },
    },
  ),
}));
jest.unstable_mockModule("../tenancy/jobBusinessScope.js", () => ({
  captureJobBusiness: async (input: any) => ({
    ...origin,
    ...input,
    businessProfileId: requireBusinessScope().businessProfileId,
  }),
  runBusinessJob: async (saved: any, work: any) => {
    if (
      saved.userId !== 991 ||
      ![1, 2].includes(saved.businessProfileId) ||
      saved.businessActorUserId !== 991 ||
      saved.billingActorUserId !== 991 ||
      saved.billingOrganizationId !== 8
    )
      throw new Error("Synthetic originating authority mismatch");
    return scope(() => work(saved), saved.businessProfileId);
  },
}));
jest.unstable_mockModule("../queues/index.js", () => ({
  QUEUE_NAMES: { GENERAL: "general", OUTREACH: "outreach" },
  queueRegistry: {
    initialize: async () => {},
    getQueue: () => ({ getJob: async () => null }),
    addJob: async (_queue: string, _name: string, data: any) => {
      const task = new Promise((done) => setTimeout(done, 60))
        .then(() =>
          scope(
            () => operations.processDashboardOperation(data),
            data.businessProfileId,
          ),
        )
        .catch((error) => workerErrors.push(error))
        .finally(() => workerTasks.delete(task));
      workerTasks.add(task);
      return `qa-${data.operationId}`;
    },
  },
}));
jest.unstable_mockModule("../queues/JobDispatcher.js", () => ({
  jobDispatcher: {
    dispatch: async () => {
      deliveryDispatches++;
      return { status: "queued" };
    },
  },
}));
jest.unstable_mockModule("../models/platformAccess/functions.js", () => ({
  getEffectiveModuleAccess: async () =>
    ["outreach", "crm", "support_ai"].map((key) => ({ key, enabled: true })),
}));
jest.unstable_mockModule("../services/outreach/CreationService.js", () => ({
  resolveCreationAccount: async () => ({
    account,
    binding: { providerAccountId: "qa-account" },
  }),
  getCreationTemplates: async () => templates,
}));
jest.unstable_mockModule("../services/CrmImportLedger.js", () => ({
  beginCrmImport: async () => {
    await database.execute(sql`INSERT INTO crm_contact_imports(id,user_id,business_profile_id,file_name,created_at,import_status)
    SELECT 7,991,1,'Synthetic browser contacts.xlsx',now(),'processing' WHERE NOT EXISTS(SELECT 1 FROM crm_contact_imports WHERE id=7 AND user_id=991 AND business_profile_id=1)`);
    return { id: 7 };
  },
}));
jest.unstable_mockModule("../services/CRMService.js", () => ({
  crmService: {
    importContactsFromCSV: async (
      _user: number,
      rows: Array<Record<string, string>>,
      _mapping: unknown,
      _name: string,
      options: any,
    ) => {
      for (const row of rows.slice(
        options.startIndex,
        options.startIndex + options.batchSize,
      ))
        await database.transaction(async (tx: any) => {
          const found = await tx.execute(
            sql`SELECT id FROM crm_contacts WHERE user_id=991 AND business_profile_id=1 AND phone=${row.phone}`,
          );
          if (found.rows[0]) return;
          const next = (
            await tx.execute(
              sql`SELECT COALESCE(MAX(id),100)+1 AS id FROM leads`,
            )
          ).rows[0].id;
          await tx.execute(
            sql`INSERT INTO leads(id,user_id,business_profile_id,name,phone,email,source) VALUES(${next},991,1,${row.firstName || "Browser Guest"},${row.phone || ""},${row.email || ""},'crm_import')`,
          );
          await tx.execute(
            sql`INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id,first_name,phone,email) VALUES(${next},991,1,${next},${row.firstName || "Browser Guest"},${row.phone || ""},${row.email || ""})`,
          );
          await tx.execute(
            sql`INSERT INTO crm_contact_import_details(import_id,business_profile_id,created_contact_id,status) VALUES(7,1,${next},'success')`,
          );
        });
      await database.execute(
        sql`UPDATE crm_contact_imports SET import_status='completed' WHERE id=7 AND user_id=991 AND business_profile_id=1`,
      );
      return {
        importId: 7,
        totalRecords: rows.length,
        successCount: Math.min(
          rows.length,
          options.startIndex + options.batchSize,
        ),
        duplicateCount: 0,
        errorCount: 0,
        skippedCount: 0,
        warningCount: 0,
        issues: [],
        importStatus: "completed",
      };
    },
  },
}));
const operations =
  await import("../services/operations/DashboardOperations.js");
const { contactAnalysisOperation } =
  await import("../controllers/contactAnalysisController.js");
const { campaignReport } =
  await import("../controllers/campaignReportController.js");
const { campaignEngagement } =
  await import("../controllers/campaignEngagementController.js");
const { campaignExport } =
  await import("../controllers/campaignExportController.js");
const { outreachRetries } =
  await import("../controllers/outreachRetryController.js");
const { preparedOutreach } =
  await import("../controllers/preparedOutreachController.js");
const { getCreationImportSources } =
  await import("../services/outreach/CreationImportSources.js");
const user = {
  id: 991,
  name: "Synthetic QA Owner",
  email: "qa@example.test",
  isApproved: true,
  isSetupComplete: true,
  hasBusinessProfile: true,
  hasBrandToolkit: true,
  workspaceRole: "owner",
  businessProfileId: 1,
};
async function screenshot(name: string) {
  await page.screenshot({
    path: resolve(artifactDirectory, `${name}.png`),
    fullPage: true,
    animations:'disabled',
  });
}
run("dashboard operations through the actual local Next browser", () => {
  beforeAll(async () => {
    const url = process.env.OUTREACH_QA_DATABASE_URL;
    if (
      !url ||
      !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
      new URL(url).pathname != "/implementation_synthetic"
    )
      throw new Error("Explicit isolated loopback database required");
    pgTypes.setTypeParser(1114, (value) => new Date(`${value}Z`));
    schema = `dashboard_browser_${randomBytes(8).toString("hex")}`;
    const connection = { connectionString: url, connectionTimeoutMillis: 5000 };
    admin = new Pool({
      ...connection,
      max: 1,
      options: "-c search_path=pg_catalog",
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture = new Pool({
      ...connection,
      max: 1,
      options: `-c search_path=${schema},pg_catalog -c timezone=UTC`,
    });
    await localBusinessFunctions(fixture);
    await fixture.query(`CREATE TABLE users(id int PRIMARY KEY);INSERT INTO users VALUES(991);
      CREATE TABLE company_settings(id int PRIMARY KEY,user_id int,billing_organization_id int);INSERT INTO company_settings VALUES(1,991,8),(2,991,8);
      CREATE TABLE billing_organizations(id int PRIMARY KEY,storage_limit bigint DEFAULT 1000000000);INSERT INTO billing_organizations VALUES(8,1000000000);
      CREATE TABLE billing_storage_reservations(id uuid PRIMARY KEY,organization_id int,business_profile_id int,user_id int,bytes bigint,created_at timestamptz DEFAULT now(),expires_at timestamptz DEFAULT now()+interval '1 hour');
      CREATE TABLE billing_capacity_items(source_table text,source_id text,resource_key text,identity_key text,organization_id int,business_profile_id int,amount bigint);
      CREATE TABLE billing_capacity_totals(organization_id int,resource_key text,usage bigint,updated_at timestamptz DEFAULT now(),PRIMARY KEY(organization_id,resource_key));
      CREATE FUNCTION billing_assert_capacity(org int,resource text,amount bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF amount+COALESCE((SELECT usage FROM billing_capacity_totals WHERE organization_id=org AND resource_key=resource),0)>(SELECT storage_limit FROM billing_organizations WHERE id=org) THEN RAISE EXCEPTION 'Storage capacity exceeded'; END IF; END $$;
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read bool,parent_links jsonb);
      CREATE FUNCTION app_business_access(profile int) RETURNS boolean LANGUAGE SQL STABLE AS $$SELECT app_business_system() OR (profile=app_business_profile_id() AND EXISTS(SELECT 1 FROM company_settings WHERE id=profile AND user_id=app_business_user_id()))$$;`);
    await installReportingFixture({
      query: (query: string) =>
        fixture.query(query.replaceAll("CREATE TEMP TABLE", "CREATE TABLE")),
    } as unknown as Client);
    await fixture.query(`DROP TABLE dashboard_operations;
      ALTER TABLE leads ADD PRIMARY KEY(id),ADD COLUMN source text;
      ALTER TABLE crm_contact_imports ADD PRIMARY KEY(id);
      ALTER TABLE campaign_lead_imports ADD PRIMARY KEY(id);
      ALTER TABLE chat_threads ADD PRIMARY KEY(id);
      ALTER TABLE crm_contact_imports ADD COLUMN created_at timestamp DEFAULT now(),ADD COLUMN import_status text;
      ALTER TABLE campaign_lead_imports ADD COLUMN created_at timestamp DEFAULT now();
      ALTER TABLE outreach_messages ADD COLUMN send_intent_id uuid DEFAULT gen_random_uuid(),ADD COLUMN provider_call_state text DEFAULT 'not_started',ADD COLUMN confirmed_at timestamp DEFAULT now(),
        ADD COLUMN confirmation_expires_at timestamp DEFAULT now()+interval '30 days',ADD COLUMN send_claimed_at timestamp;
      CREATE TABLE instagram_webhook_events(user_id int,business_profile_id int,page_id text,event_type text,message_id text,raw_data jsonb);`);
    await localBusinessIsolation(fixture, schema, []);
    const guard = readFileSync(
      "migrations/299_business_profile_isolation.js",
      "utf8",
    ).match(
      /CREATE OR REPLACE FUNCTION enforce_business_ownership\(\)[\s\S]*?END \$\$/,
    )?.[0];
    if (!guard) throw new Error("Ownership guard unavailable");
    await fixture.query(guard);
    const storage = readFileSync(
      "migrations/302_organization_capacity.js",
      "utf8",
    ).match(
      /CREATE FUNCTION billing_reserve_storage\([\s\S]*?(?=\s*CREATE FUNCTION billing_capacity_reconciliation)/,
    )?.[0];
    if (!storage) throw new Error("Native storage ledger unavailable");
    await fixture.query(
      storage.replaceAll(
        "SET search_path=public,pg_catalog",
        `SET search_path=${schema},pg_catalog`,
      ),
    );
    await migration.up({
      query: (query: string, values?: unknown[]) =>
        fixture.query(
          query.replaceAll(
            "SET search_path=public,pg_catalog",
            `SET search_path=${schema},pg_catalog`,
          ),
          values,
        ),
    });
    const tables = (
      await fixture.query(
        `SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND column_name='business_profile_id'`,
        [schema],
      )
    ).rows.map((row) => row.table_name as string);
    for (const table of tables.filter((name) => !name.startsWith("dashboard_")))
      await fixture.query(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY qa_business ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));`,
      );
    await fixture.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime`,
    );
    runtime = createBusinessScopedPool(
      new Pool({
        ...connection,
        max: 5,
        options: `-c search_path=${schema},pg_catalog -c timezone=UTC`,
      }),
    );
    database = drizzle(runtime);
    await fixture.query(`INSERT INTO leads(id,user_id,business_profile_id,name,phone) SELECT id,991,1,'Report Guest '||id,'+91990000000'||id FROM generate_series(1,4) id;
      INSERT INTO outreach_conversations(id,user_id,channel,provider_account_id,lead_id) SELECT id,991,'whatsapp','qa-account',id FROM generate_series(1,4) id;
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,provider_call_state,provider_message_id,sent_at,delivered_at,content,metadata)
        VALUES(1,991,1,'outbound','outreach','delivered','confirmed','qa-1',now()-interval '1 day',now()-interval '1 day','Synthetic approved offer','{}'),
        (2,991,2,'outbound','outreach','sent','confirmed','qa-2',now()-interval '1 day',NULL,'Synthetic approved offer','{}'),
        (3,991,3,'outbound','outreach','pending','not_started',NULL,NULL,NULL,'Synthetic queued offer','{}'),
        (4,991,4,'outbound','outreach','failed','not_started',NULL,NULL,NULL,'Synthetic failed offer','{}');
      UPDATE outreach_messages SET error_message='Invalid recipient in synthetic QA' WHERE id=4;`);
    await fixture.query(
      "UPDATE outreach_messages SET metadata=$1::jsonb WHERE id=3",
      [
        JSON.stringify({
          outreachQueuePolicy: { version: 1 },
          outreachQueueOrigin: origin,
          outreachCreation: {
            version: 1,
            whatsappOptInConfirmed: true,
            delivery: {
              userId: 991,
              conversationId: 3,
              leadId: 3,
              channel: "whatsapp",
              templateName: "qa_approved_stay",
              phone: "+919900000003",
              message: "Synthetic queued offer",
            },
          },
        }),
      ],
    );
    await fixture.query(
      `INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,message_type,created_at,content) VALUES(10,991,1,'inbound','reply','received','text',now()-interval '12 hours','Please share dates. My email is qa@example.test');`,
    );
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (req.get("origin") === browserOrigin) {
        res.setHeader("Access-Control-Allow-Origin", browserOrigin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader(
          "Access-Control-Allow-Headers",
          req.get("access-control-request-headers") || "content-type",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      }
      if (req.method === "OPTIONS") return res.sendStatus(204);
      res.on("finish", () =>
        requests.push({
          method: req.method,
          path: req.path,
          status: res.statusCode,
        }),
      );
      if (!(req.get("cookie") || "").includes("dashboard-qa=synthetic"))
        return res.status(401).json({ error: "Synthetic session required" });
      (req as any).user = user;
      const profile = Number(req.get("x-business-profile-id") || 1);
      if (![1, 2].includes(profile))
        return res
          .status(403)
          .json({ error: "Synthetic business unavailable" });
      return scope(() => next(), profile);
    });
    app.get("/api/auth/me", (_req, res) => res.json({ user }));
    app.get("/api/settings/business-profiles", (_req, res) =>
      res.json(
        [1, 2].map((id) => ({
          id,
          name: `QA business ${id}`,
          role: "owner",
          isDefault: id === 1,
          setupComplete: true,
          ownerApproved: true,
          brandToolkitCompleted: true,
          billingOrganizationId: 8,
        })),
      ),
    );
    app.get("/api/platform/access", (_req, res) =>
      res.json({
        maintenance: { enabled: false, message: "" },
        modules: [
          "outreach",
          "crm",
          "campaigns",
          "support_ai",
          "integrations",
          "billing",
          "storage",
        ].map((key) => ({
          key,
          name: key,
          status: "available",
          enabled: true,
          mode: "inherit",
        })),
      }),
    );
    app.get("/api/settings/preferences", (_req, res) =>
      res.json({
        language: "en",
        locale: "en-US",
        theme: "light",
        timezone: "Asia/Kolkata",
      }),
    );
    app.get("/api/wallet", (_req, res) => res.json({ balance: 10000 }));
    app.get("/api/notifications/unread/count", (_req, res) =>
      res.json({ count: 0 }),
    );
    app.get("/api/organizations", (_req, res) =>
      res.json({
        organizations: [
          {
            id: 8,
            businessProfileId: requireBusinessScope().businessProfileId,
            name: "QA organization",
            ownerUserId: 991,
            role: "owner",
            canManageBilling: true,
          },
        ],
        selectedOrganizationId: 8,
        invitations: [],
      }),
    );
    app.get("/api/chat/threads", (_req, res) => res.json([]));
    app.get("/api/chat-threads", (_req, res) => res.json([]));
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { files: 20, fileSize: 25 * 1024 * 1024 },
    }).array("files", 20);
    app.get("/api/crm/contact-analysis", contactAnalysisOperation);
    app.post("/api/crm/contact-analysis", upload, contactAnalysisOperation);
    app.get("/api/crm/contact-analysis/:operationId", contactAnalysisOperation);
    app.get(
      "/api/crm/contact-analysis/:operationId/rows",
      contactAnalysisOperation,
    );
    app.post(
      "/api/crm/contact-analysis/:operationId/:action",
      contactAnalysisOperation,
    );
    app.get("/api/outreach/reports", campaignReport);
    app.get("/api/outreach/reports/options", campaignReport);
    app.get("/api/outreach/reports/customers", campaignEngagement);
    app.get("/api/outreach/reports/history", campaignEngagement);
    app.post("/api/outreach/reports/exports", campaignExport);
    app.get("/api/outreach/reports/exports/:id", campaignExport);
    app.post("/api/outreach/reports/exports/:id/resume", campaignExport);
    app.get(
      "/api/outreach/reports/exports/:id/download/:format",
      campaignExport,
    );
    app.post("/api/outreach/retries/preview", outreachRetries);
    app.get("/api/outreach/retries/:id", outreachRetries);
    app.post("/api/outreach/retries/:id/apply", outreachRetries);
    app.post("/api/outreach/prepared", preparedOutreach);
    app.get("/api/outreach/prepared/:id", preparedOutreach);
    app.get("/api/outreach-conversations/compose/options", (_req, res) =>
      res.json({
        channel: "whatsapp",
        accounts:
          requireBusinessScope().businessProfileId === 1 ? [account] : [],
      }),
    );
    app.get("/api/outreach-conversations/compose/templates", (_req, res) =>
      res.json({ templates }),
    );
    app.get(
      "/api/outreach-conversations/compose/import-sources",
      async (_req, res) => res.json(await getCreationImportSources(991)),
    );
    app.get(
      "/api/outreach-conversations/compose/recipients",
      async (req, res) => {
        const rows = (
          await database.execute(
            sql`SELECT id,name,phone FROM leads WHERE user_id=991 AND business_profile_id=${requireBusinessScope().businessProfileId} ORDER BY id`,
          )
        ).rows;
        const selected = req.query.ids
          ? String(req.query.ids).split(",").map(Number)
          : null;
        const recipients = rows
          .filter((row: any) => !selected || selected.includes(row.id))
          .map((row: any) => ({
            id: row.id,
            name: row.name,
            firstName: row.name,
            lastName: "",
            company: "",
            email: "",
            phone: row.phone,
            eligible: true,
            reason: null,
            recipient: row.phone,
          }));
        res.json({
          recipients,
          total: recipients.length,
          nextCursor: null,
          eligibleCount: recipients.length,
        });
      },
    );
    app.get("/api/outreach/follow-ups/settings", (_req, res) => res.json({}));
    app.post('/api/outreach/manual-follow-ups/campaign-options',(_req,res)=>res.json({campaigns:[]}));
    app.get('/api/outreach/manual-follow-ups/campaign-options',(_req,res)=>res.json({campaigns:[]}));
    app.get('/api/content/templates',(_req,res)=>res.json([]));
    app.use((req, res) => {
      unexpected.push(req.path);
      res.status(404).json({ error: "Unconfigured synthetic auxiliary route" });
    });
    server = await new Promise<Server>((done) => {
      const value = app.listen(55441, "127.0.0.1", () => done(value));
    });
    sockets = new WebSocketServer({ server, path: "/api/agents/progress" });
    sockets.on("connection", (socket) => socket.on("message", () => {}));
    await mkdir(artifactDirectory, { recursive: true });
    browser = await chromium.launch({
      executablePath: process.env.BROWSER_EXECUTABLE_PATH,
      headless: true,
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    await context.addCookies([
      {
        name: "dashboard-qa",
        value: "synthetic",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.addInitScript(() => {
      localStorage.setItem(
        "user",
        JSON.stringify({ id: 991, name: "Synthetic QA Owner" }),
      );
      localStorage.setItem("hasBusinessProfile", "true");
      localStorage.setItem("hasBrandToolkit", "true");
      sessionStorage.setItem("active-business-profile:991", "1");
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      return ["127.0.0.1", "localhost"].includes(host)
        ? route.continue()
        : route.abort();
    });
  }, 60000);
  afterEach(async () => {
    if (page && !page.isClosed()) {
      await screenshot("last-page");
      await writeFile(
        resolve(artifactDirectory, "evidence.json"),
        JSON.stringify(
          {
            requests,
            unexpected,
            browserErrors,
            workerErrors: workerErrors.map(String),
          },
          null,
          2,
        ),
      );
    }
  });
  afterAll(async () => {
    await Promise.allSettled([...workerTasks]);
    await context?.close();
    await browser?.close();
    sockets?.close();
    if (server) await new Promise<void>((done) => server.close(() => done()));
    await runtime?.end();
    await fixture?.end();
    if (admin && /^dashboard_browser_[a-f0-9]{16}$/.test(schema))
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  it("walks analysis, import, saved review, reporting, engagement, retry recovery and authenticated downloads", async () => {
    await page.goto(`${browserOrigin}/dashboard/outreach/reports`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "Campaign reports", exact: true })
      .waitFor();
    await page.getByText("4 distinct recipients").waitFor();
    await screenshot("01-reports-desktop");
    expect(
      await page.getByText("Confirmed delivered", { exact: true }).count(),
    ).toBe(1);
    await page
      .getByRole("link", { name: "View customer engagement", exact: true })
      .click();
    await page
      .getByRole("button", { name: "View history for Report Guest 1" })
      .click();
    await page.getByText(/Please share dates/).waitFor();
    expect(
      await page.getByText("qa@example.test", { exact: true }).count(),
    ).toBe(0);
    await screenshot("02-customer-history-desktop");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close" })
      .click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button',{name:'Hide sidebar',exact:true}).waitFor({state:'hidden'});
    await screenshot("03-engagement-mobile");
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${browserOrigin}/dashboard/outreach/retries`);
    await page
      .getByRole("button", { name: "Preview eligible retries" })
      .click();
    await page.getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "Confirm eligible retries" })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "existing intents registered" })
      .waitFor();
    expect(deliveryDispatches).toBe(1);
    await screenshot("04-retry-recovery");
    expect(
      (
        await fixture.query(
          "SELECT count(*)::int AS count FROM outreach_messages WHERE direction='outbound'",
        )
      ).rows[0].count,
    ).toBe(4);
    await page.goto(`${browserOrigin}/dashboard/outreach/reports`);
    await page
      .getByRole("button", { name: "Generate report downloads" })
      .click();
    await page
      .getByRole("link", { name: "Download report", exact: true })
      .click();
    await page.getByText("Excel workbook", { exact: true }).waitFor();
    await page
      .getByText(/KB · ready/)
      .first()
      .waitFor();
    await screenshot("05-saved-report-downloads");
    for (const label of [
      "PDF report",
      "Word document",
      "Excel workbook",
      "Conversation history",
    ]) {
      const card = page
        .getByRole("heading", { name: label, exact: true })
        .locator("..")
        .locator("..");
      await card
        .getByRole("button", { name: "Download", exact: true })
        .waitFor({ state: "visible" });
      await page
        .locator('section[aria-label="Report downloads"] button:disabled')
        .first()
        .waitFor({ state: "hidden" });
      const download = page.waitForEvent("download");
      await card.getByRole("button", { name: "Download", exact: true }).click();
      const file = await download;
      await file.saveAs(resolve(artifactDirectory, file.suggestedFilename()));
    }
    await page.goto(`${browserOrigin}/dashboard/crm/import/analyze`);
    await page
      .getByRole("heading", {
        name: "Analyze and import contacts",
        exact: true,
      })
      .waitFor();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Name", "Phone"],
        ["Browser Guest A", "+919900000101"],
        ["Browser Guest B", "+919900000102"],
      ]),
      "Guests",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Name", "Phone"],
        ["Browser Guest C", "+919900000103"],
      ]),
      "More guests",
    );
    const bytes = Buffer.from(
      XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
    );
    await page.locator("input[type=file]").setInputFiles([
      {
        name: "guests.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: bytes,
      },
      {
        name: "duplicate-guests.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: bytes,
      },
    ]);
    await page.getByRole("button", { name: /Analyze.*files/ }).click();
    await page
      .getByRole("button", { name: "Import 3 ready contacts" })
      .waitFor();
    await screenshot("06-analysis-desktop");
    await page.getByRole("button", { name: /worksheet mapping/ }).click();
    await screenshot("07-mapping-drawer");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close" })
      .click();
    await page.getByRole("button", { name: "Import 3 ready contacts" }).click();
    await page
      .getByRole("link", { name: "Prepare outreach", exact: true })
      .waitFor();
    await page
      .getByRole("link", { name: "Prepare outreach", exact: true })
      .click();
    await page.getByLabel("Sending account", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: /Choose.*template|Browse.*template/ })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .getByText("qa_approved_stay", { exact: true })
      .click();
    await page
      .getByLabel("Body variable 1", { exact: true })
      .fill("{{first_name}}");
    await page
      .getByRole("button", { name: "Use template", exact: true })
      .click();
    await page
      .getByRole("switch", { name: "Enable follow-ups for this outreach" })
      .check();
    await page.getByLabel("Follow-up 1 delay", { exact: true }).fill("12");
    await page
      .getByLabel("Follow-up 1 delay unit", { exact: true })
      .selectOption("hours");
    await page
      .getByRole("group", { name: "Follow-up 1" })
      .getByRole("button", { name: /Choose.*template|Browse.*template/ })
      .click();
    await page
      .getByRole("dialog")
      .getByText("qa_approved_stay", { exact: true })
      .click();
    await page
      .getByLabel("Body variable 1", { exact: true })
      .fill("{{first_name}}");
    await page
      .getByRole("button", { name: "Use template", exact: true })
      .click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button',{name:'Hide sidebar',exact:true}).waitFor({state:'hidden'});
    await screenshot("08-prepare-mobile");
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page
      .getByRole("button", { name: "Prepare and review outreach" })
      .click();
    await page.getByRole("button", { name: "Edit outreach" }).waitFor();
    await screenshot("09-prepared-review-desktop");
    expect(
      (
        await fixture.query(
          `SELECT count(*)::int AS count FROM dashboard_operations WHERE kind='campaign_prepare'`,
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await fixture.query(
          "SELECT count(*)::int AS count FROM outreach_messages WHERE direction='outbound'",
        )
      ).rows[0].count,
    ).toBe(4);
    expect(workerErrors).toEqual([]);
    expect(requests.filter((request) => request.status >= 500)).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(browserErrors).toEqual([]);
  }, 600000);
});
