import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Client } from "pg";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { withBusinessScope } from "../tenancy/businessContext.js";

const url = process.env.FOLLOW_UP_IMPLEMENTATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
const jobs = new Map<string, unknown>();
const addJob = jest.fn<any>();
jest.unstable_mockModule("../models/db.js", () => ({
  db: { execute: (q: SQL) => database.execute(q) },
}));
jest.unstable_mockModule("../queues/index.js", () => ({
  queueRegistry: { addJob },
  QUEUE_NAMES: {
    EMAIL_SENDING: "email",
    SMS_SENDING: "sms",
    OUTREACH: "outreach",
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
const loadTemplate = jest.fn<any>();
jest.unstable_mockModule("../services/followUpTemplateService.js", () => ({
  loadFollowUpTemplate: loadTemplate,
  FollowUpTemplateError: class extends Error {},
}));
const {
  configuredFollowUpDispatch,
  reserveSmsFollowUpDispatch,
  recoverConfiguredFollowUpDispatches,
  assertConfiguredFollowUpReady,
} = await import("../services/outreach/ConfiguredFollowUpDispatchService.js");
const { reserveEmailFollowUp, confirmEmailFollowUpDelivery } =
  await import("../services/emailFollowUpService.js");
const { reserveSocialFollowUp } =
  await import("../services/socialFollowUpService.js");
const { up, down } =
  // @ts-expect-error JavaScript migration intentionally has no declarations.
  await import("../migrations/360_configured_follow_up_dispatches.js");
const { followUpSettingsRevision } =
  await import("../utils/followUpSettingsRevision.js");
const scope = <T>(work: () => T) =>
  withBusinessScope({ userId: 1, businessProfileId: 10 }, work);
const config = {
  enabled: true,
  revision: "fixture",
  followUps: [{ enabled: true, delayMinutes: 5 }],
  maxFollowUps: 1,
};
const fence = (
  channel: "sms" | "email" | "whatsapp",
  originMessageId = 41,
) => ({
  version: 1 as const,
  userId: 1,
  businessProfileId: 10,
  originMessageId,
  step: 1,
  originTable:
    channel === "sms"
      ? ("sent_messages" as const)
      : ("outreach_messages" as const),
  channel,
  settingsRevision: followUpSettingsRevision(config),
});
const dispatch = (channel: "sms" | "email" | "whatsapp", id = 41) =>
  scope(async () =>
    configuredFollowUpDispatch(channel, id, 1, {
      userId: 1,
      leadId: 7,
      message: "Synthetic",
      followUpProvenance: fence(channel, id),
    }),
  );
suite(
  "configured follow-up durable dispatch with TEMP PostgreSQL tables and mocked queues",
  () => {
    beforeAll(async () => {
      if (
        !url ||
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ||
        new URL(url).pathname !== "/followup_qa"
      )
        throw new Error("Disposable followup_qa loopback database required");
      client = new Client({ connectionString: url });
      await client.connect();
      await client.query("SET search_path TO pg_temp,pg_catalog");
      database = drizzle(client);
      await client.query(`CREATE TEMP TABLE users(id int,deleted_at timestamp);
   CREATE TEMP TABLE company_settings(id int,user_id int,company_name text,business_name text,name text,billing_organization_id int);
   CREATE TEMP TABLE billing_organizations(id int,name text,owner_user_id int,default_for_user_id int,billing_eligibility_at timestamp);
   CREATE TEMP TABLE business_profile_memberships(id int,business_profile_id int,user_id int,role text,status text);
   CREATE TEMP TABLE billing_organization_memberships(organization_id int,user_id int,status text,role text);
   INSERT INTO users VALUES(1,NULL);
   INSERT INTO company_settings VALUES(10,1,'Synthetic','Synthetic','Synthetic',101);
   INSERT INTO billing_organizations VALUES(101,'Synthetic',1,1,NOW());
   CREATE TEMP TABLE outreach_settings(user_id int,business_profile_id int,enable_auto_follow_up bool,channel_follow_ups jsonb);
   CREATE TEMP TABLE sent_messages(id int,user_id int,business_profile_id int,channel text,is_reply bool,follow_up_step int,follow_up_dispatches jsonb DEFAULT '{}',updated_at timestamp);
   CREATE TEMP TABLE outreach_conversations(id int,user_id int,channel text,automation_mode text,session_ended_at timestamp);
   CREATE TEMP TABLE outreach_messages(id serial PRIMARY KEY,user_id int,business_profile_id int DEFAULT 10,conversation_id int,direction text,subject text,content text,html_content text,status text,campaign_id int,
    is_automatic bool,sequence_step int,message_kind text,follow_up_origin_message_id int,follow_up_step int,follow_up_cancelled_at timestamp,sent_at timestamp,metadata jsonb,created_at timestamp DEFAULT NOW(),updated_at timestamp);
   CREATE UNIQUE INDEX ON outreach_messages(follow_up_origin_message_id,follow_up_step) WHERE message_kind='follow_up' AND follow_up_origin_message_id IS NOT NULL AND follow_up_step IS NOT NULL;
   CREATE TEMP TABLE social_follow_up_schedules(id int,user_id int,conversation_id int,channel text,version int,status text,next_step int,anchor_message_id int,next_run_at timestamp,delivery_message_id int,updated_at timestamp,business_profile_id int DEFAULT 10,cancelled_at timestamp,cancellation_reason text);`);
    });
    beforeEach(async () => {
      jobs.clear();
      addJob
        .mockReset()
        .mockImplementation(
          async (_q: any, _n: any, payload: any, options: any) => {
            jobs.set(options.jobId, payload);
            expect(options.removeOnComplete).toBe(false);
            return options.jobId;
          },
        );
      loadTemplate.mockResolvedValue({ template: { version: 1 } });
      await client.query(
        "TRUNCATE outreach_settings,sent_messages,outreach_messages,outreach_conversations,social_follow_up_schedules RESTART IDENTITY",
      );
      await client.query("INSERT INTO outreach_settings VALUES(1,10,true,$1)", [
        JSON.stringify({ sms: config, email: config, whatsapp: config }),
      ]);
      await client.query(
        `INSERT INTO sent_messages(id,user_id,business_profile_id,channel,is_reply) VALUES(41,1,10,'sms',false),(42,2,20,'sms',false)`,
      );
    });
    afterAll(async () => {
      await client?.end();
    });
    it("retains a rejected enqueue intent and later dispatches the same SMS step once", async () => {
      expect(
        await scope(async () =>
          reserveSmsFollowUpDispatch(41, null, 1, (await dispatch("sms"))),
        ),
      ).toBe(true);
      addJob.mockRejectedValueOnce(new Error("Synthetic queue unavailable"));
      expect(await scope(async () => recoverConfiguredFollowUpDispatches())).toBe(0);
      expect(
        (
          await client.query(
            "SELECT follow_up_step,follow_up_dispatches FROM sent_messages WHERE id=41",
          )
        ).rows[0],
      ).toMatchObject({
        follow_up_step: 1,
        follow_up_dispatches: { "1": { state: "pending" } },
      });
      expect(await scope(async () => recoverConfiguredFollowUpDispatches())).toBe(1);
      expect(jobs.size).toBe(1);
      expect(await scope(async () => recoverConfiguredFollowUpDispatches())).toBe(0);
    });
    it("deduplicates a lost queue acknowledgement and resumes persisted work after a scheduler restart", async () => {
      await scope(async () =>
        reserveSmsFollowUpDispatch(41, null, 1, (await dispatch("sms"))),
      );
      addJob.mockImplementationOnce(
        async (_q: any, _n: any, p: any, o: any) => {
          jobs.set(o.jobId, p);
          throw new Error("Synthetic acknowledgement lost");
        },
      );
      await scope(async () => recoverConfiguredFollowUpDispatches());
      await scope(async () => recoverConfiguredFollowUpDispatches());
      expect(jobs.size).toBe(1);
    });
    it("does not reserve another business or consume a counter twice", async () => {
      expect(
        await scope(async () =>
          reserveSmsFollowUpDispatch(42, null, 1, (await dispatch("sms", 42))),
        ),
      ).toBe(false);
      expect(
        await scope(async () =>
          reserveSmsFollowUpDispatch(41, null, 1, (await dispatch("sms"))),
        ),
      ).toBe(true);
      expect(
        await scope(async () =>
          reserveSmsFollowUpDispatch(41, null, 1, (await dispatch("sms"))),
        ),
      ).toBe(false);
    });
    it("cancels a disabled pending dispatch without calling the queue", async () => {
      await scope(async () =>
        reserveSmsFollowUpDispatch(41, null, 1, (await dispatch("sms"))),
      );
      await client.query(
        "UPDATE outreach_settings SET enable_auto_follow_up=false",
      );
      await scope(async () => recoverConfiguredFollowUpDispatches());
      expect(addJob).not.toHaveBeenCalled();
      expect(
        (
          await client.query(
            "SELECT follow_up_dispatches->'1'->>'state' AS state FROM sent_messages WHERE id=41",
          )
        ).rows[0].state,
      ).toBe("cancelled");
    });
    it("rejects changed settings and selected template versions during final preflight", async () => {
      await expect(
        scope(async () =>
          assertConfiguredFollowUpReady(1, "sms", {
            ...fence("sms"),
            settingsRevision: "stale",
          }),
        ),
      ).rejects.toThrow("settings changed");
      const templatedConfig = {
        ...config,
        followUps: [{ enabled: true, delayMinutes: 5, templateId: 77 }],
      };
      await client.query(
        "UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{sms}',$1::jsonb)",
        [JSON.stringify(templatedConfig)],
      );
      await expect(
        scope(async () =>
          assertConfiguredFollowUpReady(1, "sms", {
            ...fence("sms"),
            settingsRevision: followUpSettingsRevision(templatedConfig),
            templateId: 77,
            templateVersion: 2,
          }),
        ),
      ).rejects.toThrow("template changed");
    });
    it("commits Email reservation and dispatch together, then recovers without new origin eligibility", async () => {
      await client.query(
        "INSERT INTO outreach_conversations VALUES(2,1,'email','ai_active',NULL);INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,sent_at) VALUES(41,1,2,'outbound','outreach','sent',NOW()-interval '1 hour')",
      );
      const id = await scope(async () =>
        reserveEmailFollowUp({
          originMessageId: 41,
          userId: 1,
          expectedCurrentStep: 0,
          step: 1,
          subject: "Hi",
          content: "Synthetic",
          htmlContent: "",
          dispatch: (await dispatch("email")),
        }),
      );
      expect(id).toBeTruthy();
      expect(
        (
          await client.query(
            "SELECT follow_up_step FROM outreach_messages WHERE id=41",
          )
        ).rows[0].follow_up_step,
      ).toBe(1);
      await scope(async () => recoverConfiguredFollowUpDispatches());
      expect(jobs.size).toBe(1);
      expect([...jobs.values()][0]).toMatchObject({ followUpMessageId: id });
    });
    it("final Email confirmation rejects a reply or takeover committed after the first claim", async () => {
      await client.query(
        "INSERT INTO outreach_conversations VALUES(2,1,'email','ai_active',NULL);INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,sent_at) VALUES(41,1,2,'outbound','outreach','sent',NOW()-interval '1 hour');INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,follow_up_origin_message_id) VALUES(51,1,2,'outbound','follow_up','sending',41)",
      );
      expect(await scope(async () => confirmEmailFollowUpDelivery(51, 1))).toBe(true);
      await client.query(
        "UPDATE outreach_conversations SET automation_mode='human_owned'",
      );
      expect(await scope(async () => confirmEmailFollowUpDelivery(51, 1))).toBe(
        false,
      );
      await client.query(
        "UPDATE outreach_conversations SET automation_mode='ai_active';INSERT INTO outreach_messages(user_id,conversation_id,direction,message_kind,status) VALUES(1,2,'inbound','reply','received')",
      );
      expect(await scope(async () => confirmEmailFollowUpDelivery(51, 1))).toBe(
        false,
      );
    });
    it("persists the social dispatch atomically with schedule reservation and recovers it", async () => {
      await client.query(
        "INSERT INTO outreach_conversations VALUES(2,1,'whatsapp','ai_active',NULL);INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,sent_at) VALUES(41,1,2,'outbound','outreach','sent',NOW()-interval '1 hour');INSERT INTO social_follow_up_schedules(id,user_id,conversation_id,channel,version,status,next_step,anchor_message_id,next_run_at,delivery_message_id,updated_at) VALUES(3,1,2,'whatsapp',1,'active',1,41,NOW()-interval '5 minutes',NULL,NULL)",
      );
      const id = await scope(async () =>
        reserveSocialFollowUp({
          scheduleId: 3,
          scheduleVersion: 1,
          anchorMessageId: 41,
          userId: 1,
          step: 1,
          content: "Synthetic",
          dispatch: (await dispatch("whatsapp")),
        }),
      );
      expect(id).toBeTruthy();
      expect(
        (await client.query("SELECT status FROM social_follow_up_schedules"))
          .rows[0].status,
      ).toBe("queued");
      await scope(async () => recoverConfiguredFollowUpDispatches());
      expect([...jobs.values()][0]).toMatchObject({
        socialFollowUpMessageId: id,
      });
    });
    it("applies the additive migration twice and refuses rollback while SMS dispatch remains pending", async () => {
      await up(client);
      await up(client);
      await scope(async () =>
        reserveSmsFollowUpDispatch(41, null, 1, (await dispatch("sms"))),
      );
      await expect(down(client)).rejects.toThrow("Reconcile pending");
      await client.query("UPDATE sent_messages SET follow_up_dispatches='{}'");
      await down(client);
      await up(client);
    });
    it("refuses rollback while an authority review intent is retained", async () => {
      await scope(async () => reserveSmsFollowUpDispatch(41, null, 1, await dispatch("sms")));
      await client.query("UPDATE sent_messages SET follow_up_dispatches=jsonb_set(follow_up_dispatches,'{1,state}','\"review_required\"')");
      try { await expect(down(client)).rejects.toThrow("Reconcile pending"); }
      finally { await up(client); }
    });
    it("cancels the matching social schedule together with its undispatched message", async () => {
      await client.query(
        "INSERT INTO outreach_conversations VALUES(2,1,'whatsapp','ai_active',NULL);INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,sent_at) VALUES(41,1,2,'outbound','outreach','sent',NOW()-interval '1 hour');INSERT INTO social_follow_up_schedules(id,user_id,conversation_id,channel,version,status,next_step,anchor_message_id,next_run_at) VALUES(3,1,2,'whatsapp',1,'active',1,41,NOW()-interval '5 minutes')",
      );
      const intent = (await dispatch("whatsapp"));
      intent.payload.socialFollowUpScheduleId = 3;
      const id = await scope(async () =>
        reserveSocialFollowUp({
          scheduleId: 3,
          scheduleVersion: 1,
          anchorMessageId: 41,
          userId: 1,
          step: 1,
          content: "Synthetic",
          dispatch: intent,
        }),
      );
      await client.query(
        "UPDATE outreach_settings SET enable_auto_follow_up=false",
      );
      await scope(async () => recoverConfiguredFollowUpDispatches());
      expect(addJob).not.toHaveBeenCalled();
      expect(
        (
          await client.query(
            "SELECT status,cancellation_reason FROM social_follow_up_schedules",
          )
        ).rows[0],
      ).toMatchObject({
        status: "cancelled",
        cancellation_reason: "configuration_changed",
      });
      expect(
        (
          await client.query(
            "SELECT status FROM outreach_messages WHERE id=$1",
            [id],
          )
        ).rows[0].status,
      ).toBe("cancelled");
    });
    (process.env.FOLLOW_UP_IMPLEMENTATION_REDIS_URL ? it : it.skip)(
      "retains a completed real BullMQ job across a lost enqueue acknowledgement",
      async () => {
        const url = new URL(process.env.FOLLOW_UP_IMPLEMENTATION_REDIS_URL!);
        if (
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
          url.username ||
          url.password
        )
          throw new Error(
            "Disposable loopback Redis without saved credentials required",
          );
        const connection = {
          host: url.hostname,
          port: Number(url.port),
          maxRetriesPerRequest: null,
        };
        const prefix = `followup-qa-${randomUUID()}`;
        const queue = new Queue("synthetic-followup", { connection, prefix });
        let executions = 0;
        const worker = new Worker(
          "synthetic-followup",
          async () => {
            executions++;
            return "synthetic accepted";
          },
          { connection, prefix, concurrency: 1 },
        );
        const completed = new Promise<void>((resolve, reject) => {
          worker.once("completed", () => resolve());
          worker.once("error", reject);
        });
        try {
          await worker.waitUntilReady();
          await scope(async () =>
            reserveSmsFollowUpDispatch(41, null, 1, (await dispatch("sms"))),
          );
          let loseAcknowledgement = true;
          addJob.mockImplementation(
            async (
              _queue: unknown,
              name: string,
              payload: Record<string, unknown>,
              options: Record<string, unknown>,
            ) => {
              const job = await queue.add(name, payload, options);
              if (loseAcknowledgement) {
                loseAcknowledgement = false;
                throw new Error(
                  "Synthetic lost acknowledgement after Redis accepted",
                );
              }
              return job.id;
            },
          );
          expect(await scope(async () => recoverConfiguredFollowUpDispatches())).toBe(
            0,
          );
          await completed;
          expect(await scope(async () => recoverConfiguredFollowUpDispatches())).toBe(
            1,
          );
          const job = await queue.getJob((await dispatch("sms")).jobId);
          expect(await job?.getState()).toBe("completed");
          expect(executions).toBe(1);
        } finally {
          await worker.close();
          await queue.close();
        }
      },
      15000,
    );
    it("requires review for legacy missing provenance and rejects changed durable origin IDs", async () => {
      await expect(
        scope(async () => assertConfiguredFollowUpReady(1, "sms")),
      ).rejects.toThrow("metadata is unavailable");
      await expect(
        scope(async () =>
          assertConfiguredFollowUpReady(1, "sms", fence("sms"), {
            originMessageId: 999,
            step: 1,
          }),
        ),
      ).rejects.toThrow("durable origin");
    });
    it("cannot omit the selected template from an otherwise current provenance record", async () => {
      const templatedConfig = {
        ...config,
        followUps: [{ enabled: true, delayMinutes: 5, templateId: 77 }],
      };
      await client.query(
        "UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{sms}',$1::jsonb)",
        [JSON.stringify(templatedConfig)],
      );
      await expect(
        scope(async () =>
          assertConfiguredFollowUpReady(1, "sms", {
            ...fence("sms"),
            settingsRevision: followUpSettingsRevision(templatedConfig),
          }),
        ),
      ).rejects.toThrow("provenance is missing");
    });
  },
);
