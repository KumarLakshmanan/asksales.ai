/** Isolated PostgreSQL TEMP tables plus a disposable race schema; no app data or transport. */
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  jest,
} from "@jest/globals";
import { Client, Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { type SQL } from "drizzle-orm";
import { withBusinessScope } from "../tenancy/businessContext.js";
const url = process.env.MANUAL_FOLLOW_UP_QA_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: Client, database: NodePgDatabase;
let legacyStates: Record<string, unknown>[] = [];
jest.unstable_mockModule("../models/db.js", () => ({
  db: {
    execute: (query: SQL) => database.execute(query),
    transaction: (work: any) => database.transaction(work),
  },
}));
let templateVersions = new Map<number, number>(),
  unapproved = new Set<number>();
jest.unstable_mockModule("../models/contentTemplates/functions.js", () => ({
  getContentTemplateById: async (id: number) =>
    id >= 1 && id <= 3
      ? {
          id,
          userId: 7,
          businessProfileId: 10,
          brandToolkitId: 1,
          isApproved: !unapproved.has(id),
          type: "email",
          version: templateVersions.get(id) || 1,
          name:
            id === 1
              ? "HR template"
              : id === 2
                ? "CXO template"
                : "Updated HR template",
          content: `${id === 1 ? "HR" : id === 2 ? "CXO" : "Updated HR"} follow-up for {{first_name}}`,
          subject: "Checking in",
          htmlContent: null,
          brandContextSnapshot: {
            provenance: {
              businessProfile: { version: 1 },
              brandToolkit: { version: 1 },
            },
          },
        }
      : null,
}));
jest.unstable_mockModule(
  "../services/content/ContentBrandContextService.js",
  () => ({
    ContentBrandContextError: class extends Error {},
    resolveContentBrandContext: async () => ({
      businessProfile: {
        version: 1,
        timezone: "Asia/Kolkata",
        companyName: "Synthetic QA",
      },
      brandToolkit: { version: 1 },
    }),
  }),
);
jest.unstable_mockModule("../models/leads/functions.js", () => ({
  LeadModel: {
    findByIdForUser: async (id: number, userId: number) =>
      userId === 7 && [101, 102].includes(id)
        ? {
            id,
            firstName: id === 101 ? "Ada" : "Grace",
            fullName: id === 101 ? "Ada Sample" : "Grace Sample",
            email: `lead-${id}@example.test`,
            phone: "919876543210",
          }
        : null,
  },
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));
let gateReady = true;
const gate = jest.fn(async () => {
  if (!gateReady) throw new Error("ASSISTANT_SETUP_REQUIRED");
  return {};
});
jest.unstable_mockModule(
  "../services/assistants/CustomerDeliveryJobs.js",
  () => ({ admitCustomerDeliveryJob: gate }),
);
const service =
  await import("../services/outreach/CampaignManualFollowUpService.js");
const migration =
  // @ts-expect-error Plain JavaScript migration exercised against PostgreSQL below.
  await import("../migrations/572_campaign_manual_follow_ups.js");
const scope = <T>(work: () => T) =>
  withBusinessScope({ userId: 7, businessProfileId: 10 }, work);
const hr = { kind: "chat_thread" as const, id: 1 },
  cxo = { kind: "chat_thread" as const, id: 2 };
const save = (campaign = hr, templateId = 1, expectedVersion = 0) =>
  scope(() =>
    service.saveManualSequence(7, {
      campaign,
      channel: "email",
      mode: "manual",
      steps: [{ delayMinutes: 60, templateId }],
      expectedVersion,
    }),
  );
const preview = (campaign = hr, expectedVersion = 1, leadId = 101) =>
  scope(() =>
    service.previewManualSequence(7, {
      campaign,
      channel: "email",
      expectedVersion,
      recipients: [{ leadId }],
    }),
  );
async function origin(
  id: number,
  conversationId: number,
  campaign = hr,
  leadId = 101,
) {
  const review = await preview(campaign, 1, leadId);
  const enrollment = await scope(() =>
    service.enrollManualReview(
      7,
      "email",
      review.reviewId,
      leadId,
      `lead-${leadId}@example.test`,
    ),
  );
  const delivery = {
    userId: 7,
    conversationId,
    leadId,
    channel: "email",
    message: "Initial",
    subject: "Original subject",
    recipientEmail: enrollment.recipient,
    senderId: 1,
    providerAccountId: "qa@example.test",
    campaignManualReviewId: review.reviewId,
  };
  const metadata = {
    outreachCreation: {
      version: 1,
      delivery,
      followUps: enrollment.steps,
      followUpSource: "campaign_manual",
      campaignManual: enrollment,
      followUpsActivated: true,
    },
  };
  await client.query(
    "INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,message_kind,status,provider_call_state,metadata,content,sent_at) VALUES($1,7,10,$2,'outbound','outreach','sent','confirmed',$3,'Initial',now()-interval '2 hours')",
    [id, conversationId, metadata],
  );
  return { enrollment, metadata, delivery };
}
suite(
  "campaign manual isolation and immutable recipient reviews (PostgreSQL)",
  () => {
    beforeAll(async () => {
      if (
        !url ||
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
      )
        throw new Error("Explicit loopback QA database required");
      client = new Client({ connectionString: url });
      await client.connect();
      await client.query("CREATE TEMP TABLE manual_qa_anchor(id integer)");
      await client.query("SET search_path TO pg_temp,pg_catalog");
      database = drizzle(client);
      await client.query(`CREATE TEMP TABLE users(id integer PRIMARY KEY); INSERT INTO users VALUES(7),(8);
      CREATE TEMP TABLE company_settings(id integer PRIMARY KEY);INSERT INTO company_settings VALUES(10),(20);
      CREATE TEMP TABLE chat_threads(id serial PRIMARY KEY,user_id integer,business_profile_id integer,business_id integer,title text,selected_agent text,deleted_at timestamp);
      INSERT INTO chat_threads VALUES(1,7,10,10,'HR','outreach',NULL),(2,7,10,10,'CXO','outreach',NULL),(3,8,20,20,'Foreign','outreach',NULL);
      CREATE TEMP TABLE outreach_campaigns(id serial PRIMARY KEY,user_id integer,business_profile_id integer,name text);
      INSERT INTO outreach_campaigns VALUES(1,7,10,'Outreach namespace');
      CREATE TEMP TABLE outreach_settings(user_id integer,business_profile_id integer,channel_follow_ups jsonb);
      CREATE TEMP TABLE business_scope_tables(table_name text,owner_column text,global_read boolean,parent_links jsonb);
      CREATE FUNCTION pg_temp.app_business_profile_id() RETURNS integer LANGUAGE SQL AS $$ SELECT 10 $$;
      CREATE FUNCTION pg_temp.app_business_access(integer) RETURNS boolean LANGUAGE SQL AS $$ SELECT true $$;
      CREATE FUNCTION pg_temp.enforce_business_ownership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TEMP TABLE outreach_conversations(id integer PRIMARY KEY,user_id integer,business_profile_id integer,lead_id integer,automation_mode text DEFAULT 'ai_active',session_ended_at timestamp);
      INSERT INTO outreach_conversations(id,user_id,business_profile_id,lead_id) VALUES(11,7,10,101),(12,7,10,101),(13,7,10,102);
      CREATE TEMP TABLE outreach_messages(id integer PRIMARY KEY,user_id integer,business_profile_id integer,conversation_id integer,direction text,message_kind text,
        status text,provider_call_state text DEFAULT 'not_started',metadata jsonb,manual_review_required boolean DEFAULT false,
        follow_up_origin_message_id integer,follow_up_step integer,follow_up_cancelled_at timestamp,content text,subject text,html_content text,
        send_intent_id uuid DEFAULT '00000000-0000-0000-0000-000000000001',sent_at timestamp,created_at timestamp DEFAULT now(),updated_at timestamp,
        confirmation_expires_at timestamp,provider_message_id text,external_message_id text,error_message text);
      CREATE TEMP TABLE social_follow_up_schedules(id integer,status text,steps jsonb,cancellation_reason text,cancelled_at timestamp,version integer,updated_at timestamp);`);
      await client.query(`INSERT INTO outreach_messages(id,user_id,business_profile_id,message_kind,status,provider_call_state,metadata) VALUES
      (901,7,10,'follow_up','pending','not_started','{"outreachCreation":{"version":1,"followUps":[]}}'),
      (902,7,10,'follow_up','pending','started','{"outreachCreation":{"version":1,"followUps":[]}}'),
      (903,7,10,'follow_up','pending','not_started','{"configuredFollowUpDispatch":{"payload":{"followUpProvenance":{"templateId":1}}}}'),
      (904,7,10,'follow_up','pending','not_started','{"configuredFollowUpDispatch":{"payload":{"followUpProvenance":{"version":1}}}}');`);
      // All DDL executes in pg_temp. Shared cluster roles and runtime grants are not modified.
      await client.query('BEGIN');
      await migration.up({
        query: (query: string, values?: unknown[]) =>
          client.query(
            query
              .replace(/GRANT[^;]+;?/g, "")
              .replace(
                /(?<![.])app_business_profile_id\(/g,
                "pg_temp.app_business_profile_id(",
              )
              .replace(
                /(?<![.])app_business_access\(/g,
                "pg_temp.app_business_access(",
              )
              .replace(
                /(?<![.])enforce_business_ownership\(/g,
                "pg_temp.enforce_business_ownership(",
              )
              .replace(
                /(?<![.])preserve_campaign_manual_revision\(/g,
                "pg_temp.preserve_campaign_manual_revision(",
              ),
            values,
          ),
      } as any);
      await client.query('COMMIT');
      legacyStates = (
        await client.query(
          "SELECT id,status,manual_review_required FROM outreach_messages ORDER BY id",
        )
      ).rows;
    });
    afterAll(async () => {
      await client?.end();
    });
    beforeEach(async () => {
      gateReady = true;
      gate.mockClear();
      templateVersions = new Map();
      unapproved = new Set();
      await client.query(
        "TRUNCATE campaign_manual_reviews,campaign_manual_sequence_revisions,campaign_manual_sequences,outreach_messages,outreach_settings RESTART IDENTITY CASCADE",
      );
      await client.query(
        "UPDATE outreach_conversations SET automation_mode='ai_active',session_ended_at=NULL",
      );
    });
    it("holds ambiguous historical inline and global-template manual work without reassigning campaign or altering AI/started work", () => {
      expect(legacyStates).toEqual([
        { id: 901, status: "manual_review", manual_review_required: true },
        { id: 902, status: "pending", manual_review_required: false },
        { id: 903, status: "manual_review", manual_review_required: true },
        { id: 904, status: "pending", manual_review_required: false },
      ]);
    });
    it("serializes competing saves on independent PostgreSQL connections and isolates concurrent HR/CXO revisions", async () => {
      const schema = `manual_follow_up_race_${process.pid}_${Date.now()}`;
      if (!/^manual_follow_up_race_[0-9]+_[0-9]+$/.test(schema))
        throw new Error("Unexpected synthetic schema");
      const original = database;
      let pool: Pool | undefined;
      try {
        await client.query(`CREATE SCHEMA ${schema};
          CREATE TABLE ${schema}.chat_threads(id integer PRIMARY KEY,user_id integer,business_profile_id integer,deleted_at timestamp);
          INSERT INTO ${schema}.chat_threads VALUES(1,7,10,NULL),(2,7,10,NULL);
          CREATE TABLE ${schema}.campaign_manual_sequences(id bigserial PRIMARY KEY,user_id integer,business_profile_id integer,chat_thread_id integer,outreach_campaign_id integer,channel text,version integer,updated_at timestamp,UNIQUE(business_profile_id,chat_thread_id,channel));
          CREATE TABLE ${schema}.campaign_manual_sequence_revisions(user_id integer,business_profile_id integer,sequence_id bigint,version integer,configuration jsonb,checksum text,UNIQUE(sequence_id,version));`);
        pool = new Pool({
          connectionString: url,
          max: 4,
          options: `-c search_path=${schema},pg_catalog`,
        });
        database = drizzle(pool);
        const attempts = await Promise.allSettled([save(hr, 1), save(hr, 2)]);
        expect(
          attempts.filter((item) => item.status === "fulfilled"),
        ).toHaveLength(1);
        const conflict = attempts.find(
          (item) => item.status === "rejected",
        ) as PromiseRejectedResult;
        expect(conflict.reason.code).toBe("CAMPAIGN_SEQUENCE_CONFLICT");
        await Promise.all([save(hr, 3, 1), save(cxo, 2, 0)]);
        const [a, b] = await Promise.all([
          scope(() => service.getManualSequence(7, hr, "email")),
          scope(() => service.getManualSequence(7, cxo, "email")),
        ]);
        expect(a.steps[0].templateId).toBe(3);
        expect(a.version).toBe(2);
        expect(b.steps[0].templateId).toBe(2);
        expect(b.version).toBe(1);
      } finally {
        database = original;
        await pool?.end();
        // The only drop target is the exact generated synthetic schema above.
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
    it("keeps HR and CXO templates isolated across concurrent campaign saves and later batches", async () => {
      await Promise.all([save(hr, 1), save(cxo, 2)]);
      const a = await preview(hr),
        b = await preview(cxo),
        later = await preview(hr, 1, 102);
      expect(a.recipients["101"].steps[0].message).toBe("HR follow-up for Ada");
      expect(b.recipients["101"].steps[0].message).toBe(
        "CXO follow-up for Ada",
      );
      expect(later.recipients["102"].steps[0].message).toBe(
        "HR follow-up for Grace",
      );
    });
    it("records one contact in both campaigns with independent exact originating threads", async () => {
      await save(hr, 1);
      await save(cxo, 2);
      await origin(100, 11, hr);
      await origin(200, 12, cxo);
      const rows = await client.query(
        "SELECT conversation_id,metadata FROM outreach_messages ORDER BY id",
      );
      expect(rows.rows.map((row) => row.conversation_id)).toEqual([11, 12]);
      expect(
        rows.rows.map(
          (row) => row.metadata.outreachCreation.campaignManual.campaign.id,
        ),
      ).toEqual([1, 2]);
      expect(
        rows.rows.map(
          (row) => row.metadata.outreachCreation.followUps[0].message,
        ),
      ).toEqual(["HR follow-up for Ada", "CXO follow-up for Ada"]);
    });
    it("saving campaign A changes only new A enrollments; B and pinned old A remain unchanged", async () => {
      await save(hr, 1);
      await save(cxo, 2);
      const old = await origin(100, 11, hr);
      await save(hr, 3, 1);
      expect(
        (await preview(hr, 2)).recipients["101"].steps[0].message,
      ).toContain("Updated HR");
      expect((await preview(cxo)).recipients["101"].steps[0].message).toContain(
        "CXO",
      );
      await expect(
        scope(() => service.assertManualEnrollment(7, old.enrollment)),
      ).resolves.toBeUndefined();
      expect(
        (
          await client.query(
            "SELECT metadata FROM outreach_messages WHERE id=100",
          )
        ).rows[0].metadata.outreachCreation.followUps[0].message,
      ).toBe("HR follow-up for Ada");
    });
    it("rejects stale save versions and stale reviewed sequence admissions", async () => {
      await save();
      const review = await preview();
      await save(hr, 3, 1);
      await expect(save(hr, 1, 1)).rejects.toMatchObject({
        code: "CAMPAIGN_SEQUENCE_CONFLICT",
      });
      await expect(
        scope(() =>
          service.enrollManualReview(
            7,
            "email",
            review.reviewId,
            101,
            "lead-101@example.test",
          ),
        ),
      ).rejects.toMatchObject({ code: "CAMPAIGN_SEQUENCE_CONFLICT" });
    });
    it("fences a campaign edit racing final origin admission before queueing", async () => {
      await save();
      const old = await origin(100, 11);
      await client.query(
        "UPDATE outreach_messages SET status='pending',provider_call_state='not_started' WHERE id=100",
      );
      await save(hr, 3, 1);
      await expect(
        scope(() => service.admitManualOrigin(7, 100, old.enrollment)),
      ).rejects.toMatchObject({ code: "CAMPAIGN_SEQUENCE_CONFLICT" });
    });
    it("holds changed library revisions rather than substituting new template content", async () => {
      await save();
      const old = await origin(100, 11);
      templateVersions.set(1, 2);
      await expect(preview()).rejects.toThrow("template changed");
      await expect(
        scope(() => service.assertManualEnrollment(7, old.enrollment)),
      ).rejects.toThrow("template changed");
      expect(old.enrollment.steps[0].message).toBe("HR follow-up for Ada");
    });
    it("preserves current approval checks at save, review and dispatch", async () => {
      unapproved.add(1);
      await expect(save()).rejects.toThrow("approve");
      unapproved.clear();
      await save();
      const old = await origin(100, 11);
      unapproved.add(1);
      await expect(
        scope(() => service.assertManualEnrollment(7, old.enrollment)),
      ).rejects.toThrow("approve");
    });
    it("rejects missing campaign/settings, wrong business/user, and ID namespace guessing", async () => {
      await expect(
        scope(() => service.getManualSequence(7, undefined, "email")),
      ).rejects.toMatchObject({ code: "CAMPAIGN_REQUIRED" });
      await expect(
        scope(() => service.getManualSequence(7, hr, "email")),
      ).rejects.toMatchObject({ code: "CAMPAIGN_SEQUENCE_REQUIRED" });
      await expect(save({ kind: "chat_thread", id: 3 })).rejects.toMatchObject({
        code: "CAMPAIGN_NOT_FOUND",
      });
      await expect(
        withBusinessScope({ userId: 7, businessProfileId: 20 }, () =>
          service.getManualSequence(7, hr, "email"),
        ),
      ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_FOUND" });
      await save();
      await expect(
        scope(() =>
          service.getManualSequence(
            7,
            { kind: "outreach_campaign", id: 1 },
            "email",
          ),
        ),
      ).rejects.toMatchObject({ code: "CAMPAIGN_SEQUENCE_REQUIRED" });
      await expect(
        scope(() => service.getManualSequence(8, hr, "email")),
      ).rejects.toMatchObject({ status: 403 });
    });
    it("copies global manual defaults only when the owner explicitly requests a preset", async () => {
      await client.query(
        `INSERT INTO outreach_settings VALUES(7,10,'{"email":{"enabled":true,"followUps":[{"enabled":true,"delayHours":2,"templateId":2}]}}')`,
      );
      await save();
      expect((await preview()).recipients["101"].steps[0].message).toContain(
        "HR",
      );
      const copied = await scope(() =>
        service.saveManualSequence(7, {
          campaign: hr,
          channel: "email",
          mode: "manual",
          expectedVersion: 1,
          steps: [],
          copyGlobalPreset: true,
        }),
      );
      expect(copied.steps[0]).toMatchObject({
        templateId: 2,
        delayMinutes: 120,
      });
    });
    it("rejects reviewed recipient/channel substitution and mutated snapshot bodies", async () => {
      await save();
      const old = await origin(100, 11);
      await expect(
        scope(() =>
          service.enrollManualReview(
            7,
            "sms",
            old.enrollment.reviewId,
            101,
            old.enrollment.recipient,
          ),
        ),
      ).rejects.toThrow("channel");
      await expect(
        scope(() =>
          service.enrollManualReview(
            7,
            "email",
            old.enrollment.reviewId,
            102,
            old.enrollment.recipient,
          ),
        ),
      ).rejects.toThrow("recipient");
      await expect(
        scope(() =>
          service.assertManualEnrollment(7, {
            ...old.enrollment,
            steps: [{ ...old.enrollment.steps[0], message: "CXO swapped" }],
          }),
        ),
      ).rejects.toThrow("immutable recipient review");
    });
    it("rejects invalid mode, unordered timing and unresolved template choices", async () => {
      for (const input of [
        { mode: "manual", steps: [] },
        { mode: "auto", steps: [] },
        { mode: "off", steps: [{ delayMinutes: 2, templateId: 1 }] },
        {
          mode: "manual",
          steps: [
            { delayMinutes: 60, templateId: 1 },
            { delayMinutes: 30, templateId: 2 },
          ],
        },
        { mode: "manual", steps: [{ delayMinutes: 60, templateId: 0 }] },
      ])
        await expect(
          scope(() =>
            service.saveManualSequence(7, {
              campaign: hr,
              channel: "email",
              expectedVersion: 0,
              ...input,
            }),
          ),
        ).rejects.toMatchObject({ status: 400 });
    });
    it("requires an exact preview to apply a newer revision and makes retries idempotent", async () => {
      await save();
      const old = await origin(100, 11);
      await save(hr, 3, 1);
      const generic = await preview(hr, 2);
      await expect(
        scope(() =>
          service.applyPendingManualEnrollment(7, {
            originId: 100,
            reviewId: generic.reviewId,
            previousReviewId: old.enrollment.reviewId,
          }),
        ),
      ).rejects.toThrow("exact pending enrollment");
      const { items } = await scope(() =>
        service.previewPendingManualEnrollments(7, {
          campaign: hr,
          channel: "email",
          expectedVersion: 2,
        }),
      );
      expect(items).toHaveLength(1);
      const input = {
        originId: 100,
        reviewId: items[0].reviewId,
        previousReviewId: old.enrollment.reviewId,
      };
      await expect(
        scope(() => service.applyPendingManualEnrollment(7, input)),
      ).resolves.toEqual({ applied: true, duplicate: false });
      await expect(
        scope(() => service.applyPendingManualEnrollment(7, input)),
      ).resolves.toEqual({ applied: true, duplicate: true });
      expect(
        (
          await client.query(
            "SELECT metadata FROM outreach_messages WHERE id=100",
          )
        ).rows[0].metadata.outreachCreation.campaignManual.sequenceVersion,
      ).toBe(2);
    });
    it("revises only safe unsent child content, fences old review jobs, and never authorizes a duplicate provider send", async () => {
      await save();
      const old = await origin(100, 11);
      await client.query(
        "INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,message_kind,status,provider_call_state,follow_up_origin_message_id,follow_up_step,metadata,content) VALUES(101,7,10,11,'outbound','follow_up','pending','not_started',100,1,$1,'HR follow-up for Ada')",
        [
          {
            outreachCreation: {
              version: 1,
              delivery: old.delivery,
              followUps: [],
              followUpSource: "campaign_manual",
              campaignManual: old.enrollment,
            },
          },
        ],
      );
      await save(hr, 3, 1);
      const { items } = await scope(() =>
        service.previewPendingManualEnrollments(7, {
          campaign: hr,
          channel: "email",
          expectedVersion: 2,
        }),
      );
      await scope(() =>
        service.applyPendingManualEnrollment(7, {
          originId: 100,
          reviewId: items[0].reviewId,
          previousReviewId: old.enrollment.reviewId,
        }),
      );
      const child = (
        await client.query(
          "SELECT content,metadata,send_intent_id FROM outreach_messages WHERE id=101",
        )
      ).rows[0];
      expect(child.content).toBe("Updated HR follow-up for Ada");
      expect(
        child.metadata.outreachCreation.campaignManual.sequenceVersion,
      ).toBe(2);
      expect(child.send_intent_id).not.toBe(
        "00000000-0000-0000-0000-000000000001",
      );
      // Same SQL review predicate used by the existing worker's atomic claim.
      const stale = await client.query(
        "UPDATE outreach_messages SET status='sending' WHERE id=101 AND status='pending' AND provider_call_state='not_started' AND metadata->'outreachCreation'->'campaignManual'->>'reviewId'=$1 RETURNING id",
        [old.enrollment.reviewId],
      );
      expect(stale.rows).toHaveLength(0);
      const current = await client.query(
        "UPDATE outreach_messages SET status='sending' WHERE id=101 AND status='pending' AND provider_call_state='not_started' AND metadata->'outreachCreation'->'campaignManual'->>'reviewId'=$1 RETURNING id",
        [items[0].reviewId],
      );
      expect(current.rows).toHaveLength(1);
      const duplicate = await client.query(
        "UPDATE outreach_messages SET status='sending' WHERE id=101 AND status='pending' AND provider_call_state='not_started' RETURNING id",
      );
      expect(duplicate.rows).toHaveLength(0);
    });
    it("blocks apply when runtime/assignment readiness fails; leaves old revision intact", async () => {
      await save();
      const old = await origin(100, 11);
      await save(hr, 3, 1);
      const { items } = await scope(() =>
        service.previewPendingManualEnrollments(7, {
          campaign: hr,
          channel: "email",
          expectedVersion: 2,
        }),
      );
      gateReady = false;
      await expect(
        scope(() =>
          service.applyPendingManualEnrollment(7, {
            originId: 100,
            reviewId: items[0].reviewId,
            previousReviewId: old.enrollment.reviewId,
          }),
        ),
      ).rejects.toThrow("ASSISTANT_SETUP_REQUIRED");
      expect(
        (
          await client.query(
            "SELECT metadata FROM outreach_messages WHERE id=100",
          )
        ).rows[0].metadata.outreachCreation.campaignManual.sequenceVersion,
      ).toBe(1);
    });
    it.each(["sending", "manual_review", "sent"])(
      "excludes %s child work from revision apply",
      async (status) => {
        await save();
        await origin(100, 11);
        await client.query(
          "INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,message_kind,status,provider_call_state,follow_up_origin_message_id) VALUES(101,7,10,11,'follow_up',$1,'not_started',100)",
          [status],
        );
        await save(hr, 3, 1);
        expect(
          (
            await scope(() =>
              service.previewPendingManualEnrollments(7, {
                campaign: hr,
                channel: "email",
                expectedVersion: 2,
              }),
            )
          ).items,
        ).toHaveLength(0);
      },
    );
    it("stops pending revision review after a reply, opt-out or manual takeover", async () => {
      await save();
      await origin(100, 11);
      await save(hr, 3, 1);
      for (const mode of ["human_owned", "opted_out", "approval_pending"]) {
        await client.query(
          "UPDATE outreach_conversations SET automation_mode=$1 WHERE id=11",
          [mode],
        );
        expect(
          (
            await scope(() =>
              service.previewPendingManualEnrollments(7, {
                campaign: hr,
                channel: "email",
                expectedVersion: 2,
              }),
            )
          ).items,
        ).toHaveLength(0);
      }
      await client.query(
        "UPDATE outreach_conversations SET automation_mode='ai_active' WHERE id=11;INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,message_kind,status,created_at) VALUES(300,7,10,11,'inbound','reply','received',now())",
      );
      expect(
        (
          await scope(() =>
            service.previewPendingManualEnrollments(7, {
              campaign: hr,
              channel: "email",
              expectedVersion: 2,
            }),
          )
        ).items,
      ).toHaveLength(0);
    });
    it("makes revisions/reviews immutable and refuses destructive rollback after data exists", async () => {
      await save();
      await preview();
      await expect(
        client.query(
          "UPDATE campaign_manual_sequence_revisions SET checksum='replace'",
        ),
      ).rejects.toThrow("immutable");
      await expect(
        client.query("DELETE FROM campaign_manual_reviews"),
      ).rejects.toThrow("immutable");
      await expect(migration.down(client as any)).rejects.toThrow(
        "Retain campaign manual history",
      );
    });
  },
);
