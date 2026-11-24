import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope, requireBusinessScope } from '../tenancy/businessContext.js';
import { currentBillingScope, withBillingScope } from '../tenancy/billingContext.js';
import {
  newInstagramRule,
  emptyInstagramProfile,
  type InstagramRuleDefinition,
} from '../../shared/instagramAutomations.js';

const pgTests = process.env.INSTAGRAM_AUTOMATIONS_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase, fixture: Pool, admin: Pool, runtime: Pool, schema: string;
let providerReady = true, rolloutEnabled = true;
let beforeQuery: ((text: string) => Promise<void>) | undefined,
  afterQuery: ((text: string) => Promise<void>) | undefined;
const dialect = new PgDialect();
const proxy = new Proxy({} as NodePgDatabase, {
  get(_target, key) {
    if (key === 'execute')
      return async (query: Parameters<NodePgDatabase['execute']>[0]) => {
        const text = dialect.sqlToQuery(query as ReturnType<typeof sql>).sql;
        await beforeQuery?.(text);
        const result = await database.execute(query);
        await afterQuery?.(text);
        return result;
      };
    const value = database[key as keyof NodePgDatabase];
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
const privateReply = jest.fn<any>(),
  sendMessage = jest.fn<any>(),
  publicReply = jest.fn<any>(),
  followStatus = jest.fn<any>(),
  mediaIsReel = jest.fn<any>(),
  dispatch = jest.fn<any>(),
  publishProfile = jest.fn<any>(),
  verifyProfile = jest.fn<any>();
class AutomationError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
class ProviderError extends AutomationError {
  constructor(
    message: string,
    public uncertain = false
  ) {
    super(message, 502);
  }
}
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
jest.unstable_mockModule('../queues/JobDispatcher.js', () => ({
  jobDispatcher: { dispatch },
}));
const fixtureLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: fixtureLogger,
  createWorkerLogger: () => fixtureLogger,
}));
jest.unstable_mockModule('../events/EventBus.js', () => ({
  eventBus: { initialize: jest.fn(), publish: jest.fn(), close: jest.fn() }, EVENT_CHANNELS: {},
}));
jest.unstable_mockModule('../workers/NotificationEventConsumer.js', () => ({
  notificationEventConsumer: { start: jest.fn(), stop: jest.fn() },
}));
jest.unstable_mockModule('../tools/outreachSender.js', () => ({
  outreachSenderWorker: { start: jest.fn(), stop: jest.fn() },
}));
jest.unstable_mockModule('../models/failedJobs/functions.js', () => ({ insertFailedJob: jest.fn() }));
jest.unstable_mockModule('../controllers/webhooksController.js', () => ({
  sendInstagramCommentReply: publicReply,
}));
jest.unstable_mockModule('../services/instagramAutomations/InstagramAutomationProvider.js', () => ({
  InstagramAutomationError: AutomationError,
  InstagramProviderError: ProviderError,
  instagramAutomationsEnabled: () => rolloutEnabled,
  requireInstagramAutomationAccount: async (userId: number, accountId: string) => {
    const scope = requireBusinessScope();
    if (userId !== scope.userId || !['1001', '1002'].includes(accountId))
      throw new AutomationError('Account not found', 404);
    return {
      credential: {
        userId,
        businessProfileId: scope.businessProfileId,
        accountIdentifier: accountId,
        accountName: 'test',
      },
      connection: null,
    };
  },
  instagramAutomationReadiness: async () => ({
    enabled: true,
    messages: providerReady,
    comments: providerReady,
    profile: providerReady,
    richMessages: providerReady,
    reasons: [],
  }),
  InstagramAutomationProvider: class {
    assertReady = async () => {
      if (!providerReady) throw new AutomationError('Permission missing', 409);
    };
    sendPrivateReply = privateReply;
    sendMessage = sendMessage;
    followStatus = followStatus;
    publishProfile = publishProfile;
    verifyProfile = verifyProfile;
    mediaIsReel = mediaIsReel;
    verifyMedia = async () => undefined;
  },
}));
const { ingestInstagramAutomation, processInstagramAutomationRun, recoverInstagramAutomationRuns } =
  await import('../services/instagramAutomations/InstagramAutomationRuntime.js');
const {
  saveInstagramRule,
  listInstagramRules,
  saveInstagramProfile,
  getInstagramProfile,
  deleteInstagramRule,
  getInstagramAutomationOverview,
} = await import('../services/instagramAutomations/InstagramAutomationConfiguration.js');
// @ts-expect-error Custom migration runner uses JavaScript modules.
const migration = await import('../migrations/316_instagram_automations.js');
// @ts-expect-error Custom migration runner uses JavaScript modules.
const budgetIndex = await import('../migrations/318_instagram_private_reply_budget_index.js');
const scoped = <T>(work: () => T, profile = 101) =>
  withBusinessScope({ userId: 9, businessProfileId: profile }, work);
const definition = (): InstagramRuleDefinition => {
  const r = newInstagramRule('comment_dm');
  r.name = 'Send guide';
  r.trigger.keywords = ['guide'];
  r.message.text = 'Here is {{keyword}}, {{name}}.';
  return r;
};
const create = async (config = definition(), account = '1001') =>
  scoped(async () => {
    const row = (await saveInstagramRule(9, account, config)) as any;
    return (await saveInstagramRule(9, account, config, row.id, 'active', row.revision)) as any;
  });
const comment = async (
  id = 'c1',
  account = '1001',
  sender = 'reader',
  mediaProductType: string | null = 'REELS'
) =>
  scoped(() =>
    ingestInstagramAutomation(9, 20, {
      providerAccountId: account,
      externalSenderId: sender,
      messageId: id,
      messageText: 'please GUIDE',
      eventType: 'comment',
      timestamp: Date.now(),
      rawData: {
        text: 'please GUIDE',
        media: {
          id: 'media1',
          ...(mediaProductType ? { media_product_type: mediaProductType } : {}),
        },
        from: { id: sender, username: 'alex' },
      },
    })
  );
const message = async (id: string, text = 'DONE', sender = 'igsid-reader', payload?: string) =>
  scoped(() =>
    ingestInstagramAutomation(9, 20, {
      providerAccountId: '1001',
      externalSenderId: sender,
      messageId: id,
      messageText: text,
      eventType: 'message',
      timestamp: Date.now(),
      rawData: { automationPayload: payload },
    })
  );
const runs = async () =>
  (await fixture.query('SELECT * FROM instagram_automation_runs ORDER BY id')).rows;
const processRun = async (id: number) => scoped(() =>
  withBillingScope({ organizationId: 701, actorUserId: 9, businessProfileId: 101, businessOwnerUserId: 9 }, () =>
    processInstagramAutomationRun(9, id)));

pgTests('Instagram automation runtime and migration in isolated PostgreSQL', () => {
  beforeAll(async () => {
    dotenv.config({
      path: resolve(process.cwd(), '.env.development'),
      override: true,
      quiet: true,
    });
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || ''))
      throw new Error('Instagram QA requires local PostgreSQL.');
    const connection = {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      connectionTimeoutMillis: 5000,
    };
    schema = `ig_automation_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...connection, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture = new Pool({
      ...connection,
      max: 1,
      options: `-c search_path=${schema},public,pg_catalog`,
    });
    await fixture.query(`CREATE TABLE users(id integer PRIMARY KEY,name text,email text,deleted_at timestamptz,is_approved boolean DEFAULT true,is_setup_complete boolean DEFAULT true,is_verified boolean DEFAULT true,created_at timestamptz DEFAULT now());
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,archived_at timestamptz,is_default boolean DEFAULT true,billing_organization_id integer DEFAULT 701,company_name text,business_name text,name text DEFAULT 'Synthetic');
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read boolean,parent_links jsonb);
      CREATE TABLE business_profile_memberships(id serial,business_profile_id integer,user_id integer,email text,status text,role text DEFAULT 'member');
      CREATE TABLE business_profile_preferences(user_id integer,default_business_profile_id integer);
      CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer,name text,default_for_user_id integer,billing_eligibility_at timestamptz);
      CREATE TABLE billing_organization_memberships(organization_id integer,user_id integer,status text,role text);
      CREATE TABLE billing_admin_plan_terms(organization_id integer,starts_at timestamptz,ends_at timestamptz,cancelled_at timestamptz);
      CREATE TABLE subscription_settings(id integer PRIMARY KEY,enforced boolean,launched_at timestamptz,credential_id integer,published_catalog_version integer,capacity_enforced boolean);
      CREATE TABLE billing_subscriptions(id uuid PRIMARY KEY,organization_id integer,mode text,authorized boolean,cancel_at_period_end boolean,failure_at timestamptz,starts_at timestamptz,replaces_id uuid,status text);
      CREATE TABLE subscription_charges(subscription_id uuid,organization_id integer,refund_amount_paise integer,period_start timestamptz,period_end timestamptz);
      CREATE FUNCTION ${schema}.app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION ${schema}.app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
      CREATE FUNCTION ${schema}.app_business_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('app.business_system',true)='on' $$;
      CREATE FUNCTION ${schema}.app_business_access(profile integer) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_user<>'salesmarketing_business_runtime' OR current_setting('app.business_system',true)='on' OR profile=NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE TABLE crm_contacts(id integer PRIMARY KEY,user_id integer,business_profile_id integer,tags jsonb,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE leads(id integer PRIMARY KEY,user_id integer,business_profile_id integer,do_not_contact boolean);
      CREATE TABLE outreach_conversations(id integer PRIMARY KEY,user_id integer,business_profile_id integer,provider_account_id text,crm_contact_id integer,lead_id integer,status text);
      INSERT INTO users(id,name,email) VALUES(9,'Owner','owner@example.test'),(17,'Member','member@example.test');
      INSERT INTO company_settings(id,user_id) VALUES(101,9),(102,9);
      INSERT INTO business_profile_memberships(business_profile_id,user_id,email,status) VALUES(101,9,'owner@example.test','active'),(102,9,'owner@example.test','active'),(101,17,'member@example.test','active');
      INSERT INTO billing_organizations VALUES(701,9,'Synthetic',9,now()-interval '100 days');
      INSERT INTO subscription_settings VALUES(1,false,now()-interval '100 days',NULL,1,false);
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;`);
    const ownership = readFileSync(
      resolve(process.cwd(), 'migrations/299_business_profile_isolation.js'),
      'utf8'
    ).match(
      /CREATE OR REPLACE FUNCTION enforce_business_ownership\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$[\s\S]*?END \$\$/
    )?.[0];
    if (!ownership) throw new Error('Ownership guard source unavailable.');
    await fixture.query(
      `${ownership.replace('FUNCTION enforce_business_ownership()', `FUNCTION ${schema}.enforce_business_ownership()`)};`
    );
    await migration.up(fixture);
    await budgetIndex.up(fixture);
    await budgetIndex.down(fixture);
    await migration.down(fixture);
    expect((await fixture.query('SELECT count(*) FROM business_scope_tables')).rows[0].count).toBe(
      '0'
    );
    await migration.up(fixture);
    await budgetIndex.up(fixture);
    runtime = createBusinessScopedPool(
      new Pool({
        ...connection,
        max: 5,
        options: `-c search_path=${schema},public,pg_catalog`,
      })
    );
    database = drizzle(runtime);
    process.env.INSTAGRAM_AUTOMATIONS_ENABLED = 'true';
  }, 30000);
  afterAll(async () => {
    await runtime?.end();
    await fixture?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    providerReady = true;
    rolloutEnabled = true;
    beforeQuery = afterQuery = undefined;
    privateReply.mockResolvedValue({
      messageId: 'private-1',
      recipientId: 'igsid-reader',
    });
    sendMessage.mockResolvedValue({
      messageId: 'normal-1',
      recipientId: 'igsid-reader',
    });
    publicReply.mockResolvedValue({
      success: true,
      providerMessageId: 'public-1',
      outcomeUncertain: false,
    });
    followStatus.mockResolvedValue(true);
    mediaIsReel.mockResolvedValue(true);
    publishProfile.mockResolvedValue(undefined);
    verifyProfile.mockResolvedValue(undefined);
    dispatch.mockResolvedValue({});
    await fixture.query(`TRUNCATE instagram_automation_effects,instagram_automation_runs,instagram_automation_rules,instagram_automation_profiles RESTART IDENTITY CASCADE;
      TRUNCATE crm_contacts,leads,outreach_conversations;
      INSERT INTO crm_contacts VALUES(42,9,101,'[]',NULL,now()); INSERT INTO leads VALUES(5,9,101,false);
      INSERT INTO outreach_conversations VALUES(20,9,101,'1001',42,5,'active');`);
    await fixture.query(`UPDATE business_profile_memberships SET status='active'; UPDATE users SET is_approved=true;
      UPDATE company_settings SET billing_organization_id=701; UPDATE subscription_settings SET enforced=false;`);
  });
  it('creates paused rules, checks readiness on activation and protects optimistic revisions', async () => {
    const row = (await scoped(() => saveInstagramRule(9, '1001', definition()))) as any;
    expect(row.status).toBe('paused');
    providerReady = false;
    await expect(
      scoped(() => saveInstagramRule(9, '1001', definition(), row.id, 'active', 1))
    ).rejects.toThrow('Permission');
    providerReady = true;
    await scoped(() => saveInstagramRule(9, '1001', definition(), row.id, 'active', 1));
    await expect(
      scoped(() => saveInstagramRule(9, '1001', definition(), row.id, 'paused', 1))
    ).rejects.toThrow('changed');
  });
  it('isolates business profiles and accounts and enforces database RLS', async () => {
    const row = await create();
    expect(await scoped(() => listInstagramRules(9, '1002'))).toEqual([]);
    expect(await scoped(() => listInstagramRules(9, '1001'), 102)).toEqual([]);
    await expect(
      scoped(() => deleteInstagramRule(9, '1002', row.id, row.revision))
    ).rejects.toThrow('changed');
    const invisible = await scoped(
      () => database.execute(sql`SELECT * FROM instagram_automation_rules`),
      102
    );
    expect(invisible.rows).toEqual([]);
    await expect(
      scoped(() =>
        database.execute(
          sql`INSERT INTO instagram_automation_rules(user_id,business_profile_id,account_id,definition) VALUES(9,102,'1001','{}')`
        )
      )
    ).rejects.toThrow();
  });
  it('reserves the final hourly private-reply slot once across concurrent workers and defers before IO', async () => {
    await create(); await comment('candidate1'); await comment('candidate2');
    await fixture.query(`INSERT INTO instagram_automation_runs(user_id,business_profile_id,account_id,source_key,rule_name,definition,context,sender_id,status)
      SELECT 9,101,'1001','budget-'||n,'Budget fixture','{}','{}','budget-reader','sent' FROM generate_series(1,699) n;
      INSERT INTO instagram_automation_effects(user_id,business_profile_id,run_id,effect_key,status)
      SELECT 9,101,id,'private','sent' FROM instagram_automation_runs WHERE source_key LIKE 'budget-%';`);
    await Promise.all([processRun(1), processRun(2)]);
    expect(privateReply).toHaveBeenCalledTimes(1);
    const candidates = (await runs()).filter((run: any) => run.source_key.includes('candidate'));
    expect(candidates.map((run: any) => run.status).sort()).toEqual(['queued', 'sent']);
    const waiting = candidates.find((run: any) => run.status === 'queued');
    expect(waiting.context.notBefore).toBeGreaterThan(Date.now());
    expect((await fixture.query('SELECT * FROM instagram_automation_effects WHERE run_id=$1', [waiting.id])).rows).toHaveLength(0);
    await processRun(waiting.id); expect(privateReply).toHaveBeenCalledTimes(1);
    dispatch.mockClear(); await recoverInstagramAutomationRuns(); expect(dispatch).not.toHaveBeenCalled();
    await fixture.query("UPDATE instagram_automation_effects SET created_at=now()-interval '2 hours' WHERE run_id>2");
    await fixture.query("UPDATE instagram_automation_runs SET context=context||'{\"notBefore\":0}'::jsonb WHERE id=$1", [waiting.id]);
    await processRun(waiting.id); expect(privateReply).toHaveBeenCalledTimes(2);
  });
  it('deduplicates concurrent webhooks and worker jobs, tags once and acknowledges after the private reply', async () => {
    const r = definition();
    r.publicReplies = ['Check your DMs'];
    r.tags = ['guide'];
    await create(r);
    expect(await Promise.all([comment(), comment()])).toEqual([true, true]);
    expect(await runs()).toHaveLength(1);
    // A conflicting INSERT still consumes a sequence value; the winner can have either ID.
    const runId = (await runs())[0].id;
    await Promise.all([processRun(runId), processRun(runId)]);
    await processRun(runId);
    const finished = (await runs())[0];
    expect({ status: finished.status, reason: finished.reason, notBefore: finished.context.notBefore }).toEqual({ status: 'sent', reason: null, notBefore: undefined });
    expect(privateReply).toHaveBeenCalledTimes(1);
    expect(publicReply).toHaveBeenCalledTimes(1);
    expect(privateReply.mock.invocationCallOrder[0]).toBeLessThan(
      publicReply.mock.invocationCallOrder[0]
    );
    expect((await runs())[0].status).toBe('sent');
    expect((await fixture.query('SELECT tags FROM crm_contacts')).rows[0].tags).toEqual(['guide']);
  });
  it('selects one specific-media rule over a general rule and keeps a filtered match suppressed', async () => {
    await create();
    const r = definition();
    r.name = 'Specific';
    r.kind = 'comment_reply';
    r.publicReplies = ['Public guide'];
    r.trigger.scope = 'specific';
    r.trigger.mediaIds = ['media1'];
    r.filters.followers = 'followers';
    await create(r);
    followStatus.mockResolvedValue(null);
    expect(await comment()).toBe(true);
    await processRun(1);
    expect((await runs())[0]).toMatchObject({
      rule_name: 'Specific',
      status: 'skipped',
    });
    expect(privateReply).not.toHaveBeenCalled();
    expect(publicReply).not.toHaveBeenCalled();
    expect(await comment()).toBe(true);
  });
  it('freezes unmatched receipts so a retry cannot retroactively trigger a new rule', async () => {
    expect(await comment()).toBe(false);
    await create();
    expect(await comment()).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not let an earlier unmatched DONE replay fulfill a newly pending follow gate', async () => {
    expect(await message('earlier-done')).toBe(false);
    const config = definition();
    config.followGate.enabled = true;
    await create(config);
    await comment();
    const parent = (await runs()).find(run => run.definition.kind === 'comment_dm');
    await processRun(parent.id);
    const replayed = await message('earlier-done');
    for (const run of await runs()) await processRun(run.id);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(replayed).toBe(false);
    expect((await runs()).filter(run => run.definition.kind === 'follow_check')).toHaveLength(0);
  });
  it('freezes an event received while rollout is disabled across later enablement', async () => {
    await create();
    rolloutEnabled = false;
    expect(await comment('disabled-event')).toBe(false);
    rolloutEnabled = true;
    const replayed = await comment('disabled-event');
    for (const run of await runs()) await processRun(run.id);
    expect(privateReply).not.toHaveBeenCalled();
    expect(replayed).toBe(false);
    expect(await runs()).toHaveLength(1);
    expect((await runs())[0].status).toBe('unmatched');
  });
  it('keeps stale internal follow callbacks suppressed when replayed after a new prompt', async () => {
    const callback = () => message('stale-follow', 'DONE', 'igsid-reader', 'IGA_FOLLOW:1');
    expect(await callback()).toBe(true);
    const config = definition();
    config.followGate.enabled = true;
    await create(config);
    await comment();
    const parent = (await runs()).find(run => run.definition.kind === 'comment_dm');
    await processRun(parent.id);
    expect(await callback()).toBe(true);
    for (const run of await runs()) await processRun(run.id);
    expect(await runs()).toHaveLength(2);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await runs()).find(run => run.id === parent.id).status).toBe('waiting_follow');
  });
  it('does not look up media for a Reel rule whose keywords do not match', async () => {
    await create();
    const reel = definition();
    reel.name = 'Unrelated Reel';
    reel.trigger.scope = 'reels';
    reel.trigger.keywords = ['unrelated'];
    await create(reel);
    mediaIsReel.mockRejectedValue(new ProviderError('Media lookup unavailable'));

    expect(await comment('no-reel-keyword', '1001', 'reader', null)).toBe(true);
    await processRun(1);

    expect(mediaIsReel).not.toHaveBeenCalled();
    expect((await runs())[0]).toMatchObject({
      rule_name: 'Send guide',
      status: 'sent',
    });
    expect(privateReply).toHaveBeenCalledTimes(1);
  });
  it('delivers a matching specific-post rule before looking up a competing Reel rule', async () => {
    await create();
    const reel = definition();
    reel.name = 'Reel guide';
    reel.trigger.scope = 'reels';
    await create(reel);
    const specific = definition();
    specific.name = 'Specific guide';
    specific.trigger.scope = 'specific';
    specific.trigger.mediaIds = ['media1'];
    specific.message.text = 'The specific guide';
    await create(specific);
    mediaIsReel.mockRejectedValue(new ProviderError('Media lookup unavailable'));

    expect(await comment('specific-before-reel', '1001', 'reader', null)).toBe(true);
    await processRun(1);

    expect(mediaIsReel).not.toHaveBeenCalled();
    expect((await runs())[0]).toMatchObject({
      rule_name: 'Specific guide',
      status: 'sent',
    });
    expect(privateReply).toHaveBeenCalledTimes(1);
    expect(privateReply).toHaveBeenCalledWith('specific-before-reel', 'The specific guide');
  });
  it('durably suppresses a possible Reel match when media lookup fails instead of delivering a lower-priority rule', async () => {
    await create();
    const reel = definition();
    reel.name = 'Reel guide';
    reel.trigger.scope = 'reels';
    await create(reel);
    mediaIsReel.mockRejectedValue(new ProviderError('Media lookup unavailable'));

    expect(await comment('unconfirmed-reel', '1001', 'reader', null)).toBe(true);
    await processRun(1);
    expect((await runs())[0]).toMatchObject({
      rule_name: 'Reel guide',
      status: 'skipped',
    });
    expect((await runs())[0].reason).toMatch(/reel|media/i);

    mediaIsReel.mockResolvedValue(false);
    expect(await comment('unconfirmed-reel', '1001', 'reader', null)).toBe(true);
    await processRun(1);
    expect(await runs()).toHaveLength(1);
    expect(mediaIsReel).toHaveBeenCalledTimes(1);
    expect(privateReply).not.toHaveBeenCalled();
    expect(publicReply).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('serializes concurrent daily recipient limits without skipping both deliveries', async () => {
    const r = definition();
    r.filters.maxPerDay = 1;
    await create(r);
    await comment('c1');
    await comment('c2');
    await Promise.all([processRun(1), processRun(2)]);
    expect(privateReply).toHaveBeenCalledTimes(1);
    expect((await runs()).map((r) => r.status).sort()).toEqual(['sent', 'skipped']);
  });
  it('enforces repeat and cooldown limits on public replies as well as DMs', async () => {
    const r = definition();
    r.kind = 'comment_reply';
    r.publicReplies = ['Here is the guide'];
    r.filters.cooldownMinutes = 60;
    await create(r);
    await comment('c1');
    await processRun(1);
    await comment('c2');
    await processRun(2);
    expect(publicReply).toHaveBeenCalledTimes(1);
    expect((await runs())[1].status).toBe('skipped');
  });
  it('uses reservation time for daily limits when old queued comments are delivered today', async () => {
    const r = definition();
    r.filters.maxPerDay = 1;
    await create(r);
    await comment('old');
    await fixture.query("UPDATE instagram_automation_runs SET created_at=now()-interval '2 days'");
    await processRun(1);
    await comment('new');
    await processRun(2);
    expect(privateReply).toHaveBeenCalledTimes(1);
    expect((await runs())[1].reason).toContain('Daily');
  });
  it('keeps accepted effects within quota while their run is queued for recovery', async () => {
    const r = definition();
    r.filters.maxPerDay = 1;
    await create(r);
    await comment('first');
    await processRun(1);
    await fixture.query(
      "UPDATE instagram_automation_runs SET status='queued',private_message_id=NULL"
    );
    await comment('second');
    await processRun(2);
    expect(privateReply).toHaveBeenCalledTimes(1);
    expect((await runs())[1].status).toBe('skipped');
  });
  it('counts accepted provider effects separately from triggered runs', async () => {
    const r = definition();
    r.publicReplies = ['Check your DMs'];
    await create(r);
    await comment();
    await processRun(1);
    const overview = await scoped(() => getInstagramAutomationOverview(9, '1001'));
    expect(overview.stats).toMatchObject({
      triggers: 1,
      sent: 2,
      pending: 0,
    });
  });
  it('does not publicly acknowledge rejected or ambiguous private sends and never retries uncertainty', async () => {
    const r = definition();
    r.publicReplies = ['Check DMs'];
    await create(r);
    privateReply.mockRejectedValue(new ProviderError('Network timeout', true));
    await comment();
    await processRun(1);
    await processRun(1);
    await comment();
    expect((await runs())[0].status).toBe('uncertain');
    expect(publicReply).not.toHaveBeenCalled();
    expect(privateReply).toHaveBeenCalledTimes(1);
  });
  it('records deterministic message validation failures as failed effects without an uncertain delivery', async () => {
    const r = definition();
    r.publicReplies = ['Check your DMs'];
    await create(r);
    privateReply.mockRejectedValue(
      new AutomationError('Rendered DM text exceeds the provider limit.')
    );

    expect(await comment()).toBe(true);
    await processRun(1);
    expect(await comment()).toBe(true);
    await processRun(1);

    expect((await runs())[0]).toMatchObject({
      status: 'failed',
      reason: 'Rendered DM text exceeds the provider limit.',
    });
    const effects = (
      await fixture.query('SELECT effect_key,status,error FROM instagram_automation_effects')
    ).rows;
    expect(effects).toEqual([
      {
        effect_key: 'private',
        status: 'failed',
        error: 'Rendered DM text exceeds the provider limit.',
      },
    ]);
    expect((await scoped(() => getInstagramAutomationOverview(9, '1001'))).stats).toMatchObject({
      failed: 1,
      uncertain: 0,
      sent: 0,
    });
    expect(privateReply).toHaveBeenCalledTimes(1);
    expect(publicReply).not.toHaveBeenCalled();
  });
  it('requires verified follow, offers retry, and sends promised content once to the provider recipient ID', async () => {
    const r = definition();
    r.followGate.enabled = true;
    await create(r);
    await comment();
    await processRun(1);
    expect((await runs())[0].status).toBe('waiting_follow');
    followStatus.mockResolvedValue(null);
    expect(await message('m1')).toBe(true);
    await processRun(2);
    expect((await runs())[0].status).toBe('waiting_follow');
    expect((sendMessage.mock.calls[0][1] as { text: string }).text).toContain('HELP');
    followStatus.mockResolvedValue(true);
    expect(await message('m2')).toBe(true);
    await processRun(3);
    await processRun(3);
    expect((await runs())[0].status).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][0]).toBe('igsid-reader');
  });
  it('completes a DONE follow check for a rule with a maximum-length name', async () => {
    const r = definition();
    r.name = 'N'.repeat(120);
    r.followGate.enabled = true;
    await create(r);
    await comment();
    await processRun(1);

    expect(await message('long-name-done')).toBe(true);
    await processRun(2);

    const completed = await runs();
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ rule_name: r.name, status: 'sent' });
    expect(completed[1].status).toBe('sent');
    expect(completed[1].rule_name.length).toBeLessThanOrEqual(120);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe('igsid-reader');
  });
  it.each(['default', 'custom'] as const)(
    'includes exactly one DONE instruction in %s follow prompts and retries',
    async (mode) => {
      const r = definition();
      r.followGate.enabled = true;
      if (mode === 'custom') {
        r.followGate.prompt = 'Follow our account to receive your guide.';
        r.followGate.retryMessage = 'We could not confirm your follow yet.';
      }
      await create(r);
      await comment();
      await processRun(1);
      expect(String(privateReply.mock.calls[0][1]).match(/\bDONE\b/gi)).toHaveLength(1);

      followStatus.mockResolvedValue(false);
      expect(await message('retry-done')).toBe(true);
      await processRun(2);
      const retry = (sendMessage.mock.calls[0][1] as { text: string }).text;
      expect(retry.match(/\bDONE\b/gi)).toHaveLength(1);
      expect(retry).toMatch(/HELP/i);
      expect((await runs())[0].status).toBe('waiting_follow');
    }
  );
  it('retains the follow flow when only the public acknowledgement fails', async () => {
    const r = definition();
    r.followGate.enabled = true;
    r.publicReplies = ['Check DMs'];
    await create(r);
    publicReply.mockResolvedValue({
      success: false,
      providerMessageId: null,
      outcomeUncertain: false,
      error: 'Rejected',
    });
    await comment();
    await processRun(1);
    expect((await runs())[0].status).toBe('waiting_follow');
    expect((await scoped(() => getInstagramAutomationOverview(9, '1001'))).stats).toMatchObject({
      failed: 1,
      pending: 1,
      sent: 1,
    });
    expect(await message('done')).toBe(true);
    await processRun(2);
    expect((await runs())[0].status).toBe('sent');
  });
  it('claims promised content once across simultaneous verified follow checks', async () => {
    const r = definition();
    r.followGate.enabled = true;
    await create(r);
    await comment();
    await processRun(1);
    await message('m1');
    await message('m2');
    await Promise.all([processRun(2), processRun(3)]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((await runs())[0].status).toBe('sent');
    expect((await runs()).some((r) => r.status === 'uncertain')).toBe(false);
  });
  it('never returns a fulfilled follow gate to pending when the original acknowledgement finishes', async () => {
    const r = definition();
    r.followGate.enabled = true;
    r.publicReplies = ['Check your DMs'];
    await create(r);
    await comment();
    publicReply.mockImplementation(async () => {
      await message('quick-done');
      await processRun(2);
      return {
        success: true,
        providerMessageId: 'ack',
        outcomeUncertain: false,
      };
    });
    await processRun(1);
    expect((await runs())[0].status).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('does not reopen a follow gate while its promised send is in progress', async () => {
    const r = definition();
    r.followGate.enabled = true;
    r.publicReplies = ['Check DMs'];
    await create(r);
    await comment();
    let started!: () => void, release!: () => void, child!: Promise<void>;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendMessage.mockImplementation(async () => {
      started();
      await waitForRelease;
      return { messageId: 'promised' };
    });
    publicReply.mockImplementation(async () => {
      await message('done');
      child = processRun(2);
      await entered;
      return { success: true, providerMessageId: 'ack' };
    });
    await processRun(1);
    expect((await runs())[0].status).toBe('fulfilling');
    release();
    await child;
    expect((await runs())[0].status).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('marks the parent uncertain when promised delivery has an ambiguous outcome', async () => {
    const r = definition();
    r.followGate.enabled = true;
    await create(r);
    await comment();
    await processRun(1);
    sendMessage.mockRejectedValue(new ProviderError('Network timeout', true));
    await message('m1');
    await processRun(2);
    expect((await runs())[0].status).toBe('uncertain');
    expect(await message('m2')).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('rejects forged follow callbacks from another recipient and paused rules', async () => {
    const r = definition();
    r.followGate.enabled = true;
    const rule = await create(r);
    await comment();
    await processRun(1);
    await message('forged', 'DONE', 'other', 'IGA_FOLLOW:1');
    expect((await runs()).map(run => run.status)).toEqual(['waiting_follow', 'unmatched']);
    await scoped(() => saveInstagramRule(9, '1001', r, rule.id, 'paused', rule.revision));
    await message('m2');
    await processRun(3);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await runs())[2].status).toBe('skipped');
  });
  it.each(['pause', 'delete', 'opt_out', 'rollout'] as const)('suppresses the next public effect after %s during a private reply', async change => {
    const config = definition();
    config.publicReplies = ['Your guide is ready.'];
    const rule = await create(config);
    await comment();
    privateReply.mockImplementationOnce(async () => {
      if (change === 'opt_out') await fixture.query('UPDATE leads SET do_not_contact=true');
      else if (change === 'rollout') rolloutEnabled = false;
      else if (change === 'pause')
        await scoped(() => saveInstagramRule(9, '1001', config, rule.id, 'paused', rule.revision));
      else await scoped(() => deleteInstagramRule(9, '1001', rule.id, rule.revision));
      return { messageId: 'accepted-before-suppression', recipientId: 'igsid-reader' };
    });
    await processRun(1);
    expect(privateReply).toHaveBeenCalledTimes(1);
    expect(publicReply).not.toHaveBeenCalled();
    expect((await runs())[0]).toMatchObject({
      status: 'skipped',
      private_message_id: 'accepted-before-suppression',
      public_message_id: null,
    });
    expect((await fixture.query('SELECT effect_key,status FROM instagram_automation_effects ORDER BY id')).rows)
      .toEqual([{ effect_key: 'private', status: 'sent' }]);
  });
  it('suppresses promised content when opt-out changes during follow verification', async () => {
    const config = definition();
    config.followGate.enabled = true;
    await create(config);
    await comment();
    await processRun(1);
    await message('done-after-follow');
    followStatus.mockImplementationOnce(async () => {
      await fixture.query('UPDATE leads SET do_not_contact=true');
      return true;
    });
    await processRun(2);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await runs()).map(run => run.status)).toEqual(['skipped', 'skipped']);
    expect((await fixture.query("SELECT * FROM instagram_automation_effects WHERE effect_key='promised_content'")).rows).toHaveLength(0);
  });
  it('records suppression after a public intent without claiming delivery uncertainty', async () => {
    const config = definition();
    config.kind = 'comment_reply';
    config.publicReplies = ['Your guide is ready.'];
    await create(config);
    await comment();
    afterQuery = async text => {
      if (!text.startsWith('INSERT INTO instagram_automation_effects')) return;
      afterQuery = undefined;
      await fixture.query('UPDATE leads SET do_not_contact=true');
    };
    await processRun(1);
    expect(publicReply).not.toHaveBeenCalled();
    expect((await runs())[0].status).toBe('skipped');
    expect((await fixture.query('SELECT effect_key,status,error FROM instagram_automation_effects')).rows).toEqual([
      { effect_key: 'public', status: 'failed', error: 'The recipient is unavailable or has opted out.' },
    ]);
  });
  it('respects opt-out and token readiness changes after a run is queued', async () => {
    await create();
    await comment();
    await fixture.query('UPDATE leads SET do_not_contact=true');
    await processRun(1);
    expect((await runs())[0].status).toBe('skipped');
    await fixture.query('UPDATE leads SET do_not_contact=false');
    await comment('c2');
    providerReady = false;
    await processRun(2);
    expect((await runs())[1].status).toBe('failed');
    expect(privateReply).not.toHaveBeenCalled();
  });
  it('preserves drafts and prior published actions after provider sync failure', async () => {
    const config = emptyInstagramProfile();
    config.locales[0].questions = [{ id: 'q1', question: 'Hours?' }];
    const first = (await scoped(() =>
      saveInstagramProfile(9, '1001', 'icebreakers', config, 0, true)
    )) as any;
    expect(first.syncStatus).toBe('published');
    const changed = structuredClone(config);
    changed.locales[0].questions[0].question = 'Location?';
    publishProfile.mockRejectedValue(new ProviderError('Readback differs'));
    const failed = (await scoped(() =>
      saveInstagramProfile(9, '1001', 'icebreakers', changed, 1, true)
    )) as any;
    expect(failed.syncStatus).toBe('error');
    expect(failed.config).toEqual(changed);
    expect(failed.publishedConfig).toEqual(config);
    expect(await scoped(() => getInstagramProfile(9, '1002', 'icebreakers'))).toBeUndefined();
  });
  it('commits pending profile mappings before provider writes and reconciles after a lost final commit', async () => {
    const config = emptyInstagramProfile();
    config.locales[0].questions = [{ id: 'q1', question: 'Hours?' }];
    publishProfile.mockImplementation(async () => {
      const pending = (await fixture.query('SELECT * FROM instagram_automation_profiles')).rows[0];
      expect(pending.sync_status).toBe('syncing');
      expect(pending.config).toEqual(config);
      beforeQuery = async (text) => {
        if (text.includes('published_config=CASE'))
          throw new Error('Connection lost before commit');
      };
    });
    await expect(
      scoped(() => saveInstagramProfile(9, '1001', 'icebreakers', config, 0, true))
    ).rejects.toThrow('Connection lost');
    expect((await scoped(() => getInstagramProfile(9, '1001', 'icebreakers')))?.syncStatus).toBe(
      'syncing'
    );
    await expect(
      scoped(() => saveInstagramProfile(9, '1001', 'icebreakers', config, 1, false))
    ).rejects.toThrow('still being verified');
    beforeQuery = undefined;
    await fixture.query(
      "UPDATE instagram_automation_profiles SET updated_at=now()-interval '10 minutes'"
    );
    await recoverInstagramAutomationRuns();
    expect(verifyProfile).toHaveBeenCalledWith('icebreakers', config, false);
    expect(
      (await scoped(() => getInstagramProfile(9, '1001', 'icebreakers')))?.publishedConfig
    ).toEqual(config);
    expect(publishProfile).toHaveBeenCalledTimes(1);
  });
  it('does not expose draft menu content and deduplicates published action postbacks', async () => {
    const config = emptyInstagramProfile();
    config.locales[0].items = [
      {
        id: 'menu1',
        title: 'Prices',
        type: 'action',
        url: '',
        payload: 'PRICES',
        response: { ...definition().message, text: 'The price list' },
      },
    ];
    await scoped(() => saveInstagramProfile(9, '1001', 'menu', config, 0, false));
    expect(await message('draft', 'Prices', 'igsid-reader', 'IGA_MENU_PRICES')).toBe(true);
    await processRun(1);
    expect((sendMessage.mock.calls[0][1] as { text: string }).text).toMatch(/menu.*changed/i);
    expect((sendMessage.mock.calls[0][1] as { text: string }).text).not.toContain('The price list');
    await scoped(() => saveInstagramProfile(9, '1001', 'menu', config, 1, true));
    await message('published', 'Prices', 'igsid-reader', 'IGA_MENU_PRICES');
    await processRun(2);
    await message('published', 'Prices', 'igsid-reader', 'IGA_MENU_PRICES');
    await processRun(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect((sendMessage.mock.calls[1][1] as { text: string }).text).toBe('The price list');
    expect((await runs())[1].status).toBe('sent');
  });
  it('answers a stale menu selection with refresh instructions once after the action is replaced', async () => {
    const config = emptyInstagramProfile();
    config.locales[0].items = [
      {
        id: 'prices',
        title: 'Prices',
        type: 'action',
        url: '',
        payload: 'PRICES',
        response: {
          ...definition().message,
          text: 'The previous price list',
        },
      },
    ];
    await scoped(() => saveInstagramProfile(9, '1001', 'menu', config, 0, true));
    config.locales[0].items = [
      {
        id: 'hours',
        title: 'Hours',
        type: 'action',
        url: '',
        payload: 'HOURS',
        response: { ...definition().message, text: 'The opening hours' },
      },
    ];
    await scoped(() => saveInstagramProfile(9, '1001', 'menu', config, 1, true));

    expect(await message('old-choice', 'Prices', 'igsid-reader', 'IGA_MENU_PRICES')).toBe(true);
    await processRun(1);
    expect(await message('old-choice', 'Prices', 'igsid-reader', 'IGA_MENU_PRICES')).toBe(true);
    await processRun(1);

    expect(await runs()).toHaveLength(1);
    expect((await runs())[0].status).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const response = (sendMessage.mock.calls[0][1] as { text: string }).text;
    expect(response).toMatch(/menu.*changed/i);
    expect(response).toMatch(/refresh|reopen/i);
    expect(response).not.toContain('The previous price list');
    expect(response).not.toContain('The opening hours');
  });
  it('rechecks stale recovery inventory after another worker completes the run', async () => {
    await create();
    await comment();
    await fixture.query(
      "UPDATE instagram_automation_runs SET status='running',updated_at=now()-interval '10 minutes'"
    );
    dispatch.mockClear();
    afterQuery = async (text) => {
      if (text.includes('SELECT id,user_id,business_profile_id FROM instagram_automation_runs'))
        await fixture.query("UPDATE instagram_automation_runs SET status='sent',updated_at=now()");
    };
    await recoverInstagramAutomationRuns();
    expect((await runs())[0].status).toBe('sent');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('recovers an interrupted follow claim without replaying the original comment', async () => {
    const r = definition();
    r.followGate.enabled = true;
    await create(r);
    await comment();
    await processRun(1);
    await fixture.query(
      `UPDATE instagram_automation_runs SET status='recovering',context=context||'{"fulfilling":true}'::jsonb,updated_at=now()-interval '10 minutes'`
    );
    dispatch.mockClear();
    await recoverInstagramAutomationRuns();
    expect((await runs())[0].status).toBe('waiting_follow');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('recovers stale work without retrying an unconfirmed effect', async () => {
    await create();
    await comment();
    await fixture.query(
      "UPDATE instagram_automation_runs SET status='running',updated_at=now()-interval '10 minutes'"
    );
    await scoped(() =>
      database.execute(
        sql`INSERT INTO instagram_automation_effects(user_id,business_profile_id,run_id,effect_key,status) VALUES(9,101,1,'private','sending')`
      )
    );
    await recoverInstagramAutomationRuns();
    expect((await runs())[0].status).toBe('uncertain');
    expect(privateReply).not.toHaveBeenCalled();
  });

  const redisTests = process.env.INSTAGRAM_AUTOMATIONS_REDIS_QA === '1' ? describe : describe.skip;
  redisTests('immutable origin through actual GENERAL/OUTREACH workers and subscription gate', () => {
    let registry: typeof import('../queues/index.js');
    let workerModule: typeof import('../workers/index.js');
    let queue: import('bullmq').Queue, events: import('bullmq').QueueEvents;
    let generalEvents: import('bullmq').QueueEvents;
    let queued: string[];
    let attempted: Array<{ payload: Record<string, unknown>; businessActor: number; billingActor?: number }>;
    beforeEach(async () => {
      registry = await import('../queues/index.js');
      workerModule = await import('../workers/index.js');
      const { QueueEvents } = await import('bullmq');
      const connection = { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 56389) };
      if (!['127.0.0.1', 'localhost', '::1'].includes(connection.host))
        throw new Error('Instagram authority QA requires disposable local Redis.');
      await registry.queueRegistry.initialize();
      jest.spyOn(registry.queueRegistry, 'addRepeatableJob').mockResolvedValue(undefined);
      queue = registry.queueRegistry.getQueue(registry.QUEUE_NAMES.OUTREACH);
      await queue.drain();
      events = new QueueEvents(registry.QUEUE_NAMES.OUTREACH, { connection });
      generalEvents = new QueueEvents(registry.QUEUE_NAMES.GENERAL, { connection });
      await Promise.all([events.waitUntilReady(), generalEvents.waitUntilReady()]);
      queued = [];
      attempted = [];
      dispatch.mockImplementation(async (name: string, payload: { userId: number; runId: number }) => {
        attempted.push({ payload: { ...payload }, businessActor: requireBusinessScope().actorUserId ?? requireBusinessScope().userId, billingActor: currentBillingScope()?.actorUserId });
        const jobId = await registry.queueRegistry.addJob(registry.QUEUE_NAMES.OUTREACH, name,
          { ...payload, createdAt: new Date().toISOString() }, { attempts: 1, removeOnComplete: false, removeOnFail: false });
        queued.push(jobId);
        return { jobId };
      });
    });
    afterEach(async () => {
      await workerModule?.stopAllWorkers();
      await Promise.all([events?.close(), generalEvents?.close()]);
      const { closeRedisConnections } = await import('../infrastructure/redis.js');
      await closeRedisConnections();
    });
    const ingestAs = async (actorUserId: number, followGate = false) => {
      const config = definition();
      config.followGate.enabled = followGate;
      await create(config);
      await withBusinessScope({ userId: 9, businessProfileId: 101, actorUserId }, () =>
        withBillingScope({ organizationId: 701, actorUserId, businessProfileId: 101, businessOwnerUserId: 9 }, () =>
          ingestInstagramAutomation(9, 20, { providerAccountId: '1001', externalSenderId: 'reader', messageId: 'origin-event', messageText: 'guide', eventType: 'comment', timestamp: Date.now(), rawData: { text: 'guide', media: { id: 'media1', media_product_type: 'REELS' } } })));
      return (await queue.getJob(queued[0]))!;
    };
    const recoverThroughWorker = async () => {
      const general = registry.queueRegistry.getQueue(registry.QUEUE_NAMES.GENERAL);
      const job = await general.add('audit-recover-instagram', { userId: 0, systemJob: true, type: 'cron-instagram-automation-recovery' }, { attempts: 1 });
      await job.waitUntilFinished(generalEvents, 10000);
    };
    it('rejects revoked original and recovery work without replacing actor 17 with owner 9', async () => {
      const original = await ingestAs(17);
      expect(original.data).toMatchObject({ businessActorUserId: 17, billingActorUserId: 17, billingOrganizationId: 701 });
      await fixture.query("UPDATE business_profile_memberships SET status='removed' WHERE user_id=17");
      await workerModule.startAllWorkers();
      await expect(original.waitUntilFinished(events, 10000)).rejects.toThrow(/staff access|available/i);
      expect(privateReply).not.toHaveBeenCalled();
      await recoverThroughWorker();
      for (const jobId of queued.slice(1)) await (await queue.getJob(jobId))!.waitUntilFinished(events, 10000).catch(() => undefined);
      expect(privateReply).not.toHaveBeenCalled();
      expect(attempted.at(-1)).toMatchObject({ businessActor: 17, billingActor: 17, payload: { businessActorUserId: 17, billingActorUserId: 17, billingOrganizationId: 701 } });
      expect((await runs())[0]).toMatchObject({ status: 'failed', context: { queueIdentity: { businessActorUserId: 17, billingActorUserId: 17 } } });
    }, 20000);
    it('recovers legitimate owner-origin work through the actual outer subscription gate', async () => {
      const original = await ingestAs(9);
      await original.remove();
      let checkedSubscription = false;
      afterQuery = async text => { if (text.includes('FROM subscription_settings')) checkedSubscription = true; };
      await workerModule.startAllWorkers();
      await recoverThroughWorker();
      const replacement = (await queue.getJob(queued[1]))!;
      expect(replacement.data).toMatchObject({ businessActorUserId: 9, billingActorUserId: 9, billingOrganizationId: 701 });
      await replacement.waitUntilFinished(events, 10000);
      expect(checkedSubscription).toBe(true);
      expect(privateReply).toHaveBeenCalledTimes(1);
      expect((await runs())[0].status).toBe('sent');
    }, 20000);
    it.each(['missing', 'invalid', 'missing_with_intent'] as const)('keeps legacy %s identity unsent and reviewable during recovery', async state => {
      const original = await ingestAs(9);
      await original.remove();
      await fixture.query(state !== 'invalid'
        ? "UPDATE instagram_automation_runs SET context=context-'queueIdentity'"
        : "UPDATE instagram_automation_runs SET context=jsonb_set(context,'{queueIdentity}','{\"version\":0}'::jsonb)");
      if (state === 'missing_with_intent') await fixture.query(`INSERT INTO instagram_automation_effects(user_id,business_profile_id,run_id,effect_key,status)
        VALUES(9,101,1,'private','sending')`);
      dispatch.mockClear();
      await workerModule.startAllWorkers();
      await recoverThroughWorker();
      for (const jobId of queued.slice(1)) await (await queue.getJob(jobId))!.waitUntilFinished(events, 10000).catch(() => undefined);
      expect(dispatch).not.toHaveBeenCalled();
      expect(privateReply).not.toHaveBeenCalled();
      expect((await runs())[0]).toMatchObject({ status: state === 'missing_with_intent' ? 'uncertain' : 'failed', reason: expect.stringMatching(/identity/i) });
    }, 20000);
    it('does not replace the original billing organization after the business payer changes', async () => {
      const original = await ingestAs(9);
      await original.remove();
      await fixture.query(`INSERT INTO billing_organizations VALUES(702,9,'Changed payer',9,now());
        UPDATE company_settings SET billing_organization_id=702;`);
      await workerModule.startAllWorkers();
      await recoverThroughWorker();
      for (const jobId of queued.slice(1)) await (await queue.getJob(jobId))!.waitUntilFinished(events, 10000).catch(() => undefined);
      expect(privateReply).not.toHaveBeenCalled();
      expect(attempted.at(-1)).toMatchObject({ billingActor: 9, payload: { billingOrganizationId: 701, billingActorUserId: 9 } });
      expect((await runs())[0]).toMatchObject({ status: 'failed', context: { queueIdentity: { billingOrganizationId: 701 } } });
    }, 20000);
    it('rejects an already-queued legacy run before any provider effect', async () => {
      const original = await ingestAs(9);
      await fixture.query("UPDATE instagram_automation_runs SET context=context-'queueIdentity'");
      await workerModule.startAllWorkers();
      await expect(original.waitUntilFinished(events, 10000)).rejects.toThrow(/identity/i);
      expect(privateReply).not.toHaveBeenCalled();
      expect((await runs())[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/identity/i) });
    }, 20000);
    it('rejects recovered owner work when the actual subscription gate denies it', async () => {
      const original = await ingestAs(9);
      await original.remove();
      await fixture.query('UPDATE subscription_settings SET enforced=true');
      await workerModule.startAllWorkers();
      await recoverThroughWorker();
      await expect((await queue.getJob(queued[1]))!.waitUntilFinished(events, 10000)).rejects.toThrow(/subscription/i);
      expect(privateReply).not.toHaveBeenCalled();
    }, 20000);
    it('does not transfer promised-content authority to a later owner-scoped callback', async () => {
      const original = await ingestAs(17, true);
      await workerModule.startAllWorkers();
      await original.waitUntilFinished(events, 10000);
      expect((await runs())[0].status).toBe('waiting_follow');
      await fixture.query("UPDATE business_profile_memberships SET status='removed' WHERE user_id=17");
      await message('fresh-owner-done');
      for (const jobId of queued.slice(1)) await (await queue.getJob(jobId))!.waitUntilFinished(events, 10000).catch(() => undefined);
      expect(sendMessage).not.toHaveBeenCalled();
      expect((await runs())[1]).toMatchObject({ status: 'failed', context: { queueIdentity: { businessActorUserId: 17, billingActorUserId: 17 } } });
    }, 20000);
    it('rejects a conflicting fresh billing actor rather than replacing it with the business actor', async () => {
      await create();
      dispatch.mockClear();
      await expect(withBusinessScope({ userId: 9, businessProfileId: 101, actorUserId: 17 }, () =>
        withBillingScope({ organizationId: 701, actorUserId: 9, businessProfileId: 101, businessOwnerUserId: 9 }, () =>
          ingestInstagramAutomation(9, 20, { providerAccountId: '1001', externalSenderId: 'reader', messageId: 'conflicting-origin', messageText: 'guide', eventType: 'comment', timestamp: Date.now(), rawData: { text: 'guide', media: { id: 'media1', media_product_type: 'REELS' } } }))))
        .rejects.toThrow(/actor|billing/i);
      expect(dispatch).not.toHaveBeenCalled();
      expect(privateReply).not.toHaveBeenCalled();
      expect(await runs()).toHaveLength(0);
    });
    it.each(['businessActorUserId', 'billingActorUserId', 'both'] as const)('rejects a conflicting %s at the worker boundary', async field => {
      const original = await ingestAs(17);
      await original.remove();
      const conflict = field === 'both' ? { businessActorUserId: 9, billingActorUserId: 9 } : { [field]: 9 };
      const conflicting = await queue.add('process_instagram_automation', { ...original.data, ...conflict }, { attempts: 1 });
      await workerModule.startAllWorkers();
      await expect(conflicting.waitUntilFinished(events, 10000)).rejects.toThrow();
      expect(privateReply).not.toHaveBeenCalled();
    }, 20000);
  });
});
