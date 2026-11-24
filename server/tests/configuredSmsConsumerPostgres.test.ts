import type { FollowUpProvenance } from "../../shared/followUpProvenance.js";
import { afterAll, beforeAll, expect, it, jest } from "@jest/globals";
import { Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableColumns, getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import Redis from "ioredis";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
const suffix = randomBytes(6).toString("hex");
import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import {
  withBusinessScope,
  currentBusinessScope,
} from "../tenancy/businessContext.js";
import {
  withBillingScope,
  currentBillingScope,
} from "../tenancy/billingContext.js";
const root = process.env.SMS_AUDIT_ARTIFACT_DIR || "/tmp/campaign-sms-audit";
const enabled = process.env.SMS_CONSUMER_LOCAL_QA === "1";
const check = enabled ? it : it.skip;
const child = process.env.SMS_AUDIT_MODE === "consumer";
const url = process.env.SMS_AUDIT_DATABASE_URL!;
if (
  enabled &&
  (!url ||
    new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).pathname !== "/campaign_sms_audit")
)
  throw new Error("Explicit disposable audit database required");
let client: Client, database: NodePgDatabase, redis: Redis;
const logMessages: unknown[] = [];
const log = Object.fromEntries(
  ["info", "warn", "error", "debug"].map((k) => [
    k,
    (...args: unknown[]) => logMessages.push({ level: k, args }),
  ]),
);
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: log,
  createWorkerLogger: () => log,
}));
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "execute" && child)
          return async (q: SQL) => {
            const result = await database.execute(q);
            const query = new PgDialect().sqlToQuery(q);
            if (
              process.env.SMS_AUDIT_CRASH_POINT === "started" &&
              query.sql.startsWith(
                "UPDATE sms_queue_deliveries SET state='started'",
              ) &&
              result.rows.length
            )
              process.exit(86);
            if (
              process.env.SMS_AUDIT_CRASH_POINT === "confirmed" &&
              query.sql.startsWith("UPDATE sms_queue_deliveries SET state=") &&
              query.params[0] === "confirmed"
            )
              process.exit(86);
            return result;
          };
        const v = Reflect.get(database, k);
        return typeof v === "function" ? v.bind(database) : v;
      },
    },
  ),
}));
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: () => redis,
}));
jest.unstable_mockModule("../services/agents/LLMProviderFactory", () => ({
  LLMProviderFactory: {
    executeWithFallback: async () => {
      throw new Error("Audit forbids model invocation");
    },
  },
}));
jest.unstable_mockModule("../utils/emailTemplates.js", () => ({
  getBrandInfo: async () => {
    throw new Error("No email work in SMS audit");
  },
  renderBrandedEmail: () => {
    throw new Error("No email work in SMS audit");
  },
}));
jest.unstable_mockModule("../services/media/QueuedMediaConfig.js", () => ({
  queuedMediaConfig: {},
}));
jest.unstable_mockModule("../events/EventBus.js", () => ({
  eventBus: {
    initialize: async () => {},
    close: async () => {},
    emitToolEvent: async () => {},
    publish: async () => {
      if (process.env.SMS_AUDIT_CRASH_POINT === "receipt") process.exit(86);
    },
  },
  EVENT_CHANNELS: { OUTREACH_SENT: "outreach-sent" },
}));
jest.unstable_mockModule("../workers/NotificationEventConsumer.js", () => ({
  notificationEventConsumer: { start: async () => {}, stop: async () => {} },
}));
jest.unstable_mockModule("../tools/outreachSender.js", () => ({
  outreachSenderWorker: { start: async () => {}, stop: async () => {} },
}));
jest.unstable_mockModule("../services/CRMService", () => ({
  crmService: { autoCreateContactOnOutreachSend: async () => {} },
}));
jest.unstable_mockModule("../services/InboundContactResolver.js", () => ({
  inboundContactResolver: {},
}));
jest.unstable_mockModule(
  "../services/agents/orchestration/PrivacyVaultService.js",
  () => ({
    privacyVaultService: {},
    redactPiiWithStableTokens: (x: unknown) => x,
  }),
);
// Account/secret boundary is a synthetic ready sender. No credentials are created or loaded.
let preparedOnce = false;
async function syntheticCredential() {
  const kind = process.env.SMS_AUDIT_CASE || "";
  if (!preparedOnce) {
    preparedOnce = true;
    if (kind === "credential_infrastructure")
      throw new Error("Synthetic credential database unavailable");
    if (
      kind === "crash_preparation" &&
      process.env.SMS_AUDIT_CRASH_POINT === "preparation"
    )
      process.exit(86);
    if (kind === "disabled_in_service")
      await client.query(
        "UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{sms,enabled}','false')",
      );
    if (kind === "template_in_service")
      await client.query(
        "UPDATE content_templates SET version=2,content='Revised SMS' WHERE id=77",
      );
    if (kind === "settings_in_service")
      await client.query(
        "UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{sms,followUps,0,delayMinutes}','55')",
      );
    if (kind === "cancelled_in_service")
      await client.query(
        "UPDATE outreach_messages SET follow_up_cancelled_at=NOW() WHERE id=51",
      );
    if (kind === "takeover_in_service")
      await client.query(
        "UPDATE outreach_conversations SET automation_mode='human_owned' WHERE id=21",
      );
    if (kind === "reply_in_service")
      await client.query(
        "INSERT INTO outreach_messages(user_id,business_profile_id,conversation_id,direction,message_kind,status,content,created_at) VALUES(4101,4102,21,'inbound','outreach','received','Synthetic reply',NOW())",
      );
    if (kind === "suppressed_in_service")
      await client.query("UPDATE leads SET do_not_contact=true WHERE id=1");
    if (kind === "account_in_service")
      await client.query(
        "UPDATE outreach_messages SET provider_account_id='OTHERX' WHERE id=51",
      );
    if (
      kind === "infrastructure_in_service" ||
      kind === "binding_infrastructure"
    ) {
      const table =
        kind === "binding_infrastructure"
          ? "outreach_messages"
          : "outreach_settings";
      await client.query(`ALTER TABLE ${table} RENAME TO ${table}_unavailable`);
      setTimeout(
        () =>
          void client
            .query(`ALTER TABLE ${table}_unavailable RENAME TO ${table}`)
            .catch(() => {}),
        500,
      );
    }
  }
  return {
    id: 77,
    isActive: true,
    credentialType: "api_key",
    accountIdentifier: "AUDITS",
    apiSecret: "synthetic-only",
    sessionData: {
      senderId: "AUDITS",
      flowId: "synthetic-approved-flow",
      messageVariable: "message",
    },
    providerVerifiedAt: new Date(),
    encryptionVersion: "synthetic",
    encryptionKeyId: "synthetic",
    encryptedAt: new Date(),
  };
}
jest.unstable_mockModule("../models/channelCredentials/functions", () => ({
  ChannelCredentialModel: {
    findActiveAccountByIdentifier: syntheticCredential,
    findByUserAndPlatform: syntheticCredential,
    updateAccount: async () => {},
  },
}));
jest.unstable_mockModule("../utils/channelCredentialSecrets.js", () => ({
  decryptChannelCredentialSecret: () => "synthetic-provider-key-not-real",
  decryptChannelCredentialSession: (v: unknown) => v,
}));
jest.unstable_mockModule(
  "../services/integrations/MSG91ProviderService.js",
  () => ({
    getMSG91Balance: async () => {
      throw new Error("No external balance reads");
    },
    verifyMSG91Configuration: async () => {
      throw new Error("No provider verification");
    },
  }),
);
const snapshot = () => ({
  business: currentBusinessScope(),
  billing: currentBillingScope(),
});
jest.unstable_mockModule("../services/subscriptions/service.js", () => ({
  requireSubscriptionForOperation: async (userId: number) => {
    await client.query(
      "INSERT INTO audit_events(kind,data) VALUES('subscription_gate',$1)",
      [JSON.stringify({ userId, ...snapshot() })],
    );
  },
}));
jest.unstable_mockModule("../services/CreditService.js", () => ({
  creditService: {
    reserveForResource: async (input: any) => {
      const result = await database.transaction(async (tx) => {
        const created = await input.createResource(tx);
        const v = await client.query(
          "INSERT INTO wallet_transactions(organization_id,actor_user_id,billing_business_profile_id,user_id,type,reference_type,reference_id) VALUES(900,17,4102,4101,'deduction','sms_queue_claim',$1) RETURNING id",
          [created.referenceId],
        );
        await client.query(
          "INSERT INTO audit_reservations(reference_id,data) VALUES($1,$2)",
          [created.referenceId, JSON.stringify(snapshot())],
        );
        return {
          success: true,
          transactionId: v.rows[0].id,
          resource: created.resource,
        };
      });
      return result;
    },
    reserveOutreachCredit: async (input: any) => {
      const r = await client.query(
        "INSERT INTO audit_reservations(reference_id,data) VALUES($1,$2) ON CONFLICT(reference_id) DO UPDATE SET reference_id=EXCLUDED.reference_id RETURNING id",
        [input.referenceId, JSON.stringify({ input, ...snapshot() })],
      );
      return { success: true, transactionId: r.rows[0].id };
    },
    refundDeduction: async (input: any) => {
      const saved = await client.query(
        "INSERT INTO audit_refunds(transaction_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING transaction_id",
        [input.transactionId],
      );
      if (saved.rows.length)
        await client.query(
          "INSERT INTO audit_events(kind,data) VALUES('refund',$1)",
          [JSON.stringify({ input, ...snapshot() })],
        );
      return { success: true };
    },
  },
}));
jest.unstable_mockModule("../models/failedJobs/functions.js", () => ({
  insertFailedJob: async (input: any) =>
    client.query(
      "INSERT INTO audit_events(kind,data) VALUES('failed_job',$1)",
      [JSON.stringify(input)],
    ),
}));
const realBull = await import("bullmq");
if (child) {
  class IdleWorker extends EventEmitter {
    async waitUntilReady() {}
    async close() {}
    isRunning() {
      return true;
    }
    isPaused() {
      return false;
    }
  }
  const RegisteredWorker = function (
    name: string,
    processor: any,
    options: any,
  ) {
    if (name === "sms-sending")
      return new realBull.Worker(name, processor, {
        ...options,
        concurrency: 1,
        lockDuration: 2000,
        lockRenewTime: 500,
        stalledInterval: 500,
        maxStalledCount: 2,
      });
    return new IdleWorker();
  };
  jest.unstable_mockModule("bullmq", () => ({
    ...realBull,
    Worker: RegisteredWorker,
  }));
}
const { queueRegistry, QUEUE_NAMES } = await import("../queues/index.js");
let queue: InstanceType<typeof realBull.Queue>;
// Keep actual addJob/capture and worker registration; initialize one local real queue only.
queueRegistry.initialize = async () => {
  if (queue) return;
  queue = new realBull.Queue(QUEUE_NAMES.SMS_SENDING, {
    connection: { host: "127.0.0.1", port: 55440, maxRetriesPerRequest: null },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  (queueRegistry as any).queues.set(QUEUE_NAMES.SMS_SENDING, queue);
};
queueRegistry.addRepeatableJob = async () => undefined as any;
const tables = [
  (await import("../models/companySettings/schema.js")).companySettings,
  (await import("../models/brandToolkits/schema.js")).brandToolkitsTable,
  (await import("../models/contentTemplates/schema.js")).contentTemplatesTable,
  (await import("../models/leads/schema.js")).leadsTable,
  (await import("../models/outreachSettings/schema.js")).outreachSettings,
  (await import("../models/outreachConversations/schema.js"))
    .outreachConversationsTable,
  (await import("../models/outreachConversations/schema.js"))
    .outreachMessagesTable,
  (await import("../models/sentMessages/schema.js")).sentMessagesTable,
];
const scope = <T>(fn: () => T) =>
  withBusinessScope(
    { userId: 4101, businessProfileId: 4102, actorUserId: 17 },
    () =>
      withBillingScope(
        {
          organizationId: 900,
          actorUserId: 17,
          businessProfileId: 4102,
          businessOwnerUserId: 4101,
        },
        fn,
      ),
  );
beforeAll(async () => {
  if (!enabled) return;
  await mkdir(root + "/logs", { recursive: true });
  client = new Client({ connectionString: url });
  await client.connect();
  if (child) {
    if (!/^sms_audit_[a-z0-9_]+$/.test(process.env.SMS_AUDIT_SCHEMA!))
      throw new Error("Audit schema required");
    await client.query(
      `SET search_path TO ${process.env.SMS_AUDIT_SCHEMA},pg_catalog`,
    );
  }
  if (child)
    await client.query(
      "SELECT set_config('app.business_profile_id','4102',false),set_config('app.business_user_id','4101',false),set_config('app.current_user_id','4101',false),set_config('app.business_actor_user_id','17',false)",
    );
  database = drizzle(client);
  redis = new Redis({
    host: "127.0.0.1",
    port: 55440,
    maxRetriesPerRequest: null,
  });
  await queueRegistry.initialize();
}, 30000);
afterAll(async () => {
  if (!enabled) return;
  if (child) {
    const { stopAllWorkers } = await import("../workers/index.js");
    await stopAllWorkers();
  } else await queueRegistry.close();
  await redis?.quit();
  await client?.end();
});
async function seed(schema: string, originId: number) {
  await client.query(
    `CREATE SCHEMA ${schema};SET search_path TO ${schema},pg_catalog`,
  );
  for (const table of tables) {
    const fields = Object.values(getTableColumns(table)).map(
      (c) => `"${c.name}" ${c.getSQLType()}`,
    );
    await client.query(
      `CREATE TABLE ${getTableName(table)} (${fields.join(",")})`,
    );
  }
  await client.query(`CREATE TABLE users(id int,is_approved bool,deleted_at timestamp);INSERT INTO users VALUES(4101,true,NULL),(17,true,NULL);
 CREATE TABLE business_profile_memberships(id int,business_profile_id int,user_id int,status text,role text);INSERT INTO business_profile_memberships VALUES(1,4102,17,'active','member');
 CREATE TABLE business_profile_preferences(user_id int,default_business_profile_id int);
 CREATE TABLE billing_organizations(id int,name text,owner_user_id int,default_for_user_id int,billing_eligibility_at timestamp);INSERT INTO billing_organizations VALUES(900,'Synthetic payer',4101,4101,NOW());
 CREATE TABLE billing_organization_memberships(organization_id int,user_id int,status text,role text);
 CREATE TABLE wallet_transactions(id serial PRIMARY KEY,organization_id int,actor_user_id int,billing_business_profile_id int,user_id int,type text,reference_type text,reference_id text);
 CREATE TABLE audit_refunds(transaction_id int PRIMARY KEY);
 CREATE TABLE audit_events(id serial,kind text,data jsonb,at timestamp DEFAULT NOW());
 CREATE TABLE audit_reservations(id serial,reference_id text UNIQUE,data jsonb);
 CREATE TABLE audit_provider_calls(id serial,job_id text,body jsonb,scope jsonb,at timestamp DEFAULT NOW());
 ALTER TABLE sent_messages ALTER business_profile_id SET DEFAULT 4102;ALTER TABLE sent_messages ALTER created_at SET DEFAULT NOW();ALTER TABLE sent_messages ALTER follow_up_dispatches SET DEFAULT '{}';
 INSERT INTO company_settings(id,user_id,billing_organization_id,name,company_name,business_name,is_default,is_approved,version,timezone,updated_at) VALUES(4102,4101,900,'Synthetic audit','Synthetic audit','Synthetic audit',true,true,1,'UTC',NOW());
 INSERT INTO brand_toolkits(id,user_id,business_profile_id,name,is_default,is_active,is_approved,version,updated_at) VALUES(5,4101,4102,'Synthetic brand',true,true,true,1,NOW());
 INSERT INTO content_templates(id,user_id,business_profile_id,brand_toolkit_id,name,type,content,is_approved,version,brand_context_snapshot,created_at,updated_at) VALUES(77,4101,4102,5,'Synthetic approved SMS','sms','Original approved follow-up for {{first_name}}.',true,1,'{"provenance":{"businessProfile":{"version":1},"brandToolkit":{"version":1}}}',NOW(),NOW());
 INSERT INTO leads(id,user_id,business_profile_id,name,first_name,full_name,phone,blacklisted,do_not_contact,email_unsubscribed,sms_sent) VALUES(1,4101,4102,'Synthetic Ada','Ada','Synthetic Ada','+15550001111',false,false,false,0);
 INSERT INTO outreach_conversations(id,user_id,business_profile_id,lead_id,channel,automation_mode,integration_provider) VALUES(21,4101,4102,1,'sms','ai_active','msg91');
 INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,message_kind,status,content,provider_message_id,provider_account_id,sent_at,created_at,metadata) VALUES(51,4101,4102,21,'outbound','outreach','sent','Synthetic original','synthetic-original-receipt','AUDITS',NOW()-interval '2 days',NOW()-interval '2 days','{"outreachCreation":{"version":1,"followUpSource":"channel_settings","delivery":{"channel":"sms","leadId":1,"phone":"+15550001111"}}}');`);
  await client.query(
    "INSERT INTO sent_messages(id,user_id,business_profile_id,lead_id,lead_name,channel,message,sent_at,status,message_id,is_reply,follow_up_dispatches) VALUES($1,4101,4102,1,'Synthetic Ada','sms','Synthetic original',NOW()-interval '2 days','sent','synthetic-original-receipt',false,'{}')",
    [originId],
  );
  await client.query(`ALTER TABLE users ADD PRIMARY KEY(id);ALTER TABLE company_settings ADD PRIMARY KEY(id);
 CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read bool,parent_links jsonb,legacy_business_column text);
 CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE SQL STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
 CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE SQL STABLE AS $$ SELECT NULLIF(current_setting('app.business_user_id',true),'')::integer $$;
 CREATE FUNCTION app_business_actor_user_id() RETURNS integer LANGUAGE SQL STABLE AS $$ SELECT NULLIF(current_setting('app.business_actor_user_id',true),'')::integer $$;
 CREATE FUNCTION app_business_system() RETURNS bool LANGUAGE SQL STABLE AS $$ SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$;
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime') THEN CREATE ROLE salesmarketing_business_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF; END $$;
 SELECT set_config('app.business_profile_id','4102',false),set_config('app.business_user_id','4101',false),set_config('app.current_user_id','4101',false),set_config('app.business_actor_user_id','17',false);`);
  const guardSource = await readFile(
    "migrations/299_business_profile_isolation.js",
    "utf8",
  );
  const guard = guardSource.match(
    /CREATE OR REPLACE FUNCTION enforce_business_ownership\(\)[\s\S]*?END \$\$/,
  )?.[0];
  if (!guard) throw new Error("Actual ownership guard missing");
  await client.query(guard);
  const accessSource = await readFile(
    "migrations/304_business_profile_memberships.js",
    "utf8",
  );
  const access = accessSource.match(
    /CREATE FUNCTION app_business_access\(p_profile INTEGER\)[\s\S]*?\$\$;/,
  )?.[0];
  if (!access) throw new Error("Actual membership function missing");
  await client.query(
    access.replace(
      "search_path=public,pg_catalog",
      `search_path=${schema},pg_catalog`,
    ),
  );
  const migration =
    // @ts-expect-error custom JavaScript migration.
    await import("../migrations/351_sms_queue_delivery_claims.js");
  await migration.up(client);
  await migration.up(client);
  const config = {
    enabled: true,
    revision: "synthetic-original-revision",
    maxFollowUps: 1,
    followUps: [{ enabled: true, delayMinutes: 5, templateId: 77 }],
  };
  await client.query(
    "INSERT INTO outreach_settings(user_id,business_profile_id,enable_auto_follow_up,channel_follow_ups) VALUES(4101,4102,true,$1)",
    [JSON.stringify({ sms: config })],
  );
}
async function consume(
  schema: string,
  jobId: string,
  crashPoint = "",
  ambiguous = false,
) {
  const { JEST_WORKER_ID: _worker, ...env } = process.env;
  const p = spawn(
    process.execPath,
    [
      "--experimental-vm-modules",
      "node_modules/jest/bin/jest.js",
      "--runInBand",
      "--forceExit",
      "--runTestsByPath",
      "tests/configuredSmsConsumerPostgres.test.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...env,
        SMS_AUDIT_MODE: "consumer",
        SMS_AUDIT_SCHEMA: schema,
        SMS_AUDIT_JOB: jobId,
        SMS_AUDIT_CRASH_POINT: crashPoint,
        SMS_AUDIT_CASE: schema
          .replace(/^sms_audit_/, "")
          .replace(/_[a-f0-9]{12}$/, ""),
        SMS_AUDIT_AMBIGUOUS: ambiguous ? "1" : "0",
      },
    },
  );
  let output = "";
  p.stdout.on("data", (b) => (output += b));
  p.stderr.on("data", (b) => (output += b));
  const timer = setTimeout(() => p.kill("SIGTERM"), 40000);
  const code = await new Promise<number | null>((resolve) =>
    p.once("exit", resolve),
  );
  clearTimeout(timer);
  await writeFile(
    `${root}/logs/${schema}-${crashPoint || "consume"}.log`,
    output,
  );
  if (code !== (crashPoint ? 86 : 0))
    throw new Error(`Consumer exit ${code}: ${output.slice(-6500)}`);
  return code;
}
if (child) {
  check(
    "actual registered SMS consumer consumes the configured local Redis job",
    async () => {
      globalThis.fetch = async (input: any, init?: RequestInit) => {
        if (String(input) !== "https://control.msg91.com/api/v5/flow")
          throw new Error("Audit blocks all other provider requests");
        const call = await client.query(
          "INSERT INTO audit_provider_calls(job_id,body,scope) VALUES($1,$2,$3) RETURNING id",
          [process.env.SMS_AUDIT_JOB, init?.body, JSON.stringify(snapshot())],
        );
        if (process.env.SMS_AUDIT_CRASH_POINT === "accepted") process.exit(86); // task child only; side effect ledger committed, no receipt/BullMQ completion.
        if (process.env.SMS_AUDIT_CASE === "rejected")
          return new Response(
            JSON.stringify({ type: "error", message: "Synthetic rejection" }),
            { status: 400 },
          );
        if (process.env.SMS_AUDIT_CASE === "uncertain_500")
          return new Response(
            JSON.stringify({ message: "Synthetic uncertain upstream" }),
            { status: 500 },
          );
        return new Response(
          JSON.stringify({
            type: "success",
            ...(process.env.SMS_AUDIT_AMBIGUOUS === "1"
              ? {}
              : { request_id: `synthetic-accepted-${call.rows[0].id}` }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const { startAllWorkers } = await import("../workers/index.js");
      await startAllWorkers();
      const deadline = Date.now() + 25000;
      let state = "";
      while (Date.now() < deadline) {
        state = await (await queue.getJob(
          process.env.SMS_AUDIT_JOB!,
        ))!.getState();
        if (["completed", "failed"].includes(state)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await writeFile(
        `${root}/logs/${process.env.SMS_AUDIT_SCHEMA}-worker-events.json`,
        JSON.stringify({ state, logMessages }, null, 2),
      );
      expect(state).toBe("completed");
    },
    35000,
  );
} else {
  const cases = [
    "unchanged",
    "disabled",
    "template_changed",
    "settings_changed",
    "ambiguous",
    "crash_replay",
    "disabled_in_service",
    "template_in_service",
    "settings_in_service",
    "cancelled_in_service",
    "takeover_in_service",
    "reply_in_service",
    "suppressed_in_service",
    "account_in_service",
    "infrastructure_in_service",
    "binding_infrastructure",
    "crash_preparation",
    "crash_started",
    "crash_projection",
    "crash_receipt",
    "delivered_replay",
    "rejected",
    "uncertain_500",
    "credential_infrastructure",
  ];
  check.each(cases)(
    "configured producer to registered SMS consumer acceptance: %s",
    async (kind: string) => {
      const originId =
          100 + parseInt(suffix.slice(0, 6), 16) * 100 + cases.indexOf(kind),
        schema = `sms_audit_${kind}_${suffix}`;
      await seed(schema, originId);
      const { cronService } = await import("../services/cronService.js");
      const produced = await scope(() =>
        (cronService as any).processConfiguredFollowUps(),
      );
      if (produced.sent !== 1)
        throw new Error(JSON.stringify({ produced, logMessages }));
      const jobId = `configured-follow-up-4102-4101-sms-${originId}-1`,
        job = await queue.getJob(jobId);
      expect(job).toBeTruthy();
      expect(job!.name).toBe("send_follow_up_sms");
      const data = job!.data as { followUpProvenance: FollowUpProvenance };
      expect(job!.data).toMatchObject({
        userId: 4101,
        businessProfileId: 4102,
        businessActorUserId: 17,
        billingActorUserId: 17,
        billingOrganizationId: 900,
        useSavedFollowUpSettings: true,
        followUpProvenance: {
          version: 1,
          userId: 4101,
          businessProfileId: 4102,
          channel: "sms",
          originTable: "sent_messages",
          originMessageId: originId,
          step: 1,
          templateId: 77,
          templateVersion: 1,
          templateRenderContext: {
            version: 1,
            timeZone: "UTC",
            signature: expect.any(String),
          },
        },
      });
      // The actual async producer must persist originating authority before queue I/O.
      // Queue capture alone cannot repair a missing durable recovery identity.
      const savedDispatch = (
        await client.query(
          "SELECT follow_up_dispatches->'1' AS dispatch FROM sent_messages WHERE id=$1",
          [originId],
        )
      ).rows[0].dispatch;
      expect(savedDispatch.payload).toMatchObject({
        userId: 4101,
        businessProfileId: 4102,
        businessActorUserId: 17,
        billingActorUserId: 17,
        billingOrganizationId: 900,
        followUpProvenance: data.followUpProvenance,
      });
      const { assertConfiguredFollowUpReady } =
        await import("../services/outreach/ConfiguredFollowUpDispatchService.js");
      await scope(() =>
        assertConfiguredFollowUpReady(
          4101,
          "sms",
          data.followUpProvenance,
          { originMessageId: originId, step: 1 },
        ),
      );
      if (kind === "disabled")
        await client.query(
          "UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{sms,enabled}','false')",
        );
      if (kind === "template_changed")
        await client.query(
          "UPDATE content_templates SET version=2,content='New approved SMS content' WHERE id=77",
        );
      if (kind === "settings_changed")
        await client.query(
          "UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{sms,followUps,0,delayMinutes}','55')",
        );
      let readinessAfterChange = "ready";
      try {
        await scope(() =>
          assertConfiguredFollowUpReady(
            4101,
            "sms",
            data.followUpProvenance,
            { originMessageId: originId, step: 1 },
          ),
        );
      } catch (e) {
        readinessAfterChange = (e as Error).message;
      }
      if (["disabled", "template_changed", "settings_changed"].includes(kind))
        expect(readinessAfterChange).not.toBe("ready");
      let crashSnapshot: any;
      const crashPoint: Record<string, string> = {
        crash_replay: "accepted",
        crash_projection: "confirmed",
        crash_preparation: "preparation",
        crash_started: "started",
        crash_receipt: "receipt",
      };
      if (crashPoint[kind]) {
        await consume(schema, jobId, crashPoint[kind]);
        crashSnapshot = {
          jobState: await (await queue.getJob(jobId))!.getState(),
          providerCalls: (
            await client.query("SELECT * FROM audit_provider_calls")
          ).rows,
          followUpReceipts: (
            await client.query(
              "SELECT * FROM sent_messages WHERE is_reply=true",
            )
          ).rows,
          origin: (
            await client.query(
              "SELECT follow_up_step,follow_up_dispatches FROM sent_messages WHERE id=$1",
              [originId],
            )
          ).rows[0],
        };
        expect(crashSnapshot.jobState).toBe("active");
        expect(crashSnapshot.providerCalls).toHaveLength(
          ["crash_preparation", "crash_started"].includes(kind) ? 0 : 1,
        );
        expect(crashSnapshot.followUpReceipts).toHaveLength(
          kind === "crash_receipt" ? 1 : 0,
        );
      }
      await consume(schema, jobId, "", kind === "ambiguous");
      if (kind === "delivered_replay") {
        await client.query(
          "UPDATE sent_messages SET status='delivered',delivery_status='delivered',delivered_at=NOW() WHERE is_reply=true",
        );
        await (await queue.getJob(jobId))!.retry("completed");
        await consume(schema, jobId);
      }
      const finalJob = (await queue.getJob(jobId))!;
      const observation = {
        kind,
        produced,
        readinessAfterChange,
        job: {
          id: jobId,
          state: await finalJob.getState(),
          data: finalJob.data,
          returnValue: finalJob.returnvalue,
          attemptsMade: finalJob.attemptsMade,
          stalledCounter: finalJob.stalledCounter,
        },
        providerCalls: (
          await client.query("SELECT * FROM audit_provider_calls ORDER BY id")
        ).rows,
        followUpReceipts: (
          await client.query(
            "SELECT * FROM sent_messages WHERE is_reply=true ORDER BY id",
          )
        ).rows,
        reservations: (await client.query("SELECT * FROM audit_reservations"))
          .rows,
        events: (await client.query("SELECT * FROM audit_events ORDER BY id"))
          .rows,
        ledger: (await client.query("SELECT * FROM sms_queue_deliveries")).rows,
        refunds: (await client.query("SELECT * FROM audit_refunds")).rows,
        lead: (await client.query("SELECT sms_sent FROM leads WHERE id=1"))
          .rows[0],
        crashSnapshot,
      };
      await writeFile(
        `${root}/${kind}.json`,
        JSON.stringify(observation, null, 2),
      );
      const invalidated = [
        "disabled",
        "template_changed",
        "settings_changed",
        "disabled_in_service",
        "template_in_service",
        "settings_in_service",
        "cancelled_in_service",
        "takeover_in_service",
        "reply_in_service",
        "suppressed_in_service",
        "account_in_service",
      ].includes(kind);
      expect(observation.providerCalls).toHaveLength(
        invalidated || kind === "crash_started" ? 0 : 1,
      );
      for (const call of observation.providerCalls)
        expect(call.scope).toMatchObject({
          business: { userId: 4101, businessProfileId: 4102, actorUserId: 17 },
          billing: {
            organizationId: 900,
            actorUserId: 17,
            businessProfileId: 4102,
            businessOwnerUserId: 4101,
          },
        });
      if (
        [
          "ambiguous",
          "uncertain_500",
          "crash_replay",
          "crash_started",
        ].includes(kind)
      ) {
        expect(finalJob.returnvalue).toMatchObject({
          success: false,
          uncertain: true,
        });
        expect(observation.followUpReceipts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ delivery_status: "uncertain" }),
          ]),
        );
      } else if (invalidated) {
        expect(finalJob.returnvalue).toMatchObject({
          success: false,
          suppressed: true,
        });
        expect(observation.followUpReceipts).toHaveLength(1);
        expect(observation.followUpReceipts[0].status).toBe("cancelled");
      } else if (kind === "rejected") {
        expect(finalJob.returnvalue).toMatchObject({ success: false });
        expect(finalJob.attemptsMade).toBe(1);
        expect(observation.followUpReceipts[0].delivery_status).toBe("failed");
        expect(observation.refunds).toHaveLength(1);
      } else
        expect(observation.followUpReceipts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: kind === "delivered_replay" ? "delivered" : "sent",
              follow_up_step: 1,
            }),
          ]),
        );
      if (invalidated)
        expect(observation.refunds).toHaveLength(
          observation.reservations.length,
        );
      expect(observation.ledger).toHaveLength(1);
      expect(observation.followUpReceipts).toHaveLength(1);
      expect(observation.lead.sms_sent).toBe(
        invalidated ||
          [
            "ambiguous",
            "uncertain_500",
            "crash_replay",
            "crash_started",
            "rejected",
          ].includes(kind)
          ? 0
          : 1,
      );
      if (kind.includes("infrastructure")) {
        expect(finalJob.attemptsMade).toBe(2);
        expect(observation.refunds).toHaveLength(1);
      }
    },
    90000,
  );
  check(
    "durable SMS claims reject changed content/authority and fence a replaced preparer",
    async () => {
      await seed(`sms_audit_fence_${suffix}`, 1001);
      const delivery =
        await import("../services/outreach/SmsQueueDeliveryService.js");
      const payload = {
        userId: 4101,
        to: "+15550001111",
        message: "Synthetic claim",
        leadId: 1,
      };
      const first = await scope(() =>
        delivery.claimQueuedSms("fence-" + suffix, payload),
      );
      const second = await scope(() =>
        delivery.claimQueuedSms("fence-" + suffix, payload, true),
      );
      expect(first.claim).toBeDefined();
      expect(second.claim).toBeDefined();
      expect(second.claim!.token).not.toBe(first.claim!.token);
      expect(await scope(() => delivery.startQueuedSms(first.claim!))).toBe(
        false,
      );
      expect(await scope(() => delivery.startQueuedSms(second.claim!))).toBe(
        true,
      );
      expect(
        await scope(() => delivery.claimQueuedSms("fence-" + suffix, payload)),
      ).toMatchObject({ uncertain: true });
      await scope(() =>
        delivery.finishQueuedSms(
          second.claim!,
          "confirmed",
          undefined,
          "synthetic-fenced-receipt",
        ),
      );
      expect(
        await scope(() => delivery.finishQueuedSms(first.claim!, "pending")),
      ).toBe(false);
      expect(
        await scope(() => delivery.claimQueuedSms("fence-" + suffix, payload)),
      ).toMatchObject({ success: true, messageId: "synthetic-fenced-receipt" });
      await expect(
        scope(() =>
          delivery.claimQueuedSms("fence-" + suffix, {
            ...payload,
            message: "Changed",
          }),
        ),
      ).rejects.toThrow("content or originating authority changed");
      await expect(
        withBusinessScope(
          { userId: 4101, businessProfileId: 4102, actorUserId: 4101 },
          () =>
            withBillingScope({ organizationId: 900, actorUserId: 4101 }, () =>
              delivery.claimQueuedSms("fence-" + suffix, payload),
            ),
        ),
      ).rejects.toThrow("originating authority changed");
      expect(
        (
          await client.query(
            "SELECT business_actor_user_id,billing_actor_user_id,billing_organization_id,state FROM sms_queue_deliveries",
          )
        ).rows,
      ).toEqual([
        {
          business_actor_user_id: 17,
          billing_actor_user_id: 17,
          billing_organization_id: 900,
          state: "confirmed",
        },
      ]);
    },
  );
  check(
    "recovers an atomic reservation reference even before its response ID was saved",
    async () => {
      await seed(`sms_audit_reservation_${suffix}`, 1002);
      const delivery =
        await import("../services/outreach/SmsQueueDeliveryService.js");
      const { creditService } = await import("../services/CreditService.js");
      const payload = {
        userId: 4101,
        to: "+15550001111",
        message: "Synthetic reservation",
      };
      const first = await scope(() =>
        delivery.claimQueuedSms("reservation-" + suffix, payload),
      );
      await scope(() =>
        creditService.reserveForResource({
          userId: 4101,
          eventKey: "outreach_sms",
          description: "Synthetic reservation",
          service: "test",
          referenceType: "sms_queue_claim",
          createResource: (tx) =>
            delivery.attachSmsReservation(first.claim!, tx),
        }),
      );
      const recovered = await scope(() =>
        delivery.claimQueuedSms("reservation-" + suffix, payload, true),
      );
      expect(recovered.claim!.reservationId).toBeUndefined();
      const id = await scope(() =>
        delivery.findSmsReservation(recovered.claim!),
      );
      expect(id).toBeGreaterThan(0);
      await scope(() =>
        creditService.refundDeduction({
          userId: 4101,
          transactionId: id!,
          description: "Synthetic unused reservation",
        }),
      );
      await scope(() =>
        creditService.refundDeduction({
          userId: 4101,
          transactionId: id!,
          description: "Synthetic duplicate refund",
        }),
      );
      expect(
        (await client.query("SELECT count(*) FROM audit_refunds")).rows[0]
          .count,
      ).toBe("1");
      await expect(
        scope(() =>
          database.transaction(async (tx) => {
            await delivery.attachSmsReservation(recovered.claim!, tx);
            throw new Error("Synthetic rollback");
          }),
        ),
      ).rejects.toThrow("Synthetic rollback");
      expect(
        (
          await client.query(
            "SELECT reservation_reference FROM sms_queue_deliveries",
          )
        ).rows[0].reservation_reference,
      ).toBe(recovered.claim!.reservationReference);
    },
  );
  check(
    "migration351 forces business RLS and parent ownership and retains evidence on rollback",
    async () => {
      const schema = `sms_audit_isolation_${suffix}`;
      await seed(schema, 1003);
      const delivery =
        await import("../services/outreach/SmsQueueDeliveryService.js");
      await scope(() =>
        delivery.claimQueuedSms("isolation-" + suffix, {
          userId: 4101,
          to: "+15550001111",
          message: "Synthetic isolation",
        }),
      );
      expect(
        (
          await client.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='sms_queue_deliveries'::regclass",
          )
        ).rows[0],
      ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect(
        (
          await client.query(
            "SELECT count(*) FROM pg_trigger WHERE tgrelid='sms_queue_deliveries'::regclass AND NOT tgisinternal",
          )
        ).rows[0].count,
      ).toBe("2");
      await client.query(`INSERT INTO users VALUES(4201,true,NULL);INSERT INTO company_settings(id,user_id,billing_organization_id,is_approved) VALUES(4202,4101,900,true),(4302,4201,900,true);
    INSERT INTO business_profile_memberships VALUES(2,4202,17,'active','member');
    INSERT INTO sent_messages(id,user_id,business_profile_id,lead_id,lead_name,channel,message,sent_at,status,is_reply) VALUES(991,4101,4202,1,'Synthetic','sms','Other profile',NOW(),'sent',true);
    GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;SET ROLE salesmarketing_business_runtime`);
      try {
        expect(
          (await client.query("SELECT count(*) FROM sms_queue_deliveries"))
            .rows[0].count,
        ).toBe("1");
        await expect(
          client.query(
            "UPDATE sms_queue_deliveries SET activity_message_id=991",
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          client.query(
            "UPDATE sms_queue_deliveries SET business_profile_id=4202",
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query(
          "SELECT set_config('app.business_profile_id','4202',false)",
        );
        expect(
          (await client.query("SELECT count(*) FROM sms_queue_deliveries"))
            .rows[0].count,
        ).toBe("0");
        await expect(
          client.query(
            "INSERT INTO sms_queue_deliveries(user_id,business_profile_id,business_actor_user_id,billing_actor_user_id,billing_organization_id,job_id,payload_hash) VALUES(4101,4102,17,17,900,'cross-profile','hash')",
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query(
          "SELECT set_config('app.business_profile_id','4302',false),set_config('app.business_user_id','4201',false)",
        );
        expect(
          (await client.query("SELECT count(*) FROM sms_queue_deliveries"))
            .rows[0].count,
        ).toBe("0");
      } finally {
        await client.query(
          "RESET ROLE;SELECT set_config('app.business_profile_id','4102',false),set_config('app.business_user_id','4101',false)",
        );
      }
      await client.query(
        "UPDATE business_profile_memberships SET status='revoked' WHERE user_id=17;SET ROLE salesmarketing_business_runtime",
      );
      try {
        expect(
          (await client.query("SELECT count(*) FROM sms_queue_deliveries"))
            .rows[0].count,
        ).toBe("0");
      } finally {
        await client.query("RESET ROLE");
      }
      const migration =
        // @ts-expect-error custom JavaScript migration.
        await import("../migrations/351_sms_queue_delivery_claims.js");
      await expect(migration.down(client)).rejects.toThrow(
        "evidence is retained",
      );
    },
  );
}
