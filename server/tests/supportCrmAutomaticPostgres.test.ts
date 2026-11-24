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
import { sql, getTableName, getTableColumns, SQL } from "drizzle-orm";
import type { PipelineContext } from "../services/agents/pipeline/ChannelGateway.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { withBusinessScope } from "../tenancy/businessContext.js";
import { DEFAULT_CRM_CONFIGURATION } from "../../shared/crmConfiguration.js";
import {
  type AutomationAction,
  type AutomationDefinition,
} from "../../shared/crmAutomations.js";

const postgres = process.env.SUPPORT_CRM_HANDOFF_SOCKET
  ? describe
  : describe.skip;
let database: NodePgDatabase,
  fixture: Pool,
  admin: Pool,
  runtime: Pool,
  schema: string,
  grantedRole = false;
let failRuntimeLookup = false,
  failEnabledRuntimeLookup = false;
let loseHandoffReply: "" | "claim" | "complete" = "",
  loseLegacyTicketReply = false;
let crashCommit = false,
  senderReady = true;
const proxy = new Proxy({} as NodePgDatabase, {
  get(_target, key) {
    if (key === "execute")
      return async (query: any) => {
        if (
          failEnabledRuntimeLookup &&
          new PgDialect()
            .sqlToQuery(query)
            .sql.includes("SELECT enabled FROM crm_automation_runtime")
        ) {
          failEnabledRuntimeLookup = false;
          throw new Error("Synthetic enabled runtime lookup unavailable");
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
        if (
          crashCommit &&
          (
            await fixture.query(
              "SELECT pipeline_status FROM crm_contacts WHERE id=42",
            )
          ).rows[0]?.pipeline_status === "qualified_custom"
        ) {
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
      const result = await (context?.database || database)
        .execute(sql`INSERT INTO support_tickets(user_id,business_profile_id,contact_id,ticket_number,subject,priority,status)
    VALUES(${userId},101,${input.contactId},${`TKT-${randomBytes(4).toString("hex")}`},${input.subject},${input.priority},'open') RETURNING id,ticket_number`);
      if (loseLegacyTicketReply) {
        loseLegacyTicketReply = false;
        throw new Error("Synthetic lost ticket reply");
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
const { automationService } = await import("../services/AutomationService.js");
const { crmService } = await import("../services/CRMService.js");
const { PostProcessingStage } =
  await import("../services/agents/pipeline/stages/PostProcessingStage.js");
const { applySupportCrmStage } =
  await import("../services/agents/orchestration/SupportCRMPipeline.js");
const { contactAutomationHandoff } =
  await import("../services/automations/ContactAutomationHandoff.js");
// @ts-expect-error JavaScript migration modules are used by the migration runner.
const migration = await import("../migrations/314_crm_automation_builder.js");
const scope = <T>(work: () => T, profile = 101) =>
  withBusinessScope({ userId: 9, businessProfileId: profile }, work);
const tag: AutomationAction = {
  id: "tag",
  type: "update_tags",
  config: { tags: ["qualified"] },
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

postgres(
  "automatic Support CRM through actual orchestration and scoped PostgreSQL",
  () => {
    beforeAll(async () => {
      const socket = process.env.SUPPORT_CRM_HANDOFF_SOCKET;
      if (
        socket !== "/workspace/support-crm-handoff-evidence-20261023/pgsocket"
      )
        throw Error("Owned disposable CRM socket required");
      const connection = {
        host: socket,
        database: "postgres",
        user: "postgres",
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
        await admin.query(
          "CREATE ROLE salesmarketing_business_runtime NOLOGIN",
        );
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
      await admin.query(
        "CREATE OR REPLACE FUNCTION public.app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$",
      );
      await admin.query("SET search_path=public,pg_catalog");
      const modelModules = await import("../models/allSchemas.js");
      const orchestration =
        await import("../models/supportOrchestration/schema.js");
      const names = new Set([
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
        "support_effect_ledger",
      ]);
      const modelTables = new Map<string, any>();
      for (const mod of [modelModules, modelModules.schema, orchestration])
        for (const value of Object.values(mod)) {
          try {
            const name = getTableName(value as any);
            if (names.has(name)) modelTables.set(name, value);
          } catch {
            /* Non-table exports are irrelevant. */
          }
        }
      expect([...names].filter((name) => !modelTables.has(name))).toEqual([]);
      for (const [name, table] of modelTables) {
        const columns = Object.values(getTableColumns(table)) as any[];
        const definitions = columns.map((column) => {
          let def = '"' + column.name + '" ' + column.getSQLType();
          if (column.primary) def += " PRIMARY KEY";
          if (column.notNull) def += " NOT NULL";
          if (column.default !== undefined) {
            const value = column.default;
            if (value instanceof SQL)
              def += " DEFAULT " + new PgDialect().sqlToQuery(value).sql;
            else if (column.getSQLType() === "jsonb")
              def +=
                " DEFAULT '" +
                (typeof value === "string"
                  ? value
                  : JSON.stringify(value)
                ).replaceAll("'", "''") +
                "'::jsonb";
            else
              def +=
                " DEFAULT " +
                (typeof value === "string"
                  ? "'" + value.replaceAll("'", "''") + "'"
                  : String(value));
          }
          return def;
        });
        await admin.query(
          'CREATE TABLE public."' + name + '" (' + definitions.join(",") + ")",
        );
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
        "support_effect_ledger",
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
      await fixture.query(
        "CREATE UNIQUE INDEX fixture_support_effect_key ON support_effect_ledger(effect_key)",
      );
      await migration.up(fixture);
      const preserved = (
        await fixture.query(
          "SELECT * FROM crm_pipeline_automations WHERE id=73",
        )
      ).rows[0];
      expect(preserved.is_active).toBe(true);
      expect(preserved.priority).toBe(9);
      expect(preserved.definition.actions[0].config).toEqual({ tags: ["won"] });
      expect(preserved.definition.trigger.config).toEqual({ toStatus: "won" });
      expect(
        (await fixture.query("SELECT count(*) FROM crm_automation_logs"))
          .rows[0].count,
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
      if (admin && schema)
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (grantedRole)
        await admin.query(
          `REVOKE salesmarketing_business_runtime FROM ${process.env.DB_USER}`,
        );
      // The role exists only in the disposable cluster; container cleanup removes it.
      if (admin) {
        await admin.query(
          "DROP TABLE IF EXISTS public.crm_activities,public.crm_contacts,public.crm_pipeline_automations,public.crm_automation_logs,public.outreach_messages,public.outreach_conversations,public.support_tickets,public.handoff_queue,public.outreach_campaigns,public.leads,public.whatsapp_templates,public.channel_credentials,public.wallet_transactions,public.crm_alerts,public.support_effect_ledger CASCADE; DROP FUNCTION IF EXISTS public.app_business_profile_id()",
        );
      }
      await admin?.end();
    });
    beforeEach(async () => {
      jest.clearAllMocks();
      failRuntimeLookup = false;
      failEnabledRuntimeLookup = false;
      loseHandoffReply = "";
      loseLegacyTicketReply = false;
      fireEvent.mockReset().mockResolvedValue(undefined);
      senderReady = true;
      crashCommit = false;
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
        "TRUNCATE support_effect_ledger,crm_activities,crm_automation_run_steps,crm_automation_runs,crm_automation_events,crm_automation_receipts,crm_automation_logs,crm_pipeline_automations,crm_contacts,outreach_messages,outreach_conversations,support_tickets,leads,channel_credentials,whatsapp_templates RESTART IDENTITY CASCADE",
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
      await fixture.query(`INSERT INTO outreach_conversations(id,user_id,business_profile_id,lead_id,crm_contact_id,channel,status) VALUES(21,9,101,7,42,'email','active'); UPDATE crm_automation_runtime SET enabled=true,cutover_at=now();INSERT INTO business_profile_memberships VALUES(101,9,'owner@example.test','active') ON CONFLICT DO NOTHING;
      INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,last_name,email,phone,status,pipeline_status,tags)
      VALUES(42,9,101,'Alex','Morgan','alex@example.test','+919876543210','new','new','[]');
      INSERT INTO channel_credentials(user_id,business_profile_id,platform,credential_type,account_identifier,account_name,is_active,session_data)
      VALUES(9,101,'msg91_sms','api_key','SMSAPP','Alerts',true,'{"flowId":"flow-1"}');
      INSERT INTO whatsapp_templates(id,user_id,business_profile_id,name,language,body,header_type,waba_template_id,status,meta_status,has_local_changes)
      VALUES(12,9,101,'hello','en','Hello {{1}}','TEXT','meta-template','APPROVED','APPROVED',false);`);
    });

    const ctx = (): PipelineContext => ({
      message: {
        userId: 9,
        conversationId: 21,
        channel: "email",
        senderIdentifier: "synthetic",
        inboundText: "Qualified request",
        rawMessageId: "synthetic-support-crm-1",
        metadata: { executionMode: "customer" },
      },
      agentResult: {
        replyText: "Recorded.",
        escalated: false,
        confidence: 1,
        crmStageDecision: {
          stageKey: "qualified_custom",
          outcome: "active",
          evidence: "progress",
          confidence: 1,
        },
      },
      confidence: 1,
      policyViolations: [],
      metadata: { deliveryStatus: "sent", ownerHandoffPolicy: null },
    });
    const executeStage = async (context = ctx()) => {
      await scope(() => new PostProcessingStage().execute(context));
      return context;
    };
    const legacy = async () => {
      await createRule([tag]);
      await fixture.query(
        "UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL",
      );
    };
    const activity = async () =>
      (
        await fixture.query(
          "SELECT * FROM crm_activities WHERE type='pipeline_change' ORDER BY id DESC LIMIT 1",
        )
      ).rows[0];
    const ledger = async () =>
      (
        await fixture.query(
          "SELECT status FROM support_effect_ledger WHERE effect_type='crm_pipeline_update'",
        )
      ).rows[0]?.status;
    it("retains a recoverable automatic checkpoint and saved-stage success on discovery failure", async () => {
      await legacy();
      failRuntimeLookup = true;
      const result = await executeStage();
      const saved = await activity();
      expect((await inspect()).contact.pipeline_status).toBe(
        "qualified_custom",
      );
      expect(saved.metadata.automationHandoff).toMatchObject({
        version: 1,
        events: { pipeline_status_change: { status: "pending" } },
      });
      expect(result.metadata?.crmStage).toMatchObject({
        key: "qualified_custom",
        automationTransitionId: saved.id,
        automationReviewRequired: true,
      });
      expect(result.metadata?.effectReconciliationRequired).not.toBe(true);
      expect(await ledger()).toBe("success");
      const replay = await executeStage();
      expect((await inspect()).logs).toHaveLength(0);
      const recovered = await scope(() =>
        contactAutomationHandoff(9, 42, saved.id, true),
      );
      expect(recovered?.status).toBe("completed");
      expect((await inspect()).logs).toHaveLength(1);
      expect(replay.metadata?.crmStage.key).toBe("qualified_custom");
    });
    it("keeps a saved automatic stage truthful when the final contact reread fails", async () => {
      await legacy();
      const original = crmService.getContactById.bind(crmService);
      let reads = 0;
      const spy = jest
        .spyOn(crmService, "getContactById")
        .mockImplementation(async (...args) => {
          if (++reads === 2) throw Error("Synthetic final refresh failed");
          return original(...args);
        });
      try {
        const result = await executeStage();
        expect(result.metadata?.crmStage).toMatchObject({
          key: "qualified_custom",
          refreshRequired: true,
        });
        expect(await ledger()).toBe("success");
        expect((await inspect()).logs).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
    it("retains uncertain legacy action outcomes without repeating the action", async () => {
      await legacy();
      await fixture.query(
        "UPDATE crm_pipeline_automations SET action='create_ticket',action_config='{}'",
      );
      loseLegacyTicketReply = true;
      const result = await executeStage();
      expect(result.metadata?.crmStage.automationReviewRequired).toBe(true);
      const saved = await activity();
      expect(
        saved.metadata.automationHandoff.events.pipeline_status_change.status,
      ).toBe("review_required");
      await executeStage();
      await scope(() => contactAutomationHandoff(9, 42, saved.id, true));
      expect(
        (await fixture.query("SELECT count(*)::int n FROM support_tickets"))
          .rows[0].n,
      ).toBe(1);
      expect((await inspect()).logs).toHaveLength(1);
    });
    it.each(["claim", "complete"] as const)(
      "resolves a lost %s checkpoint response without replaying an action",
      async (where) => {
        await legacy();
        loseHandoffReply = where;
        const result = await executeStage();
        const saved = await activity();
        expect(result.metadata?.crmStage.automationHandoff.status).toBe(
          where === "claim" ? "processing" : "completed",
        );
        expect(await ledger()).toBe("success");
        await executeStage();
        await scope(() => contactAutomationHandoff(9, 42, saved.id, true));
        expect((await inspect()).logs).toHaveLength(where === "claim" ? 0 : 1);
      },
    );
    it("keeps a lost stage-commit response for explicit reconciliation rather than unguarded replay", async () => {
      await legacy();
      crashCommit = true;
      const result = await executeStage();
      const saved = await activity();
      expect((await inspect()).contact.pipeline_status).toBe(
        "qualified_custom",
      );
      expect(
        saved.metadata.automationHandoff.events.pipeline_status_change.status,
      ).toBe("pending");
      expect(result.metadata?.effectReconciliationRequired).toBe(true);
      expect(await ledger()).toBe("reconciliation_required");
      await executeStage();
      expect((await inspect()).logs).toHaveLength(0);
      expect(
        (await scope(() => contactAutomationHandoff(9, 42, saved.id, true)))
          ?.status,
      ).toBe("completed");
      expect((await inspect()).logs).toHaveLength(1);
      expect(await ledger()).toBe("reconciliation_required");
    });
    it("delegates cutover to the existing captured event and actual engine only once", async () => {
      await createRule([tag]);
      const result = await executeStage();
      expect(result.metadata?.crmStage.automationHandoff.status).toBe("queued");
      const events = (
        await fixture.query(
          "SELECT id FROM crm_automation_events WHERE event_type='pipeline_status_change'",
        )
      ).rows;
      expect(events).toHaveLength(1);
      expect((await inspect()).logs).toHaveLength(0);
      await scope(() => processAutomationEvent(9, events[0].id));
      const saved = await activity();
      expect(
        (await scope(() => contactAutomationHandoff(9, 42, saved.id, false)))
          ?.status,
      ).toBe("completed");
      await executeStage();
      expect((await inspect()).contact.tags).toEqual(["qualified"]);
      expect(
        (
          await fixture.query(
            "SELECT count(*)::int n FROM crm_automation_events WHERE event_type='pipeline_status_change'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await inspect()).runs).toHaveLength(1);
    });
    it("keeps the automatic source and exact insights conversation association", async () => {
      await legacy();
      await executeStage();
      const saved = await activity();
      expect(saved.outreach_conversation_id).toBe(21);
      expect(saved.metadata).toMatchObject({
        source: "support_agent",
        insightsConversation: { kind: "outreach", id: 21 },
        actorUserId: 9,
      });
    });
    it("does not resume an unrelated pending manual checkpoint on an unchanged automatic observation", async () => {
      await legacy();
      const saved = await scope(() =>
        crmService.updatePipelineStatus(9, 42, "qualified_custom", {
          recoverableAutomation: "pipeline",
        }),
      );
      await executeStage();
      expect((await inspect()).logs).toHaveLength(0);
      expect(
        (
          await scope(() =>
            contactAutomationHandoff(
              9,
              42,
              saved!.automationTransitionId!,
              false,
            ),
          )
        )?.status,
      ).toBe("pending");
    });
    it("preserves terminal stages without reopening or evaluating new automation", async () => {
      await legacy();
      await fixture.query(
        "UPDATE crm_contacts SET pipeline_status='won',status='won' WHERE id=42",
      );
      await executeStage();
      expect((await inspect()).contact).toMatchObject({
        pipeline_status: "won",
        status: "won",
      });
      expect((await inspect()).logs).toHaveLength(0);
      expect(await activity()).toBeUndefined();
    });
    it.each(["preview", "advisory"] as const)(
      "preserves the %s non-mutation gate",
      async (mode) => {
        const context = ctx();
        context.message.metadata = { executionMode: mode };
        await executeStage(context);
        expect((await inspect()).contact.pipeline_status).toBe("new");
        expect(await ledger()).toBeUndefined();
      },
    );
    it.each([
      "uncertain",
      "failed_retry_scheduled",
      "failed",
      "pending_approval",
      "blocked",
    ])(
      "does not commit CRM for delivery outcome %s",
      async (deliveryStatus) => {
        const context = ctx();
        context.metadata!.deliveryStatus = deliveryStatus;
        await executeStage(context);
        expect((await inspect()).contact.pipeline_status).toBe("new");
        expect(await ledger()).toBeUndefined();
      },
    );
    it("keeps automatic CRM work inside the actual selected business profile", async () => {
      await scope(() => new PostProcessingStage().execute(ctx()), 102);
      expect((await inspect()).contact.pipeline_status).toBe("new");
      expect(await ledger()).toBeUndefined();
    });
    it("requires a matching owner principal at the actual configuration boundary", async () => {
      await expect(
        scope(() =>
          applySupportCrmStage(10, 42, { legacyStage: "qualified_custom" }),
        ),
      ).rejects.toThrow();
      expect((await inspect()).contact.pipeline_status).toBe("new");
    });
  },
);
