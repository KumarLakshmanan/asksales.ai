import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql, getTableColumns } from "drizzle-orm";
import { leadsTable } from "../models/leads/schema.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let pool: Pool;
let database: NodePgDatabase;
const schema = `outreach_creation_qa_${process.pid}`;
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        const value = (database as unknown as Record<PropertyKey, unknown>)[
          key
        ];
        return typeof value === "function" ? value.bind(database) : value;
      },
    },
  ),
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { warn: jest.fn() },
}));
jest.unstable_mockModule(
  "../services/outreach/ProviderBindingService.js",
  () => ({
    resolveOfficialProviderBinding: async () => ({
      providerAccountId: "account-1",
    }),
  }),
);
const { prepareCreationContact } =
  await import("../services/outreach/CreationService.js");
const { getOutboundCountForDay, withCreationDailyQuota } =
  await import("../services/outreach/QuotaService.js");
const { SentMessageModel } =
  await import("../models/sentMessages/functions.js");
const { cancelConversationEmailFollowUps } =
  await import("../services/emailFollowUpService.js");
const scope = <T>(work: () => T) =>
  withBusinessScope({ userId: 1, businessProfileId: 11 }, work);

suite("Outreach creation database scheduling and history", () => {
  beforeAll(async () => {
    if (
      !connectionString ||
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(connectionString).hostname,
      )
    )
      throw new Error("Explicit local QA database required");
    const setup = new Pool({ connectionString });
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.end();
    pool = new Pool({
      connectionString,
      options: `-c search_path=${schema},pg_catalog`,
    });
    database = drizzle(pool);
    await pool.query(`
      CREATE TABLE outreach_settings(user_id INTEGER,daily_email_limit INTEGER);
      CREATE TABLE channel_credentials(user_id INTEGER,platform TEXT,is_active BOOLEAN,session_data JSONB,updated_at TIMESTAMP);
      CREATE TABLE outreach_conversations(id INTEGER PRIMARY KEY,user_id INTEGER,channel TEXT,lead_name TEXT,
        lead_id INTEGER,crm_contact_id INTEGER,provider_account_id TEXT,last_message_at TIMESTAMP);
      CREATE TABLE crm_contacts(id INTEGER PRIMARY KEY,user_id INTEGER,lead_id INTEGER,first_name TEXT,last_name TEXT,
        email TEXT,phone TEXT,company TEXT,role TEXT,deleted_at TIMESTAMP,updated_at TIMESTAMP);
      CREATE TABLE outreach_messages(id INTEGER PRIMARY KEY,user_id INTEGER,conversation_id INTEGER,direction TEXT,status TEXT,
        provider_call_state TEXT DEFAULT 'not_started',send_claimed_at TIMESTAMP,sent_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW(),metadata JSONB,
        subject TEXT,content TEXT,message_kind TEXT DEFAULT 'outreach',manual_review_required BOOLEAN DEFAULT false,follow_up_step INTEGER,
        provider_message_id TEXT,external_message_id TEXT,rfc_message_id TEXT,updated_at TIMESTAMP,
        follow_up_origin_message_id INTEGER,follow_up_cancelled_at TIMESTAMP);
      CREATE TABLE followup_sequences(conversation_id INTEGER,completed BOOLEAN,replied_at TIMESTAMP,updated_at TIMESTAMP);
      CREATE TABLE sent_messages(id INTEGER PRIMARY KEY,user_id INTEGER,channel TEXT,lead_name TEXT,subject TEXT,message TEXT,status TEXT,
        delivery_status TEXT,follow_up_step INTEGER,sent_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW(),message_id TEXT,is_reply BOOLEAN);
    `);
    const columns = Object.values(getTableColumns(leadsTable)).map(
      (column) => `"${column.name}" ${column.getSQLType()}`,
    );
    await pool.query(`CREATE TABLE leads(${columns.join(",")})`);
    // Migration 587's stored thread key, read by the thread and import filters.
    await pool.query(`ALTER TABLE leads ADD COLUMN legacy_campaign_thread_key text GENERATED ALWAYS AS (CASE WHEN length(campaign_data->>'threadId') BETWEEN 1 AND 10 THEN campaign_data->>'threadId' END) STORED`);
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE outreach_messages,outreach_conversations,outreach_settings,sent_messages,followup_sequences,leads,crm_contacts",
    );
    await pool.query(
      "INSERT INTO outreach_conversations(id,user_id,channel,lead_name) VALUES(1,1,'email','Ada'),(2,2,'email','Foreign contact'); INSERT INTO outreach_settings VALUES(1,1)",
    );
  });
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });
  it("counts future reservations on the planned day and old messages on their actual successful send day", async () => {
    const future = new Date(Date.now() + 2 * 86_400_000);
    await pool.query(
      `INSERT INTO outreach_messages(id,user_id,conversation_id,direction,status,metadata) VALUES(1,1,1,'outbound','pending',$1)`,
      [JSON.stringify({ scheduledAt: future.toISOString() })],
    );
    await pool.query(
      "INSERT INTO outreach_messages(id,user_id,conversation_id,direction,status,created_at,sent_at) VALUES(2,1,1,'outbound','sent',NOW()-INTERVAL '3 days',NOW()),(3,2,2,'outbound','sent',NOW(),NOW())",
    );
    expect(await scope(() => getOutboundCountForDay(1, "email"))).toBe(1);
    expect(await scope(() => getOutboundCountForDay(1, "email", future))).toBe(
      1,
    );
  });
  it("creates one real outreach lead for a phone-only CRM contact even when preparation is requested concurrently", async () => {
    await pool.query(
      "INSERT INTO crm_contacts(id,user_id,first_name,phone) VALUES(8,1,'Ada','+91 98765 43210'),(9,2,'Foreign','+91 99999 99999')",
    );
    const results = await scope(() =>
      Promise.all(
        [1, 2].map(() =>
          prepareCreationContact(1, 8, "whatsapp", {
            providerAccountId: "account-1",
          }),
        ),
      ),
    );
    expect(results[0].leadId).toBeTruthy();
    expect(results[1].leadId).toBe(results[0].leadId);
    const records = (await pool.query("SELECT id,email,phone FROM leads")).rows;
    expect(records).toEqual([
      { id: results[0].leadId, email: null, phone: "919876543210" },
    ]);
    expect(
      await scope(() =>
        prepareCreationContact(1, 9, "whatsapp", {
          providerAccountId: "account-1",
        }),
      ),
    ).toMatchObject({ error: expect.stringContaining("unavailable") });
  });
  it("reuses an owned native social conversation without permanently linking the CRM contact to a temporary lead", async () => {
    await pool.query(
      "INSERT INTO crm_contacts(id,user_id,first_name,phone) VALUES(8,1,'Ada','919876543210'); INSERT INTO leads(id,user_id,phone) VALUES(77,1,'919876543210'); INSERT INTO outreach_conversations(id,user_id,channel,lead_id,crm_contact_id,provider_account_id) VALUES(77,1,'instagram',77,8,'account-1')",
    );
    expect(
      await scope(() =>
        prepareCreationContact(1, 8, "instagram", {
          providerAccountId: "account-1",
        }),
      ),
    ).toEqual({ leadId: 77 });
    expect(
      (await pool.query("SELECT lead_id FROM crm_contacts WHERE id=8")).rows[0]
        .lead_id,
    ).toBeNull();
    expect(
      Number((await pool.query("SELECT COUNT(*) FROM leads")).rows[0].count),
    ).toBe(1);
  });
  it("allows only one provider boundary when two scheduled jobs reach a daily limit concurrently", async () => {
    await pool.query(
      "INSERT INTO outreach_messages(id,user_id,conversation_id,direction,status,send_claimed_at) VALUES(1,1,1,'outbound','sending',NOW()),(2,1,1,'outbound','sending',NOW())",
    );
    const results = await scope(() =>
      Promise.all(
        [1, 2].map((id) =>
          withCreationDailyQuota(1, "email", async (tx) => {
            await tx.execute(
              sql`UPDATE outreach_messages SET provider_call_state='started' WHERE id=${id}`,
            );
            return id;
          }),
        ),
      ),
    );
    expect(results.filter((value) => value !== null)).toHaveLength(1);
    expect(
      Number(
        (
          await pool.query(
            "SELECT COUNT(*) FROM outreach_messages WHERE provider_call_state='started'",
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  });
  it("includes scheduled email follow-ups, hides foreign history and deduplicates provider tracking mirrors", async () => {
    const planned = new Date(Date.now() + 86_400_000).toISOString();
    await pool.query(
      `INSERT INTO outreach_messages(id,user_id,conversation_id,direction,status,metadata,message_kind,follow_up_step,provider_message_id,content)
      VALUES(1,1,1,'outbound','pending',$1,'follow_up',1,NULL,'Checking in'),(2,1,1,'outbound','sent',NULL,'follow_up',2,'provider-2','Second reminder'),(3,2,2,'outbound','pending',NULL,'follow_up',1,NULL,'Foreign')`,
      [JSON.stringify({ scheduledAt: planned })],
    );
    await pool.query(
      "INSERT INTO sent_messages(id,user_id,channel,message_id,is_reply,follow_up_step) VALUES(10,1,'email','provider-2',TRUE,2),(11,1,'email','older-provider',TRUE,1),(12,2,'email','foreign-provider',TRUE,1)",
    );
    const records = await scope(() =>
      SentMessageModel.findRecentFollowUpsByUser(1, "email"),
    );
    expect(records).toHaveLength(3);
    expect(records.find((item) => item.id === 1)).toMatchObject({
      status: "pending",
      scheduledAt: planned,
      kind: "conversation",
      message: "Checking in",
    });
    expect(records.map((item) => item.id).sort((a, b) => a - b)).toEqual([
      1, 2, 11,
    ]);
  });
  it("immediately cancels pending and legacy queued follow-ups when their customer replies", async () => {
    await pool.query(
      "INSERT INTO outreach_messages(id,user_id,conversation_id,direction,status,message_kind,follow_up_origin_message_id) VALUES(1,1,1,'outbound','sent','outreach',NULL),(2,1,1,'outbound','pending','follow_up',1),(3,1,1,'outbound','queued','follow_up',1),(4,1,1,'outbound','pending','reply',NULL),(5,2,2,'outbound','pending','follow_up',NULL)",
    );
    await scope(() => cancelConversationEmailFollowUps(1));
    const rows = (
      await pool.query(
        "SELECT id,status,follow_up_cancelled_at FROM outreach_messages ORDER BY id",
      )
    ).rows;
    expect(rows[0].follow_up_cancelled_at).toBeTruthy();
    expect(rows.map((row) => row.status)).toEqual([
      "sent",
      "cancelled",
      "cancelled",
      "pending",
      "pending",
    ]);
  });
});
