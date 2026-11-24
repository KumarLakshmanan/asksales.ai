import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { withBusinessScope } from '../tenancy/businessContext.js';
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { DelayedError } from 'bullmq';
import { getTableColumns, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import type { FollowUpProvenance } from '../../shared/followUpProvenance.js';

// Exercise the real producer reservation/recovery and shared consumer policy.
// Only provider, credit, account and unrelated worker infrastructure are mocked.
let readinessInfrastructureFailure = false;
let confirmationInfrastructureFailure = false;
let beforeConfirmation: (() => Promise<void>) | undefined;
const queryTrace: string[] = [];
let confirmationState: Record<string, unknown> | undefined;
const queued = new Map<string, Record<string, unknown>>();
const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const refund = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const reserve = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const log = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: log,
  createWorkerLogger: () => log,
}));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({
  getRedisConnection: jest.fn(),
}));
jest.unstable_mockModule('../events/EventBus.js', () => ({
  eventBus: { emitToolEvent: async () => {}, publish: async () => {} },
  EVENT_CHANNELS: {},
}));
jest.unstable_mockModule('../queues/index.js', () => ({
  QUEUE_NAMES: {},
  QUEUE_LIMITERS: {},
  queueRegistry: {
    addJob: async (
      _queue: unknown,
      _name: unknown,
      payload: Record<string, unknown>,
      options: { jobId: string },
    ) => {
      queued.set(options.jobId, payload);
      return options.jobId;
    },
  },
}));
jest.unstable_mockModule('../services/media/QueuedMediaConfig.js', () => ({
  queuedMediaConfig: {},
}));
let client: Client, database: NodePgDatabase;
const toMessage = (row: any) =>
  row
    ? {
        ...row,
        userId: row.user_id,
        conversationId: row.conversation_id,
        messageKind: row.message_kind,
        followUpOriginMessageId: row.follow_up_origin_message_id,
        providerCallState: row.provider_call_state,
        manualReviewRequired: row.manual_review_required,
        sendClaimedAt: row.send_claimed_at,
      }
    : undefined;
const messageModel = {
  getOutreachMessageById: async (id: number) =>
    toMessage(
      (await client.query('SELECT * FROM outreach_messages WHERE id=$1', [id]))
        .rows[0],
    ),
  getOutreachMessageByIdempotencyKey: async (userId: number, key: string) =>
    toMessage(
      (
        await client.query(
          'SELECT * FROM outreach_messages WHERE user_id=$1 AND idempotency_key=$2',
          [userId, key],
        )
      ).rows[0],
    ),
  createOutreachConversation: async (data: any) =>
    (
      await client.query(
        "INSERT INTO outreach_conversations(user_id,lead_id,channel,provider_account_id,status,automation_mode,lead_email) VALUES($1,$2,'email',$3,'active','ai_active',$4) RETURNING id",
        [data.userId, data.leadId, data.providerAccountId, data.leadEmail],
      )
    ).rows[0],
  createOutreachMessage: async (data: any) =>
    toMessage(
      (
        await client.query(
          `INSERT INTO outreach_messages(user_id,conversation_id,direction,content,subject,html_content,status,idempotency_key,provider_account_id,metadata,message_kind)
    VALUES($1,$2,'outbound',$3,$4,$5,'pending',$6,$7,$8,'outreach') ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,
          [
            data.userId,
            data.conversationId,
            data.content,
            data.subject,
            data.htmlContent,
            data.idempotencyKey,
            data.providerAccountId,
            JSON.stringify(data.metadata),
          ],
        )
      ).rows[0],
    ),
};
jest.unstable_mockModule(
  '../models/outreachConversations/functions.js',
  () => messageModel,
);
jest.unstable_mockModule('../models/index.js', () => ({
  OutreachConversationModel: {
    ...messageModel,
    updateOutreachConversation: async () => {},
    getOutreachConversationById: async () => undefined,
  },
}));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({
  getDefault: async () => ({ id: 7 }),
}));
jest.unstable_mockModule('../services/outreach/CreationService.js', () => ({
  resolveCreationAccount: async () => ({
    account: {
      ready: true,
      label: 'sales@example.test',
      providerAccountId: 'account',
    },
    binding: { credentialId: 77 },
  }),
}));
jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    select: (...args: Parameters<typeof database.select>) =>
      database.select(...args),
    execute: async (query: SQL) => {
      const text = new PgDialect().sqlToQuery(query).sql;
      queryTrace.push(text);
      if (text.includes('SELECT enable_auto_follow_up,channel_follow_ups')) {
        if (readinessInfrastructureFailure)
          throw new Error('Synthetic readiness database outage');
        const state = (
          await client.query(
            "SELECT provider_call_state FROM outreach_messages WHERE message_kind='follow_up'",
          )
        ).rows[0];
        // Readiness is after preparation but before the provider-start boundary.
        if (state) expect(state.provider_call_state).toBe('not_started');
      }
      if (text.includes('UPDATE outreach_messages delivery SET updated_at')) {
        if (confirmationInfrastructureFailure)
          throw new Error('Synthetic confirmation database outage');
        if (beforeConfirmation) await beforeConfirmation();
        confirmationState = (
          await client.query(
            "SELECT status,provider_call_state,metadata->'queueEmail'->>'token' AS token FROM outreach_messages WHERE message_kind='follow_up'",
          )
        ).rows[0];
      }
      return database.execute(query);
    },
    transaction: (work: any) => database.transaction((tx) => work(tx)),
  },
}));
jest.unstable_mockModule('../services/CreditService.js', () => ({
  creditService: { reserveOutreachCredit: reserve, refundDeduction: refund },
}));
jest.unstable_mockModule('../services/emailService.js', () => ({
  emailService: { sendEmailWithUserCredentials: send },
}));
const { processEmailSending } = await import('../workers/index.js');
const { configuredFollowUpDispatch, recoverConfiguredFollowUpDispatches } =
  await import('../services/outreach/ConfiguredFollowUpDispatchService.js');
const { reserveEmailFollowUp } =
  await import('../services/emailFollowUpService.js');
const { followUpSettingsRevision } =
  await import('../utils/followUpSettingsRevision.js');
const { issueTemplateRenderContext } =
  await import('../services/content/TemplateRenderContext.js');
const { loadFollowUpTemplate, renderFollowUpTemplate } =
  await import('../services/followUpTemplateService.js');
const { companySettings } = await import('../models/companySettings/schema.js');
const { brandToolkitsTable } =
  await import('../models/brandToolkits/schema.js');
const { contentTemplatesTable } =
  await import('../models/contentTemplates/schema.js');
const config = {
  enabled: true,
  revision: 'first',
  maxFollowUps: 1,
  followUps: [{ enabled: true, templateId: 7 }],
};
const jobFixture = () => ({
  id: 'fixture-job',
  data: {
    userId: 1,
    messageId: 3,
    conversationId: 2,
    channel: 'email',
    recipientEmail: 'recipient@example.test',
    message: 'Hello',
    subject: 'Hello',
  },
  attemptsMade: 0,
  opts: { attempts: 3 },
  token: 'fixture-token',
  updateData: jest
    .fn<(...args: unknown[]) => Promise<void>>()
    .mockResolvedValue(undefined),
  moveToDelayed: jest
    .fn<(...args: unknown[]) => Promise<void>>()
    .mockResolvedValue(undefined),
});
const scope = <T>(work: () => T) =>
  withBusinessScope({ userId: 1, businessProfileId: 11 }, work);
const run = (job: any) => scope(() => processEmailSending(job));
const generic = () => ({
  ...jobFixture(),
  data: {
    userId: 1,
    leadId: 73,
    to: 'recipient@example.test',
    body: 'Synthetic message',
    subject: 'Synthetic subject',
  },
});
beforeAll(async () => {
  if (!process.env.OUTREACH_QA_DATABASE_URL?.startsWith('postgresql://audit:'))
    throw new Error('Synthetic audit database only');
  client = new Client({
    connectionString: process.env.OUTREACH_QA_DATABASE_URL,
  });
  await client.connect();
  await client.query('SET search_path TO pg_temp,pg_catalog');
  database = drizzle(client);
  await client.query(`CREATE TEMP TABLE users(id int,deleted_at timestamp);
    CREATE TEMP TABLE billing_organizations(id int,name text,owner_user_id int,default_for_user_id int,billing_eligibility_at timestamp);
    CREATE TEMP TABLE business_profile_memberships(id int,business_profile_id int,user_id int,role text,status text);
    CREATE TEMP TABLE billing_organization_memberships(organization_id int,user_id int,status text,role text);
    INSERT INTO users VALUES(1,NULL);
    INSERT INTO billing_organizations VALUES(101,'Synthetic',1,1,NOW());
    CREATE TEMP TABLE outreach_settings(user_id integer,business_profile_id integer DEFAULT 11,enable_auto_follow_up boolean,daily_email_limit integer,channel_follow_ups jsonb);
    CREATE TEMP TABLE leads(id integer,user_id integer,email text,phone text,blacklisted boolean,do_not_contact boolean,email_unsubscribed boolean);
    CREATE TEMP TABLE sent_messages(id integer,user_id integer,business_profile_id integer DEFAULT 11,follow_up_dispatches jsonb DEFAULT '{}',channel text,recipient_address text,lead_name text,bounced_at timestamp,status text,delivery_status text);
    CREATE TEMP TABLE outreach_conversations(id serial PRIMARY KEY,user_id integer,lead_id integer,channel text,provider_account_id text,lead_email text,status text,automation_mode text,session_ended_at timestamp);
    CREATE TEMP TABLE outreach_messages(id serial PRIMARY KEY,user_id integer,conversation_id integer,direction text,content text,subject text,html_content text,status text,
      business_profile_id integer DEFAULT 11,campaign_id integer,is_automatic boolean,sequence_step integer,follow_up_step integer,
      idempotency_key text UNIQUE,provider_account_id text,metadata jsonb,message_kind text,follow_up_origin_message_id integer,follow_up_cancelled_at timestamp,
      provider_call_state text DEFAULT 'not_started',manual_review_required boolean DEFAULT false,send_claimed_at timestamp,updated_at timestamp,created_at timestamp DEFAULT NOW(),sent_at timestamp,
      external_message_id text,provider_message_id text,rfc_message_id text,error_message text);
    CREATE UNIQUE INDEX follow_up_origin_step ON outreach_messages(follow_up_origin_message_id,follow_up_step)
      WHERE message_kind='follow_up' AND follow_up_origin_message_id IS NOT NULL AND follow_up_step IS NOT NULL;
    CREATE TEMP TABLE social_follow_up_schedules(id integer,delivery_message_id integer,user_id integer,business_profile_id integer,status text,cancelled_at timestamp,cancellation_reason text,version integer,updated_at timestamp);`);
  // Build synthetic TEMP tables with all fields selected by the real template/brand models.
  for (const [name, table] of [
    ['company_settings', companySettings],
    ['brand_toolkits', brandToolkitsTable],
    ['content_templates', contentTemplatesTable],
  ] as const) {
    const fields = Object.values(getTableColumns(table as PgTable))
      .map((column) => `"${column.name}" ${column.getSQLType()}`)
      .join(',');
    await client.query(`CREATE TEMP TABLE ${name} (${fields})`);
  }
});
afterAll(async () => {
  await client?.end();
});
beforeEach(async () => {
  jest.clearAllMocks();
  readinessInfrastructureFailure = false;
  confirmationInfrastructureFailure = false;
  beforeConfirmation = undefined;
  confirmationState = undefined;
  queryTrace.length = 0;
  queued.clear();
  await client.query(
    'TRUNCATE outreach_settings,leads,sent_messages,outreach_conversations,outreach_messages,content_templates,company_settings,brand_toolkits RESTART IDENTITY',
  );
  await client.query(
    'INSERT INTO outreach_settings(user_id,enable_auto_follow_up,daily_email_limit,channel_follow_ups) VALUES(1,true,200,$1)',
    [JSON.stringify({ email: config })],
  );
  await client.query(`INSERT INTO leads VALUES(73,1,'recipient@example.test','919876543210',false,false,false);
    INSERT INTO company_settings(id,user_id,company_name,is_approved,is_default,version,timezone,updated_at,billing_organization_id) VALUES(11,1,'Synthetic Business',true,true,1,'UTC',NOW(),101);
    INSERT INTO brand_toolkits(id,user_id,business_profile_id,name,is_active,is_default,is_approved,version,updated_at) VALUES(22,1,11,'Synthetic Brand',true,true,true,1,NOW());
    INSERT INTO content_templates(id,user_id,business_profile_id,brand_toolkit_id,type,version,content,subject,brand_context_snapshot,is_approved)
      VALUES(7,1,11,22,'email',1,'Synthetic message','Synthetic subject','{"provenance":{"businessProfile":{"version":1},"brandToolkit":{"version":1}}}',true);`);
  send.mockResolvedValue({
    success: true,
    messageId: 'accepted-native',
    providerMessageId: 'accepted-native',
    rfcMessageId: '<accepted@example.test>',
  });
  reserve.mockResolvedValue({ success: true, transactionId: 88 });
  refund.mockResolvedValue({ success: true });
});
async function followUp() {
  await client.query(`INSERT INTO outreach_conversations(user_id,lead_id,channel,provider_account_id,lead_email,status,automation_mode) VALUES(1,73,'email','account','recipient@example.test','active','ai_active');
    INSERT INTO outreach_messages(user_id,conversation_id,direction,content,status,message_kind,provider_account_id,metadata,sent_at)
      VALUES(1,1,'outbound','Original','sent','outreach','account','{"outreachCreation":{"version":1,"followUpSource":"channel_settings","delivery":{"channel":"email","leadId":73,"senderId":7,"recipientEmail":"recipient@example.test"}}}',NOW()-INTERVAL '1 day');`);
  // Use the real template snapshot, render clock and producer envelope/reservation/recovery.
  const payload = await scope(async () => {
    const { template } = await loadFollowUpTemplate(1, 'email', 7);
    const context = issueTemplateRenderContext(
      1,
      template.id,
      template.version,
      'UTC',
    );
    const rendered = renderFollowUpTemplate(template, {}, '', {
      now: new Date(context.renderedAt),
      timeZone: context.timeZone,
    });
    const provenance: FollowUpProvenance = {
      version: 1,
      userId: 1,
      businessProfileId: 11,
      channel: 'email',
      originTable: 'outreach_messages',
      originMessageId: 1,
      step: 1,
      settingsRevision: followUpSettingsRevision(config),
      templateId: template.id,
      templateVersion: template.version,
      templateRenderContext: context,
    };
    const dispatch = await configuredFollowUpDispatch('email', 1, 1, {
      ...generic().data,
      body: rendered.body,
      subject: rendered.subject,
      html: rendered.html,
      isFollowUp: true,
      useSavedFollowUpSettings: true,
      followUpProvenance: provenance,
    });
    const id = await reserveEmailFollowUp({
      originMessageId: 1,
      userId: 1,
      expectedCurrentStep: 0,
      step: 1,
      subject: rendered.subject,
      content: rendered.body,
      htmlContent: rendered.html,
      dispatch,
    });
    expect(id).toBe(2);
    expect(await recoverConfiguredFollowUpDispatches()).toBe(1);
    return queued.get(dispatch.jobId)!;
  });
  queryTrace.length = 0;
  return { ...generic(), data: payload };
}
describe('EMAIL_SENDING lifecycle acceptance: actual processor and PostgreSQL claim/policy', () => {
  it('F07 replay after acceptance keeps one provider dispatch and one durable message', async () => {
    const job = generic();
    expect(await run(job)).toMatchObject({ success: true });
    expect(await run(job)).toMatchObject({ success: true, duplicate: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await client.query(
          'SELECT status,provider_call_state FROM outreach_messages',
        )
      ).rows,
    ).toEqual([{ status: 'sent', provider_call_state: 'confirmed' }]);
    expect(send).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: 'email-queue:1',
        expectedCredentialId: 77,
      }),
      7,
    );
  });
  it('F07 an ambiguous receipt never automatically dispatches again', async () => {
    const job = generic();
    send.mockResolvedValue({ success: true });
    await run(job);
    await run(job);
    expect(send).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
    expect(
      (await client.query('SELECT status FROM outreach_messages')).rows[0]
        .status,
    ).toBe('manual_review');
  });
  it('F07 concurrent replay while provider is in progress cannot dispatch twice', async () => {
    let enter!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    send.mockImplementationOnce(async () => {
      enter();
      await gate;
      return { success: true, messageId: 'native' };
    });
    const job = generic(),
      first = run(job);
    await waiting;
    try {
      expect(await run(job)).toMatchObject({ inProgress: true });
    } finally {
      release();
      await first;
    }
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('F01/F07 a resumed stale preparer loses its provider-start claim', async () => {
    let enter!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    reserve.mockImplementationOnce(async () => {
      enter();
      await gate;
      return { success: true, transactionId: 87 };
    });
    const job = generic(),
      first = run(job);
    await waiting;
    try {
      await client.query(
        "UPDATE outreach_messages SET send_claimed_at=NOW()-INTERVAL '16 minutes'",
      );
      await run(job);
    } finally {
      release();
      await first;
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 87 }),
    );
  });
  it.each([
    'disabled',
    'takeover',
    'cancelled',
    'template changed',
    'settings ABA',
    'missing fence',
    'brand changed',
  ])('suppresses prepared follow-up after %s', async (kind) => {
    const job = await followUp();
    if (kind === 'missing fence') delete (job.data as any).followUpProvenance;
    reserve.mockImplementationOnce(async () => {
      if (kind === 'disabled')
        await client.query(
          'UPDATE outreach_settings SET enable_auto_follow_up=false',
        );
      if (kind === 'takeover')
        await client.query(
          "UPDATE outreach_conversations SET automation_mode='human_owned'",
        );
      if (kind === 'cancelled')
        await client.query(
          'UPDATE outreach_messages SET follow_up_cancelled_at=NOW() WHERE id=1',
        );
      if (kind === 'brand changed')
        await client.query('UPDATE content_templates SET is_approved=false');
      if (kind === 'template changed')
        await client.query('UPDATE content_templates SET version=2');
      if (kind === 'settings ABA')
        await client.query(
          `UPDATE outreach_settings SET channel_follow_ups=jsonb_set(channel_follow_ups,'{email,revision}','"second"')`,
        );
      return { success: true, transactionId: 88 };
    });
    expect(await run(job)).toMatchObject({ success: false, suppressed: true });
    expect(send).not.toHaveBeenCalled();
    expect(refund).toHaveBeenCalledTimes(1);
    expect(
      (await client.query('SELECT status FROM outreach_messages WHERE id=2'))
        .rows[0].status,
    ).toBe('cancelled');
  });
  it('sends a current enabled, approved and unchanged follow-up once', async () => {
    const job = await followUp();
    expect(await run(job)).toMatchObject({ success: true });
    await run(job);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('F09 daily limit zero leaves a generic send pending without calling provider', async () => {
    await client.query('UPDATE outreach_settings SET daily_email_limit=0');
    const job = generic();
    await expect(run(job)).rejects.toBeInstanceOf(DelayedError);
    expect(send).not.toHaveBeenCalled();
    expect(refund).toHaveBeenCalledTimes(1);
    expect(job.moveToDelayed).toHaveBeenCalled();
  });

  it.each(['readiness', 'confirmation'])(
    'keeps %s infrastructure failure retryable before any external send',
    async (kind) => {
      const job = await followUp();
      if (kind === 'readiness') readinessInfrastructureFailure = true;
      else confirmationInfrastructureFailure = true;
      await expect(run(job)).rejects.toThrow('database outage');
      expect(send).not.toHaveBeenCalled();
      expect(refund).toHaveBeenCalledTimes(1);
      expect(
        (
          await client.query(
            'SELECT status,provider_call_state FROM outreach_messages WHERE id=2',
          )
        ).rows[0],
      ).toEqual({ status: 'pending', provider_call_state: 'not_started' });
    },
  );
  it('preserves templateRenderContext through the provider mapping', async () => {
    const job = await followUp();
    await run(job);
    expect(send).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        templateRenderContext: (
          job.data.followUpProvenance as FollowUpProvenance
        ).templateRenderContext,
      }),
      7,
    );
  });
  it('real confirmation preserves the started reservation and lease token before one dispatch', async () => {
    const job = await followUp();
    send.mockImplementationOnce(async () => {
      const row = (
        await client.query(
          "SELECT status,provider_call_state,metadata->'queueEmail'->>'token' AS token FROM outreach_messages WHERE id=2",
        )
      ).rows[0];
      expect(row).toEqual(confirmationState);
      expect(row).toMatchObject({
        status: 'sending',
        provider_call_state: 'started',
        token: expect.any(String),
      });
      return {
        success: true,
        messageId: 'native',
        providerMessageId: 'native',
      };
    });
    expect(await run(job)).toMatchObject({ success: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['takeover', 'cancelled', 'reply', 'closed'])(
    'real final confirmation stops late %s after provider-start reservation',
    async (kind) => {
      const job = await followUp();
      beforeConfirmation = async () => {
        if (kind === 'takeover')
          await client.query(
            "UPDATE outreach_conversations SET automation_mode='human_owned'",
          );
        if (kind === 'cancelled')
          await client.query(
            'UPDATE outreach_messages SET follow_up_cancelled_at=NOW() WHERE id=1',
          );
        if (kind === 'reply')
          await client.query(
            "INSERT INTO outreach_messages(user_id,conversation_id,direction,content,message_kind,status) VALUES(1,1,'inbound','Synthetic reply','reply','received')",
          );
        if (kind === 'closed')
          await client.query(
            'UPDATE outreach_conversations SET session_ended_at=NOW()',
          );
      };
      expect(await run(job)).toMatchObject({
        success: false,
        suppressed: true,
      });
      expect(send).not.toHaveBeenCalled();
      expect(refund).toHaveBeenCalledTimes(1);
      expect(
        (
          await client.query(
            'SELECT status,provider_call_state FROM outreach_messages WHERE id=2',
          )
        ).rows[0],
      ).toEqual({ status: 'cancelled', provider_call_state: 'not_started' });
    },
  );
  it.each([
    'user',
    'business',
    'channel',
    'origin table',
    'origin ID',
    'step',
    'internal UUID',
    'tampered context',
  ])('rejects real queued provenance with mismatched %s', async (kind) => {
    const job = await followUp();
    const p = job.data.followUpProvenance as FollowUpProvenance;
    if (kind === 'user') p.userId = 2;
    if (kind === 'business') p.businessProfileId = 12;
    if (kind === 'channel') p.channel = 'sms';
    if (kind === 'origin table') p.originTable = 'sent_messages';
    if (kind === 'origin ID') p.originMessageId = 9;
    if (kind === 'step') p.step = 2;
    if (kind === 'internal UUID') p.settingsRevision = 'first';
    if (kind === 'tampered context')
      p.templateRenderContext = {
        ...p.templateRenderContext!,
        timeZone: 'Asia/Kolkata',
      };
    expect(await run(job)).toMatchObject({ success: false, suppressed: true });
    expect(send).not.toHaveBeenCalled();
    expect(refund).toHaveBeenCalledTimes(1);
  });
});
