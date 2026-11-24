import { sql } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { OutreachJob } from '../tools/outreachSender.js';
let client: Client, database: NodePgDatabase;
let failCancellation = false;
const dialect = new PgDialect();
const sendEmail = jest.fn<any>(),
  sendSMS = jest.fn<any>(),
  account = jest.fn<any>(),
  recipients = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    execute: (query: SQL) => {
      if (
        failCancellation &&
        dialect.sqlToQuery(query).sql.includes('UPDATE outreach_jobs')
      )
        throw new Error('Synthetic cancellation persistence failure');
      return database.execute(query);
    },
    transaction: (work: any) =>
      database.transaction((tx) =>
        work({
          execute: (query: SQL) => {
            if (
              failCancellation &&
              dialect.sqlToQuery(query).sql.includes('UPDATE outreach_jobs')
            )
              throw new Error('Synthetic cancellation persistence failure');
            return tx.execute(query);
          },
        }),
      ),
  },
}));
jest.unstable_mockModule('../services/emailService.js', () => ({
  emailService: { sendEmailWithUserCredentials: sendEmail },
}));
jest.unstable_mockModule('../services/smsService.js', () => ({ sendSMS }));
jest.unstable_mockModule('../services/CreditService.js', () => ({
  creditService: {
    reserveOutreachCredit: async () => ({ success: true, transactionId: 88 }),
    refundDeduction: async () => ({ success: true }),
  },
}));
jest.unstable_mockModule('../models/sentMessages/functions.js', () => ({
  SentMessageModel: { create: async () => ({ id: 1 }) },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../services/outreach/CreationService.js', () => ({
  resolveCreationAccount: account,
  getCreationRecipients: recipients,
  validateOutreachTiming: jest.fn(),
}));
const { campaignMessageHash } =
  await import('../services/outreach/CampaignDeliveryService.js');
const { OutreachSenderWorker } = await import('../tools/outreachSender.js');
const { recordOutreachEmailDelivery, reconcileOutreachJobCampaign } =
  await import('../services/outreach/OutreachJobCampaignService.js');
const worker = () => {
  const value = new OutreachSenderWorker() as any;
  return new Proxy(value, {
    get(target, key) {
      const member = target[key];
      return typeof member === 'function'
        ? (...args: unknown[]) =>
            withBusinessScope({ userId: 12, businessProfileId: 101 }, () =>
              member.apply(target, args),
            )
        : member;
    },
  });
};
function fixture(channel = 'email', step = 1): OutreachJob {
  const recipient =
    channel === 'email' ? 'recipient@example.test' : '919876543210';
  return {
    id: step,
    campaignId: 9,
    sequenceId: 5,
    leadId: 73,
    userId: 12,
    stepNumber: step,
    messageType: channel as any,
    content: 'Synthetic message',
    subject: 'Synthetic subject',
    status: 'pending',
    scheduledFor: new Date(),
    retryCount: 0,
    maxRetries: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    deliveryReview: {
      version: 1,
      channel: channel as any,
      senderId: channel === 'email' ? 7 : undefined,
      fromEmail: channel === 'email' ? 'sales@example.test' : undefined,
      providerCredentialId: 77,
      providerAccountId: 'account',
      recipient,
      stepNumber: step,
      contentHash: campaignMessageHash(
        channel,
        recipient,
        'Synthetic subject',
        'Synthetic message',
      ),
    },
  };
}
async function seed(
  job: OutreachJob,
  metadata: Record<string, unknown> = {},
  status = 'pending',
) {
  await client.query(
    `INSERT INTO outreach_jobs (id,user_id,campaign_id,lead_id,sequence_step_id,channel,status,scheduled_for,attempts,max_attempts,message_body,subject,metadata,updated_at)
    VALUES($1,12,9,73,$1,$2,$3,NOW(),0,3,$4,$5,$6,NOW())`,
    [
      job.id,
      job.messageType,
      status,
      job.content,
      job.subject,
      JSON.stringify({ deliveryReview: job.deliveryReview, ...metadata }),
    ],
  );
}
beforeAll(async () => {
  client = new Client({
    connectionString: process.env.OUTREACH_QA_DATABASE_URL,
  });
  await client.connect();
  await client.query('SET search_path TO pg_temp,pg_catalog');
  database = drizzle(client);
  await client.query(`CREATE TEMP TABLE outreach_campaigns(id integer PRIMARY KEY,user_id integer,campaign_type text,status text,settings jsonb,start_date timestamp,is_active boolean,messages_sent integer,messages_delivered integer,messages_failed integer,launched_at timestamp,completed_at timestamp,updated_at timestamp,created_at timestamp DEFAULT NOW());
    CREATE TEMP TABLE leads(id integer PRIMARY KEY,user_id integer,email text,phone text,full_name text,blacklisted boolean DEFAULT false,do_not_contact boolean DEFAULT false,email_unsubscribed boolean DEFAULT false,deleted_at timestamp);
    CREATE TEMP TABLE outreach_jobs(id integer PRIMARY KEY,user_id integer,campaign_id integer,lead_id integer,sequence_step_id integer,channel text,status text,scheduled_for timestamp,attempts integer,max_attempts integer,message_body text,subject text,metadata jsonb,updated_at timestamp,sent_at timestamp,external_message_id text,error text,is_dead_letter boolean,last_attempt_at timestamp,created_at timestamp DEFAULT NOW());
    CREATE TEMP TABLE sent_messages(id serial PRIMARY KEY,user_id integer,campaign_id integer,lead_id integer,sender_id integer,channel text,message_id text,gmail_thread_id text,recipient_address text,lead_name text,rfc_message_id text,references_header text,reply_received_at timestamp,is_reply boolean DEFAULT false,status text,delivery_status text,delivered_at timestamp,opened_at timestamp,bounced_at timestamp,bounce_reason text,updated_at timestamp,sent_at timestamp);
    CREATE TEMP TABLE outreach_conversations(id integer,user_id integer,lead_id integer,channel text,provider_account_id text,status text);
    CREATE TEMP TABLE outreach_messages(id integer,conversation_id integer,user_id integer,direction text,created_at timestamp,external_message_id text,provider_message_id text,rfc_message_id text,status text,sent_at timestamp,provider_call_state text,send_claimed_at timestamp);
    CREATE TEMP TABLE outreach_settings(user_id integer,daily_email_limit integer);`);
});
afterAll(async () => {
  await client?.end();
});
beforeEach(async () => {
  jest.clearAllMocks();
  failCancellation = false;
  await client.query(
    'TRUNCATE outreach_campaigns,leads,outreach_jobs,sent_messages,outreach_conversations,outreach_messages,outreach_settings',
  );
  await client.query('INSERT INTO outreach_settings VALUES(12,200)');
  await client.query(`INSERT INTO outreach_campaigns(id,user_id,campaign_type,status,settings,start_date,updated_at) VALUES(9,12,'email','queued','{}',NOW(),NOW());
    INSERT INTO leads(id,user_id,email,phone,full_name) VALUES(73,12,'recipient@example.test','919876543210','Synthetic Contact');`);
  account.mockImplementation(async (_user: number, channel: string) => ({
    account: {
      ready: true,
      providerAccountId: 'account',
      senderId: channel === 'email' ? 7 : undefined,
      label: 'sales@example.test',
    },
    binding: { credentialId: 77 },
  }));
  recipients.mockImplementation(async (_user: number, channel: string) => ({
    recipients: [
      {
        id: 73,
        eligible: true,
        recipient:
          channel === 'email' ? 'recipient@example.test' : '919876543210',
      },
    ],
  }));
  sendEmail.mockResolvedValue({ success: true, messageId: 'mock-provider-id' });
  sendSMS.mockImplementation(async () => ({
    success: true,
    messageId: 'mock-sms-' + sendSMS.mock.calls.length,
  }));
});
describe('campaign lifecycle hardening acceptance with isolated PostgreSQL', () => {
  it('F01 recovery fences a suspended worker before a second SMS provider dispatch', async () => {
    const job = fixture('sms');
    await seed(job, { providerCallStarted: false });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    account.mockImplementationOnce(async () => {
      entered();
      await gate;
      return {
        account: {
          ready: true,
          providerAccountId: 'account',
          label: 'sales@example.test',
        },
        binding: { credentialId: 77 },
      };
    });
    const first = worker().processJob(job);
    await waiting;
    try {
      await client.query(
        "UPDATE outreach_jobs SET updated_at=NOW()-INTERVAL '16 minutes' WHERE id=1",
      );
      const second = worker();
      await second.recoverStaleProcessingJobs();
      expect(
        (await client.query('SELECT status FROM outreach_jobs WHERE id=1'))
          .rows[0].status,
      ).toBe('pending');
      const ready = await second.fetchPendingJobs();
      expect(ready).toHaveLength(1);
      await second.processJob(ready[0]);
      expect(sendSMS).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
    expect(sendSMS).toHaveBeenCalledTimes(1);
  });
  it('F02 cancellation failure propagates and the entire transaction rolls back', async () => {
    await seed(fixture());
    failCancellation = true;
    await expect(worker().cancelCampaignJobs(9, 12)).rejects.toThrow(
      'Synthetic cancellation persistence failure',
    );
    expect(
      (await client.query('SELECT status FROM outreach_campaigns WHERE id=9'))
        .rows[0].status,
    ).toBe('queued');
    expect(
      (await client.query('SELECT status FROM outreach_jobs WHERE id=1'))
        .rows[0].status,
    ).toBe('pending');
  });
  it('F03 a pending predecessor defers a due step without requiring manual review', async () => {
    await seed(fixture());
    const next = fixture('email', 2);
    await seed(next);
    await worker().processJob(next);
    expect(
      (
        await client.query(
          'SELECT status,metadata FROM outreach_jobs WHERE id=2',
        )
      ).rows[0],
    ).toMatchObject({
      status: 'pending',
      metadata: { manualReviewRequired: false },
    });
    await client.query(
      "UPDATE outreach_jobs SET status='sent',external_message_id='first-ack',sent_at=NOW() WHERE id=1",
    );
    expect(await worker().retryFailedCampaignJobs(9, 12)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it('F04 campaign follow-up bounce updates its receipt and failed totals', async () => {
    const next = fixture('email', 2);
    await seed(next, {}, 'sent');
    await client.query(
      "UPDATE outreach_jobs SET external_message_id='followup-ack',sent_at=NOW() WHERE id=2",
    );
    await client.query(`INSERT INTO sent_messages(user_id,campaign_id,lead_id,channel,message_id,is_reply,status,delivery_status,sent_at)
      VALUES(12,9,73,'email','followup-ack',true,'sent','sent',NOW())`);
    await recordOutreachEmailDelivery(
      'followup-ack',
      'bounced',
      'Synthetic hard bounce',
    );
    expect(
      (
        await client.query(
          "SELECT status,delivery_status FROM sent_messages WHERE message_id='followup-ack'",
        )
      ).rows[0],
    ).toEqual({ status: 'bounced', delivery_status: 'bounced' });
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({
      status: 'failed',
      sent: 1,
      failed: 1,
      delivered: 0,
    });
  });
  it('F05 a hard bounce suppresses the next campaign dispatch', async () => {
    await seed(fixture(), {}, 'sent');
    const next = fixture('email', 2);
    await seed(next);
    await client.query(
      "UPDATE outreach_jobs SET external_message_id='first-ack',sent_at=NOW()-INTERVAL '1 day' WHERE id=1",
    );
    await client.query(`INSERT INTO sent_messages(user_id,campaign_id,lead_id,sender_id,channel,message_id,status,delivery_status,sent_at)
      VALUES(12,9,73,7,'email','first-ack','sent','sent',NOW()-INTERVAL '1 day')`);
    await client.query(
      "UPDATE sent_messages SET recipient_address='recipient@example.test',rfc_message_id='<first@example.test>'",
    );
    await recordOutreachEmailDelivery(
      'first-ack',
      'bounced',
      'Synthetic hard bounce',
    );
    await worker().processJob(next);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      (await client.query('SELECT status,error FROM outreach_jobs WHERE id=2'))
        .rows[0],
    ).toMatchObject({
      status: 'cancelled',
      error: expect.stringContaining('suppressed'),
    });
    expect(
      (
        await client.query(
          'SELECT email_unsubscribed,do_not_contact FROM leads WHERE id=73',
        )
      ).rows[0],
    ).toEqual({ email_unsubscribed: false, do_not_contact: false });
  });
  it('F06 sequence uses the exact RFC identity and full reference chain', async () => {
    await seed(fixture(), {}, 'sent');
    const next = fixture('email', 2);
    await seed(next);
    await client.query(
      "UPDATE outreach_jobs SET external_message_id='first-native-id',sent_at=NOW()-INTERVAL '1 day' WHERE id=1",
    );
    await client.query(`INSERT INTO sent_messages(user_id,campaign_id,lead_id,sender_id,channel,message_id,status,delivery_status,sent_at)
      VALUES(12,9,73,7,'email','first-native-id','sent','sent',NOW()-INTERVAL '1 day')`);
    await client.query(
      "UPDATE sent_messages SET rfc_message_id='<first@example.test>',references_header='<root@example.test>'",
    );
    await worker().processJob(next);
    expect(sendEmail).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        inReplyTo: '<first@example.test>',
        references: '<root@example.test> <first@example.test>',
      }),
      7,
    );
  });
  it('F04 outbound follow-up is not a customer reply and step three remains eligible', async () => {
    await seed(fixture(), {}, 'sent');
    await seed(fixture('email', 2), {}, 'sent');
    const third = fixture('email', 3);
    await seed(third);
    await client.query(
      "UPDATE outreach_jobs SET external_message_id='step-'||id,sent_at=NOW()-(4-id)*INTERVAL '1 day' WHERE id IN (1,2)",
    );
    await client.query(`INSERT INTO sent_messages(user_id,campaign_id,lead_id,sender_id,channel,message_id,is_reply,status,delivery_status,sent_at)
      VALUES(12,9,73,7,'email','step-1',false,'sent','sent',NOW()-INTERVAL '3 days'),(12,9,73,7,'email','step-2',true,'sent','sent',NOW()-INTERVAL '2 days')`);
    await client.query(
      "UPDATE sent_messages SET rfc_message_id='<step-'||id||'@example.test>'",
    );
    await worker().processJob(third);
    expect(
      (await client.query('SELECT status,error FROM outreach_jobs WHERE id=3'))
        .rows[0],
    ).toEqual({ status: 'sent', error: null });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
  it('F09 configured daily limit zero defers campaign dispatch', async () => {
    await client.query('UPDATE outreach_settings SET daily_email_limit=0');
    try {
      const job = fixture();
      await seed(job);
      await worker().processJob(job);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(
        (
          await client.query(
            'SELECT status,error FROM outreach_jobs WHERE id=1',
          )
        ).rows[0],
      ).toMatchObject({
        status: 'pending',
        error: 'Daily outreach allowance reached.',
      });
    } finally {
      await client.query('UPDATE outreach_settings SET daily_email_limit=200');
    }
  });

  it('F02 cancellation after preparation fences an unstarted provider attempt', async () => {
    const job = fixture('sms');
    await seed(job);
    let enter!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    account.mockImplementationOnce(async () => {
      enter();
      await gate;
      return {
        account: {
          ready: true,
          providerAccountId: 'account',
          label: 'sales@example.test',
        },
        binding: { credentialId: 77 },
      };
    });
    const first = worker().processJob(job);
    await waiting;
    try {
      expect(await worker().cancelCampaignJobs(9, 12)).toBe(1);
    } finally {
      release();
      await first;
    }
    expect(sendSMS).not.toHaveBeenCalled();
    expect(
      (await client.query('SELECT status FROM outreach_jobs WHERE id=1'))
        .rows[0].status,
    ).toBe('cancelled');
  });
  it('uncertain provider starts remain manual review after stale recovery', async () => {
    await seed(
      fixture('sms'),
      { claimToken: 'old-token', providerCallStarted: true },
      'processing',
    );
    await client.query(
      "UPDATE outreach_jobs SET updated_at=NOW()-INTERVAL '16 minutes'",
    );
    await worker().recoverStaleProcessingJobs();
    expect(
      (
        await client.query(
          'SELECT status,metadata FROM outreach_jobs WHERE id=1',
        )
      ).rows[0],
    ).toMatchObject({
      status: 'failed',
      metadata: { manualReviewRequired: true },
    });
    expect(await worker().fetchPendingJobs()).toHaveLength(0);
    expect(sendSMS).not.toHaveBeenCalled();
  });
  it('permanent provider rejection is terminal even when more attempts remain', async () => {
    const job = fixture('sms');
    await seed(job);
    sendSMS.mockResolvedValueOnce({
      success: false,
      deliveryAttempted: true,
      outcomeUncertain: false,
      retryable: false,
      error: 'Synthetic permanent rejection',
    });
    await worker().processJob(job);
    expect(
      (
        await client.query(
          'SELECT status,attempts FROM outreach_jobs WHERE id=1',
        )
      ).rows[0],
    ).toMatchObject({ status: 'failed', attempts: 1 });
  });
  it('F09 counts a campaign projection once and shares capacity with composer starts', async () => {
    const { withCreationDailyQuota } =
      await import('../services/outreach/QuotaService.js');
    const job = fixture();
    await seed(job, {}, 'sent');
    await client.query(
      "UPDATE outreach_jobs SET sent_at=NOW(),external_message_id='projected'",
    );
    await client.query(
      "INSERT INTO outreach_conversations(id,user_id,channel) VALUES(1,12,'email'); INSERT INTO outreach_messages(id,user_id,conversation_id,direction,status,sent_at,external_message_id) VALUES(1,12,1,'outbound','sent',NOW(),'projected'); UPDATE outreach_settings SET daily_email_limit=2",
    );
    const scoped = <T,>(work: () => T) =>
      withBusinessScope({ userId: 12, businessProfileId: 101 }, work);
    expect(
      await scoped(() =>
        withCreationDailyQuota(12, 'email', async (tx: any) => {
          await tx.execute(
            sql`INSERT INTO outreach_messages(id,user_id,conversation_id,direction,status,provider_call_state,send_claimed_at) VALUES(2,12,1,'outbound','sending','started',NOW())`,
          );
          return true;
        }),
      ),
    ).toBe(true);
    expect(
      await scoped(() => withCreationDailyQuota(12, 'gmail', async () => true)),
    ).toBeNull();
  });
  it('suppression includes normalized duplicate destinations without crossing owners', async () => {
    const { assertRecipientNotSuppressed, getSuppressedRecipients } =
      await import('../services/outreach/RecipientSuppressionService.js');
    await client.query(
      "INSERT INTO leads(id,user_id,email,blacklisted) VALUES(74,99,'recipient@example.test',true)",
    );
    await expect(
      assertRecipientNotSuppressed(12, 'email', 'recipient@example.test'),
    ).resolves.toBeUndefined();
    await client.query(
      "INSERT INTO leads(id,user_id,email,phone,do_not_contact) VALUES(75,12,' RECIPIENT@EXAMPLE.TEST ','9876543210',true)",
    );
    expect(
      await getSuppressedRecipients(12, 'email', [
        'recipient@example.test',
        'other@example.test',
      ]),
    ).toEqual(new Set(['recipient@example.test']));
    await expect(
      assertRecipientNotSuppressed(12, 'sms', '+919876543210'),
    ).rejects.toThrow('suppressed');
  });
  it('migration 350 is repeatable on a fresh fixture and rollback retains evidence', async () => {
    const migration = await import(
      // @ts-expect-error JavaScript migrations use the custom runner.
      '../migrations/350_outreach_delivery_identity.js'
    );
    const migrationClient=new Client({connectionString:process.env.OUTREACH_QA_DATABASE_URL});
    await migrationClient.connect();
    try {
      await migrationClient.query("SET search_path TO pg_temp,pg_catalog; CREATE TEMP TABLE sent_messages(business_profile_id integer,user_id integer,channel text,bounced_at timestamp,status text,delivery_status text)");
      await migration.up(migrationClient);await migration.up(migrationClient);
      await migrationClient.query("INSERT INTO sent_messages(user_id,recipient_address,rfc_message_id) VALUES(12,'recipient@example.test','<evidence@example.test>')");
      await migration.down(migrationClient);
      expect((await migrationClient.query('SELECT recipient_address,rfc_message_id FROM sent_messages')).rows[0]).toEqual({recipient_address:'recipient@example.test',rfc_message_id:'<evidence@example.test>'});
    } finally {await migrationClient.end();}
  });
});
