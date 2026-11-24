import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import request from "supertest";
import { withBusinessScope } from "../tenancy/businessContext.js";

let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, property) => (fixtureDb as any)[property].bind(fixtureDb),
    },
  ),
}));
jest.unstable_mockModule("../services/agents/AgentRouter.js", () => ({
  agentRouter: { handle: jest.fn() },
}));
jest.unstable_mockModule(
  "../services/agents/orchestration/PrivacyVaultService.js",
  () => ({
    redactPiiWithStableTokens: (text: string) => ({
      redactedText: text.replace(/person@example.invalid/g, "[EMAIL_1]"),
    }),
    privacyVaultService: {},
    encryptRestrictedPayload: jest.fn(),
    decryptRestrictedPayload: jest.fn(),
  }),
);
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
const {
  getSupportAIReport,
  getOwnerSupportSession,
  getSupportAIQuality,
  updateSupportMessageFeedback,
  archiveOwnerSupportSession,
  listOwnerSupportSessions,
} = await import("../controllers/ownerSupportAIController.js");
const {
  parseSupportReportQuery,
  parseSupportQualityQuery,
  parseStaffFeedback,
  SupportReportValidationError,
} = await import("../services/supportReporting/SupportAIReportingService.js");

// @ts-expect-error JavaScript migration uses the deployment runner's ESM convention.
const reportingMigration = await import("../migrations/321_support_reporting_indexes.js");
// @ts-expect-error JavaScript migration uses the deployment runner's ESM convention.
const widgetMigration = await import("../migrations/320_support_widget_settings.js");

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: Number(req.headers["x-user"] ?? 9) } as any;
  const business = Number(req.headers["x-business"] ?? 101);
  const actorUserId = req.user?.id;
  if (actorUserId)
    withBusinessScope(
      {
        userId: Number(req.headers["x-owner"] ?? actorUserId),
        actorUserId,
        businessProfileId: business,
      },
      next,
    );
  else next();
});
app.get("/report", getSupportAIReport);
app.get("/quality", getSupportAIQuality);
app.put("/messages/:messageId/feedback", updateSupportMessageFeedback);
app.patch("/sessions/:id", archiveOwnerSupportSession);
app.get("/sessions", listOwnerSupportSessions);
app.get("/sessions/:id", getOwnerSupportSession);

describe("support reporting input validation", () => {
  it("defaults to independent 25-row pages and rejects malformed values", () => {
    expect(parseSupportReportQuery({})).toMatchObject({
      source: "all",
      sessionPage: 1,
      leadPage: 1,
      limit: 25,
    });
    for (const query of [
      { from: "" },
      { to: "" },
      { teamId: "" },
      { from: "2026-02-30" },
      { from: "2026-13-01" },
      { from: "0000-01-01" },
      { from: "2026-03-02", to: "2026-03-01" },
      { source: ["widget"] },
      { source: "bad" },
      { teamId: "-1" },
      { limit: "101" },
      { sessionPage: "1x" },
      { sessionPage: "1.5" },
      { leadPage: "0" },
      { sessionSearch: "x".repeat(201) },
      { assistantId: ["a"] },
    ]) {
      expect(() => parseSupportReportQuery(query)).toThrow(
        SupportReportValidationError,
      );
    }
    expect(() => parseSupportQualityQuery({ status: "resolved" })).toThrow(
      SupportReportValidationError,
    );
    expect(() =>
      parseStaffFeedback({ rating: "needs_review", notes: "x".repeat(2001) }),
    ).toThrow(SupportReportValidationError);
  });
  it("returns HTTP validation errors without database access", async () => {
    for (const path of [
      "/report?from=2026-13-01",
      "/report?limit=101",
      "/quality?status=resolved",
    ]) {
      expect((await request(app).get(path)).status).toBe(400);
    }
    expect((await request(app).get("/report").set("x-user", "0")).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .put("/messages/oops/feedback")
          .send({ rating: "helpful" })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).put("/messages/1/feedback").send({ rating: "bad" }))
        .status,
    ).toBe(400);
    expect(
      (await request(app).patch("/sessions/1").send({ title: "   " })).status,
    ).toBe(400);
    expect(
      (await request(app).patch("/sessions/1").send({ archived: "true" }))
        .status,
    ).toBe(400);
  });
});

const localPostgres =
  process.env.SUPPORT_REPORTING_LOCAL_QA === "1" ? describe : describe.skip;
localPostgres(
  "support reports and quality (disposable local PostgreSQL schema)",
  () => {
    let pool: Pool;
    let admin: Pool;
    let schema: string;
    beforeAll(async () => {
      dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });
      if (
        !["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST || "")
      )
        throw new Error("Reporting QA requires local PostgreSQL");
      const config = {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || process.env.DB_DATABASE,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD || "",
        connectionTimeoutMillis: 5000,
      };
      schema = `support_reporting_qa_${randomBytes(8).toString("hex")}`;
      admin = new Pool({
        ...config,
        max: 1,
        options: "-c search_path=pg_catalog",
      });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({
        ...config,
        max: 4,
        options: `-c search_path=${schema},pg_catalog -c timezone=UTC`,
      });
      fixtureDb = drizzle(pool);
      await pool.query(`CREATE TABLE support_teams(id SERIAL PRIMARY KEY,user_id INTEGER,business_profile_id INTEGER,name TEXT);
      CREATE TABLE team_members(id SERIAL PRIMARY KEY,team_id INTEGER,user_id INTEGER,business_profile_id INTEGER,name TEXT);
      CREATE TABLE support_chat_sessions(id SERIAL PRIMARY KEY,member_id INTEGER,business_profile_id INTEGER,title TEXT,summary TEXT,
        lead_id INTEGER,ticket_id INTEGER,automation_mode TEXT DEFAULT 'ai_active',metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),client_session_key TEXT,public_token TEXT,session_expires_at TIMESTAMP,opted_out_at TIMESTAMP);
      CREATE TABLE support_chat_messages(id SERIAL PRIMARY KEY,session_id INTEGER,business_profile_id INTEGER,role TEXT,content TEXT,
        sources JSONB DEFAULT '[]',confidence REAL,metadata JSONB DEFAULT '{}',request_id TEXT,processing_started_at TIMESTAMP,processing_expires_at TIMESTAMP,deferred_commit JSONB,commit_token UUID,privacy_vault_id BIGINT,processing_status TEXT DEFAULT 'completed',created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE leads(id SERIAL PRIMARY KEY,user_id INTEGER,business_profile_id INTEGER,source TEXT,deleted_at TIMESTAMP,
        name TEXT,email TEXT,phone TEXT,status TEXT,lead_status TEXT,created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE outreach_assistants(id TEXT PRIMARY KEY,user_id INTEGER,business_profile_id INTEGER,draft JSONB);`);
      await reportingMigration.up(pool);
      await reportingMigration.up(pool);
      await reportingMigration.down(pool);
      await reportingMigration.up(pool);
      await widgetMigration.up(pool);
      await widgetMigration.up(pool);
      await widgetMigration.down(pool);
      await widgetMigration.up(pool);
    });
    afterAll(async () => {
      await pool?.end();
      if (admin && /^support_reporting_qa_[a-f0-9]{16}$/.test(schema))
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin?.end();
    });
    beforeEach(async () => {
      await pool.query(`TRUNCATE support_teams,team_members,support_chat_sessions,support_chat_messages,leads,outreach_assistants RESTART IDENTITY;
      INSERT INTO support_teams(id,user_id,business_profile_id,name) VALUES(1,9,101,'Main'),(2,9,102,'Other business'),(3,10,201,'Foreign');
      INSERT INTO team_members(id,team_id,user_id,business_profile_id,name) VALUES(1,1,9,101,'Alex'),(2,2,9,102,'Other'),(3,3,10,201,'Foreign');
      INSERT INTO outreach_assistants VALUES('assistant-a',9,101,'{"name":"Main assistant"}'),('assistant-b',9,102,'{"name":"Other"}');
      INSERT INTO support_chat_sessions(id,member_id,business_profile_id,title,metadata,created_at,updated_at,lead_id) SELECT n,1,101,'Chat '||n,'{"source":"widget","assistantId":"assistant-a"}','2026-09-20','2026-09-20',NULL FROM generate_series(1,125) n;
      INSERT INTO support_chat_sessions(id,member_id,business_profile_id,title,metadata,created_at,updated_at) VALUES(200,2,102,'Other business secret','{"source":"widget"}','2026-09-20','2026-09-20'),(300,3,201,'Foreign secret','{"source":"widget"}','2026-09-20','2026-09-20'),(126,1,101,'Internal','{}','2026-09-21','2026-09-21');
      INSERT INTO support_chat_messages(session_id,business_profile_id,role,content,created_at) SELECT id,business_profile_id,'user','Question '||id,'2026-09-20' FROM support_chat_sessions;
      INSERT INTO leads(id,user_id,business_profile_id,source,name,status,created_at) VALUES(1,9,101,'support_widget','Literal % customer','new','2026-09-20'),(2,9,101,'support_widget','Converted lead','converted','2026-09-20'),(3,9,102,'support_widget','Other business lead','new','2026-09-20'),(4,10,201,'support_widget','Foreign lead','new','2026-09-20'),(5,9,101,'support_widget','Historical orphan','new','2026-09-20');
      UPDATE support_chat_sessions SET lead_id=1 WHERE id IN (1,2); UPDATE support_chat_sessions SET lead_id=2 WHERE id=3;
      UPDATE support_chat_sessions SET lead_id=4 WHERE id=125;`);
    });
    it("searches complete history, isolates businesses, and returns stable independent pagination and totals", async () => {
      await pool.query(
        "UPDATE support_chat_messages SET content='Hidden needle outside page' WHERE session_id=1",
      );
      const full = await request(app).get("/report");
      expect(full.status).toBe(200);
      expect(full.body.data.stats).toEqual({
        totalSessions: 126,
        widgetSessions: 125,
        totalMessages: 126,
        leadsGenerated: 3,
      });
      expect(full.body.data.sessions).toHaveLength(25);
      expect(full.body.data.sessions.map((s: any) => s.id)).toEqual([
        126,
        ...Array.from({ length: 24 }, (_, i) => 125 - i),
      ]);
      expect(full.body.data.filters).toEqual({
        teams: [{ id: 1, name: "Main" }],
        assistants: [{ id: "assistant-a", name: "Main assistant" }],
      });
      expect(
        full.body.data.sessions.find((s: any) => s.id === 125).leadInfo,
      ).toBeNull();
      expect(JSON.stringify(full.body)).not.toContain("Other business");
      expect(JSON.stringify(full.body)).not.toContain("Foreign");
      const searched = await request(app).get(
        "/report?sessionSearch=needle&leadSearch=%25",
      );
      expect(searched.body.data.sessions.map((s: any) => s.id)).toEqual([1]);
      expect(searched.body.data.pagination.sessions.total).toBe(1);
      expect(searched.body.data.leads.map((l: any) => l.id)).toEqual([1]);
      expect(searched.body.data.stats).toEqual(full.body.data.stats);
      const page = await request(app).get("/report?sessionPage=2&limit=25");
      expect(page.body.data.sessions[0].id).toBe(101);
      expect(page.body.data.pagination.sessions).toEqual({
        page: 2,
        limit: 25,
        total: 126,
        totalPages: 6,
      });
    });
    it("searches displayed lead statuses and scoped conversation visitor/linked contact fields literally", async () => {
      await pool.query(`UPDATE leads SET email='linked_%@example.invalid',phone='+9100000' WHERE id=1;
        UPDATE leads SET email='foreign_contact@example.invalid' WHERE id=4;
        UPDATE support_chat_sessions SET metadata=metadata||'{"visitorEmail":"visitor_%@example.invalid","visitorPhone":"+9122222"}' WHERE id=4;`);
      const status = await request(app)
        .get("/report")
        .query({ leadSearch: "converted" });
      expect(status.status).toBe(200);
      expect(
        status.body.data.leads.map((lead: { id: number }) => lead.id),
      ).toEqual([2]);
      expect(status.body.data.pagination.leads.total).toBe(1);
      const contact = await request(app)
        .get("/report")
        .query({ sessionSearch: "linked_%" });
      expect(
        contact.body.data.sessions.map((session: { id: number }) => session.id),
      ).toEqual([2, 1]);
      expect(contact.body.data.pagination.sessions.total).toBe(2);
      const phone = await request(app)
        .get("/report")
        .query({ sessionSearch: "+9100000" });
      expect(phone.body.data.pagination.sessions.total).toBe(2);
      for (const sessionSearch of ["visitor_%", "+9122222"]) {
        const visitor = await request(app)
          .get("/report")
          .query({ sessionSearch });
        expect(
          visitor.body.data.sessions.map(
            (session: { id: number }) => session.id,
          ),
        ).toEqual([4]);
      }
      const foreign = await request(app)
        .get("/report")
        .query({ sessionSearch: "foreign_contact" });
      expect(foreign.body.data.sessions).toEqual([]);
      expect(foreign.body.data.pagination.sessions.total).toBe(0);
      await pool.query("UPDATE leads SET deleted_at=NOW() WHERE id=1");
      const deleted = await request(app)
        .get("/report")
        .query({ sessionSearch: "linked_%" });
      expect(deleted.body.data.sessions).toEqual([]);
    });
    it("omits operational private metadata from report and transcript JSON while retaining feedback and display context", async () => {
      const metadata = {
        source: "widget",
        visitorName: "Customer",
        customerFeedback: { rating: "helpful" },
        profilePrivacyVaultId: "private-vault",
        deferredCommit: { payload: "private-deferred" },
        commit_token: "private-commit-token",
        sessionToken: "private-session-token",
        capability: { token: "private-capability" },
        nested: {
          privacy_vault_id: "nested-private-vault",
          safe: "display context",
        },
        attachments: [
          {
            id: "asset",
            name: "Attachment",
            capabilityToken: "private-asset-capability",
          },
        ],
      };
      await pool.query(
        "UPDATE support_chat_sessions SET metadata=$1::jsonb WHERE id=125",
        [JSON.stringify(metadata)],
      );
      await pool.query(
        "INSERT INTO support_chat_messages(id,session_id,business_profile_id,role,content,metadata) VALUES(1000,125,101,'assistant','Visible answer',$1::jsonb)",
        [JSON.stringify(metadata)],
      );
      const report = await request(app).get("/report");
      const row = report.body.data.sessions.find(
        (session: { id: number }) => session.id === 125,
      );
      expect(row.metadata).toMatchObject({
        source: "widget",
        visitorName: "Customer",
        customerFeedback: { rating: "helpful" },
        nested: { safe: "display context" },
        attachments: [{ id: "asset", name: "Attachment" }],
      });
      expect(JSON.stringify(report.body)).not.toContain("private-");
      expect(JSON.stringify(report.body)).not.toContain("nested-private-vault");
      const detail = await request(app).get("/sessions/125");
      expect(detail.body.data.metadata).toEqual(row.metadata);
      expect(detail.body.data.messages.at(-1).metadata).toEqual(row.metadata);
      expect(JSON.stringify(detail.body)).not.toContain("private-");
      const persisted = (
        await pool.query(
          "SELECT metadata FROM support_chat_sessions WHERE id=125",
        )
      ).rows[0].metadata;
      expect(persisted).toEqual(metadata);
    });
    it("uses inclusive UTC creation-date filters and distinct linked leads for source/team/assistant filters", async () => {
      await pool.query(
        "UPDATE support_chat_sessions SET created_at='2026-09-20 23:59:59' WHERE id=1; UPDATE support_chat_sessions SET created_at='2026-09-21 00:00:00' WHERE id=2",
      );
      const date = await request(app).get(
        "/report?from=2026-09-20&to=2026-09-20&source=widget&teamId=1&assistantId=assistant-a",
      );
      expect(date.status).toBe(200);
      expect(date.body.data.stats.totalSessions).toBe(124);
      expect(date.body.data.stats.leadsGenerated).toBe(2);
      const internal = await request(app).get("/report?source=internal");
      expect(internal.body.data.stats).toEqual({
        totalSessions: 1,
        widgetSessions: 0,
        totalMessages: 1,
        leadsGenerated: 0,
      });
      expect(internal.body.data.metrics.leadConversionRate).toBeNull();
      const empty = await request(app).get("/report?teamId=2");
      expect(empty.body.data.stats.totalSessions).toBe(0);
      expect(empty.body.data.leads).toEqual([]);
    });
    it("atomically preserves unrelated metadata and attribution while preventing feedback on foreign/user messages", async () => {
      await pool.query(`INSERT INTO support_chat_messages(id,session_id,business_profile_id,role,content,metadata,created_at)
      VALUES(1000,1,101,'assistant','Approved answer','{"attachments":[{"id":"asset"}],"provenance":{"approved":true}}','2026-09-20 00:00:04'),
      (1001,200,102,'assistant','Foreign business answer','{}','2026-09-20'),(1002,300,201,'assistant','Foreign answer','{}','2026-09-20');`);
      expect(
        (
          await request(app)
            .put("/messages/1001/feedback")
            .send({ rating: "needs_review" })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .put("/messages/1002/feedback")
            .send({ rating: "needs_review" })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .put("/messages/1/feedback")
            .send({ rating: "needs_review" })
        ).status,
      ).toBe(404);
      const saved = await request(app).put("/messages/1000/feedback").send({
        rating: "needs_review",
        reason: "incorrect",
        notes: "Contact person@example.invalid",
      });
      expect(saved.status).toBe(200);
      expect(saved.body.data.feedback).toMatchObject({
        rating: "needs_review",
        reason: "incorrect",
        notes: "Contact [EMAIL_1]",
        status: "open",
        actorUserId: 9,
      });
      const stored = (
        await pool.query(
          "SELECT metadata FROM support_chat_messages WHERE id=1000",
        )
      ).rows[0].metadata;
      expect(stored.attachments).toEqual([{ id: "asset" }]);
      expect(stored.provenance).toEqual({ approved: true });
      await request(app)
        .put("/messages/1000/feedback")
        .send({ rating: "helpful" });
      const replaced = (
        await pool.query(
          "SELECT metadata FROM support_chat_messages WHERE id=1000",
        )
      ).rows[0].metadata;
      expect(replaced.staffFeedback).toMatchObject({
        rating: "helpful",
        status: "reviewed",
      });
      expect(replaced.staffFeedback).not.toHaveProperty("reason");
      expect(replaced.attachments).toEqual(stored.attachments);
      const delegate = await request(app)
        .put("/messages/1000/feedback")
        .set("x-user", "20")
        .set("x-owner", "9")
        .send({ rating: "needs_review", reason: "other" });
      expect(delegate.status).toBe(200);
      expect(delegate.body.data.feedback.actorUserId).toBe(20);
      await pool.query(
        "INSERT INTO support_chat_messages(id,session_id,business_profile_id,role,content,metadata) VALUES(1003,1,101,'assistant','Legacy answer','null'::jsonb)",
      );
      const legacy = await request(app)
        .put("/messages/1003/feedback")
        .send({ rating: "helpful" });
      expect(legacy.status).toBe(200);
      expect(legacy.body.data.feedback.rating).toBe("helpful");
    });
    it("paginates explicit quality flags and computes truthful recorded metrics without inventing resolutions", async () => {
      await pool.query(`INSERT INTO support_chat_messages(id,session_id,business_profile_id,role,content,metadata,created_at) VALUES
      (1000,1,101,'assistant','Helpful answer','{"staffFeedback":{"rating":"helpful","status":"reviewed"}}','2026-09-20 00:00:04'),
      (1001,2,101,'assistant','Bad answer','{"staffFeedback":{"rating":"needs_review","status":"open","reason":"missing_information","notes":"Missing manual"}}','2026-09-20 00:00:06'),
      (1002,2,101,'assistant','Second answer part','{}','2026-09-20 00:00:07');
      UPDATE support_chat_sessions SET metadata=metadata||'{"customerFeedback":{"rating":"helpful"}}' WHERE id=1;
      UPDATE support_chat_sessions SET metadata=metadata||'{"customerFeedback":{"rating":"not_helpful"}}',automation_mode='human_paused' WHERE id=2;
      UPDATE support_chat_sessions SET ticket_id=12 WHERE id=3;`);
      const quality = await request(app).get("/quality");
      expect(quality.status).toBe(200);
      expect(quality.body.data.items).toHaveLength(1);
      expect(quality.body.data.items[0]).toMatchObject({
        messageId: 1001,
        question: "Question 2",
        answer: "Bad answer",
        teamName: "Main",
      });
      expect(quality.body.data.summary).toEqual({
        open: 1,
        reviewed: 1,
        helpful: 1,
      });
      const all = await request(app).get("/quality?status=all&limit=1&page=2");
      expect(all.body.data.pagination).toEqual({
        page: 2,
        limit: 1,
        total: 2,
        totalPages: 2,
      });
      const search = await request(app).get("/quality?search=Missing%20manual");
      expect(search.body.data.items[0].messageId).toBe(1001);
      const report = await request(app).get("/report");
      expect(report.body.data.metrics).toMatchObject({
        averageResponseSeconds: 5,
        feedbackCount: 2,
        helpfulRate: 50,
        csatCount: 2,
        satisfactionRate: 50,
        handoffCount: 2,
        convertedLeads: 1,
      });
      expect(report.body.data.metrics.leadConversionRate).toBeCloseTo(100 / 3);
      expect(report.body.data.metrics).not.toHaveProperty("resolutionRate");
    });
    it("returns scoped transcript context and withholds session secrets and private commit payloads", async () => {
      await pool.query(`UPDATE support_chat_sessions SET public_token='private-session-secret' WHERE id=1;
        INSERT INTO support_chat_messages(id,session_id,business_profile_id,role,content,metadata,deferred_commit,created_at)
        VALUES(1000,1,101,'assistant','Visible answer','{"attachments":[]}','{"secret":"private-commit"}','2026-09-20 00:00:01');`);
      const detail = await request(app).get("/sessions/1");
      expect(detail.status).toBe(200);
      const migrationColumns = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='support_teams' AND column_name IN ('widget_settings','widget_installation')",
        [schema],
      );
      expect(migrationColumns.rowCount).toBe(2);
      const indexes = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname IN ('idx_support_chat_sessions_reporting','idx_support_chat_messages_timeline','idx_support_chat_messages_staff_feedback','idx_support_widget_leads_reporting')",
        [schema],
      );
      expect(indexes.rowCount).toBe(4);
      expect(detail.body.data).toMatchObject({
        id: 1,
        teamId: 1,
        teamName: "Main",
        memberName: "Alex",
        messageCount: 2,
        leadInfo: { id: 1, name: "Literal % customer" },
      });
      expect(detail.body.data.messages[1]).toMatchObject({
        content: "Visible answer",
        metadata: { attachments: [] },
      });
      expect(JSON.stringify(detail.body)).not.toContain(
        "private-session-secret",
      );
      expect(JSON.stringify(detail.body)).not.toContain("private-commit");
      expect((await request(app).get("/sessions/200")).status).toBe(404);
      expect((await request(app).get("/sessions/300")).status).toBe(404);
      expect((await request(app).get("/sessions/1x")).status).toBe(400);
    });
    it("renames and archives sessions without overwriting widget metadata, and excludes widgets before internal list pagination", async () => {
      const rename = await request(app)
        .patch("/sessions/1")
        .send({ title: "  Updated person@example.invalid  ", archived: true });
      expect(rename.status).toBe(200);
      expect(rename.body.data).toMatchObject({
        id: 1,
        title: "Updated [EMAIL_1]",
        archived: true,
      });
      expect(
        (
          await pool.query(
            "SELECT metadata FROM support_chat_sessions WHERE id=1",
          )
        ).rows[0].metadata.source,
      ).toBe("widget");
      expect(
        (await request(app).patch("/sessions/200").send({ title: "Stolen" }))
          .status,
      ).toBe(404);
      const internal = await request(app).get(
        "/sessions?source=internal&page=1&limit=1",
      );
      expect(internal.status).toBe(200);
      expect(internal.body.total).toBe(1);
      expect(internal.body.data[0].id).toBe(126);
      await pool.query(
        "UPDATE support_chat_messages SET content='Unique internal % search' WHERE session_id=126",
      );
      const found = await request(app).get(
        "/sessions?source=internal&search=%25",
      );
      expect(
        found.body.data.map((session: { id: number }) => session.id),
      ).toEqual([126]);
    });
  },
);
