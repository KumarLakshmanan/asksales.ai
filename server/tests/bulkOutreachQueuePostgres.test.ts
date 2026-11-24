import { afterAll, beforeAll, expect, it, jest } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableColumns, getTableName } from "drizzle-orm";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { writeFile, mkdir } from "node:fs/promises";
const artifacts =
  process.env.OUTREACH_AUDIT_ARTIFACT_DIR || "/tmp/bulk-outreach-audit";
import { withBusinessScope } from "../tenancy/businessContext.js";
let client: Client, database: NodePgDatabase, redis: Redis, server: Server;
const enabled = process.env.OUTREACH_BULK_LOCAL_QA === "1";
const check = enabled ? it : it.skip;
let rejectBeforeAcceptance = false;
let loseAcknowledgement = false,
  syntheticReceiptBeforeAckLoss = false,
  ackLostJobId: string | undefined;
const log = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: log,
  createWorkerLogger: () => log,
}));
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_t, k) {
        const v = Reflect.get(database, k);
        return typeof v === "function" ? v.bind(database) : v;
      },
    },
  ),
}));
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: () => redis,
}));
jest.unstable_mockModule("../services/agents/AgentRouter.js", () => ({
  agentRouter: {},
}));
jest.unstable_mockModule(
  "../services/outreach/ProviderBindingService.js",
  () => ({
    resolveOfficialProviderBinding: async () => ({
      channel: "email",
      providerVariant: "gmail",
      providerAccountId: "synthetic-account",
      credentialId: 77,
      accountIdentifier: "sales@example.test",
    }),
    resolveOfficialSocialProviderBinding: async () => null,
  }),
);
const { leadsTable } = await import("../models/leads/schema.js");
const { emailSendersTable } = await import("../models/emailSenders/schema.js");
const { outreachConversationsTable, outreachMessagesTable } =
  await import("../models/outreachConversations/schema.js");
const { sentMessagesTable } = await import("../models/sentMessages/schema.js");
const { outreachSettings } =
  await import("../models/outreachSettings/schema.js");
const { queueRegistry, QUEUE_NAMES } = await import("../queues/index.js");
const { getOutreachCreationOptions, getOutreachCreationRecipients } =
  await import("../controllers/outreachCreationController.js");
const { bulkCreateConversations } =
  await import("../controllers/outreachConversationsController.js");
let queue: Queue;
beforeAll(async () => {
  if (!enabled) return;
  const url = process.env.OUTREACH_QA_DATABASE_URL;
  if (
    !url ||
    !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/campaign_audit"
  )
    throw new Error(
      "Explicit disposable campaign_audit loopback database required",
    );
  await mkdir(artifacts, { recursive: true });
  client = new Client({
    connectionString: process.env.OUTREACH_QA_DATABASE_URL,
  });
  await client.connect();
  await client.query("SET search_path TO pg_temp,pg_catalog");
  database = drizzle(client);
  for (const table of [
    leadsTable,
    emailSendersTable,
    outreachConversationsTable,
    outreachMessagesTable,
    sentMessagesTable,
    outreachSettings,
  ]) {
    if (!table) throw new Error("Fixture schema export unavailable");
    const fields = Object.values(getTableColumns(table)).map(
      (c) => `"${c.name}" ${c.getSQLType()}`,
    );
    await client.query(
      `CREATE TEMP TABLE ${getTableName(table)} (${fields.join(",")})`,
    );
  }
  await client.query(`ALTER TABLE outreach_messages ADD PRIMARY KEY(id);CREATE UNIQUE INDEX ON outreach_messages(idempotency_key);ALTER TABLE outreach_messages ALTER send_intent_id SET DEFAULT gen_random_uuid();ALTER TABLE outreach_messages ALTER provider_call_state SET DEFAULT 'not_started';
 ALTER TABLE outreach_messages ALTER created_at SET DEFAULT NOW();ALTER TABLE outreach_messages ALTER business_profile_id SET DEFAULT 4102;
 ALTER TABLE outreach_conversations ALTER business_profile_id SET DEFAULT 4102;ALTER TABLE outreach_conversations ALTER total_messages SET DEFAULT 0;
 CREATE TEMP TABLE users(id int,is_approved bool,deleted_at timestamp);INSERT INTO users VALUES(4101,true,NULL);
 CREATE TEMP TABLE company_settings(id int,user_id int,is_default bool,archived_at timestamp,billing_organization_id int,company_name text,business_name text,name text);
 CREATE TEMP TABLE business_profile_memberships(id int,business_profile_id int,user_id int,status text,role text);
 CREATE TEMP TABLE billing_organizations(id int,name text,owner_user_id int,default_for_user_id int,billing_eligibility_at timestamp);
 CREATE TEMP TABLE billing_organization_memberships(organization_id int,user_id int,status text,role text);
 INSERT INTO company_settings VALUES(4102,4101,true,NULL,900,'Synthetic audit',NULL,'Synthetic audit');INSERT INTO billing_organizations VALUES(900,'Synthetic audit',4101,4101,NOW());
 INSERT INTO leads(id,user_id,business_profile_id,name,full_name,first_name,email,blacklisted,do_not_contact,email_unsubscribed) VALUES(1,4101,4102,'Synthetic Ada','Synthetic Ada','Ada','ada@example.test',false,false,false),(2,4101,4102,'Synthetic Grace','Synthetic Grace','Grace','grace@example.test',false,false,false);
 INSERT INTO email_senders(id,user_id,business_profile_id,type,label,email,is_default,is_verified,credential_id) VALUES(7,4101,4102,'gmail','Synthetic sender','sales@example.test',true,true,77);
 INSERT INTO outreach_settings(user_id,business_profile_id,daily_email_limit) VALUES(4101,4102,200);`);
  redis = new Redis({
    host: "127.0.0.1",
    port: 55440,
    maxRetriesPerRequest: null,
  });
  // Initialize only the named real queue; bootstrap and external workers remain disabled.
  queue = new Queue(QUEUE_NAMES.OUTREACH, {
    connection: { host:"127.0.0.1",port:55440,maxRetriesPerRequest:null },
    prefix: `campaign-second-pass-${process.pid}`,
  });
  (queueRegistry as any).queues.set(QUEUE_NAMES.OUTREACH, queue);
  const add = queue.add.bind(queue);
  queue.add = async (...args: Parameters<typeof queue.add>) => {
    if (rejectBeforeAcceptance) {
      rejectBeforeAcceptance = false;
      throw new Error("Synthetic queue receipt unavailable");
    }
    const job = await add(...args);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      ackLostJobId = job.id;
      if (syntheticReceiptBeforeAckLoss) {
        syntheticReceiptBeforeAckLoss = false;
        await client.query(
          "UPDATE outreach_messages SET status='sent',provider_call_state='confirmed',provider_message_id='synthetic-provider-accepted',sent_at=NOW() WHERE id=$1",
          [job.data.messageId],
        );
      }
      throw new Error(
        "Synthetic queue acknowledgement lost after Redis accepted",
      );
    }
    return job;
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:3029");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,X-Business-Profile-Id,Idempotency-Key,X-CSRF-Token",
    );
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  // Synthetic authentication fixture. Real auth, module/credit middleware and RLS are not asserted here.
  app.use((req, _res, next) => {
    (req as any).user = { id: 4101 };
    withBusinessScope(
      { userId: 4101, businessProfileId: 4102, actorUserId: 4101 },
      next,
    );
  });
  app.get(
    "/api/outreach-conversations/compose/options",
    getOutreachCreationOptions,
  );
  app.get(
    "/api/outreach-conversations/compose/recipients",
    getOutreachCreationRecipients,
  );
  app.post("/api/outreach-conversations/bulk", bulkCreateConversations);
  app.get("/__audit/state", async (_req, res) =>
    res.json({
      messages: (
        await client.query(
          "SELECT id,conversation_id,content,status,send_intent_id FROM outreach_messages ORDER BY id",
        )
      ).rows,
      jobs: (
        await queue.getJobs(["waiting", "delayed", "completed", "failed"])
      ).map((j) => ({ id: j.id, data: j.data })),
    }),
  );
  server = app.listen(3139, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
}, 30000);
afterAll(async () => {
  if (!enabled) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await queue?.close();
  await redis?.quit();
  await client?.end();
});
const payload = (key: string, message = "Synthetic audited message") => ({
  channel: "email",
  creationVersion: 1,
  providerAccountId: "synthetic-account",
  idempotencyKey: key,
  confirmation: { confirmed: true, channel: "email", recipientCount: 1 },
  messages: [
    {
      leadId: 1,
      senderId: 7,
      expectedRecipient: "ada@example.test",
      recipientEmail: "ada@example.test",
      subject: "Synthetic audit subject",
      message,
      followUps: [],
    },
  ],
});
const post = async (body: unknown) => {
  const r = await fetch(
    "http://127.0.0.1:3139/api/outreach-conversations/bulk",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: r.status, body: (await r.json()) as {queued:number;errors:number;uncertain?:number;code?:string;results:Array<{messageId:number;conversationId:number;status:string}>} };
};
check(
  "actual mounted compose API, services, PostgreSQL and Redis accept one durable reviewed item",
  async () => {
    const result = await post(
      payload("second-pass-mounted-" + process.pid + "-0001"),
    );
    expect(result).toMatchObject({
      status: 200,
      body: { queued: 1, errors: 0 },
    });
    const jobs = await queue.getJobs(["waiting"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toMatchObject({
      userId: 4101,
      businessProfileId: 4102,
      businessActorUserId: 4101,
      billingActorUserId: 4101,
      billingOrganizationId: 900,
    });
    expect(
      (await client.query("SELECT content FROM outreach_messages")).rows[0]
        .content,
    ).toBe("Synthetic audited message");
  },
);
check(
  "rejects changed content under the same idempotency key at the mounted HTTP boundary",
  async () => {
    const before = Number(
      (await client.query("SELECT count(*) FROM outreach_messages")).rows[0]
        .count,
    );
    const result = await post(
      payload(
        "second-pass-mounted-" + process.pid + "-0001",
        "Changed but same key",
      ),
    );
    const after = Number(
      (await client.query("SELECT count(*) FROM outreach_messages")).rows[0]
        .count,
    );
    await writeFile(
      `${artifacts}/idempotency-observation.json`,
      JSON.stringify({ result, before, after }, null, 2),
    );
    expect(result).toMatchObject({
      status: 409,
      body: { code: "REQUEST_KEY_CONFLICT" },
    });
    expect(after).toBe(before);
  },
);
check(
  "reconciles an accepted Redis job without marking its pending message failed",
  async () => {
    loseAcknowledgement = true;
    const result = await post(
      payload("second-pass-lost-ack-" + process.pid + "-0002"),
    );
    const job = await queue.getJob(ackLostJobId!);
    const row = (
      await client.query(
        "SELECT id,status,error_message FROM outreach_messages WHERE id=$1",
        [job!.data.messageId],
      )
    ).rows[0];
    await writeFile(
      `${artifacts}/lost-ack-observation.json`,
      JSON.stringify(
        {
          result,
          message: row,
          jobId: job?.id,
          jobState: await job?.getState(),
        },
        null,
        2,
      ),
    );
    expect(result.body.queued).toBe(1);
    expect(row.status).toBe("pending");
    expect(await job?.getState()).toBe("waiting");
  },
);
check(
  "preserves a provider receipt when queue acknowledgement is lost",
  async () => {
    loseAcknowledgement = true;
    syntheticReceiptBeforeAckLoss = true;
    const result = await post(
      payload("second-pass-accepted-before-ack-" + process.pid + "-0003"),
    );
    const job = await queue.getJob(ackLostJobId!);
    const row = (
      await client.query(
        "SELECT id,status,provider_call_state,provider_message_id,sent_at,error_message FROM outreach_messages WHERE id=$1",
        [job!.data.messageId],
      )
    ).rows[0];
    await writeFile(
      `${artifacts}/accepted-before-lost-ack-observation.json`,
      JSON.stringify(
        {
          fault:
            "After actual Redis queue acceptance, inject the durable receipt a concurrent worker could persist, before throwing queue acknowledgement loss. The actual provider worker is not executed.",
          result,
          message: row,
          jobState: await job?.getState(),
        },
        null,
        2,
      ),
    );
    expect(result.body).toMatchObject({ queued: 1, errors: 0 });
    expect(row).toMatchObject({
      status: "sent",
      provider_call_state: "confirmed",
      provider_message_id: "synthetic-provider-accepted",
    });
    expect(row.sent_at).not.toBeNull();
  },
);

check(
  "holds an unconfirmed queue submission with stable receipt IDs instead of offering a failed-recipient resend",
  async () => {
    rejectBeforeAcceptance = true;
    const result = await post(payload("unconfirmed-queue-" + process.pid));
    expect(result.body).toMatchObject({
      queued: 0,
      errors: 0,
      uncertain: 1,
      results: [
        {
          status: "uncertain",
          messageId: expect.any(Number),
          conversationId: expect.any(Number),
        },
      ],
    });
    const row = (
      await client.query(
        "SELECT status,provider_call_state,manual_review_required FROM outreach_messages WHERE id=$1",
        [result.body.results[0].messageId],
      )
    ).rows[0];
    expect(row).toEqual({
      status: "manual_review",
      provider_call_state: "not_started",
      manual_review_required: true,
    });
  },
);
check("returns the same receipt for an identical reviewed retry", async () => {
  const key = "identical-bulk-" + process.pid,
    first = await post(payload(key));
  const second = await post(payload(key));
  expect(second).toEqual(first);
});
check.each(["subject", "htmlContent", "scheduledAt"])(
  "rejects changed reviewed %s with the same key",
  async (field: string) => {
    const key = "conflict-" + field + "-" + process.pid;
    await post(payload(key));
    const changed: any = payload(key);
    if (field === "scheduledAt")
      changed.scheduledAt = new Date(Date.now() + 86400000).toISOString();
    else changed.messages[0][field] = "Changed reviewed field";
    const result = await post(changed);
    expect(result).toMatchObject({
      status: 409,
      body: { code: "REQUEST_KEY_CONFLICT" },
    });
  },
);
