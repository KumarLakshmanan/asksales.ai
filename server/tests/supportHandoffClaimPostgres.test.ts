import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  jest,
} from "@jest/globals";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns, getTableName, SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import express from "express";
import jwt from "jsonwebtoken";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
// Opt-in Unix socket only: never consume inherited production database URLs.
const socket = process.env.SUPPORT_CLAIM_PG_SOCKET;
const qa = socket ? describe : describe.skip;
let admin: Pool;
let raw: Pool;
let database: any;
let server: any;
let schema: string;
let beforeUpdate: (() => Promise<void>) | undefined;
let beforeTransaction: (() => Promise<void>) | undefined;
const dialect = new PgDialect();
function wrapped(database: any): any {
  return new Proxy(database, {
    get(target, key) {
      if (key === "transaction")
        return async (fn: any, ...args: any[]) => {
          const hook = beforeTransaction;
          beforeTransaction = undefined;
          await hook?.();
          return target.transaction((tx: any) => fn(wrapped(tx)), ...args);
        };
      if (key === "execute")
        return async (q: any) => {
          const sqlText =
            typeof q === "string"
              ? q
              : dialect.sqlToQuery(q.getSQL ? q.getSQL() : q).sql;
          if (
            /UPDATE\s+handoff_queue/.test(sqlText) &&
            sqlText.includes("support_ticket_id IS NULL")
          ) {
            const hook = beforeUpdate;
            beforeUpdate = undefined;
            await hook?.();
          }
          return target.execute(q);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const proxy = new Proxy(
  {},
  {
    get(_target, key) {
      const value = Reflect.get(wrapped(database), key);
      return value;
    },
  },
);
jest.unstable_mockModule(root + "/models/db.ts", () => ({
  db: proxy,
  pgPool: undefined,
}));
jest.unstable_mockModule(root + "/infrastructure/redis.ts", () => ({
  getRedisConnection() {
    throw Error("Synthetic Redis unavailable; in-memory fallback");
  },
  getRedisSubscriber() {
    throw Error("Synthetic subscriber disabled");
  },
  closeRedisConnections: async () => {},
  isRedisAvailable: async () => false,
}));
const schemas = await import(root + "/models/allSchemas.ts");
const presence = await import(root + "/models/supportMemberPresence/schema.ts");
const orchestration = await import(
  root + "/models/supportOrchestration/schema.ts"
);
const { createBusinessScopedPool } = await import(
  root + "/tenancy/scopedPool.ts"
);
const { localBusinessFunctions, localBusinessIsolation } = await import(
  root + "/tests/helpers/localBusinessPostgres.ts"
);
const { default: router } = await import(
  root + "/routes/supportMember.routes.ts"
);
const { withBusinessScope } = await import(
  root + "/tenancy/businessContext.ts"
);
async function api(path: string, method = "GET", body?: any, member = 5) {
  const token = jwt.sign(
    { supportMemberId: member, email: "synthetic@example.invalid" },
    process.env.JWT_SECRET!,
    { expiresIn: 3600 },
  );
  const response = await fetch("http://127.0.0.1:8319" + path, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}
async function reset() {
  await admin.query(
    "TRUNCATE support_delivery_outbox,support_ticket_messages,support_chat_messages,support_ticket_read_receipts RESTART IDENTITY; UPDATE support_tickets SET assigned_member_id=NULL,status='open',version=4,resolved_at=NULL,closed_at=NULL,total_messages=1 WHERE id=59; UPDATE team_members SET is_active=TRUE WHERE id=5; UPDATE handoff_queue SET status='waiting',assigned_member_id=NULL,team_id=2,ai_reply_enabled=TRUE WHERE id=12; INSERT INTO support_ticket_messages(id,user_id,business_profile_id,ticket_id,content,direction) VALUES(10,9,1,59,'Synthetic customer question','inbound'); SELECT setval(pg_get_serial_sequence('support_ticket_messages','id'),10);",
  );
}
qa("scoped support claim and queue on disposable PostgreSQL", () => {
  beforeAll(async () => {
    if (
      socket !== "/workspace/support-second-pass-fix-evidence-20261023/pgsocket"
    )
      throw Error("Only the owned disposable support socket is allowed");
    schema = "support_second_" + crypto.randomBytes(8).toString("hex");
    admin = new Pool({
      host: socket,
      user: "postgres",
      database: "postgres",
      max: 1,
      connectionTimeoutMillis: 5000,
      options: "-c search_path=" + schema + ",public -c timezone=UTC",
    });
    await admin.query(
      "CREATE SCHEMA " + schema + "; SET search_path=" + schema + ",public",
    );
    await localBusinessFunctions(admin);
    await admin.query(
      "CREATE TABLE users(id int PRIMARY KEY,name text,email text,password text); CREATE TABLE company_settings(id int PRIMARY KEY,user_id int); INSERT INTO company_settings VALUES(1,9),(2,9),(3,10); INSERT INTO users VALUES(9,'Synthetic owner','owner@synthetic.invalid','unused'),(10,'Other owner','other@synthetic.invalid','unused')",
    );
    const wanted = new Set([
      "support_tickets",
      "support_teams",
      "team_members",
      "support_ticket_messages",
      "support_chat_sessions",
      "support_chat_messages",
      "support_delivery_outbox",
      "handoff_queue",
      "support_admin_audit_logs",
      "crm_contacts",
      "leads",
      "outreach_conversations",
      "outreach_messages",
      "agent_audit_logs",
      "support_ticket_summaries",
      "support_member_presence_sessions",
      "support_ticket_reviews",
      "tool_approvals",
    ]);
    const tables = new Map<string, any>();
    for (const mod of [schemas, schemas.schema, presence, orchestration])
      for (const value of Object.values(mod)) {
        try {
          const name = getTableName(value as any);
          if (wanted.has(name)) tables.set(name, value);
        } catch {
          // Schema modules also export non-table values; only the listed tables matter here.
        }
      }
    expect([...wanted].filter((name) => !tables.has(name))).toEqual([]);
    const businessTables: string[] = [];
    for (const [name, table] of tables) {
      const columns = Object.values(getTableColumns(table)) as any[];
      const definitions = columns.map((column) => {
        let text = '"' + column.name + '" ' + column.getSQLType();
        if (column.primary) text += " PRIMARY KEY";
        if (column.notNull) text += " NOT NULL";
        if (column.default !== undefined) {
          const d = column.default;
          if (d instanceof SQL) text += " DEFAULT " + dialect.sqlToQuery(d).sql;
          else if (column.getSQLType() === "jsonb")
            text +=
              " DEFAULT '" +
              (typeof d === "string" ? d : JSON.stringify(d)).replaceAll(
                "'",
                "''",
              ) +
              "'::jsonb";
          else
            text +=
              " DEFAULT " +
              (typeof d === "string"
                ? "'" + d.replaceAll("'", "''") + "'"
                : String(d));
        }
        return text;
      });
      await admin.query(
        'CREATE TABLE "' + name + '" (' + definitions.join(",") + ")",
      );
      if (columns.some((c) => c.name === "business_profile_id"))
        businessTables.push(name);
    }
    await admin.query(
      "CREATE TABLE support_ticket_read_receipts(business_profile_id int,user_id int,ticket_id int,reader_kind text,reader_id int,last_read_message_id int,last_read_at timestamp,created_at timestamp,updated_at timestamp,UNIQUE(business_profile_id,user_id,ticket_id,reader_kind,reader_id));",
    );
    businessTables.push("support_ticket_read_receipts");
    await admin.query(
      "CREATE UNIQUE INDEX decision_unique ON support_delivery_outbox(decision_key); CREATE UNIQUE INDEX message_delivery_unique ON support_ticket_messages(delivery_action_id) WHERE delivery_action_id IS NOT NULL; CREATE UNIQUE INDEX chat_request_unique ON support_chat_messages(session_id,request_id) WHERE request_id IS NOT NULL; CREATE UNIQUE INDEX summary_unique ON support_ticket_summaries(business_profile_id,user_id,ticket_id);",
    );
    await localBusinessIsolation(admin, schema, businessTables);
    await admin.query(
      "INSERT INTO support_teams(id,user_id,business_profile_id,name) VALUES(2,9,1,'Synthetic Billing'),(3,9,1,'Other Queue'),(4,9,2,'Other Business'),(5,10,3,'Other Tenant'); INSERT INTO team_members(id,user_id,business_profile_id,team_id,name,email,role,is_active) VALUES(5,9,1,2,'Synthetic Agent','agent@synthetic.invalid','member',TRUE),(6,9,1,3,'Other Queue Agent','queue@synthetic.invalid','member',TRUE),(7,9,1,2,'Synthetic Lead','lead@synthetic.invalid','lead',TRUE),(8,9,2,4,'Other Business Agent','business@synthetic.invalid','member',TRUE),(9,10,3,5,'Other Tenant Agent','tenant@synthetic.invalid','member',TRUE); INSERT INTO support_tickets(id,user_id,business_profile_id,ticket_number,subject,team_id,assigned_member_id,status,version) VALUES(59,9,1,'TKT-S59001','Synthetic billing question',2,NULL,'open',4),(60,9,2,'TKT-OTHER-BUSINESS','Other business confidential request',4,8,'open',1),(61,10,3,'TKT-OTHER-TENANT','Other tenant confidential request',5,9,'open',1),(62,9,1,'TKT-OTHER-QUEUE','Other queue request',3,6,'open',1); INSERT INTO support_chat_sessions(id,member_id,business_profile_id,ticket_id,public_token,session_expires_at) VALUES(20,5,1,59,'synthetic-public-token',NOW()+INTERVAL '1 hour'); INSERT INTO handoff_queue(id,user_id,business_profile_id,conversation_id,channel,support_ticket_id,team_id,status,ai_reply_enabled) VALUES(12,9,1,-20,'web',59,2,'waiting',TRUE),(14,9,1,68,'email',NULL,2,'waiting',TRUE); INSERT INTO support_ticket_summaries(user_id,business_profile_id,ticket_id,status,summary,generated_at) VALUES(9,1,59,'current','{\"issue\":\"Synthetic billing question\",\"customerIntent\":\"Get help\",\"importantFacts\":[],\"actionsAttempted\":[],\"unresolvedQuestions\":[],\"recommendedNextAction\":\"Review ticket\",\"sourceReferences\":[]}',NOW())",
    );
    raw = new Pool({
      host: socket,
      user: "postgres",
      database: "postgres",
      max: 4,
      options: "-c search_path=" + schema + ",public -c timezone=UTC",
    });
    database = drizzle(createBusinessScopedPool(raw));
    await admin.query(
      "ALTER TABLE users ADD COLUMN deleted_at timestamp, ADD COLUMN is_approved boolean DEFAULT TRUE; ALTER TABLE company_settings ADD COLUMN archived_at timestamp; INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,last_name,email) VALUES(30,9,1,'Casey','Customer','casey@synthetic.invalid'); UPDATE support_tickets SET contact_id=30 WHERE id=59; CREATE SEQUENCE audit_presence_id; ALTER TABLE support_member_presence_sessions ALTER COLUMN id SET DEFAULT nextval('audit_presence_id'); CREATE UNIQUE INDEX support_presence_one_open_session_uq ON support_member_presence_sessions(business_profile_id,user_id,member_id,session_fingerprint) WHERE ended_at IS NULL; GRANT USAGE,SELECT ON SEQUENCE audit_presence_id TO salesmarketing_business_runtime;",
    );
    const policySource = fs.readFileSync(
      new URL(
        "../migrations/304_business_profile_memberships.js",
        import.meta.url,
      ),
      "utf8",
    );
    const start = policySource.indexOf(
      "CREATE FUNCTION app_business_actor_user_id()",
    );
    const end = policySource.indexOf("    DO $$ DECLARE t record;", start);
    if (start < 0 || end < start)
      throw Error("Migration 304 access functions not found");
    // Same function bodies and predicates; isolate SECURITY DEFINER lookup to this fixture schema.
    const definitions = policySource
      .slice(start, end)
      .replace(
        "SET search_path=public,pg_catalog",
        "SET search_path=" + schema + ",public,pg_catalog",
      );
    await admin.query(
      "CREATE TABLE business_profile_memberships(id int,business_profile_id int,user_id int,status text); " +
        definitions,
    );
    for (const name of businessTables)
      await admin.query(
        'ALTER POLICY business_isolation ON "' +
          name +
          '" USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id))',
      );
    await reset();
    const app = express();
    app.use(express.json());
    app.get("/api/auth/me", (_req, res) =>
      res.status(401).json({ error: "Synthetic owner shell signed out" }),
    );
    app.get("/api/auth/csrf-token", (_req, res) =>
      res
        .cookie("XSRF-TOKEN", "synthetic-csrf")
        .json({ csrfToken: "synthetic-csrf" }),
    );
    app.use("/api/support-portal", router);
    app.use((_req, res) =>
      res.status(404).json({ error: "Not in synthetic audit surface" }),
    );
    server = await new Promise<any>((resolve) => {
      const s = app.listen(8319, "127.0.0.1", () => resolve(s));
    });
  }, 180000);
  beforeEach(async () => {
    beforeUpdate = undefined;
    beforeTransaction = undefined;
    await admin.query(
      "UPDATE users SET deleted_at=NULL; UPDATE company_settings SET archived_at=NULL; UPDATE team_members SET is_active=TRUE,team_id=CASE WHEN id IN (5,7) THEN 2 WHEN id=6 THEN 3 ELSE team_id END; UPDATE support_teams SET is_active=TRUE; UPDATE handoff_queue SET team_id=2,version=2,status='waiting',assigned_member_id=NULL,support_ticket_id=NULL,accepted_at=NULL,ai_reply_enabled=TRUE WHERE id=14; UPDATE handoff_queue SET team_id=2,status='waiting',assigned_member_id=NULL WHERE id=12; UPDATE support_tickets SET assigned_member_id=NULL,status='open',version=4 WHERE id=59",
    );
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await raw?.end();
    if (admin) {
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
    }
  }, 30000);
  const claim = () => api("/api/support-portal/handoffs/14/claim", "POST", {});
  const handoff = async () =>
    (
      await admin.query(
        "SELECT team_id,assigned_member_id,status,version,support_ticket_id,ai_reply_enabled FROM handoff_queue WHERE id=14",
      )
    ).rows[0];
  it("executes business queries through the unprivileged scoped runtime role", async () => {
    const result = await withBusinessScope(
      { userId: 9, businessProfileId: 1 },
      () => database.execute(sql.raw("SELECT current_user role")),
    );
    expect(result.rows[0].role).toBe("salesmarketing_business_runtime");
  });
  it("claims an authorized unlinked handoff without implicitly pausing AI", async () => {
    const response = await claim();
    expect(response.status).toBe(200);
    expect(await handoff()).toMatchObject({
      team_id: 2,
      assigned_member_id: 5,
      status: "in_progress",
      version: 3,
      ai_reply_enabled: true,
    });
  });
  it("rejects a team move between preflight and the actual update", async () => {
    beforeUpdate = async () => {
      await admin.query(
        "UPDATE handoff_queue SET team_id=3,version=version+1 WHERE id=14",
      );
    };
    const response = await claim();
    expect(response.status).toBe(409);
    expect(await handoff()).toMatchObject({
      team_id: 3,
      assigned_member_id: null,
      status: "waiting",
      version: 3,
    });
  });
  it("rejects any intervening handoff version change", async () => {
    beforeUpdate = async () => {
      await admin.query(
        "UPDATE handoff_queue SET priority='high',version=version+1 WHERE id=14",
      );
    };
    expect((await claim()).status).toBe(409);
    expect(await handoff()).toMatchObject({
      assigned_member_id: null,
      status: "waiting",
      version: 3,
    });
  });
  it.each(["member", "team", "membership"])(
    "rechecks current %s authority after preflight",
    async (change) => {
      beforeTransaction = async () => {
        await admin.query(
          change === "member"
            ? "UPDATE team_members SET is_active=FALSE WHERE id=5"
            : change === "team"
              ? "UPDATE support_teams SET is_active=FALSE WHERE id=2"
              : "UPDATE team_members SET team_id=3 WHERE id=5",
        );
      };
      expect((await claim()).status).toBe(403);
      expect(await handoff()).toMatchObject({
        assigned_member_id: null,
        status: "waiting",
        version: 2,
      });
    },
  );
  it("does not overwrite a concurrent other member claim", async () => {
    beforeUpdate = async () => {
      await admin.query(
        "UPDATE handoff_queue SET assigned_member_id=7,status='in_progress',version=version+1 WHERE id=14",
      );
    };
    expect((await claim()).status).toBe(409);
    expect(await handoff()).toMatchObject({
      assigned_member_id: 7,
      status: "in_progress",
      version: 3,
    });
  });
  it("does not mutate a newly linked ticket through the legacy branch", async () => {
    beforeUpdate = async () => {
      await admin.query(
        "UPDATE handoff_queue SET support_ticket_id=59,version=version+1 WHERE id=14",
      );
    };
    expect((await claim()).status).toBe(409);
    expect(await handoff()).toMatchObject({
      assigned_member_id: null,
      support_ticket_id: 59,
      version: 3,
    });
    expect(
      (
        await admin.query(
          "SELECT assigned_member_id,version FROM support_tickets WHERE id=59",
        )
      ).rows[0],
    ).toEqual({ assigned_member_id: null, version: 4 });
  });
  it("holds current member and team authorization until claim commits", async () => {
    beforeUpdate = async () => {
      for (const statement of [
        "UPDATE team_members SET is_active=FALSE WHERE id=5",
        "UPDATE support_teams SET is_active=FALSE WHERE id=2",
      ]) {
        await admin.query("SET lock_timeout='100ms'");
        await expect(admin.query(statement)).rejects.toMatchObject({
          code: "55P03",
        });
        await admin.query("SET lock_timeout=0");
      }
    };
    expect((await claim()).status).toBe(200);
    expect(await handoff()).toMatchObject({
      assigned_member_id: 5,
      status: "in_progress",
    });
  });
  it("keeps linked ticket claims on the canonical atomic lifecycle", async () => {
    const response = await api(
      "/api/support-portal/handoffs/12/claim",
      "POST",
      {},
    );
    expect(response.status).toBe(200);
    expect(
      (
        await admin.query(
          "SELECT assigned_member_id,status FROM support_tickets WHERE id=59",
        )
      ).rows[0],
    ).toEqual({ assigned_member_id: 5, status: "in_progress" });
  });
  it("denies another business profile", async () => {
    const response = await api(
      "/api/support-portal/handoffs/14/claim",
      "POST",
      {},
      8,
    );
    expect(response.status).toBe(404);
    expect(await handoff()).toMatchObject({
      assigned_member_id: null,
      version: 2,
    });
  });
  it("does not hide a deleted-owner rejection behind the older policy helper", async () => {
    await admin.query("UPDATE users SET deleted_at=NOW() WHERE id=9");
    expect((await claim()).status).toBe(403);
  });
  it.each([
    "2147483648",
    "4294967296",
    "9007199254740991",
    "9007199254740992",
    "0",
    "-1",
    "1.5",
    "not-a-member",
  ])(
    "rejects out-of-range or invalid int4 assignee %s before a queue query",
    async (assignee) => {
      const response = await api(
        "/api/support-portal/tickets?scope=team&assignee=" +
          encodeURIComponent(assignee),
      );
      expect(response.status).toBe(400);
      expect(response.data).toEqual({ error: "Invalid assignee filter" });
    },
  );
  it.each(["5", "2147483647", "unassigned"])(
    "accepts a supported assignee filter %s on scoped persistence",
    async (assignee) => {
      const response = await api(
        "/api/support-portal/tickets?scope=team&assignee=" + assignee,
      );
      expect(response.status).toBe(200);
      expect(
        response.data.data.tickets.map((ticket: { id: number }) => ticket.id),
      ).toEqual(assignee === "unassigned" ? [59] : []);
    },
  );
});
