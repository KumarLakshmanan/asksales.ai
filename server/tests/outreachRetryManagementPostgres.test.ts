import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Client, types as pgTypes } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { withBusinessScope } from "../tenancy/businessContext.js";
import { installReportingFixture } from "./helpers/outreachReportingFixture.js";
let client: Client, database: NodePgDatabase;
const run =
  process.env.OUTREACH_QUEUE_LOCAL_QA === "1" ? describe : describe.skip;
const origin = {
  userId: 991,
  businessProfileId: 1,
  businessActorUserId: 991,
  billingActorUserId: 991,
  billingOrganizationId: 8,
};
const scope = <T>(work: () => T) =>
  withBusinessScope(
    { userId: 991, businessProfileId: 1, actorUserId: 991 },
    work,
  );
const dispatch = jest.fn<(...args: any[]) => Promise<any>>(),
  addJob = jest.fn<(...args: any[]) => Promise<any>>(),
  getJob = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        const value = Reflect.get(database, key);
        return typeof value === "function" ? value.bind(database) : value;
      },
    },
  ),
}));
jest.unstable_mockModule("../tenancy/jobBusinessScope.js", () => ({
  captureJobBusiness: async (input: any) => ({ ...origin, ...input }),
  runBusinessJob: async (saved: any, work: any) => {
    expect(saved).toMatchObject({
      userId: 991,
      businessProfileId: 1,
      billingOrganizationId: 8,
    });
    if (saved.businessActorUserId !== 991)
      throw Object.assign(new Error("Original actor no longer authorized"), {
        code: "ORGANIZATION_FORBIDDEN",
      });
    return scope(() => work(saved));
  },
}));
jest.unstable_mockModule("../queues/index.js", () => ({
  QUEUE_NAMES: { GENERAL: "general", OUTREACH: "outreach" },
  queueRegistry: {
    initialize: async () => {},
    addJob,
    getQueue: () => ({ getJob }),
  },
}));
jest.unstable_mockModule("../queues/JobDispatcher.js", () => ({
  jobDispatcher: { dispatch },
}));
const retries = await import("../services/outreach/OutreachRetryService.js");
const operations =
  await import("../services/operations/DashboardOperations.js");
const preview = () => scope(() => retries.previewOutreachRetries(991, {}));
const processRetry = async (id: string) => {
  const row = await scope(() => operations.ownedDashboardOperation(id));
  return scope(() =>
    operations.processDashboardOperation({ ...row.origin, operationId: id }),
  );
};
run(
  "reviewed retry recovery with real PostgreSQL and synthetic intents",
  () => {
    beforeAll(async () => {
      const url = process.env.OUTREACH_QA_DATABASE_URL;
      if (
        !url ||
        !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
        new URL(url).pathname != "/implementation_synthetic"
      )
        throw new Error("Explicit isolated loopback fixture required");
      pgTypes.setTypeParser(1114, (value) => new Date(`${value}Z`));
      client = new Client({ connectionString: url });
      await client.connect();
      await client.query("SET TIME ZONE 'UTC'");
      await client.query("SET search_path TO pg_temp,pg_catalog");
      database = drizzle(client);
      await installReportingFixture(client);
      await client.query(`ALTER TABLE dashboard_operations ADD PRIMARY KEY(id),ADD COLUMN status text,ADD COLUMN request_key text,ADD COLUMN fingerprint text,
      ADD COLUMN origin jsonb,ADD COLUMN processed int DEFAULT 0,ADD COLUMN total int DEFAULT 0,ADD COLUMN cursor int DEFAULT 0,ADD COLUMN generation int DEFAULT 0,
      ADD COLUMN lease_token uuid,ADD COLUMN lease_until timestamptz,ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN expires_at timestamptz DEFAULT now()+interval '30 days',
      ADD COLUMN parent_id uuid,ADD COLUMN error text;
      ALTER TABLE outreach_messages ADD COLUMN send_intent_id uuid DEFAULT gen_random_uuid(),ADD COLUMN provider_call_state text DEFAULT 'not_started',
      ADD COLUMN confirmed_at timestamp DEFAULT now(),ADD COLUMN confirmation_expires_at timestamp DEFAULT now()+interval '30 days',ADD COLUMN send_claimed_at timestamp;
      CREATE TEMP TABLE instagram_webhook_events(user_id int,business_profile_id int DEFAULT 1,page_id text,event_type text,message_id text,raw_data jsonb);`);
    });
    afterAll(async () => {
      await client?.end();
    });
    beforeEach(async () => {
      jest.clearAllMocks();
      getJob.mockResolvedValue(undefined);
      dispatch.mockResolvedValue({});
      addJob.mockResolvedValue("queued");
      await client.query(`TRUNCATE outreach_messages,outreach_conversations,dashboard_operations,instagram_webhook_events;
      INSERT INTO outreach_conversations(id,user_id,channel,provider_account_id,lead_id) VALUES(1,991,'whatsapp','wa',7),(2,991,'email','mail',8),(3,991,'instagram','ig',9),(4,991,'facebook','fb',10);
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,provider_account_id)
        SELECT id,991,CASE WHEN id=7 THEN 2 WHEN id=8 THEN 3 WHEN id=9 THEN 4 ELSE 1 END,'outbound','outreach','pending',
          CASE WHEN id=7 THEN 'mail' WHEN id=8 THEN 'ig' WHEN id=9 THEN 'fb' ELSE 'wa' END FROM generate_series(1,10) id;
      UPDATE outreach_messages SET metadata=jsonb_build_object('outreachQueuePolicy',jsonb_build_object('version',1),'outreachQueueOrigin',jsonb_build_object('userId',991,'businessProfileId',1,'businessActorUserId',991,'billingActorUserId',991,'billingOrganizationId',8),
        'outreachCreation',jsonb_build_object('version',1,'whatsappOptInConfirmed',true,'delivery',jsonb_build_object('userId',991,'conversationId',conversation_id,
          'leadId',7,'channel',CASE WHEN id=7 THEN 'email' WHEN id=8 THEN 'instagram' WHEN id=9 THEN 'facebook' ELSE 'whatsapp' END,'templateName','approved_test','message','Synthetic QA')));
      UPDATE outreach_messages SET metadata=metadata||jsonb_build_object('outreachQueue',jsonb_build_object('reason','provider_limit','nextAttemptAt',to_char(now()+interval '2 hours','YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE id=2;
      UPDATE outreach_messages SET status='sent',provider_call_state='confirmed',provider_message_id='accepted',sent_at=now() WHERE id=3;
      UPDATE outreach_messages SET status='manual_review',provider_call_state='unknown',manual_review_required=true WHERE id=4;
      UPDATE outreach_messages SET confirmation_expires_at=now()-interval '1 minute' WHERE id=5;
      UPDATE outreach_messages SET status='failed',error_message='Invalid recipient' WHERE id=6;
      UPDATE outreach_messages SET status='failed',provider_call_state='confirmed',provider_message_id='marketing-rejected',error_message='131049' WHERE id=10;
      INSERT INTO instagram_webhook_events(user_id,page_id,event_type,message_id,raw_data) VALUES(991,'wa','whatsapp_failed','marketing-rejected','{"status":{"errors":[{"code":131049}]}}');`);
    });
    it("separates due intents, future cooldowns, accepted, uncertain, expired and invalid failures across channels", async () => {
      const result = await preview();
      expect(result.counts).toMatchObject({
        selected: 10,
        eligible: 5,
        waiting: 1,
        excluded: 4,
        registered: 0,
      });
      expect(
        result.items
          .filter((item) => item.eligible)
          .map((item) => item.id)
          .sort(),
      ).toEqual([
        "message-1",
        "message-10",
        "message-7",
        "message-8",
        "message-9",
      ]);
      expect(
        Date.parse(
          result.items.find((item) => item.id === "message-10")!.nextAttemptAt!,
        ) - Date.now(),
      ).toBeGreaterThan(14390000);
      expect(dispatch).not.toHaveBeenCalled();
      expect(addJob).not.toHaveBeenCalled();
    });
    it("checks changed state again, reuses existing IDs and authority, and confirms a preview only once", async () => {
      const result = await preview();
      await client.query(
        `UPDATE outreach_messages SET status='sent',provider_call_state='confirmed',provider_message_id='late-receipt',sent_at=now() WHERE id=7`,
      );
      await scope(() =>
        retries.applyOutreachRetryPreview(result.id, result.fingerprint),
      );
      await scope(() =>
        retries.applyOutreachRetryPreview(result.id, result.fingerprint),
      );
      expect(addJob).toHaveBeenCalledTimes(1);
      await processRetry(result.id);
      await processRetry(result.id);
      const saved = await scope(() => retries.getRetryPreview(result.id));
      expect(saved.status).toBe("completed");
      expect(saved.counts).toMatchObject({ registered: 4, changed: 1 });
      expect(dispatch).toHaveBeenCalledTimes(4);
      for (const call of dispatch.mock.calls) {
        expect(call[0]).toBe("send_outreach_message");
        expect(call[1]).toMatchObject(origin);
        expect([1, 8, 9, 10]).toContain(call[1].messageId);
      }
      const rows = await client.query(
        "SELECT count(*)::int AS count FROM outreach_messages",
      );
      expect(rows.rows[0].count).toBe(10);
      const marketing = (
        await client.query(
          "SELECT metadata,provider_message_id FROM outreach_messages WHERE id=10",
        )
      ).rows[0];
      expect(marketing.provider_message_id).toBeNull();
      expect(marketing.metadata.outreachQueue.lastFailureReceipt).toBe(
        "marketing-rejected",
      );
    });
    it("retains the durable outbox through Redis failure and recovers without another intent", async () => {
      dispatch.mockRejectedValue(new Error("Synthetic Redis outage"));
      const result = await preview();
      await scope(() =>
        retries.applyOutreachRetryPreview(result.id, result.fingerprint),
      );
      await processRetry(result.id);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM outreach_messages WHERE metadata->'dashboardRetry'->>'enqueueNeeded'='true'`,
          )
        ).rows[0].count,
      ).toBe(5);
      dispatch.mockClear();
      dispatch.mockResolvedValue({});
      await scope(() => retries.reconcileDashboardRetries());
      await scope(() => retries.reconcileDashboardRetries());
      expect(dispatch).toHaveBeenCalledTimes(5);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM outreach_messages WHERE metadata->'dashboardRetry'->>'enqueueNeeded'='true'`,
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it("keeps a live queue job and refuses removed original authority", async () => {
      await client.query(`UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachQueueOrigin,businessActorUserId}','993'::jsonb) WHERE id=8;
      UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachQueueOrigin,billingActorUserId}','993'::jsonb) WHERE id=8`);
      getJob.mockResolvedValue({
        data: { messageId: 1, ...origin },
        getState: async () => "active",
      });
      const result = await preview();
      await scope(() =>
        retries.applyOutreachRetryPreview(result.id, result.fingerprint),
      );
      await processRetry(result.id);
      expect(
        (await client.query("SELECT status FROM outreach_messages WHERE id=8"))
          .rows[0].status,
      ).toBe("setup_required");
      expect(
        dispatch.mock.calls.some(
          (call) => call[1].messageId === 1 || call[1].messageId === 8,
        ),
      ).toBe(false);
    });
    it("rejects changed confirmations, expired previews and another business", async () => {
      const result = await preview();
      await expect(
        scope(() =>
          retries.applyOutreachRetryPreview(result.id, "0".repeat(64)),
        ),
      ).rejects.toThrow("Refresh and confirm");
      await expect(
        withBusinessScope({ userId: 991, businessProfileId: 2 }, () =>
          retries.getRetryPreview(result.id),
        ),
      ).rejects.toThrow("not found");
      await client.query(
        `UPDATE dashboard_operations SET result=jsonb_set(result,'{reviewExpiresAt}',to_jsonb((now()-interval '1 minute')::text)) WHERE id=$1`,
        [result.id],
      );
      await expect(
        scope(() =>
          retries.applyOutreachRetryPreview(result.id, result.fingerprint),
        ),
      ).rejects.toThrow("expired");
      expect(addJob).not.toHaveBeenCalled();
    });
    it('keeps the later original schedule and preserves a local email RFC identity',async()=>{
      await client.query(`UPDATE outreach_messages SET metadata=metadata||jsonb_build_object('scheduledAt',to_char(now()+interval '6 hours','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'outreachQueue',jsonb_build_object('nextAttemptAt',to_char(now()-interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE id=1;
        UPDATE outreach_messages SET rfc_message_id='<synthetic-local@example.test>' WHERE id=7;`);
      const result=await preview();expect(result.items.find(item=>item.id==='message-1')).toMatchObject({eligible:false,reason:'Waiting for the saved schedule or provider cooldown'});
      expect(result.items.find(item=>item.id==='message-7')?.eligible).toBe(true);
      await scope(()=>retries.applyOutreachRetryPreview(result.id,result.fingerprint));await processRetry(result.id);
      expect((await client.query('SELECT rfc_message_id FROM outreach_messages WHERE id=7')).rows[0].rfc_message_id).toBe('<synthetic-local@example.test>');
    });
    it('resumes only a previously confirmed recovery and retains its original send intents',async()=>{
      const result=await preview();await expect(scope(()=>retries.resumeOutreachRetryPreview(result.id))).rejects.toThrow('Confirm a fresh retry preview');
      await scope(()=>retries.applyOutreachRetryPreview(result.id,result.fingerprint));
      await client.query(`UPDATE dashboard_operations SET status='review',error='Synthetic interrupted worker' WHERE id=$1`,[result.id]);
      expect((await scope(()=>retries.resumeOutreachRetryPreview(result.id))).status).toBe('queued');await processRetry(result.id);await processRetry(result.id);
      expect(dispatch).toHaveBeenCalledTimes(5);expect((await scope(()=>retries.getRetryPreview(result.id))).counts.registered).toBe(5);
      await client.query(`UPDATE dashboard_operations SET expires_at=now()-interval '1 minute' WHERE id=$1`,[result.id]);
      await expect(scope(()=>retries.getRetryPreview(result.id))).rejects.toThrow('expired');
    });
  },
);
