import { preserveAsyncContext } from "../middleware/preserveAsyncContext.js";
/* Synthetic-only acceptance tests. Original observer tests and evidence are preserved outside the checkout. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  jest,
} from "@jest/globals";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as xlsx from "@e965/xlsx";
import express from "express";
import multer from "multer";
import request from "supertest";
import { writeFileSync } from "node:fs";
import { withBusinessScope } from "../tenancy/businessContext.js";
import { crmContactsTable } from "../models/crmContacts/schema.js";
import { leadsTable } from "../models/leads/schema.js";
import { usersTable } from "../models/users/schema.js";
import { crmContactImportsTable } from "../models/crmContactImports/schema.js";
import { crmContactImportDetailsTable } from "../models/crmContactImportDetails/schema.js";
import { storageFilesTable } from "../models/storageFiles/schema.js";
import { storageQuotasTable } from "../models/storageQuotas/schema.js";
import { companySettings } from "../models/companySettings/schema.js";
import { userConsentsTable } from "../models/userConsents/schema.js";
import { crmActivitiesTable } from "../models/crmActivities/schema.js";
import { chatThreadsTable } from "../models/chatThreads/schema.js";
import { chatMessagesTable } from "../models/chatMessages/schema.js";
import {
  outreachConversationsTable,
  outreachMessagesTable,
} from "../models/outreachConversations/schema.js";
import { supportTicketsTable } from "../models/supportTickets/schema.js";
import { followupSequencesTable } from "../models/followupSequences/schema.js";
import { sequenceExecutionsTable } from "../models/sequenceExecutions/schema.js";

import {
  DEFAULT_CRM_CONFIGURATION,
  crmConfigurationIssues,
} from "../../shared/crmConfiguration.js";

const pool = new Pool({
  host: "127.0.0.1",
  port: 55437,
  database: "implementation_synthetic",
  user: "postgres",
  max: 3,
  options: "-c search_path=integrity_impl,pg_catalog -c timezone=UTC",
});
const realDb = drizzle(pool);
let failProgressAt = 0;
let progressCalls = 0;
let capacityBlockAt = 0;
let failCleanupMarker = false;
const databaseProxy = (target: any): any =>
  new Proxy(target, {
    get(t, k) {
      if (k === "transaction")
        return (callback: any, options: any) =>
          t.transaction((tx: any) => callback(databaseProxy(tx)), options);
      if (k === "execute")
        return (query: any) => {
          const text = new PgDialect().sqlToQuery(query).sql;
          if (/UPDATE crm_contact_imports SET\s+success_count/.test(text)) {
            progressCalls++;
            if (progressCalls === capacityBlockAt)
              throw Object.assign(new Error("Synthetic capacity limit"), {
                detail: JSON.stringify({
                  code: "PLAN_LIMIT_EXCEEDED",
                  resource: "contacts",
                  current: 1,
                  requestedIncrease: 1,
                  limit: 1,
                  organizationId: 1,
                }),
              });
            if (progressCalls === failProgressAt)
              throw Object.assign(
                new Error("Synthetic connection interruption"),
                { code: "08006" },
              );
          }
          if (
            failCleanupMarker &&
            /UPDATE storage_files SET metadata = CASE/.test(text)
          ) {
            failCleanupMarker = false;
            throw new Error("Synthetic cleanup acknowledgement interruption");
          }
          return t.execute(query);
        };
      const value = t[k];
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
const db = databaseProxy(realDb);
const evidence: any[] = [];
const record = (id: string, data: any) => evidence.push({ id, ...data });
const log = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule("../models/db.js", () => ({ db }));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: log,
  createWorkerLogger: () => log,
}));
jest.unstable_mockModule("../models/leads/functions.js", () => ({
  LeadModel: { resolveBusinessCategory: async () => ({}) },
}));
jest.unstable_mockModule("../services/SentimentAnalysisService.js", () => ({
  sentimentAnalysisService: {},
}));
jest.unstable_mockModule("../services/AlertService.js", () => ({
  alertService: { fireEvent: jest.fn() },
  ALERT_EVENT_TYPES: [],
}));
jest.unstable_mockModule("../services/AutomationService.js", () => ({
  automationService: {},
}));
jest.unstable_mockModule("../services/ReminderService.js", () => ({
  reminderService: {},
}));
jest.unstable_mockModule("../controllers/crmWorkspaceController.js", () => ({
  getPaginatedActivities: jest.fn(),
  getPaginatedConversations: jest.fn(),
  getPaginatedTickets: jest.fn(),
}));
jest.unstable_mockModule("../services/booking/HotelRagSyncService.js", () => ({
  hotelRagSyncService: {
    deleteRoomTypeFromRag: jest.fn<any>().mockResolvedValue(undefined),
  },
}));
jest.unstable_mockModule("../models/userConsents/functions.js", () => ({
  createUserConsent: jest.fn<any>().mockResolvedValue({ id: 1 }),
  getLatestConsent: jest.fn(),
  listConsentsForUser: jest.fn(),
}));
jest.unstable_mockModule("../services/dashboardCache.js", () => ({
  invalidateDashboardCache: jest.fn(),
}));
jest.unstable_mockModule("../services/ICPGenerationService.js", () => ({
  ICPGenerationService: class {},
}));
jest.unstable_mockModule("../services/credentialService.js", () => ({
  getApifyKey: jest.fn(),
}));
jest.unstable_mockModule("../services/agents/LLMProviderFactory.js", () => ({
  LLMProviderFactory: {},
}));
jest.unstable_mockModule("../services/NotificationService.js", () => ({
  NotificationService: {},
}));
const removeObject = jest.fn<any>().mockResolvedValue(undefined);
jest.unstable_mockModule("../services/ObjectStorageService.js", () => ({
  objectStorage: { delete: removeObject },
}));
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: jest.fn(),
}));
jest.unstable_mockModule("../events/EventBus.js", () => ({
  eventBus: {},
  EVENT_CHANNELS: {},
}));
jest.unstable_mockModule("../queues/index.js", () => ({
  QUEUE_NAMES: {},
  QUEUE_LIMITERS: {},
  queueRegistry: {},
}));
jest.unstable_mockModule("../services/businessProfileAssetCleanup.js", () => ({
  cleanupDeletedProfileAssets: async () => ({ processed: 0 }),
}));
jest.unstable_mockModule("../services/OutreachAttachmentService.js", () => ({
  outreachAttachmentService: { cleanupExpired: async () => 0 },
}));
const { importContacts, getImportStatus } =
  await import("../controllers/crmController.js");
const { importRateReport } =
  await import("../controllers/hotelImportController.js");
const { businessProfileScope } = await import("../middleware/businessProfileScope.js");
const { billingOrganizationScope } = await import("../middleware/billingOrganizationScope.js");
const { checkSubscriptionRequest } = await import("../middleware/subscriptionAccess.js");
const { privacyController } =
  await import("../controllers/privacyController.js");
const { webhookRetentionService } =
  await import("../services/WebhookRetentionService.js");
const { exportLeads } = await import("../controllers/leadController.js");
const { storageService } = await import("../services/StorageService.js");
const { processGeneralJob } = await import("../workers/index.js");
const { runBusinessJob } = await import("../tenancy/jobBusinessScope.js");
const app = express();
app.use(express.json());
app.use((req: any, res, next) => {
  req.user = { id: 9 };
  withBusinessScope({ userId: 9, businessProfileId: 101 }, next);
});
const upload = multer({ storage: multer.memoryStorage() });
app.post(
  "/api/crm/contacts/import",
  preserveAsyncContext(upload.single("file")),
  importContacts,
);
app.get("/api/crm/imports/:id", getImportStatus);
app.post(
  "/api/hotel/import-rate-report",
  preserveAsyncContext(upload.single("file")),
  importRateReport,
);
app.post("/api/privacy/data-export", businessProfileScope, billingOrganizationScope, async (req, res) => {
  if (await checkSubscriptionRequest(req, res)) await privacyController.dataExport(req, res);
});
app.get("/api/leads/export", exportLeads);
const mapping = {
  Email: "email",
  Company: "company",
  Status: "status",
  Value: "dealValue",
};
const csv = (body: string) =>
  request(app)
    .post("/api/crm/contacts/import")
    .field("columnMapping", JSON.stringify(mapping))
    .attach("file", Buffer.from("Email,Company,Status,Value\n" + body), {
      filename: "synthetic.csv",
    });
function workbook(rows: any[][]) {
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(
    wb,
    xlsx.utils.aoa_to_sheet([
      [
        "Date",
        "Room Type",
        "Rate (Gross)",
        "Availability",
        "Total Rooms Available",
      ],
      ...rows,
    ]),
    "Audit",
  );
  return Buffer.from(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
}
const hotel = (rows: any[][]) =>
  request(app)
    .post("/api/hotel/import-rate-report")
    .attach("file", workbook(rows), { filename: "synthetic.xlsx" });
const dialect = new PgDialect();
const literal = (v: any): string =>
  v instanceof SQL
    ? dialect.sqlToQuery(v).sql
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : "'" +
        (typeof v === "object" ? JSON.stringify(v) : String(v)).replaceAll(
          "'",
          "''",
        ) +
        "'";
const local =
  process.env.DATA_INTEGRITY_LOCAL_QA === "1" ? describe : describe.skip;
local("data integrity acceptance on disposable PostgreSQL", () => {
  beforeAll(async () => {
    await pool.query(
      "DROP SCHEMA IF EXISTS integrity_impl CASCADE; CREATE SCHEMA integrity_impl",
    );
    await pool.query(
      "CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql AS $$ SELECT 101 $$; CREATE FUNCTION app_billing_organization_id() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$",
    );
    for (const table of [
      usersTable,
      leadsTable,
      crmContactsTable,
      crmContactImportsTable,
      crmContactImportDetailsTable,
      storageFilesTable,
      storageQuotasTable,
      companySettings,
      userConsentsTable,
      crmActivitiesTable,
      chatThreadsTable,
      chatMessagesTable,
      outreachConversationsTable,
      outreachMessagesTable,
      supportTicketsTable,
      followupSequencesTable,
      sequenceExecutionsTable,
    ]) {
      const cfg = getTableConfig(table);
      const cols = cfg.columns.map(
        (c) =>
          '"' +
          c.name +
          '" ' +
          c.getSQLType() +
          (c.primary ? " PRIMARY KEY" : "") +
          (c.notNull ? " NOT NULL" : "") +
          (c.default !== undefined ? " DEFAULT " + literal(c.default) : ""),
      );
      await pool.query(
        'CREATE TABLE "' + cfg.name + '" (' + cols.join(",") + ")",
      );
    }
    await pool.query(`CREATE UNIQUE INDEX import_identity ON crm_contact_imports(business_profile_id,user_id,request_fingerprint); CREATE UNIQUE INDEX import_receipt ON crm_contact_import_details(import_id,row_number);
    CREATE TABLE hotel_properties(id serial PRIMARY KEY,user_id integer NOT NULL,name varchar(255) NOT NULL);
    CREATE TABLE room_types(id serial PRIMARY KEY,hotel_id integer,name varchar(255),base_price numeric(10,2),min_price numeric(10,2),capacity integer);
    CREATE TABLE room_availability(id serial PRIMARY KEY,room_type_id integer,date date NOT NULL,total_count integer NOT NULL,available_count integer NOT NULL,price_per_night numeric(10,2),updated_at timestamp DEFAULT now(),UNIQUE(room_type_id,date),
      CONSTRAINT room_availability_counts_nonnegative CHECK(available_count>=0 AND total_count>=0 AND available_count<=total_count),
      CONSTRAINT room_availability_price_nonnegative CHECK(price_per_night>=0));
    -- Composed Hotel imports read the retained reservation lifecycle, even when
    -- this fixture has no bookings. Actual stock races use the migrated Hotel suite.
    CREATE TABLE bookings(id serial PRIMARY KEY,room_type_id integer,check_in_date date,check_out_date date,number_of_rooms integer,status varchar(50),inventory_reserved_at timestamp,inventory_released_at timestamp);
    CREATE TABLE instagram_webhook_events(id serial PRIMARY KEY,created_at timestamp,processed_at timestamp,timestamp timestamp);
    CREATE TABLE webhook_events(id serial PRIMARY KEY,user_id integer,business_profile_id integer,created_at timestamp);`);
  });
  afterAll(async () => {
    if (process.env.DATA_INTEGRITY_EVIDENCE_PATH)
      writeFileSync(
        process.env.DATA_INTEGRITY_EVIDENCE_PATH,
        JSON.stringify(evidence, null, 2),
      );
    await pool.query("DROP SCHEMA integrity_impl CASCADE");
    await pool.end();
  });
  beforeEach(async () => {
    failProgressAt = 0;
    progressCalls = 0;
    capacityBlockAt = 0;
    failCleanupMarker = false;
    removeObject.mockReset();
    removeObject.mockResolvedValue(undefined);
    await pool.query(
      "TRUNCATE users,leads,crm_contacts,crm_contact_imports,crm_contact_import_details,company_settings,hotel_properties,room_types,room_availability,instagram_webhook_events,webhook_events,storage_files,storage_quotas,user_consents,crm_activities,chat_threads,chat_messages,outreach_conversations,outreach_messages,support_tickets RESTART IDENTITY",
    );
    await pool.query(
      "INSERT INTO users(id,name,email,is_approved) VALUES(9,'Synthetic Owner','owner@example.invalid',true); INSERT INTO company_settings(id,user_id) VALUES(101,9)",
    );
  });

  it("A01 row transactions contain validation failures and duplicate rows", async () => {
    const r = await csv(
      "ada@example.invalid,Audit Co,new,12.50\nADA@example.invalid,Audit Co,new,12.50\nbad@example.invalid,Audit Co,new,invalid\n",
    );
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      successCount: 1,
      duplicateCount: 1,
      errorCount: 1,
    });
    const counts = (
      await pool.query(
        "SELECT (SELECT count(*) FROM crm_contacts)::int contacts,(SELECT count(*) FROM leads)::int leads,(SELECT count(*) FROM crm_contact_import_details)::int details",
      )
    ).rows[0];
    expect(counts).toEqual({ contacts: 1, leads: 1, details: 3 });
    record("A01", { status: r.status, response: r.body, counts });
  });
  it("A02 progress and effects commit together; exact file resubmission resumes once", async () => {
    failProgressAt = 2;
    const body =
      "ada@example.invalid,Audit Co,new,12.50\nben@example.invalid,Audit Co,new,13.50\n";
    const first = await csv(body);
    expect(first.status).toBe(503);
    expect(first.body.importId).toBeGreaterThan(0);
    const state = (
      await pool.query(
        "SELECT processed_records,success_count,import_status FROM crm_contact_imports",
      )
    ).rows[0];
    expect(state).toMatchObject({
      processed_records: 1,
      success_count: 1,
      import_status: "processing",
    });
    expect(
      (await pool.query("SELECT count(*)::int n FROM crm_contacts")).rows[0].n,
    ).toBe(1);
    failProgressAt = 0;
    const resumed = await csv(body);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toMatchObject({
      importId: first.body.importId,
      successCount: 2,
      importStatus: "completed",
    });
    const replay = await csv(body);
    expect(replay.body.data.importId).toBe(first.body.importId);
    expect(
      (await pool.query("SELECT count(*)::int n FROM crm_contacts")).rows[0].n,
    ).toBe(2);
    expect(
      (await pool.query("SELECT count(*)::int n FROM crm_contact_imports"))
        .rows[0].n,
    ).toBe(1);
    record("A02", {
      first: first.body,
      state,
      resumed: resumed.body,
      replay: replay.body,
    });
  });
  it("A03 imports retain configured stage keys and lifecycle", async () => {
    const config = structuredClone(DEFAULT_CRM_CONFIGURATION);
    config.stages.splice(2, 0, {
      key: "qualified",
      label: "Qualified",
      type: "active",
      color: "#6366f1",
      inFlow: true,
    });
    expect(crmConfigurationIssues(config)).toEqual([]);
    await pool.query(
      "UPDATE company_settings SET crm_configuration=$1 WHERE id=101",
      [config],
    );
    const r = await csv("ada@example.invalid,Audit Co,qualified,12.50\n");
    const saved = (
      await pool.query("SELECT status,pipeline_status FROM crm_contacts")
    ).rows[0];
    expect(r.status).toBe(200);
    expect(r.body.data.warningCount).toBe(0);
    expect(saved.pipeline_status).toBe("qualified");
    expect(saved.status).toBe("contacted");
    record("A03", { response: r.body, saved, configuredStage: "qualified" });
  });
  it("A04 two concurrent imports serialize duplicate resolution", async () => {
    const [a, b] = await Promise.all([
      csv("ada@example.invalid,Audit Co,new,12.50\n"),
      csv("ada@example.invalid,Audit Co,new,12.50\n"),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const n = (await pool.query("SELECT count(*)::int n FROM crm_contacts"))
      .rows[0].n;
    expect(n).toBe(1);
    expect(a.body.data.importId).toBe(b.body.data.importId);
    expect(a.body.data.successCount).toBe(1);
    expect(b.body.data.successCount).toBe(1);
    record("A04", { contacts: n, responses: [a.body, b.body] });
  });
  it("A05 invalid later hotel row rejects the entire workbook before mutation", async () => {
    const r = await hotel([
      ["2026-11-01", "Deluxe", 100, 2, 2],
      ["2026-11-02", "Suite", 200, 3, 2],
    ]);
    const inventory = (
      await pool.query(
        "SELECT date,available_count FROM room_availability ORDER BY date",
      )
    ).rows;
    const rooms = (await pool.query("SELECT name FROM room_types ORDER BY id"))
      .rows;
    expect(r.status).toBe(400);
    expect(r.body.row).toBe(3);
    expect(inventory).toHaveLength(0);
    expect(rooms).toHaveLength(0);
    record("A05", { status: r.status, response: r.body, inventory, rooms });
  });
  it("A06 invalid calendar date is rejected", async () => {
    const r = await hotel([["2026-02-30", "Deluxe", 100, 2, 2]]);
    expect(r.status).toBe(400);
    expect(
      (await pool.query("SELECT count(*)::int n FROM room_availability"))
        .rows[0].n,
    ).toBe(0);
    record("A06", { status: r.status, response: r.body });
  });
  it("A07 concurrent hotel imports share one room inventory", async () => {
    await pool.query(
      "INSERT INTO hotel_properties(user_id,name) VALUES(9,'Synthetic Hotel'); CREATE FUNCTION delay_room() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$; CREATE TRIGGER delay_room BEFORE INSERT ON room_types FOR EACH ROW EXECUTE FUNCTION delay_room()",
    );
    try {
      const result = await Promise.all([
        hotel([["2026-11-01", "Deluxe", 100, 2, 2]]),
        hotel([["2026-11-01", "Deluxe", 100, 2, 2]]),
      ]);
      const counts = (
        await pool.query(
          "SELECT (SELECT count(*) FROM room_types)::int room_types,(SELECT count(*) FROM room_availability)::int inventory_rows",
        )
      ).rows[0];
      expect(result.map((r) => r.status)).toEqual([200, 200]);
      expect(counts).toEqual({ room_types: 1, inventory_rows: 1 });
      record("A07", { statuses: result.map((r) => r.status), counts });
    } finally {
      await pool.query(
        "DROP TRIGGER delay_room ON room_types; DROP FUNCTION delay_room()",
      );
    }
  });
  it("A08 privacy export has declared business sections and excludes security internals", async () => {
    await csv("ada@example.invalid,Audit Co,new,12.50\n");
    await pool.query(
      "UPDATE users SET password='NONFUNCTIONAL_SENTINEL',reset_password_token='NONFUNCTIONAL_SENTINEL' WHERE id=9",
    );
    const r = await request(app).post("/api/privacy/data-export").send({});
    expect(r.status).toBe(200);
    const lines = r.text
      .trim()
      .split("\n")
      .map((v) => JSON.parse(v));
    expect(lines.some((v) => v.table === "leads")).toBe(true);
    expect(lines.some((v) => v.table === "crm_contacts")).toBe(true);
    expect(r.text).not.toContain("NONFUNCTIONAL_SENTINEL");
    expect(lines.at(-1)).toMatchObject({
      table: "export_manifest",
      data: { version: 2, status: "completed", inventoryComplete: false },
    });
    record("A08", {
      status: r.status,
      tables: [...new Set(lines.map((v) => v.table))],
      manifest: lines.at(-1).data,
    });
  });
  it("A09 privacy read failure produces no successful download", async () => {
    await pool.query(
      "ALTER TABLE users RENAME TO users_temporarily_unavailable",
    );
    try {
      const r = await request(app).post("/api/privacy/data-export").send({});
      expect(r.status).toBe(500);
      expect(r.headers["content-disposition"]).toBeUndefined();
      record("A09", {
        status: r.status,
        body: r.text,
        contentType: r.headers["content-type"],
      });
    } finally {
      await pool.query(
        "ALTER TABLE users_temporarily_unavailable RENAME TO users",
      );
    }
  });
  it("A10 retention removes expired events and preserves fresh records", async () => {
    await pool.query(
      "INSERT INTO instagram_webhook_events(created_at) VALUES(now()-interval '31 days'),(now()); INSERT INTO webhook_events(user_id,business_profile_id,created_at) VALUES(9,101,now()-interval '31 days'),(9,101,now()),(NULL,NULL,now()-interval '31 days')",
    );
    const result = await webhookRetentionService.purgeExpired();
    expect(result).toEqual({ integrationEvents: 1, healthEvents: 2 });
    const counts = (
      await pool.query(
        "SELECT (SELECT count(*) FROM instagram_webhook_events)::int integration,(SELECT count(*) FROM webhook_events)::int health",
      )
    ).rows[0];
    expect(counts).toEqual({ integration: 1, health: 1 });
    record("A10", {
      result,
      counts,
      limitation: "No production RLS in this fixture",
    });
  });
  it("A11 lead CSV export neutralizes formulas; historical selection semantics remain explicit", async () => {
    await csv("ada@example.invalid,Audit Co,new,12.50\n");
    await pool.query(
      "UPDATE leads SET name='=1+1',deleted_at=now() WHERE user_id=9",
    );
    const r = await request(app).get("/api/leads/export?format=csv");
    expect(r.status).toBe(200);
    expect(r.text).toContain('"\'=1+1"');
    expect(r.text).not.toContain(',"=1+1"');
    expect(r.text).toContain("ada@example.invalid");
    record("A11", {
      status: r.status,
      csv: r.text,
      containsSoftDeleted: true,
      unneutralizedFormula: false,
    });
  });
  it("A12 cleanup intent survives provider and acknowledgement failures", async () => {
    await pool.query(
      "INSERT INTO storage_quotas(user_id,storage_used_bytes,file_count) VALUES(9,123,1)",
    );
    const file = (
      await pool.query(
        "INSERT INTO storage_files(user_id,file_name,storage_key,file_size_bytes) VALUES(9,'synthetic.bin','9/general/synthetic.bin',123) RETURNING id",
      )
    ).rows[0];
    removeObject.mockRejectedValueOnce(
      new Error("Synthetic object provider failure"),
    );
    const ok = await withBusinessScope(
      { userId: 9, businessProfileId: 101 },
      () => storageService.deleteFile(file.id, 9),
    );
    const state = (
      await pool.query(
        "SELECT is_deleted,metadata FROM storage_files WHERE id=$1",
        [file.id],
      )
    ).rows[0];
    expect(ok).toBe(true);
    expect(state.metadata.pendingCleanupKeys).toEqual([
      "9/general/synthetic.bin",
    ]);
    failCleanupMarker = true;
    expect(await storageService.cleanupPendingObjects(10)).toEqual({
      processed: 0,
      remaining: 1,
    });
    expect(await storageService.cleanupPendingObjects(10)).toEqual({
      processed: 1,
      remaining: 0,
    });
    expect(
      (
        await pool.query("SELECT metadata FROM storage_files WHERE id=$1", [
          file.id,
        ])
      ).rows[0].metadata.pendingCleanupKeys,
    ).toBeUndefined();
    record("A12", {
      returnedSuccess: ok,
      persistedIntent: state,
      providerDeleteCalls: removeObject.mock.calls.length,
    });
  });
  it("A13 ordinary object-provider failure queues cleanup and succeeds on the next maintenance run", async () => {
    await pool.query(
      "INSERT INTO storage_quotas(user_id,storage_used_bytes,file_count) VALUES(9,123,1)",
    );
    const file = (
      await pool.query(
        "INSERT INTO storage_files(user_id,file_name,storage_key,file_size_bytes) VALUES(9,'synthetic.bin','9/general/synthetic.bin',123) RETURNING id",
      )
    ).rows[0];
    removeObject.mockRejectedValueOnce(
      new Error("AUDIT mocked temporary object failure"),
    );
    const ok = await withBusinessScope(
      { userId: 9, businessProfileId: 101 },
      () => storageService.deleteFile(file.id, 9),
    );
    const queued = (
      await pool.query("SELECT metadata FROM storage_files WHERE id=$1", [
        file.id,
      ])
    ).rows[0].metadata;
    const maintenance = await storageService.cleanupPendingObjects(10);
    const metadata = (
      await pool.query("SELECT metadata FROM storage_files WHERE id=$1", [
        file.id,
      ])
    ).rows[0].metadata;
    expect(ok).toBe(true);
    expect(queued.pendingCleanupKeys).toHaveLength(1);
    expect(maintenance).toEqual({ processed: 1, remaining: 0 });
    expect(metadata.pendingCleanupKeys).toBeUndefined();
    record("A13", {
      returnedSuccess: ok,
      queued,
      maintenance,
      finalMetadata: metadata,
    });
  });
  it("A14 one business maintenance error does not prevent later businesses running", async () => {
    await pool.query("INSERT INTO company_settings(id,user_id) VALUES(102,9)");
    const visited: number[] = [];
    const maintenance = jest
      .spyOn(storageService, "cleanupPendingObjects")
      .mockImplementation(async () => {
        const { currentBusinessScope } =
          await import("../tenancy/businessContext.js");
        if (currentBusinessScope()?.businessProfileId === 101)
          throw new Error("Synthetic first profile failure");
        return { processed: 0, remaining: 0 };
      });
    try {
      const payload = { systemJob: true, type: "cron-storage-object-cleanup" };
      for (let i = 0; i < 2; i++)
        await expect(
          runBusinessJob(payload, async (scoped) => {
            visited.push(scoped.businessProfileId!);
            return processGeneralJob({
              id: "synthetic-maintenance",
              data: scoped,
            } as any);
          }),
        ).rejects.toThrow("Business maintenance failed for 1 profile(s): 101");
      expect(visited).toEqual([101, 102, 101, 102]);
      record("A14", {
        businesses: [101, 102],
        attempts: 2,
        visited,
        laterBusinessRan: true,
      });
    } finally {
      maintenance.mockRestore();
    }
  });
  it("A15 system maintenance enumeration excludes archived businesses", async () => {
    await pool.query(
      "UPDATE company_settings SET archived_at=now() WHERE id=101; INSERT INTO company_settings(id,user_id) VALUES(102,9)",
    );
    const visited: number[] = [];
    await runBusinessJob(
      { systemJob: true, type: "cron-support-sla-check" },
      async (scoped) => {
        visited.push(scoped.businessProfileId!);
        return {};
      },
    );
    expect(visited).toEqual([102]);
    record("A15", {
      archivedBusiness: 101,
      activeBusiness: 102,
      visited,
      limitation:
        "Retention consequence is a static inference; no production RLS or archived data purge tested",
    });
  });

  it("A16 database rejection after the first valid hotel row rolls the whole transaction back", async () => {
    await pool.query(
      "CREATE FUNCTION reject_suite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='Suite' THEN RAISE EXCEPTION 'Synthetic room rejection'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_suite BEFORE INSERT ON room_types FOR EACH ROW EXECUTE FUNCTION reject_suite()",
    );
    try {
      const r = await hotel([
        ["2026-11-01", "Deluxe", 100, 1, 2],
        ["2026-11-02", "Suite", 200, 1, 2],
      ]);
      expect(r.status).toBe(500);
      expect(
        (
          await pool.query(
            "SELECT (SELECT count(*) FROM room_types)::int rooms,(SELECT count(*) FROM room_availability)::int inventory,(SELECT count(*) FROM hotel_properties)::int hotels",
          )
        ).rows[0],
      ).toEqual({ rooms: 0, inventory: 0, hotels: 0 });
    } finally {
      await pool.query(
        "DROP TRIGGER reject_suite ON room_types; DROP FUNCTION reject_suite()",
      );
    }
  });
  it("A17 existing duplicate room identities require review and are not merged", async () => {
    await pool.query(
      "INSERT INTO hotel_properties(user_id,name) VALUES(9,'Synthetic Hotel'); INSERT INTO room_types(hotel_id,name,base_price,min_price,capacity) VALUES(1,'Deluxe',100,80,1),(1,'Deluxe',100,80,1)",
    );
    const r = await hotel([["2026-11-01", "Deluxe", 100, 1, 2]]);
    expect(r.status).toBe(409);
    expect(
      (await pool.query("SELECT count(*)::int n FROM room_types")).rows[0].n,
    ).toBe(2);
    expect(
      (await pool.query("SELECT count(*)::int n FROM room_availability"))
        .rows[0].n,
    ).toBe(0);
  });
  it("A18 capacity-blocked rows resume under the same import identity after capacity is available", async () => {
    capacityBlockAt = 1;
    const body = "ada@example.invalid,Audit Co,new,12.50\n";
    const blocked = await csv(body);
    expect(blocked.status).toBe(403);
    expect(blocked.body.importId).toBeGreaterThan(0);
    expect(
      (
        await pool.query(
          "SELECT processed_records,success_count,import_status FROM crm_contact_imports",
        )
      ).rows[0],
    ).toEqual({
      processed_records: 0,
      success_count: 0,
      import_status: "failed",
    });
    expect(
      (await pool.query("SELECT status FROM crm_contact_import_details"))
        .rows[0].status,
    ).toBe("blocked");
    capacityBlockAt = 0;
    const resumed = await csv(body);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toMatchObject({
      importId: blocked.body.importId,
      successCount: 1,
      importStatus: "completed",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM crm_contact_import_details",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("A19 privacy export uses parent ownership and excludes restricted originals and another owner", async () => {
    expect((await csv("ada@example.invalid,Audit Co,new,12.50\n")).status).toBe(
      200,
    );
    const lead = (await pool.query("SELECT id FROM leads")).rows[0].id;
    await pool.query(
      "INSERT INTO users(id,name,email) VALUES(19,'Other synthetic','other@example.invalid'); INSERT INTO leads(uuid,user_id,business_profile_id,email,source,status) VALUES(gen_random_uuid(),19,201,'other@example.invalid','fixture','new')",
    );
    const other = (await pool.query("SELECT id FROM leads WHERE user_id=19"))
      .rows[0].id;
    await pool.query(
      "INSERT INTO outreach_conversations(id,user_id,business_profile_id,lead_id,channel) VALUES(55,9,101,$1,'email'),(56,19,201,$2,'email');",
      [lead, other],
    );
    await pool.query(
      "INSERT INTO outreach_messages(conversation_id,business_profile_id,user_id,direction,content,redacted_content) VALUES(55,101,NULL,'inbound','RESTRICTED_ORIGINAL_SENTINEL','Owner redacted text'),(56,201,9,'inbound','OTHER_OWNER_SENTINEL','OTHER_OWNER_SENTINEL')",
    );
    const r = await request(app).post("/api/privacy/data-export").send({});
    expect(r.status).toBe(200);
    expect(r.text).toContain("Owner redacted text");
    expect(r.text).not.toContain("RESTRICTED_ORIGINAL_SENTINEL");
    expect(r.text).not.toContain("OTHER_OWNER_SENTINEL");
    expect(r.text).not.toContain("other@example.invalid");
    const lines = r.text.trimEnd().split("\n");
    const manifest = JSON.parse(lines.at(-1)!).data;
    const { createHash } = await import("node:crypto");
    expect(manifest.recordsSha256).toBe(
      createHash("sha256")
        .update(lines.slice(0, -1).join("\n") + "\n")
        .digest("hex"),
    );
  });
  it("A20 an already-cancelled privacy export cleans its private temporary artifact", async () => {
    const { readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const before = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("privacy-export-"))
      .sort();
    const { preparePrivacyExport } =
      await import("../services/privacy/PrivacyDataExport.js");
    const controller = new AbortController();
    controller.abort();
    await expect(preparePrivacyExport(9, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(
      (await readdir(tmpdir()))
        .filter((name) => name.startsWith("privacy-export-"))
        .sort(),
    ).toEqual(before);
  });
  it("A21 legacy import status is reconstructed from committed receipts without invented timestamps", async () => {
    const created = await csv("legacy@example.invalid,Audit Co,new,12.50\n");
    expect(created.status).toBe(200);
    const id = created.body.data.importId;
    await pool.query(
      "UPDATE crm_contact_imports SET request_fingerprint=NULL,processed_records=0,success_count=0,import_status='processing',completed_at=NULL WHERE id=$1",
      [id],
    );
    const result = await request(app).get(`/api/crm/imports/${id}`);
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      successCount: 1,
      processedRecords: 1,
      importStatus: "completed",
      completedAt: null,
      recovery: { canResumeByFingerprint: false, needsResubmission: false },
    });
    await pool.query(
      "UPDATE crm_contact_imports SET total_records=2 WHERE id=$1;",
      [id],
    );
    await pool.query(
      "INSERT INTO crm_contact_import_details(import_id,row_number,status) VALUES($1,3,'pending')",
      [id],
    );
    const pending = await request(app).get(`/api/crm/imports/${id}`);
    expect(pending.body.data).toMatchObject({
      processedRecords: 1,
      importStatus: "processing",
      recovery: { canResumeByFingerprint: false, needsResubmission: true },
    });
  });
  it("A22 custom won stage retains its pipeline key while mapping the linked lead lifecycle", async () => {
    const configuration = structuredClone(DEFAULT_CRM_CONFIGURATION);
    const won = configuration.stages.find((stage) => stage.type === "won")!;
    won.key = "closed_sale";
    won.label = "Closed sale";
    expect(crmConfigurationIssues(configuration)).toEqual([]);
    await pool.query(
      "UPDATE company_settings SET crm_configuration=$1 WHERE id=101",
      [configuration],
    );
    const result = await csv(
      "won@example.invalid,Audit Co,closed_sale,12.50\n",
    );
    expect(result.status).toBe(200);
    expect(
      (await pool.query("SELECT status,pipeline_status FROM crm_contacts"))
        .rows[0],
    ).toEqual({ status: "won", pipeline_status: "closed_sale" });
    expect((await pool.query("SELECT status FROM leads")).rows[0].status).toBe(
      "converted",
    );
  });
  it("A23 account-only privacy export ignores stale selectors without an active business", async () => {
    await pool.query("DELETE FROM company_settings");
    await pool.query("UPDATE users SET is_approved=false WHERE id=9");
    const result = await request(app).post("/api/privacy/data-export")
      .set("x-business-profile-id", "stale-foreign-profile")
      .set("x-billing-organization-id", "stale-foreign-payer")
      .send({ userId: 19 });
    expect(result.status).toBe(200);
    expect(result.headers["x-data-export-user"]).toBe("9");
    expect(result.headers["cache-control"]).toBe("no-store");
    const lines = result.text.trimEnd().split("\n").map((line: string) => JSON.parse(line));
    expect(lines.find((line: any) => line.table === "users").data.id).toBe(9);
    expect(lines.at(-1)).toMatchObject({ table: "export_manifest", data: { status: "completed", inventoryComplete: false } });
  });

  it("A24 system maintenance excludes unapproved owners before executing callbacks", async () => {
    await pool.query("UPDATE users SET is_approved=false WHERE id=9");
    const work = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await runBusinessJob({ systemJob: true, type: "cron-storage-object-cleanup" }, work);
    expect(work).not.toHaveBeenCalled();
  });

});
