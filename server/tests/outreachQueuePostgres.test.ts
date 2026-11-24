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
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { withBusinessScope } from "../tenancy/businessContext.js";
import { installReportingFixture } from './helpers/outreachReportingFixture.js';
let client: Client, database: NodePgDatabase;
const run =
  process.env.OUTREACH_QUEUE_LOCAL_QA === "1" ? describe : describe.skip;
const dispatch = jest
  .fn<(...args: any[]) => Promise<any>>()
  .mockResolvedValue({});
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
jest.unstable_mockModule("../queues/JobDispatcher.js", () => ({
  jobDispatcher: { dispatch },
}));
jest.unstable_mockModule("../tenancy/jobBusinessScope.js", () => ({
  runBusinessJob: (origin: any, work: any) => {
    expect(origin).toMatchObject({
      userId: 991,
      businessProfileId: 1,
      businessActorUserId: 991,
      billingOrganizationId: 8,
      billingActorUserId: 991,
    });
    return work(origin);
  },
}));
const { planWhatsAppProviderRetry, reconcileWhatsAppProviderRetries, planWhatsAppAppRateLimitRecovery, planWhatsAppMarketingRetryRecovery, LEGACY_WHATSAPP_APP_LIMIT_ERROR } =
  await import("../services/outreach/WhatsAppProviderRetry.js");
const { getOutreachQueueOverview } =
  await import("../services/outreach/QueueOverview.js");
run("outreach queue durable PostgreSQL states", () => {
  beforeAll(async () => {
    const url = process.env.OUTREACH_QA_DATABASE_URL;
    if (
      !url ||
      !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
      new URL(url).pathname != "/implementation_synthetic"
    )
      throw new Error("Explicit isolated loopback fixture required");
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query("SET search_path TO pg_temp,pg_catalog");
    database = drizzle(client);
    await client.query(`CREATE TEMP TABLE outreach_conversations(id int,user_id int,channel text,provider_account_id text,business_profile_id int DEFAULT 1);
      CREATE TEMP TABLE outreach_messages(business_profile_id int DEFAULT 1,id int,user_id int,conversation_id int,direction text,message_kind text,status text,metadata jsonb,confirmation_expires_at timestamp,
        external_message_id text,provider_message_id text,waba_message_id text,rfc_message_id text,send_intent_id text,provider_call_state text,manual_review_required bool,
        send_claimed_at timestamp,error_message text,updated_at timestamp DEFAULT NOW(),created_at timestamp DEFAULT NOW(),sent_at timestamp,delivered_at timestamp,read_at timestamp,provider_account_id text DEFAULT 'account-1');
      CREATE TEMP TABLE instagram_webhook_events(user_id int,page_id text,event_type text,message_id text,raw_data jsonb);
      CREATE TEMP TABLE outreach_jobs(business_profile_id int DEFAULT 1,id int,user_id int,channel text,status text,sent_at timestamp,created_at timestamp DEFAULT NOW(),metadata jsonb,attempts int,scheduled_for timestamp,error text,external_message_id text);
      INSERT INTO outreach_conversations VALUES(1,991,'whatsapp','account-1'),(2,991,'email','email-1'),(3,992,'whatsapp','other-account');`);
    await installReportingFixture(client);
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    await client.query("TRUNCATE outreach_messages,outreach_jobs,instagram_webhook_events");
    const metadata = {
      outreachQueuePolicy: { version: 1 },
      outreachQueueOrigin: {
        userId: 991,
        businessProfileId: 1,
        businessActorUserId: 991,
        billingOrganizationId: 8,
        billingActorUserId: 991,
      },
      outreachCreation: {
        version: 1,
        whatsappOptInConfirmed: true,
        delivery: {
          userId: 991,
          conversationId: 1,
          leadId: 7,
          channel: "whatsapp",
          phone: "+919999999999",
          message: "Approved offer",
          templateName: "approved_test",
        },
      },
    };
    await client.query(
      `INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,metadata,confirmation_expires_at,external_message_id,send_intent_id,provider_call_state,manual_review_required) VALUES(1,991,1,'outbound','outreach','failed',$1,NOW()+INTERVAL '30 days','receipt-1','intent-1','confirmed',false)`,
      [JSON.stringify(metadata)],
    );
  });
  const plan = (code = 131049) =>
    withBusinessScope({ userId: 991, businessProfileId: 1 }, () =>
      planWhatsAppProviderRetry(
        database as any,
        991,
        "receipt-1",
        "account-1",
        code,
      ),
    );
  const appRecovery = () => withBusinessScope({userId:991,businessProfileId:1},()=>planWhatsAppAppRateLimitRecovery(database as any,991,[1]));
  const prepareAppFailure = async () => client.query(`UPDATE outreach_messages SET provider_call_state='not_started',external_message_id=NULL,error_message=$1 WHERE id=1`,[LEGACY_WHATSAPP_APP_LIMIT_ERROR]);
  it('recovers an unstarted app-limited message once with its original intent and a deterministic retry job',async()=>{
    await prepareAppFailure();
    expect(await appRecovery()).toEqual([{id:1,send_intent_id:'intent-1'}]);
    expect(await appRecovery()).toEqual([]);
    dispatch.mockRejectedValueOnce(new Error('Lost Redis acknowledgement'));
    const reconcile=()=>withBusinessScope({userId:991,businessProfileId:1},()=>reconcileWhatsAppProviderRetries());
    await expect(reconcile()).rejects.toThrow('Lost Redis');await reconcile();await reconcile();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][2].jobId).toBe('outreach-app-rate-recovery-intent-1');
    expect(dispatch.mock.calls[1][2].jobId).toBe(dispatch.mock.calls[0][2].jobId);
    expect(dispatch.mock.calls[1][1]).toMatchObject({messageId:1,providerRateLimitRetries:0,businessActorUserId:991});
    const row=(await client.query('SELECT * FROM outreach_messages WHERE id=1')).rows[0];
    expect(row).toMatchObject({status:'pending',send_intent_id:'intent-1',provider_call_state:'not_started'});
    expect(row.metadata.outreachQueue).toMatchObject({reason:'app_rate_limit',appRateLimitRecovery:true,retryCount:0});
    expect(row.metadata.outreachQueue.enqueueNeeded).toBeUndefined();
    expect(await appRecovery()).toEqual([]);
  });
  it.each([
    "status='delivered'", "provider_call_state='unknown'", "provider_call_state='started'", "manual_review_required=true",
    "external_message_id='receipt'", "provider_message_id='receipt'", "waba_message_id='receipt'", "rfc_message_id='receipt'",
    "sent_at=NOW()", "delivered_at=NOW()", "business_profile_id=2", "user_id=992", "confirmation_expires_at=NOW()",
    "error_message='Meta rejected recipient'", "metadata=metadata-'outreachQueueOrigin'",
  ])('refuses unsafe app-limit recovery: %s',async change=>{
    await prepareAppFailure();await client.query(`UPDATE outreach_messages SET ${change} WHERE id=1`);
    expect(await appRecovery()).toEqual([]);expect(dispatch).not.toHaveBeenCalled();
  });
  it("persists one four-hour retry for repeated failure webhooks", async () => {
    const now = Date.now();
    await plan();
    await plan();
    const row = (
      await client.query("SELECT metadata FROM outreach_messages WHERE id=1")
    ).rows[0];
    expect(row.metadata.outreachQueue).toMatchObject({
      retryCount: 1,
      enqueueNeeded: true,
      lastFailureReceipt: "receipt-1",
      providerCode: 131049,
    });
    expect(
      Date.parse(row.metadata.outreachQueue.nextAttemptAt),
    ).toBeGreaterThanOrEqual(now + 14_400_000);
    const result = await withBusinessScope(
      { userId: 991, businessProfileId: 1 },
      () => getOutreachQueueOverview(991),
    );
    expect(result.channels[0]).toMatchObject({
      queued: 1,
      retrying: 1,
      failed: 0,
      accepted: 0,
    });
  });
  it.each([131026, 131047, 131048, 131050, 190])(
    "does not retry permanent or policy failure %s",
    async (code) => {
      await plan(code);
      expect(
        (await client.query("SELECT metadata FROM outreach_messages")).rows[0]
          .metadata.outreachQueue,
      ).toBeUndefined();
    },
  );
  it.each(["legacy", "consent", "expiry", "delivered", "account", "uncertain", "delivered timestamp", "read timestamp"])(
    "does not enroll ineligible %s work",
    async (reason) => {
      if (reason === "legacy")
        await client.query(
          `UPDATE outreach_messages SET metadata=metadata-'outreachQueuePolicy'`,
        );
      if (reason === "consent")
        await client.query(
          `UPDATE outreach_messages SET metadata=jsonb_set(metadata,'{outreachCreation,whatsappOptInConfirmed}','false')`,
        );
      if (reason === "expiry")
        await client.query(
          `UPDATE outreach_messages SET confirmation_expires_at=NOW()+INTERVAL '1 hour'`,
        );
      if (reason === "uncertain")
        await client.query(`UPDATE outreach_messages SET manual_review_required=true`);
      if (reason === "delivered timestamp")
        await client.query(`UPDATE outreach_messages SET delivered_at=NOW()`);
      if (reason === "read timestamp")
        await client.query(`UPDATE outreach_messages SET read_at=NOW()`);
      if (reason === "delivered")
        await client.query(`UPDATE outreach_messages SET status='delivered'`);
      if (reason === "account")
        await client.query(
          `UPDATE outreach_conversations SET provider_account_id='other' WHERE id=1`,
        );
      try {
        await plan();
        expect(
          (await client.query("SELECT metadata FROM outreach_messages")).rows[0]
            .metadata.outreachQueue?.enqueueNeeded,
        ).not.toBe(true);
      } finally {
        await client.query(
          `UPDATE outreach_conversations SET provider_account_id='account-1' WHERE id=1`,
        );
      }
    },
  );
  it("recurs past the old cap and preserves a single intent/job after a lost acknowledgement", async () => {
    await client.query(`UPDATE outreach_messages SET metadata=metadata||'{"outreachQueue":{"retryCount":40}}'`);
    await plan(); await plan();
    const reconcile=()=>withBusinessScope({userId:991,businessProfileId:1},()=>reconcileWhatsAppProviderRetries());
    dispatch.mockRejectedValueOnce(new Error('Lost Redis acknowledgement'));
    await expect(reconcile()).rejects.toThrow('Lost Redis');
    await reconcile(); await reconcile();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][2].jobId).toBe('outreach-provider-retry-intent-1-41');
    expect(dispatch.mock.calls[1][2].jobId).toBe(dispatch.mock.calls[0][2].jobId);
    expect(dispatch.mock.calls[1][1]).toMatchObject({messageId:1,providerRateLimitRetries:41});
    expect((await client.query('SELECT send_intent_id FROM outreach_messages')).rows).toEqual([{send_intent_id:'intent-1'}]);
  });
  const marketingRecovery = () => withBusinessScope({userId:991,businessProfileId:1},
    ()=>planWhatsAppMarketingRetryRecovery(database as any,991,[1]));
  const recordMarketingFailure = () => client.query(`INSERT INTO instagram_webhook_events
    VALUES(991,'account-1','whatsapp_failed','receipt-1','{"status":{"errors":[{"code":131049}]}}')`);
  it("requeues an exhausted marketing failure only once using its matching Meta receipt", async () => {
    await client.query(`UPDATE outreach_messages SET metadata=metadata||'{"outreachQueue":{"retryCount":4,"lastFailureReceipt":"older"}}'`);
    await recordMarketingFailure();
    expect(await marketingRecovery()).toEqual([{id:1,send_intent_id:'intent-1'}]);
    expect(await marketingRecovery()).toEqual([]);
    const row=(await client.query('SELECT metadata FROM outreach_messages')).rows[0];
    expect(row.metadata.outreachQueue).toMatchObject({retryCount:5,lastFailureReceipt:'receipt-1',enqueueNeeded:true});
  });
  it.each(["status='sent'","status='delivered'","provider_call_state='unknown'","provider_call_state='started'",
    "manual_review_required=true","delivered_at=NOW()","read_at=NOW()","provider_message_id='different'",
    "provider_account_id='other'","business_profile_id=2","confirmation_expires_at=NOW()"])(
    "does not recover an accepted, uncertain, expired or mismatched marketing failure: %s",async change=>{
      await recordMarketingFailure(); await client.query(`UPDATE outreach_messages SET ${change} WHERE id=1`);
      expect(await marketingRecovery()).toEqual([]); expect(dispatch).not.toHaveBeenCalled();
    });
  it("requires authoritative Meta failure evidence for explicit recovery",async()=>{
    expect(await marketingRecovery()).toEqual([]);
    await client.query(`INSERT INTO instagram_webhook_events
      VALUES(991,'account-1','whatsapp_failed','receipt-1','{"status":{"errors":[{"code":131026}]}}')`);
    expect(await marketingRecovery()).toEqual([]);
  });
  it("recovers failed queue acknowledgement using the same deterministic job identity and original actor", async () => {
    await plan();
    dispatch.mockRejectedValueOnce(new Error("Lost Redis acknowledgement"));
    await expect(
      withBusinessScope({ userId: 991, businessProfileId: 1 }, () =>
        reconcileWhatsAppProviderRetries(),
      ),
    ).rejects.toThrow("Lost Redis");
    const interim = (
      await client.query("SELECT * FROM outreach_messages WHERE id=1")
    ).rows[0];
    expect(interim.status).toBe("pending");
    expect(interim.metadata.outreachQueue.enqueueNeeded).toBe(true);
    await withBusinessScope({ userId: 991, businessProfileId: 1 }, () =>
      reconcileWhatsAppProviderRetries(),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][2].jobId).toBe(
      dispatch.mock.calls[1][2].jobId,
    );
    expect(dispatch.mock.calls[1][2].priority).toBe(10);
    expect(dispatch.mock.calls[1][1]).toMatchObject({
      messageId: 1,
      businessActorUserId: 991,
      billingOrganizationId: 8,
      providerRateLimitRetries: 1,
    });
    expect(
      (await client.query("SELECT metadata FROM outreach_messages WHERE id=1"))
        .rows[0].metadata.outreachQueue.enqueueNeeded,
    ).toBeUndefined();
    await withBusinessScope({ userId: 991, businessProfileId: 1 }, () =>
      reconcileWhatsAppProviderRetries(),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("shows cooldown reasons ahead of immediate jobs without delaying the whole channel's next-attempt label", async () => {
    await client.query(`INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,metadata,manual_review_required)
      SELECT 100+i,991,1,'outbound','outreach','pending','{}'::jsonb,false FROM generate_series(1,25) i;
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,metadata,manual_review_required)
      VALUES(200,991,1,'outbound','outreach','pending','{"outreachQueue":{"reason":"provider_limit","nextAttemptAt":"2026-10-30T00:00:00Z"}}',false);`);
    const result=await withBusinessScope({userId:991,businessProfileId:1},()=>getOutreachQueueOverview(991));
    const row=result.channels.find((item:{channel:unknown})=>item.channel==='whatsapp');
    expect(row).toMatchObject({queued:26,retrying:1,nextAttemptAt:null});
    expect(row?.waiting[0]).toMatchObject({reason:'provider_limit',nextAttemptAt:'2026-10-30T00:00:00Z'});
  });
  it("does not hide a legacy job behind another business's provider receipt", async () => {
    await client.query(`DELETE FROM outreach_messages;
      INSERT INTO outreach_messages(business_profile_id,id,user_id,conversation_id,direction,message_kind,status,metadata,manual_review_required,external_message_id)
        VALUES(2,8,991,2,'outbound','outreach','sent','{}',false,'shared-provider-receipt');
      INSERT INTO outreach_jobs(id,user_id,channel,status,sent_at,created_at,metadata,attempts,scheduled_for,error,external_message_id)
        VALUES(8,991,'email','pending',NULL,NOW(),'{}',0,NOW(),NULL,'shared-provider-receipt');`);
    const result = await withBusinessScope({ userId: 991, businessProfileId: 1 }, () => getOutreachQueueOverview(991));
    expect(result.channels.find((row: {channel: unknown}) => row.channel === "email")).toMatchObject({queued: 1, accepted: 0});
  });
  it("counts delivered as accepted, separates uncertain and retry states, and does not double count legacy projections or another owner", async () => {
    await client.query(`UPDATE outreach_messages SET status='delivered',sent_at=NOW(),delivered_at=NOW();
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,metadata,manual_review_required) VALUES
        (2,991,2,'outbound','outreach','pending','{"outreachQueue":{"reason":"daily_allowance","nextAttemptAt":"2026-10-30T00:00:00Z"}}',false),
        (3,991,2,'outbound','outreach','manual_review','{}',true),(4,992,3,'outbound','outreach','sent','{}',false);
      INSERT INTO outreach_messages(business_profile_id,id,user_id,conversation_id,direction,message_kind,status,metadata,manual_review_required) VALUES(2,5,991,1,'outbound','outreach','sent','{}',false);
      INSERT INTO outreach_jobs(id,user_id,channel,status,sent_at,created_at,metadata,attempts,scheduled_for,error,external_message_id) VALUES(1,991,'whatsapp','sent',NOW(),NOW(),'{}',0,NOW(),NULL,'receipt-1'),(2,991,'email','pending',NULL,NOW(),'{}',1,NOW()+INTERVAL '1 day','Provider cooldown',NULL);`);
    const result = await withBusinessScope(
      { userId: 991, businessProfileId: 1 },
      () => getOutreachQueueOverview(991),
    );
    expect(
      result.channels.find(
        (row: { channel: unknown }) => row.channel === "whatsapp",
      ),
    ).toMatchObject({ accepted: 1, delivered: 1 });
    expect(
      result.channels.find(
        (row: { channel: unknown }) => row.channel === "email",
      ),
    ).toMatchObject({ queued: 2, retrying: 2, review: 1, accepted: 0 });
  });
});
