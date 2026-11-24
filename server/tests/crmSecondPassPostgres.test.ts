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
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Request } from "express";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { withBusinessScope } from "../tenancy/businessContext.js";
import { DEFAULT_CRM_CONFIGURATION } from "../../shared/crmConfiguration.js";
import {
  type AutomationAction,
  type AutomationDefinition,
} from "../../shared/crmAutomations.js";

const postgres =
  process.env.CRM_AUTOMATIONS_LOCAL_QA === "1" ? describe : describe.skip;
let database: NodePgDatabase,
  fixture: Pool,
  admin: Pool,
  runtime: Pool,
  schema: string,
  createdRole = false,
  grantedRole = false;
let failRuntimeLookup = false,failEnabledRuntimeLookup=false;
let loseHandoffReply: "" | "claim" | "complete" = "",
  loseLegacyTicketReply = false;
let crashAfterTicket = false,
  crashCommit = false,
  senderReady = true,
  ticketGate: Promise<void> | null = null,
  ticketEntered: (() => void) | null = null;
const proxy = new Proxy({} as NodePgDatabase, {
  get(_target, key) {
    if (key === "execute")
      return async (query: any) => {
        if(failEnabledRuntimeLookup && new PgDialect().sqlToQuery(query).sql.includes('SELECT enabled FROM crm_automation_runtime')) {
          failEnabledRuntimeLookup=false;throw new Error('Synthetic enabled runtime lookup unavailable');
        }
        if (
          failRuntimeLookup &&
          new PgDialect().sqlToQuery(query).sql.includes("enabled,cutover_at")
        ) {
          failRuntimeLookup = false;
          throw Object.assign(
            new Error("Synthetic runtime lookup unavailable"),
            { code: "08006" },
          );
        }
        const compiled = new PgDialect().sqlToQuery(query);
        const result = await database.execute(query);
        if (
          loseHandoffReply &&
          compiled.sql.includes("UPDATE crm_activities") &&
          (loseHandoffReply === "claim"
            ? compiled.sql.includes("processing")
            : compiled.params.includes("completed"))
        ) {
          loseHandoffReply = "";
          throw Object.assign(new Error("Synthetic lost checkpoint response"), {
            code: "08006",
          });
        }
        return result;
      };
    if (key === "transaction")
      return async (work: Parameters<NodePgDatabase["transaction"]>[0]) => {
        const result = await database.transaction(work);
        if (crashCommit) {
          crashCommit = false;
          throw Object.assign(new Error("Simulated lost commit response"), {
            code: "08006",
          });
        }
        return result;
      };
    const value = database[key as keyof NodePgDatabase];
    return typeof value === "function" ? value.bind(database) : value;
  },
});
const fireEvent = jest.fn<any>().mockResolvedValue(undefined);
jest.unstable_mockModule("../services/AlertService.js", () => ({
  alertService: { fireEvent },
  ALERT_EVENT_TYPES: [],
}));
jest.unstable_mockModule("../services/SentimentAnalysisService.js", () => ({
  sentimentAnalysisService: {},
}));
jest.unstable_mockModule("../services/ReminderService.js", () => ({
  reminderService: {},
}));
const emailSend = jest.fn<any>(),
  smsSend = jest.fn<any>(),
  waSend = jest.fn<any>(),
  charge = jest.fn<any>(),
  refund = jest.fn<any>(),
  webhook = jest.fn<any>();
jest.unstable_mockModule("../models/db.js", () => ({ db: proxy }));
jest.unstable_mockModule("../events/EventBus.js", () => ({
  eventBus: { publish: async () => undefined },
  EVENT_CHANNELS: { CRM_AUTOMATION_UPDATED: "events:crm:automation:updated" },
}));
jest.unstable_mockModule("../queues/index.js", () => ({
  queueRegistry: { addJob: jest.fn() },
  QUEUE_NAMES: { CRM_AUTOMATIONS: "crm-automations" },
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../services/SupportService.js", () => ({
  supportService: {
    createTicket: async (
      userId: number,
      input: { contactId: number; subject: string; priority: string },
      context?: { database: NodePgDatabase },
    ) => {
      if (ticketGate) {
        ticketEntered?.();
        await ticketGate;
      }
      const result = await (context?.database || database)
        .execute(sql`INSERT INTO support_tickets(user_id,business_profile_id,contact_id,ticket_number,subject,priority,status)
    VALUES(${userId},101,${input.contactId},${`TKT-${randomBytes(4).toString("hex")}`},${input.subject},${input.priority},'open') RETURNING id,ticket_number`);
      if (loseLegacyTicketReply) {
        loseLegacyTicketReply = false;
        throw new Error("Synthetic lost ticket reply");
      }
      if (crashAfterTicket) {
        crashAfterTicket = false;
        crashCommit = true;
      }
      return {
        id: result.rows[0].id,
        ticketNumber: result.rows[0].ticket_number,
      };
    },
  },
}));
jest.unstable_mockModule("../services/subscriptions/service.js", () => ({
  requireSubscriptionForOperation: async () => undefined,
}));
jest.unstable_mockModule("../services/CreditService.js", () => ({
  creditService: { deductOnceForResource: charge, refundDeduction: refund },
}));
jest.unstable_mockModule("../services/SmartThrottlingService.js", () => ({
  SmartThrottlingService: {
    getInstance: () => ({
      isAllowed: async () => ({ allowed: true }),
      recordRequest: async () => undefined,
    }),
  },
}));
jest.unstable_mockModule("../services/emailService.js", () => ({
  emailService: { sendEmailWithUserCredentials: emailSend },
}));
jest.unstable_mockModule("../services/smsService.js", () => ({
  sendSMS: smsSend,
}));
jest.unstable_mockModule("../services/whatsappApiService.js", () => ({
  whatsappApiService: {
    sendTemplate: waSend,
    listApprovedTemplates: async () => [
      {
        id: "meta-template",
        name: "hello",
        language: "en",
        body: "Hello {{1}}",
        headerType: "TEXT",
        buttons: [],
      },
    ],
  },
}));
jest.unstable_mockModule("../utils/safeRemoteFetch.js", () => ({
  assertPublicHttpUrl: async (value: string) => new URL(value),
  fetchPublicHttpUrl: webhook,
}));
jest.unstable_mockModule("../services/outreach/CreationService.js", () => ({
  getCreationOptions: async (_user: number, channel: string) => ({
    accounts: [
      {
        senderId: channel === "email" ? 7 : undefined,
        providerAccountId:
          channel === "email" ? "example.test" : `${channel}-account`,
        label: channel,
        ready: senderReady,
      },
    ],
  }),
  resolveCreationAccount: async (
    _user: number,
    channel: string,
    selection: { senderId?: number; providerAccountId?: string },
  ) => ({
    account: {
      senderId: selection.senderId,
      providerAccountId:
        channel === "email" ? "example.test" : `${channel}-account`,
      ready: senderReady,
      reason: "Sender disconnected",
    },
    binding: senderReady ? {} : null,
  }),
  validateCreationTemplate: () => "Hello Alex",
}));
jest.unstable_mockModule("../models/channelCredentials/functions.js", () => ({
  ChannelCredentialModel: {
    findActiveAccountByIdentifier: async () => ({
      accountIdentifier: "SMSAPP",
      sessionData: { flowId: "flow-1" },
      isActive: senderReady,
    }),
  },
}));
jest.unstable_mockModule("../utils/msg91Credentials.js", () => ({
  inspectMSG91Credential: () => ({
    settings: { senderId: "SMSAPP", flowId: "flow-1" },
    ready: senderReady,
    issue: "Sender disconnected",
  }),
}));
jest.unstable_mockModule("../utils/channelCredentialSecrets.js", () => ({
  decryptChannelCredentialSession: (value: unknown) => value,
}));

const { processAutomationEvent } =
  await import("../services/automations/AutomationEngine.js");
await import("../queues/index.js");
await import("../services/automations/AutomationDelivery.js");
await import("../services/automations/AutomationReceipts.js");
const { automationService } = await import("../services/AutomationService.js");
const { crmService } = await import("../services/CRMService.js");
const { contactAutomationHandoff } =
  await import("../services/automations/ContactAutomationHandoff.js");
const { updatePipelineStatus, updateContact } =
  await import("../controllers/crmController.js");
const { bulkUpdateContacts, getAutomationHandoffs, retryAutomationHandoff } =
  await import("../controllers/crmWorkspaceController.js");
async function invokeRoute(
  method: any,
  body: any,
  params: Record<string, string> = {},
) {
  const response: any = {
    code: 200,
    value: undefined,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(value: unknown) {
      this.value = value;
      return this;
    },
  };
  await scope(() =>
    method(
      {
        user: { id: 9 },
        params: { id: "42", ...params },
        query: { page: "1", limit: "10" },
        body,
      },
      response,
    ),
  );
  return response;
}
async function patchStage(stage = "qualified_custom") {
  const response: any = {
    code: 200,
    value: undefined,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(value: unknown) {
      this.value = value;
      return this;
    },
  };
  await scope(() =>
    updatePipelineStatus(
      {
        user: { id: 9 },
        params: { id: "42" },
        body: { pipelineStatus: stage },
      } as unknown as Request,
      response,
    ),
  );
  return response;
}
await import("../controllers/crmAutomationsController.js");
await import("../services/CRMConfigurationService.js");
// @ts-expect-error JavaScript migration modules are used by the migration runner.
const migration = await import("../migrations/314_crm_automation_builder.js");
const scope = <T>(work: () => T, profile = 101) =>
  withBusinessScope({ userId: 9, businessProfileId: profile }, work);
const tag: AutomationAction = {
  id: "tag",
  type: "update_tags",
  config: { tags: ["qualified"] },
};
const hook: AutomationAction = {
  id: "hook",
  type: "webhook",
  config: {
    url: "https://example.test/hook",
    body: { name: "{{contact.name}}" },
    headers: {},
  },
};
const rule = (actions: AutomationAction[]): AutomationDefinition => ({
  version: 2,
  trigger: {
    type: "pipeline_status_change",
    config: { toStatus: "qualified_custom" },
  },
  conditions: { match: "all", rules: [] },
  actions,
});
const createRule = async (actions: AutomationAction[], priority = 0) =>
  scope(async () => {
    const created = await automationService.createAutomation(9, {
      name: "Qualified workflow",
      definition: rule(actions),
      priority,
    });
    return (await automationService.updateAutomation(9, created.id, {
      isActive: true,
    }))!;
  });
const inspect = async () => {
  const [runs, steps, contacts, logs] = await Promise.all([
    fixture.query("SELECT * FROM crm_automation_runs ORDER BY id"),
    fixture.query("SELECT * FROM crm_automation_run_steps ORDER BY position"),
    fixture.query("SELECT * FROM crm_contacts WHERE id=42"),
    fixture.query("SELECT * FROM crm_automation_logs"),
  ]);
  return {
    runs: runs.rows,
    steps: steps.rows,
    contact: contacts.rows[0],
    logs: logs.rows,
  };
};

postgres("Durable CRM automation runtime in isolated PostgreSQL", () => {
  beforeAll(async () => {
    // Audit-only: never load repository environment files; use the guarded disposable socket target.
    if (!["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST || ""))
      throw new Error("Automation QA requires local PostgreSQL.");
    if (!(process.env.DB_NAME === "crm_audit" || process.env.DB_NAME?.startsWith("test_")))
      throw new Error("Select crm_audit or a test_ database for CRM_AUTOMATIONS_LOCAL_QA.");
    const connection = {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || "",
      connectionTimeoutMillis: 5000,
    };
    schema = `crm_automation_${randomBytes(8).toString("hex")}`;
    admin = new Pool({
      ...connection,
      max: 1,
      options: "-c search_path=pg_catalog",
    });
    const role = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime'",
    );
    if (!role.rows.length) {
      await admin.query("CREATE ROLE salesmarketing_business_runtime NOLOGIN");
      createdRole = true;
    }
    const membership = await admin.query(
      "SELECT pg_has_role(current_user,'salesmarketing_business_runtime','MEMBER') AS member",
    );
    if (!membership.rows[0].member) {
      await admin.query(
        `GRANT salesmarketing_business_runtime TO ${process.env.DB_USER}`,
      );
      grantedRole = true;
    }
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture = new Pool({
      ...connection,
      max: 1,
      options: `-c search_path=${schema},public,pg_catalog`,
    });
    await fixture.query(`CREATE TABLE users(id integer PRIMARY KEY,name text,email text);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,crm_configuration jsonb,updated_at timestamptz DEFAULT now());
      CREATE TABLE business_scope_accounts(table_name text PRIMARY KEY);
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read boolean,parent_links jsonb);
      CREATE TABLE business_profile_memberships(business_profile_id integer,user_id integer,email text,status text);
      CREATE FUNCTION ${schema}.app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION ${schema}.app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
      CREATE FUNCTION ${schema}.app_business_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('app.business_system',true)='on' $$;
      CREATE FUNCTION ${schema}.app_business_access(profile integer) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_user<>'salesmarketing_business_runtime' OR current_setting('app.business_system',true)='on'
          OR (profile=NULLIF(current_setting('app.business_profile_id',true),'')::integer) $$;`);
    const ownership = readFileSync(
      resolve(process.cwd(), "migrations/299_business_profile_isolation.js"),
      "utf8",
    ).match(
      /CREATE OR REPLACE FUNCTION enforce_business_ownership\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$[\s\S]*?END \$\$/,
    )?.[0];
    if (!ownership)
      throw new Error("Could not locate business ownership guard source");
    await fixture.query(
      `${ownership.replace("FUNCTION enforce_business_ownership()", `FUNCTION ${schema}.enforce_business_ownership()`)};`,
    );
    const base = [
      "crm_activities",
      "crm_contacts",
      "crm_pipeline_automations",
      "crm_automation_logs",
      "outreach_messages",
      "outreach_conversations",
      "support_tickets",
      "handoff_queue",
      "outreach_campaigns",
      "leads",
      "whatsapp_templates",
      "channel_credentials",
      "wallet_transactions",
      "crm_alerts",
    ];
    for (const table of base) {
      await fixture.query(`CREATE TABLE ${table}(LIKE public.${table} INCLUDING DEFAULTS);ALTER TABLE ${table} ADD PRIMARY KEY(id);
        CREATE SEQUENCE ${table}_fixture_seq OWNED BY ${table}.id;ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_fixture_seq');
        ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS business_profile_id integer;`);
    }
    await fixture.query(`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS business_profile_id integer;
      ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS message_kind varchar(24) DEFAULT 'outreach';
      ALTER TABLE outreach_conversations ADD COLUMN IF NOT EXISTS session_ended_at timestamptz;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_member_id integer;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS outreach_conversation_id integer;
      ALTER TABLE channel_credentials ADD COLUMN IF NOT EXISTS business_profile_id integer;
      ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS business_profile_id integer;
      ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS organization_id integer;
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;`);
    await fixture.query(`INSERT INTO users VALUES(9,'Owner','owner@example.test');INSERT INTO company_settings(id,user_id) VALUES(101,9),(102,9);
      INSERT INTO crm_pipeline_automations(id,user_id,business_profile_id,name,trigger_type,trigger_config,action,action_config,is_active,priority)
      VALUES(73,9,101,'Preserved legacy','pipeline_status_change','{"fromStatus":"any","toStatus":"won"}','update_tags','{"tags":["won"]}',true,9);
      INSERT INTO crm_automation_logs(user_id,business_profile_id,automation_id,action_taken,result) VALUES(9,101,73,'update_tags','success');`);
    await migration.up(fixture);
    const preserved = (
      await fixture.query("SELECT * FROM crm_pipeline_automations WHERE id=73")
    ).rows[0];
    expect(preserved.is_active).toBe(true);
    expect(preserved.priority).toBe(9);
    expect(preserved.definition.actions[0].config).toEqual({ tags: ["won"] });
    expect(preserved.definition.trigger.config).toEqual({ toStatus: "won" });
    expect(
      (await fixture.query("SELECT count(*) FROM crm_automation_logs")).rows[0]
        .count,
    ).toBe("1");
    expect(
      (await fixture.query("SELECT enabled FROM crm_automation_runtime"))
        .rows[0].enabled,
    ).toBe(false);
    for (const table of base.filter(
      (name) => !["wallet_transactions"].includes(name),
    )) {
      await fixture.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY fixture_isolation ON ${table} FOR ALL USING(current_user<>'salesmarketing_business_runtime' OR (business_profile_id=NULLIF(current_setting('app.business_profile_id',true),'')::integer AND user_id=9))
        WITH CHECK(current_user<>'salesmarketing_business_runtime' OR (business_profile_id=NULLIF(current_setting('app.business_profile_id',true),'')::integer AND user_id=9));`);
    }
    runtime = createBusinessScopedPool(
      new Pool({
        ...connection,
        max: 3,
        options: `-c search_path=${schema},public,pg_catalog`,
      }),
    );
    database = drizzle(runtime);
  }, 30_000);
  afterAll(async () => {
    await runtime?.end();
    await fixture?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    if (grantedRole)
      await admin.query(
        `REVOKE salesmarketing_business_runtime FROM ${process.env.DB_USER}`,
      );
    if (createdRole)
      await admin.query("DROP ROLE salesmarketing_business_runtime");
    await admin?.end();
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    failRuntimeLookup = false;failEnabledRuntimeLookup=false;
    loseHandoffReply = "";
    loseLegacyTicketReply = false;
    fireEvent.mockReset().mockResolvedValue(undefined);
    senderReady = true;
    crashAfterTicket = false;
    crashCommit = false;
    ticketGate = null;
    ticketEntered = null;
    emailSend.mockResolvedValue({
      success: true,
      providerMessageId: "email-receipt",
      rfcMessageId: "<msg@example.test>",
      threadId: "gmail-thread",
    });
    smsSend.mockResolvedValue({
      success: true,
      messageId: "sms-receipt",
      deliveryAttempted: true,
      outcomeUncertain: false,
    });
    waSend.mockResolvedValue({ messages: [{ id: "wa-receipt" }] });
    charge.mockResolvedValue({ success: true, transactionId: 99 });
    refund.mockResolvedValue({ success: true });
    webhook.mockResolvedValue({
      response: { ok: true, status: 200, body: null },
    });
    await fixture.query(
      "TRUNCATE crm_activities,crm_automation_run_steps,crm_automation_runs,crm_automation_events,crm_automation_receipts,crm_automation_logs,crm_pipeline_automations,crm_contacts,outreach_messages,outreach_conversations,support_tickets,leads,channel_credentials,whatsapp_templates RESTART IDENTITY CASCADE",
    );
    const configuration = {
      ...DEFAULT_CRM_CONFIGURATION,
      stages: [
        ...DEFAULT_CRM_CONFIGURATION.stages,
        {
          key: "qualified_custom",
          label: "Qualified",
          type: "active",
          color: "#129877",
          inFlow: true,
        },
      ],
    };
    await fixture.query("UPDATE company_settings SET crm_configuration=$1", [
      JSON.stringify(configuration),
    ]);
    await fixture.query(`UPDATE crm_automation_runtime SET enabled=true,cutover_at=now();INSERT INTO business_profile_memberships VALUES(101,9,'owner@example.test','active') ON CONFLICT DO NOTHING;
      INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,last_name,email,phone,status,pipeline_status,tags)
      VALUES(42,9,101,'Alex','Morgan','alex@example.test','+919876543210','new','new','[]');
      INSERT INTO channel_credentials(user_id,business_profile_id,platform,credential_type,account_identifier,account_name,is_active,session_data)
      VALUES(9,101,'msg91_sms','api_key','SMSAPP','Alerts',true,'{"flowId":"flow-1"}');
      INSERT INTO whatsapp_templates(id,user_id,business_profile_id,name,language,body,header_type,waba_template_id,status,meta_status,has_local_changes)
      VALUES(12,9,101,'hello','en','Hello {{1}}','TEXT','meta-template','APPROVED','APPROVED',false);`);
  });
  it.each(["rejected", "synchronous"])(
    "returns the saved PATCH contact when alert publication is %s",
    async (mode) => {
      if (mode === "synchronous")
        fireEvent.mockImplementationOnce(() => {
          throw new Error("Synthetic alert outage");
        });
      else fireEvent.mockRejectedValueOnce(new Error("Synthetic alert outage"));
      const first = await patchStage();
      expect(first.code).toBe(200);
      expect(first.value.data.pipelineStatus).toBe("qualified_custom");
      expect(
        (
          await fixture.query(
            "SELECT pipeline_status FROM crm_contacts WHERE id=42",
          )
        ).rows[0].pipeline_status,
      ).toBe("qualified_custom");
      expect(
        (
          await fixture.query(
            "SELECT count(*) FROM crm_activities WHERE type='pipeline_change'",
          )
        ).rows[0].count,
      ).toBe("1");
      expect((await patchStage()).code).toBe(200);
      expect(
        (
          await fixture.query(
            "SELECT count(*) FROM crm_activities WHERE type='pipeline_change'",
          )
        ).rows[0].count,
      ).toBe("1");
    },
  );
  it("returns saved PUT fields with a refresh flag when the final reread fails", async () => {
    await fixture.query("UPDATE crm_contacts SET phone=NULL WHERE id=42");
    const original = crmService.getContactById.bind(crmService);
    let reads = 0;
    const spy = jest
      .spyOn(crmService, "getContactById")
      .mockImplementation(async (...args) => {
        reads++;
        if (reads === 2) throw new Error("Synthetic final read unavailable");
        return original(...args);
      });
    try {
      const response = await invokeRoute(updateContact, {
        company: "Saved company",
      });
      expect(response.code).toBe(200);
      expect(response.value.data).toMatchObject({
        company: "Saved company",
        refreshRequired: true,
      });
      expect(
        (await fixture.query("SELECT company FROM crm_contacts WHERE id=42"))
          .rows[0].company,
      ).toBe("Saved company");
    } finally {
      spy.mockRestore();
    }
  });
  it.each(["PATCH", "PUT", "bulk"])(
    "recovers a legacy %s discovery outage on the same saved transition without duplicate effects",
    async (kind) => {
      await createRule([tag]);
      await fixture.query(
        "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
      );
      await fixture.query(
        "UPDATE crm_contacts SET phone=NULL,status='contacted' WHERE id=42",
      );
      failRuntimeLookup = true;
      const invoke = () =>
        kind === "PATCH"
          ? patchStage()
          : invokeRoute(
              kind === "PUT" ? updateContact : bulkUpdateContacts,
              kind === "PUT"
                ? { pipelineStatus: "qualified_custom" }
                : { contactIds: [42], pipelineStatus: "qualified_custom" },
            );
      const first = await invoke();
      expect(first.code).toBe(200);
      expect(first.value.data.automationReviewRequired).toBe(true);
      const receipt =
        kind === "bulk" ? first.value.data.contacts[0] : first.value.data;
      expect(receipt.automationTransitionId).toBeGreaterThan(0);
      expect(receipt.automationHandoff.status).toBe("pending");
      expect((await inspect()).contact.tags).toEqual([]);
      const second = await invoke();
      expect(second.code).toBe(200);
      expect(second.value.data.automationReviewRequired).toBe(false);
      expect((await inspect()).contact.tags).toEqual(["qualified"]);
      expect((await inspect()).logs).toHaveLength(1);
      await invoke();
      expect((await inspect()).logs).toHaveLength(1);
    },
  );
  it("delegates enabled cutover to the single migration 314 event and refreshes its actual completion", async () => {
    await createRule([tag]);
    const first = await patchStage();
    expect(first.code).toBe(200);
    expect(first.value.data.automationHandoff.status).toBe("queued");
    const events = (
      await fixture.query(
        "SELECT id FROM crm_automation_events WHERE event_type='pipeline_status_change'",
      )
    ).rows;
    expect(events).toHaveLength(1);
    await scope(() => processAutomationEvent(9, events[0].id));
    const retry = await patchStage();
    expect(retry.value.data.automationHandoff.status).toBe("completed");
    expect((await inspect()).contact.tags).toEqual(["qualified"]);
    expect(
      (
        await fixture.query(
          "SELECT count(*) FROM crm_automation_events WHERE event_type='pipeline_status_change'",
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("CRM07 acceptance: crash after the stage commit resumes the saved transition on same-stage PATCH", async () => {
    await createRule([tag]);
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    const saved = await scope(() =>
      crmService.updatePipelineStatus(9, 42, "qualified_custom", {
        recoverableAutomation: "pipeline",
      }),
    );
    expect(saved?.automationTransitionId).toBeGreaterThan(0);
    const response = await patchStage();
    expect(response.value.data.automationHandoff.status).toBe("completed");
    expect(
      (await fixture.query("SELECT tags FROM crm_contacts WHERE id=42")).rows[0]
        .tags,
    ).toEqual(["qualified"]);
    expect(
      (await fixture.query("SELECT count(*)::int n FROM crm_automation_logs"))
        .rows[0].n,
    ).toBe(1);
  });
  it("CRM07 acceptance: concurrent legacy retries claim one evaluation only", async () => {
    await createRule([tag]);
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    await scope(() =>
      crmService.updatePipelineStatus(9, 42, "qualified_custom", {
        recoverableAutomation: "pipeline",
      }),
    );
    const responses = await Promise.all([patchStage(), patchStage()]);
    expect(responses.every((row) => row.code === 200)).toBe(true);
    expect(
      (await fixture.query("SELECT count(*)::int n FROM crm_automation_logs"))
        .rows[0].n,
    ).toBe(1);
    expect((await patchStage()).value.data.automationHandoff.status).toBe(
      "completed",
    );
  });
  it.each(["claim", "complete"] as const)(
    "CRM07 acceptance: lost %s checkpoint response cannot duplicate legacy actions",
    async (where) => {
      await createRule([tag]);
      await fixture.query(
        "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
      );
      loseHandoffReply = where;
      const response = await patchStage();
      expect(response.code).toBe(200);
      const replay = await patchStage();
      expect(replay.code).toBe(200);
      expect(replay.value.data.automationHandoff.status).toBe(
        where === "claim" ? "processing" : "completed",
      );
      expect(
        (await fixture.query("SELECT count(*)::int n FROM crm_automation_logs"))
          .rows[0].n,
      ).toBe(where === "claim" ? 0 : 1);
    },
  );
  it("CRM07 acceptance: a partially failed legacy evaluation remains review-required without repeating completed rules", async () => {
    await createRule([tag], 10);
    const bad = await createRule([tag], 0);
    await fixture.query(
      "UPDATE crm_pipeline_automations SET action='unsupported' WHERE id=$1",
      [bad.id],
    );
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    const response = await patchStage();
    expect(response.code).toBe(200);
    expect(response.value.data.automationHandoff.status).toBe(
      "review_required",
    );
    await patchStage();
    await patchStage();
    expect(
      (
        await fixture.query(
          "SELECT result FROM crm_automation_logs ORDER BY id",
        )
      ).rows.map((row) => row.result),
    ).toEqual(["success", "failed"]);
  });
  it("CRM07 acceptance: uncertain legacy ticket creation is retained for review without a second ticket", async () => {
    const created = await createRule([tag]);
    await fixture.query(
      "UPDATE crm_pipeline_automations SET action='create_ticket',action_config='{}' WHERE id=$1",
      [created.id],
    );
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    loseLegacyTicketReply = true;
    const response = await patchStage();
    expect(response.code).toBe(200);
    expect(response.value.data.automationHandoff.status).toBe(
      "review_required",
    );
    await patchStage();
    await patchStage();
    expect(
      (await fixture.query("SELECT count(*)::int n FROM support_tickets"))
        .rows[0].n,
    ).toBe(1);
    expect(
      (await fixture.query("SELECT result FROM crm_automation_logs")).rows.map(
        (row) => row.result,
      ),
    ).toEqual(["failed"]);
  });
  it("CRM07 acceptance: cutover after an uncaptured legacy commit requires review instead of falsely claiming delegation", async () => {
    await createRule([tag]);
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    await scope(() =>
      crmService.updatePipelineStatus(9, 42, "qualified_custom", {
        recoverableAutomation: "pipeline",
      }),
    );
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=true,cutover_at=now()",
    );
    const response = await patchStage();
    expect(response.code).toBe(200);
    expect(response.value.data.automationHandoff.status).toBe(
      "review_required",
    );
    expect(
      (
        await fixture.query(
          "SELECT count(*)::int n FROM crm_automation_events WHERE event_type='pipeline_status_change'",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await fixture.query("SELECT tags FROM crm_contacts WHERE id=42")).rows[0]
        .tags,
    ).toEqual([]);
  });
  it("CRM07 acceptance: transition checkpoints stay within their business profile", async () => {
    await createRule([tag]);
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    const saved = await scope(() =>
      crmService.updatePipelineStatus(9, 42, "qualified_custom", {
        recoverableAutomation: "pipeline",
      }),
    );
    expect(
      await scope(
        () =>
          contactAutomationHandoff(9, 42, saved!.automationTransitionId!, true),
        102,
      ),
    ).toBeNull();
    expect(
      (await fixture.query("SELECT count(*)::int n FROM crm_automation_logs"))
        .rows[0].n,
    ).toBe(0);
    expect((await patchStage()).value.data.automationHandoff.status).toBe(
      "completed",
    );
  });
  it("CRM07 acceptance: activity checkpoint failure rolls back stage and captured events together", async () => {
    await fixture.query(
      "CREATE FUNCTION reject_crm07_activity() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic history outage';END$$; CREATE TRIGGER reject_crm07_activity BEFORE INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION reject_crm07_activity()",
    );
    try {
      expect((await patchStage()).code).toBe(500);
      expect(
        (
          await fixture.query(
            "SELECT pipeline_status FROM crm_contacts WHERE id=42",
          )
        ).rows[0].pipeline_status,
      ).toBe("new");
      expect(
        (
          await fixture.query(
            "SELECT count(*)::int n FROM crm_automation_events WHERE event_type='pipeline_status_change'",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await fixture.query(
        "DROP TRIGGER reject_crm07_activity ON crm_activities;DROP FUNCTION reject_crm07_activity()",
      );
    }
  });
  it("keeps PUT status and pipeline discovery independent and recovers only the unclaimed event", async () => {
    await createRule([tag]);
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    await fixture.query("UPDATE crm_contacts SET phone=NULL WHERE id=42");
    failRuntimeLookup = true;
    const first = await invokeRoute(updateContact, {
      pipelineStatus: "qualified_custom",
    });
    expect(first.code).toBe(200);
    expect(first.value.data.automationHandoff.events).toEqual([
      {
        type: "status_change",
        oldValue: "new",
        newValue: "contacted",
        status: "pending",
      },
      {
        type: "pipeline_status_change",
        oldValue: "new",
        newValue: "qualified_custom",
        status: "completed",
      },
    ]);
    expect((await inspect()).logs).toHaveLength(1);
    const second = await invokeRoute(updateContact, {
      pipelineStatus: "qualified_custom",
    });
    expect(second.value.data.automationHandoff.status).toBe("completed");
    expect((await inspect()).logs).toHaveLength(1);
  });
  it("never replays a stale checkpoint after a newer unmarked stage transition", async () => {
    await createRule([tag]);
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    const saved = await scope(() =>
      crmService.updatePipelineStatus(9, 42, "qualified_custom", {
        recoverableAutomation: "pipeline",
      }),
    );
    await scope(() => crmService.updatePipelineStatus(9, 42, "new"));
    await scope(() =>
      crmService.updatePipelineStatus(9, 42, "qualified_custom"),
    );
    const receipt = await scope(() =>
      contactAutomationHandoff(9, 42, saved!.automationTransitionId!, true),
    );
    expect(receipt!.status).toBe("review_required");
    expect((await inspect()).logs).toHaveLength(0);
  });
  it("reads durable status after remount, retries safely by receipt and rejects a different profile receipt", async () => {
    await createRule([tag]);
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    const saved = await scope(() =>
      crmService.updatePipelineStatus(9, 42, "qualified_custom", {
        recoverableAutomation: "pipeline",
      }),
    );
    const before = await invokeRoute(getAutomationHandoffs, {});
    expect(before.code).toBe(200);
    expect(before.value.data[0]).toMatchObject({
      transitionId: saved!.automationTransitionId,
      status: "pending",
    });
    expect(before.value.pagination.total).toBe(1);
    expect((await inspect()).logs).toHaveLength(0);
    const retry = await invokeRoute(
      retryAutomationHandoff,
      {},
      { transitionId: String(saved!.automationTransitionId) },
    );
    expect(retry.code).toBe(200);
    expect(retry.value.data.status).toBe("completed");
    await invokeRoute(
      retryAutomationHandoff,
      {},
      { transitionId: String(saved!.automationTransitionId) },
    );
    expect((await inspect()).logs).toHaveLength(1);
    const after = await invokeRoute(getAutomationHandoffs, {});
    expect(after.value.data[0].status).toBe("completed");
    expect(
      await scope(
        () =>
          contactAutomationHandoff(9, 42, saved!.automationTransitionId!, true),
        102,
      ),
    ).toBeNull();
  });
  it("reports a failed enabled-engine run as needing review despite completed event bookkeeping", async () => {
    await createRule([hook]);
    webhook.mockResolvedValue({
      response: { ok: false, status: 400, body: null },
    });
    const first = await patchStage();
    const event = (
      await fixture.query(
        "SELECT id FROM crm_automation_events WHERE event_type='pipeline_status_change'",
      )
    ).rows[0];
    await scope(() => processAutomationEvent(9, event.id));
    const reread = await invokeRoute(getAutomationHandoffs, {});
    expect(reread.value.data[0].status).toBe("review_required");
    const retry = await patchStage();
    expect(retry.value.data.automationReviewRequired).toBe(true);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(first.value.data.automationTransitionId).toBe(
      retry.value.data.automationTransitionId,
    );
  });
  it("retains enabled-engine recovery when its actual worker runtime lookup fails after the stage is saved", async () => {
    await createRule([tag]);
    failRuntimeLookup = true;
    const first = await patchStage();
    expect(first.code).toBe(200);
    expect(first.value.data.automationHandoff.status).toBe("queued");
    const event = (
      await fixture.query(
        "SELECT id FROM crm_automation_events WHERE event_type='pipeline_status_change'",
      )
    ).rows[0];
    expect(failRuntimeLookup).toBe(true);failRuntimeLookup=false;failEnabledRuntimeLookup=true;
    await expect(
      scope(() => processAutomationEvent(9, event.id)),
    ).rejects.toThrow("Synthetic enabled runtime lookup unavailable");
    await scope(() => processAutomationEvent(9, event.id));
    await scope(() => processAutomationEvent(9, event.id));
    expect((await patchStage()).value.data.automationHandoff.status).toBe(
      "completed",
    );
    expect((await inspect()).logs).toHaveLength(1);
  });
  it("returns independent bulk receipts and recovers the one pending contact without repeating the other", async () => {
    await createRule([tag]);
    await fixture.query(
      "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
    );
    await fixture.query(
      "UPDATE crm_contacts SET phone=NULL,status='contacted' WHERE id=42; INSERT INTO crm_contacts(id,user_id,business_profile_id,email,status,pipeline_status,tags) VALUES(43,9,101,'second@example.test','contacted','new','[]')",
    );
    failRuntimeLookup = true;
    const first = await invokeRoute(bulkUpdateContacts, {
      contactIds: [42, 43],
      pipelineStatus: "qualified_custom",
    });
    expect(first.code).toBe(200);
    expect(first.value.data.automationReviewRequired).toBe(true);
    expect(
      first.value.data.contacts.map(
        (contact: any) => contact.automationHandoff.status,
      ),
    ).toEqual(["pending", "completed"]);
    const second = await invokeRoute(bulkUpdateContacts, {
      contactIds: [42, 43],
      pipelineStatus: "qualified_custom",
    });
    expect(second.value.data.automationReviewRequired).toBe(false);
    expect((await inspect()).logs).toHaveLength(2);
    expect(
      (
        await fixture.query(
          "SELECT count(*)::int n FROM crm_activities WHERE type='pipeline_change'",
        )
      ).rows[0].n,
    ).toBe(2);
  });  it.each(['PUT','bulk'])('does not resume an earlier automation from an unrelated %s details edit',async(kind)=>{
    await createRule([tag]);await fixture.query('UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL');await fixture.query('UPDATE crm_contacts SET phone=NULL WHERE id=42');
    const saved=await scope(()=>crmService.updatePipelineStatus(9,42,'qualified_custom',{recoverableAutomation:'pipeline'}));
    const response=await invokeRoute(kind==='PUT'?updateContact:bulkUpdateContacts,kind==='PUT'?{company:'Details only'}:{contactIds:[42],addTags:['manual']});
    expect(response.code).toBe(200);expect((await inspect()).logs).toHaveLength(0);
    expect((await scope(()=>contactAutomationHandoff(9,42,saved!.automationTransitionId!)))!.status).toBe('pending');
  });

});
