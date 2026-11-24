import {
  installReadyCustomerDeliveryMock,
  readyDeliveryReceipt,
} from "./helpers/readyCustomerDelivery.js";
installReadyCustomerDeliveryMock();
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { withBusinessScope } from "../tenancy/businessContext.js";
import type { OutreachJob, SendResult } from "../tools/outreachSender.js";

// Real worker SQL, transactions, row/advisory locks and campaign reconciliation.
// All provider, assistant readiness, account/recipient selection and credit
// boundaries are synthetic. No application DB, Redis, or provider is loaded.
const run =
  process.env.OUTREACH_QUEUE_LOCAL_QA === "1" ? describe : describe.skip;
const schema = `outreach_provider_races_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | undefined, pool: Pool | undefined, database: NodePgDatabase;
const sendEmail = jest.fn<(...args: unknown[]) => Promise<SendResult>>();
const sendSMS = jest.fn<(...args: unknown[]) => Promise<SendResult>>();
const reserve =
  jest.fn<
    (...args: unknown[]) => Promise<{ success: boolean; transactionId: number }>
  >();
const refund = jest.fn<(...args: unknown[]) => Promise<{ success: boolean }>>();
const createSentMessage =
  jest.fn<(...args: unknown[]) => Promise<{ id: number }>>();
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
jest.unstable_mockModule("../services/emailService.js", () => ({
  emailService: { sendEmailWithUserCredentials: sendEmail },
}));
jest.unstable_mockModule("../services/smsService.js", () => ({ sendSMS }));
jest.unstable_mockModule("../services/CreditService.js", () => ({
  creditService: { reserveOutreachCredit: reserve, refundDeduction: refund },
}));
jest.unstable_mockModule("../models/sentMessages/functions.js", () => ({
  SentMessageModel: { create: createSentMessage },
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("../services/outreach/CreationService.js", () => ({
  resolveCreationAccount: async (_user: number, channel: string) => ({
    account: {
      ready: true,
      providerAccountId: "synthetic-account",
      senderId: channel === "email" ? 7 : undefined,
      label: "sales@example.test",
    },
    binding: { credentialId: 77 },
  }),
  getCreationRecipients: async (_user: number, channel: string) => ({
    recipients: [
      {
        id: 73,
        eligible: true,
        recipient:
          channel === "email" ? "recipient@example.test" : "919876543210",
      },
    ],
  }),
  validateOutreachTiming: jest.fn(),
}));
const { campaignMessageHash } =
  await import("../services/outreach/CampaignDeliveryService.js");
const { OutreachSenderWorker } = await import("../tools/outreachSender.js");
interface WorkerProbe {
  processJob(job: OutreachJob): Promise<void>;
  fetchPendingJobs(): Promise<OutreachJob[]>;
  recoverStaleProcessingJobs(): Promise<void>;
  cancelCampaignJobs(campaignId: number, userId: number): Promise<number>;
  retryFailedCampaignJobs(campaignId: number, userId: number): Promise<number>;
}
const scoped = <T>(work: () => T) =>
  withBusinessScope({ userId: 12, businessProfileId: 101 }, work);
const worker = () => new OutreachSenderWorker() as unknown as WorkerProbe;
const execute = (job: OutreachJob) => scoped(() => worker().processJob(job));
const replay = (job: OutreachJob) =>
  Promise.all(Array.from({ length: 8 }, () => execute(job)));
const query = (text: string, values?: unknown[]) => pool!.query(text, values);
const state = async () =>
  (await query("SELECT * FROM outreach_jobs WHERE id=1")).rows[0];

function validateProviderFixtureUrl(value: string | undefined): string {
  const message = 'Explicit isolated loopback implementation_synthetic database without URL overrides required';
  if (!value) throw new Error(message);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/implementation_synthetic' || url.search || url.hash) throw new Error(message);
  return value;
}

describe('provider concurrency fixture isolation guard', () => {
  it.each([undefined, 'not-a-url', 'https://localhost/implementation_synthetic',
    'postgres://example.test/implementation_synthetic', 'postgres://localhost/production',
    'postgres://localhost/implementation_synthetic?host=example.test',
    'postgres://localhost/implementation_synthetic?dbname=production',
    'postgres://localhost/implementation_synthetic#ignored'])('rejects unsafe target %#', value => {
    expect(() => validateProviderFixtureUrl(value)).toThrow();
  });
  it('accepts an explicit disposable loopback target', () => {
    const url = 'postgres://fixture@127.0.0.1:55439/implementation_synthetic';
    expect(validateProviderFixtureUrl(url)).toBe(url);
  });
});

function latch() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    pause: async () => {
      enter();
      await gate;
    },
    waitFor: async (work: Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered,
          work.then(() => {
            throw new Error(
              "Worker exited before the expected provider/preparation boundary",
            );
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("Worker did not reach the expected boundary")),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
async function seed(channel: "email" | "sms") {
  const recipient =
    channel === "email" ? "recipient@example.test" : "919876543210";
  const now = new Date();
  const job: OutreachJob = {
    id: 1,
    userId: 12,
    campaignId: 9,
    sequenceId: 5,
    leadId: 73,
    stepNumber: 1,
    messageType: channel,
    content: "Synthetic reviewed message",
    subject: "Synthetic subject",
    status: "pending",
    scheduledFor: now,
    retryCount: 0,
    maxRetries: 3,
    createdAt: now,
    updatedAt: now,
    deliveryReview: {
      version: 1,
      channel,
      assistant: readyDeliveryReceipt,
      senderId: channel === "email" ? 7 : undefined,
      fromEmail: channel === "email" ? "sales@example.test" : undefined,
      providerCredentialId: 77,
      providerAccountId: "synthetic-account",
      recipient,
      stepNumber: 1,
      contentHash: campaignMessageHash(
        channel,
        recipient,
        "Synthetic subject",
        "Synthetic reviewed message",
      ),
    },
  };
  await query(
    `INSERT INTO outreach_campaigns(id,user_id,campaign_type,status,settings,start_date,updated_at)
    VALUES(9,12,$1,'queued','{}',NOW(),NOW());`,
    [channel],
  );
  await query(
    `INSERT INTO outreach_jobs(id,user_id,campaign_id,lead_id,sequence_step_id,channel,status,scheduled_for,attempts,max_attempts,message_body,subject,metadata,updated_at)
    VALUES(1,12,9,73,1,$1,'pending',NOW(),0,3,$2,$3,$4,NOW())`,
    [
      channel,
      job.content,
      job.subject,
      JSON.stringify({ deliveryReview: job.deliveryReview }),
    ],
  );
  return job;
}

run(
  "outreach provider races with independent PostgreSQL connections and fake transports",
  () => {
    beforeAll(async () => {
      const url = validateProviderFixtureUrl(process.env.OUTREACH_QA_DATABASE_URL);
      admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: url,
        max: 8,
        options: `-c search_path=${schema},pg_catalog -c timezone=UTC -c statement_timeout=5000 -c lock_timeout=3000`,
      });
      database = drizzle(pool);
      await query(`CREATE TABLE outreach_campaigns(id int PRIMARY KEY,user_id int,campaign_type text,status text,settings jsonb,start_date timestamp,is_active boolean,messages_sent int,messages_delivered int,messages_failed int,launched_at timestamp,completed_at timestamp,updated_at timestamp,created_at timestamp DEFAULT NOW());
      CREATE TABLE leads(id int PRIMARY KEY,user_id int,email text,phone text,full_name text,blacklisted boolean DEFAULT false,do_not_contact boolean DEFAULT false,email_unsubscribed boolean DEFAULT false,deleted_at timestamp);
      CREATE TABLE outreach_jobs(id int PRIMARY KEY,user_id int,campaign_id int,lead_id int,sequence_step_id int,channel text,status text,scheduled_for timestamp,attempts int,max_attempts int,message_body text,subject text,metadata jsonb,updated_at timestamp,sent_at timestamp,external_message_id text,error text,is_dead_letter boolean,last_attempt_at timestamp,created_at timestamp DEFAULT NOW());
      CREATE TABLE sent_messages(id serial PRIMARY KEY,user_id int,campaign_id int,lead_id int,sender_id int,channel text,message_id text,gmail_thread_id text,recipient_address text,lead_name text,rfc_message_id text,references_header text,reply_received_at timestamp,is_reply boolean DEFAULT false,status text,delivery_status text,delivered_at timestamp,opened_at timestamp,bounced_at timestamp,bounce_reason text,updated_at timestamp,sent_at timestamp);
      CREATE TABLE outreach_conversations(id int,user_id int,lead_id int,channel text,provider_account_id text,status text);
      CREATE TABLE outreach_messages(id int,conversation_id int,user_id int,direction text,created_at timestamp,external_message_id text,provider_message_id text,rfc_message_id text,status text,sent_at timestamp,provider_call_state text,send_claimed_at timestamp);
      CREATE TABLE outreach_settings(user_id int,daily_email_limit int);`);
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    });
    beforeEach(async () => {
      jest.resetAllMocks();
      await query(
        "TRUNCATE outreach_campaigns,leads,outreach_jobs,sent_messages,outreach_conversations,outreach_messages,outreach_settings",
      );
      await query(`INSERT INTO outreach_settings VALUES(12,200);
      INSERT INTO leads(id,user_id,email,phone,full_name) VALUES(73,12,'recipient@example.test','919876543210','Synthetic Contact');`);
      reserve.mockImplementation(async () => ({
        success: true,
        transactionId: 88 + reserve.mock.calls.length,
      }));
      refund.mockResolvedValue({ success: true });
      sendEmail.mockResolvedValue({
        success: true,
        messageId: "synthetic-receipt",
      });
      sendSMS.mockResolvedValue({
        success: true,
        messageId: "synthetic-receipt",
      });
      createSentMessage.mockResolvedValue({ id: 1 });
    });

    it("uses eight distinct PostgreSQL backend connections", async () => {
      const clients = await Promise.all(
        Array.from({ length: 8 }, () => pool!.connect()),
      );
      try {
        const pids = await Promise.all(
          clients.map((client) =>
            client.query("SELECT pg_backend_pid() AS pid"),
          ),
        );
        expect(new Set(pids.map((result) => result.rows[0].pid)).size).toBe(8);
      } finally {
        clients.forEach((client) => client.release());
      }
    });

    describe.each(["email", "sms"] as const)(
      "%s provider boundary",
      (channel) => {
        const transport = () => (channel === "email" ? sendEmail : sendSMS);

        it("fences eight simultaneous claimants and in-flight replays to one provider dispatch", async () => {
          const job = await seed(channel),
            boundary = latch();
          transport().mockImplementationOnce(async () => {
            await boundary.pause();
            return { success: true, messageId: "accepted-once" };
          });
          const work = replay(job);
          try {
            await boundary.waitFor(work);
            expect((await state()).metadata.providerCallStarted).toBe(true);
            await replay(job);
            expect(transport()).toHaveBeenCalledTimes(1);
            expect(reserve).toHaveBeenCalledTimes(1);
          } finally {
            boundary.release();
            await work;
          }
          expect(await state()).toMatchObject({
            status: "sent",
            external_message_id: "accepted-once",
          });
          expect(refund).not.toHaveBeenCalled();
        });

        it("honors a definitive rejection cooldown and retries the same durable job once", async () => {
          const job = await seed(channel),
            retryAt = new Date(Date.now() + 7200_000).toISOString();
          transport().mockResolvedValueOnce({
            success: false,
            error: "Synthetic rate rejection",
            deliveryAttempted: true,
            outcomeUncertain: false,
            retryable: true,
            retryAt,
          });
          await execute(job);
          const rejected = await state();
          expect(rejected).toMatchObject({
            status: "pending",
            attempts: 1,
            is_dead_letter: false,
          });
          // Read an explicit UTC instant, independent of the test runner's timezone.
          const due = await query(
            "SELECT scheduled_for AT TIME ZONE 'UTC' AS instant FROM outreach_jobs WHERE id=1",
          );
          expect(due.rows[0].instant.getTime()).toBeGreaterThanOrEqual(
            Date.parse(retryAt),
          );
          expect(refund).toHaveBeenCalledTimes(1);
          await replay(job);
          expect(transport()).toHaveBeenCalledTimes(1);
          await query(
            "UPDATE outreach_jobs SET scheduled_for=NOW()-INTERVAL '1 second' WHERE id=1",
          );
          const ready = await scoped(() => worker().fetchPendingJobs());
          expect(ready).toHaveLength(1);
          expect(ready[0].retryCount).toBe(1);
          await replay(ready[0]);
          expect(transport()).toHaveBeenCalledTimes(2);
          expect(
            reserve.mock.calls.map(
              ([input]) => (input as { referenceId: string }).referenceId,
            ),
          ).toEqual(["outreach-job:1:attempt:1", "outreach-job:1:attempt:2"]);
          if (channel === "email")
            expect(
              sendEmail.mock.calls.map(
                ([, input]) =>
                  (input as { idempotencyKey: string }).idempotencyKey,
              ),
            ).toEqual(["outreach-job:1", "outreach-job:1"]);
          expect(await state()).toMatchObject({
            status: "sent",
            attempts: 1,
            external_message_id: "synthetic-receipt",
          });
          expect(refund).toHaveBeenCalledTimes(1);
        });

        it("cancels during credit preparation before a provider call and refunds the unstarted reservation", async () => {
          const job = await seed(channel),
            boundary = latch();
          reserve.mockImplementationOnce(async () => {
            await boundary.pause();
            return { success: true, transactionId: 901 };
          });
          const work = execute(job);
          try {
            await boundary.waitFor(work);
            expect(await scoped(() => worker().cancelCampaignJobs(9, 12))).toBe(
              1,
            );
            expect(await scoped(() => worker().cancelCampaignJobs(9, 12))).toBe(
              0,
            );
          } finally {
            boundary.release();
            await work;
          }
          await replay(job);
          expect(transport()).not.toHaveBeenCalled();
          expect(refund).toHaveBeenCalledTimes(1);
          expect(refund).toHaveBeenCalledWith(
            expect.objectContaining({ transactionId: 901 }),
          );
          expect(await state()).toMatchObject({
            status: "cancelled",
            external_message_id: null,
          });
          expect((await state()).metadata.claimToken).toBeUndefined();
        });

        it("preserves an already-started receipt when cancellation wins before provider acknowledgement", async () => {
          const job = await seed(channel),
            boundary = latch();
          transport().mockImplementationOnce(async () => {
            await boundary.pause();
            return { success: true, messageId: "accepted-before-stop" };
          });
          const work = execute(job);
          try {
            await boundary.waitFor(work);
            expect(await scoped(() => worker().cancelCampaignJobs(9, 12))).toBe(
              0,
            );
            expect((await state()).status).toBe("processing");
          } finally {
            boundary.release();
            await work;
          }
          await replay(job);
          expect(transport()).toHaveBeenCalledTimes(1);
          expect(await state()).toMatchObject({
            status: "sent",
            external_message_id: "accepted-before-stop",
          });
          expect(
            (await query("SELECT status FROM outreach_campaigns WHERE id=9"))
              .rows[0].status,
          ).toBe("cancelled");
          expect(refund).not.toHaveBeenCalled();
        });

        it.each(["timeout", "missing receipt", "structured uncertainty"])(
          "holds %s without automatic retry or refund",
          async (kind) => {
            const job = await seed(channel);
            if (kind === "timeout")
              transport().mockRejectedValueOnce(
                new Error("Synthetic acknowledgement lost"),
              );
            else
              transport().mockResolvedValueOnce(
                kind === "missing receipt"
                  ? { success: true }
                  : {
                      success: false,
                      error: "Synthetic unknown outcome",
                      retryable: true,
                      deliveryAttempted: true,
                      outcomeUncertain: true,
                    },
              );
            await execute(job);
            expect(await state()).toMatchObject({
              status: "failed",
              attempts: 1,
              is_dead_letter: true,
              external_message_id: null,
              metadata: expect.objectContaining({
                providerCallStarted: true,
                manualReviewRequired: true,
              }),
            });
            expect(
              await scoped(() => worker().retryFailedCampaignJobs(9, 12)),
            ).toBe(0);
            await scoped(() => worker().recoverStaleProcessingJobs());
            await replay(job);
            expect(transport()).toHaveBeenCalledTimes(1);
            expect(refund).not.toHaveBeenCalled();
            expect(createSentMessage).not.toHaveBeenCalled();
          },
        );

        it("revokes a stale preparation token before a replacement worker sends", async () => {
          const job = await seed(channel),
            boundary = latch();
          reserve.mockImplementationOnce(async () => {
            await boundary.pause();
            return { success: true, transactionId: 901 };
          });
          const oldWorker = execute(job);
          try {
            await boundary.waitFor(oldWorker);
            await query(
              "UPDATE outreach_jobs SET updated_at=NOW()-INTERVAL '16 minutes' WHERE id=1",
            );
            await scoped(() => worker().recoverStaleProcessingJobs());
            const ready = await scoped(() => worker().fetchPendingJobs());
            expect(ready).toHaveLength(1);
            await replay(ready[0]);
            expect(await state()).toMatchObject({
              status: "sent",
              attempts: 1,
            });
          } finally {
            boundary.release();
            await oldWorker;
          }
          expect(transport()).toHaveBeenCalledTimes(1);
          expect(refund).toHaveBeenCalledTimes(1);
          expect(refund).toHaveBeenCalledWith(
            expect.objectContaining({ transactionId: 901 }),
          );
          expect(await state()).toMatchObject({
            status: "sent",
            external_message_id: "synthetic-receipt",
          });
        });

        it("keeps stale started calls in manual review even after a late acknowledgement", async () => {
          const job = await seed(channel),
            boundary = latch();
          transport().mockImplementationOnce(async () => {
            await boundary.pause();
            return { success: true, messageId: "late-acceptance" };
          });
          const work = execute(job);
          try {
            await boundary.waitFor(work);
            await query(
              "UPDATE outreach_jobs SET updated_at=NOW()-INTERVAL '16 minutes' WHERE id=1",
            );
            await scoped(() => worker().recoverStaleProcessingJobs());
            expect(await state()).toMatchObject({
              status: "failed",
              is_dead_letter: true,
              metadata: expect.objectContaining({ manualReviewRequired: true }),
            });
            await replay(job);
          } finally {
            boundary.release();
            await work;
          }
          expect(
            await scoped(() => worker().retryFailedCampaignJobs(9, 12)),
          ).toBe(0);
          expect((await state()).metadata.claimToken).toBeUndefined();
          expect((await state()).status).toBe("failed");
          expect(transport()).toHaveBeenCalledTimes(1);
          expect(refund).not.toHaveBeenCalled();
        });

        it.each(["permanent rejection", "exhausted retry budget"])(
          "does not automatically resend after %s",
          async (kind) => {
            const job = await seed(channel);
            if (kind === "exhausted retry budget") {
              await query("UPDATE outreach_jobs SET attempts=2 WHERE id=1");
              job.retryCount = 2;
            }
            transport().mockResolvedValueOnce({
              success: false,
              error: "Synthetic explicit rejection",
              deliveryAttempted: true,
              outcomeUncertain: false,
              retryable: kind === "exhausted retry budget",
            });
            await execute(job);
            await replay(job);
            expect(await state()).toMatchObject({
              status: "failed",
              is_dead_letter: true,
              metadata: expect.objectContaining({
                manualReviewRequired: false,
                providerCallStarted: false,
              }),
            });
            expect(transport()).toHaveBeenCalledTimes(1);
            expect(refund).toHaveBeenCalledTimes(1);
          },
        );
      },
    );
  },
);
