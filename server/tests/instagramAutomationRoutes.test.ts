/**
 * HTTP contracts use the real router, account resolver, configuration service,
 * provider adapter, validators and RLS. Only session establishment is replaced
 * by fixture identities; every Meta request is intercepted by the fetch mock.
 * Run with INSTAGRAM_AUTOMATIONS_LOCAL_QA=1 against local PostgreSQL.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import dotenv from 'dotenv';
import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { metaPageConnectionsTable } from '../models/metaPageConnections/schema.js';
import { adminApiCredentialsTable } from '../models/adminApiCredentials/schema.js';
import {
  emptyInstagramMessage,
  newInstagramRule,
  type InstagramProfileConfig,
} from '../../shared/instagramAutomations.js';

const pgTests = process.env.INSTAGRAM_AUTOMATIONS_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase,
  fixture: Pool,
  admin: Pool,
  runtime: Pool,
  schema: string,
  browserServer: Server | undefined;
const databaseProxy = new Proxy({} as NodePgDatabase, {
  get(_target, key) {
    const value = database[key as keyof NodePgDatabase];
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
const logError = jest.fn();
jest.unstable_mockModule('../models/db.js', () => ({ db: databaseProxy }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: logError },
}));
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticateToken: async (req: Request, res: ExpressResponse, next: NextFunction) => {
    const actor =
      req.headers.authorization === 'Bearer fixture-owner'
        ? 9
        : req.headers.authorization === 'Bearer fixture-other'
          ? 10
          : 0;
    if (!actor) return res.status(401).json({ error: 'A fixture session is required.' });
    const profile = Number(req.headers['x-business-profile-id'] || (actor === 9 ? 101 : 103));
    const result = await fixture.query(
      'SELECT user_id FROM company_settings WHERE id=$1 AND user_id=$2',
      [profile, actor]
    );
    if (!result.rows.length)
      return res.status(403).json({ error: 'The fixture session cannot access this profile.' });
    req.user = { id: actor } as Request['user'];
    return withBusinessScope({ userId: actor, businessProfileId: profile }, next);
  },
}));
const { default: router } = await import('../routes/instagramAutomations.routes.js');
const { clearGraphApiVersionCache } = await import('../utils/metaApiVersion.js');
// @ts-expect-error The custom migration runner consumes JavaScript modules.
const migration = await import('../migrations/316_instagram_automations.js');
const app = express().use(express.json()).use('/api/instagram/automations', router);
const base = '/api/instagram/automations';
const api = (
  method: 'get' | 'put' | 'post' | 'delete',
  path = '/1001',
  profile = 101,
  actor = 'fixture-owner'
) =>
  request(app)[method](`${base}${path}`)
    .set('Authorization', `Bearer ${actor}`)
    .set('x-business-profile-id', String(profile));
const definition = (name = 'Guide') => {
  const value = newInstagramRule('comment_dm');
  value.name = name;
  value.trigger.keywords = ['guide'];
  value.message.text = 'Here is the requested guide.';
  return value;
};
const profile = (kind: 'icebreakers' | 'menu'): InstagramProfileConfig => ({
  locales: [
    {
      locale: 'default',
      questions: kind === 'icebreakers' ? [{ id: 'hours', question: 'When are you open?' }] : [],
      items:
        kind === 'menu'
          ? [
              {
                id: 'pricing',
                title: 'Pricing',
                type: 'action',
                url: '',
                payload: 'PRICES',
                response: { ...emptyInstagramMessage(), text: 'Our prices start at 20.' },
              },
              {
                id: 'site',
                title: 'Website',
                type: 'link',
                url: 'https://example.test',
                payload: '',
                response: emptyInstagramMessage(),
              },
            ]
          : [],
    },
  ],
});
const createRule = async (value = definition(), account = '1001', businessProfile = 101) => {
  const response = await api('post', `/${account}/rules`, businessProfile)
    .send({ definition: value })
    .expect(200);
  return response.body.data;
};
const providerProfiles = new Map<string, unknown>();
const allFields = ['messages', 'messaging_postbacks', 'comments'];
let subscribedFields: string[];
let providerFailure: 'reject' | 'readback' | 'network' | null;
const providerCalls = () => jest.mocked(globalThis.fetch).mock.calls;
const providerWrites = () => providerCalls().filter(([, options]) => options?.method !== 'GET');
const originalEnabled = process.env.INSTAGRAM_AUTOMATIONS_ENABLED;
const originalTestAccounts = process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS;

async function createLookupTable(table: PgTable, scoped: boolean) {
  const config = getTableConfig(table);
  // Lookup fixtures retain production column names/types; migration 316 itself
  // creates the exact automation schema, constraints, indexes and ownership guards.
  await fixture.query(
    `CREATE TABLE ${config.name} (${config.columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`).join(',')})`
  );
  await fixture.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ${config.name} TO salesmarketing_business_runtime`
  );
  if (scoped)
    await fixture.query(`ALTER TABLE ${config.name} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${config.name} FORCE ROW LEVEL SECURITY;
    CREATE POLICY fixture_business_isolation ON ${config.name} USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));`);
}

pgTests('Instagram automation HTTP workflows with real scoped PostgreSQL', () => {
  beforeAll(async () => {
    // Parse local connection settings without replacing process environment or
    // loading any real integration tokens into the isolated fixture database.
    const env = dotenv.parse(readFileSync(resolve(process.cwd(), '.env.development')));
    if (!['localhost', '127.0.0.1', '::1'].includes(env.DB_HOST || ''))
      throw new Error('Instagram route QA requires local PostgreSQL.');
    const connection = {
      host: env.DB_HOST,
      port: Number(env.DB_PORT || 5432),
      database: env.DB_NAME || env.DB_DATABASE,
      user: env.DB_USER,
      password: env.DB_PASSWORD || '',
      connectionTimeoutMillis: 5000,
    };
    schema = `ig_routes_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...connection, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture = new Pool({
      ...connection,
      max: 1,
      options: `-c search_path=${schema},public,pg_catalog`,
    });
    await fixture.query(`CREATE TABLE users(id integer PRIMARY KEY,name text,email text);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer);
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read boolean,parent_links jsonb);
      CREATE TABLE business_profile_memberships(business_profile_id integer,user_id integer,email text,status text);
      CREATE FUNCTION ${schema}.app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION ${schema}.app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
      CREATE FUNCTION ${schema}.app_business_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('app.business_system',true)='on' $$;
      CREATE FUNCTION ${schema}.app_business_access(profile integer) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_user<>'salesmarketing_business_runtime' OR current_setting('app.business_system',true)='on' OR profile=NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      INSERT INTO users VALUES(9,'Owner','owner@example.test'),(10,'Other','other@example.test');
      INSERT INTO company_settings VALUES(101,9),(102,9),(103,10);
      INSERT INTO business_profile_memberships VALUES(101,9,'owner@example.test','active'),(102,9,'owner@example.test','active'),(103,10,'other@example.test','active');
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
    await createLookupTable(channelCredentialsTable, true);
    await createLookupTable(metaPageConnectionsTable, true);
    await createLookupTable(adminApiCredentialsTable, false);
    runtime = createBusinessScopedPool(
      new Pool({ ...connection, max: 5, options: `-c search_path=${schema},public,pg_catalog` })
    );
    database = drizzle(runtime);
  }, 90000);

  const resetFixture = async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    clearGraphApiVersionCache();
    process.env.INSTAGRAM_AUTOMATIONS_ENABLED = 'true';
    delete process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS;
    subscribedFields = [...allFields];
    providerFailure = null;
    providerProfiles.clear();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://graph.instagram.com')
        throw new Error('Unexpected external request blocked by the route test.');
      if (providerFailure === 'network') throw new Error('Simulated Meta timeout');
      if (providerFailure === 'reject')
        return Response.json(
          { error: { code: 200, message: 'Sensitive provider diagnostic' } },
          { status: 403 }
        );
      if (url.pathname.endsWith('/subscribed_apps'))
        return Response.json({ data: [{ subscribed_fields: subscribedFields }] });
      if (url.pathname.endsWith('/messenger_profile')) {
        const body = options?.body ? JSON.parse(String(options.body)) : {};
        if (options?.method === 'POST')
          Object.entries(body).forEach(([field, value]) =>
            providerProfiles.set(`${url.pathname}:${field}`, value)
          );
        if (options?.method === 'DELETE')
          for (const field of body.fields) providerProfiles.delete(`${url.pathname}:${field}`);
        if (options?.method !== 'GET') return Response.json({ success: true });
        const field = url.searchParams.get('fields')!;
        const groups =
          providerFailure === 'readback'
            ? []
            : providerProfiles.get(`${url.pathname}:${field}`) || [];
        return Response.json({ data: field === 'ice_breakers' ? groups : [{ [field]: groups }] });
      }
      if (url.pathname.endsWith('/media')) {
        if (url.searchParams.get('after') === 'next-page')
          return Response.json({
            data: [
              {
                id: 'media-2',
                media_type: 'VIDEO',
                permalink: 'https://www.instagram.com/reel/fixture2/',
              },
            ],
          });
        return Response.json({
          data: [
            {
              id: 'media-1',
              media_type: 'IMAGE',
              permalink: 'https://www.instagram.com/p/fixture1/',
            },
          ],
          paging: { next: 'https://graph.instagram.com/next', cursors: { after: 'next-page' } },
        });
      }
      if (url.searchParams.get('fields') === 'owner')
        return Response.json({
          owner: { id: url.pathname.endsWith('/foreign-media') ? '1002' : '1001' },
        });
      throw new Error(`Unexpected mocked Meta operation ${url.pathname}`);
    });
    await fixture.query(`TRUNCATE instagram_automation_effects,instagram_automation_runs,instagram_automation_rules,instagram_automation_profiles RESTART IDENTITY CASCADE;
      TRUNCATE channel_credentials,meta_page_connections,admin_api_credentials RESTART IDENTITY;`);
    const scopes = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
    for (const [id, user, business, account] of [
      [1, 9, 101, '1001'],
      [2, 9, 101, '1002'],
      [3, 9, 102, '1003'],
      [4, 10, 103, '1004'],
    ] as const) {
      await fixture.query(
        `INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,credential_type,access_token,session_data,account_identifier,account_name,is_active,is_selected,granted_scopes)
        VALUES($1,$2,$3,'instagram_api','oauth',$4,'{"useInstagramLogin":true}'::jsonb,$5,$6,true,$7,$8::jsonb)`,
        [
          id,
          user,
          business,
          `fixture-token-${account}`,
          account,
          `test_${account}`,
          id === 1,
          JSON.stringify(scopes),
        ]
      );
      await fixture.query(
        `INSERT INTO meta_page_connections(id,user_id,business_profile_id,page_id,page_access_token,user_access_token,instagram_account_id,instagram_username,is_active,instagram_active,webhook_subscribed)
        VALUES($1,$2,$3,$4,'fixture-page','fixture-user',$4,$5,true,true,true)`,
        [id, user, business, account, `test_${account}`]
      );
    }
    await fixture.query(
      `INSERT INTO admin_api_credentials(id,platform,name,api_key,is_encrypted,is_active,priority,config)
      VALUES(1,'meta_app','Fixture app','fixture-app',false,true,'normal',$1::jsonb)`,
      [
        JSON.stringify({
          apiVersion: 'v25.0',
          appReviewPermissions: Object.fromEntries(scopes.map((scope) => [scope, 'approved'])),
        }),
      ]
    );
  };
  beforeEach(resetFixture);

  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    await new Promise<void>((resolve) =>
      browserServer ? browserServer.close(() => resolve()) : resolve()
    );
    await runtime?.end();
    await fixture?.end();
    if (schema) await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    if (originalEnabled === undefined) delete process.env.INSTAGRAM_AUTOMATIONS_ENABLED;
    else process.env.INSTAGRAM_AUTOMATIONS_ENABLED = originalEnabled;
    if (originalTestAccounts === undefined) delete process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS;
    else process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS = originalTestAccounts;
  });

  it('duplicates the current saved version as paused and protects account scope and revisions', async () => {
    const source = await createRule();
    await api('post', '/1002/rules/' + source.id + '/duplicate').send({ revision: source.revision }).expect(404);
    await api('post', '/1001/rules/' + source.id + '/duplicate').send({ revision: source.revision + 1 }).expect(409);
    const copy = (await api('post', '/1001/rules/' + source.id + '/duplicate').send({ revision: source.revision }).expect(200)).body.data;
    expect(copy).toMatchObject({ status: 'paused', accountId: '1001', revision: 1, definition: { name: 'Guide (copy)', trigger: source.definition.trigger, message: source.definition.message } });
    expect(copy.id).not.toBe(source.id);
    expect(providerWrites()).toHaveLength(0);
  });
  it('simulates the saved rule against active priorities without provider requests or executions', async () => {
    const source = await createRule();
    const specificDefinition = definition('Specific first'); specificDefinition.trigger.scope = 'specific'; specificDefinition.trigger.mediaIds = ['post1'];
    const specific = await createRule(specificDefinition);
    await fixture.query("UPDATE instagram_automation_rules SET status='active' WHERE id=$1", [specific.id]);
    const result = (await api('post', '/1001/rules/' + source.id + '/test').send({ text: 'guide', mediaId: 'post1', isReel: false }).expect(200)).body.data;
    expect(result).toMatchObject({ matched: true, targetWins: false, winner: { id: specific.id, name: 'Specific first' } });
    expect(result.warnings.join(' ')).toContain('sends nothing');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect((await fixture.query('SELECT count(*)::integer AS count FROM instagram_automation_runs')).rows[0].count).toBe(0);
    await api('post', '/1002/rules/' + source.id + '/test').send({ text: 'guide', mediaId: '', isReel: false }).expect(404);
    await api('post', '/1001/rules/' + source.id + '/test').send({ text: 'x', mediaId: '', isReel: 'false' }).expect(400);
  });
  it('filters delivery receipts by rule and rejects malformed rule identifiers', async () => {
    const first = await createRule(), second = await createRule(definition('Other'));
    await fixture.query(`INSERT INTO instagram_automation_runs(user_id,business_profile_id,account_id,source_key,rule_id,rule_name,definition,context,sender_id,status)
      VALUES(9,101,'1001','delivery1',$1,'Guide','{}','{}','reader','sent'),(9,101,'1001','delivery2',$2,'Other','{}','{}','reader','failed')`, [first.id, second.id]);
    const result = (await api('get', '/1001/runs?ruleId=' + first.id).expect(200)).body.data;
    expect(result.runs).toHaveLength(1); expect(result.runs[0].ruleId).toBe(first.id);
    expect((await api('get', '/1002/runs?ruleId=' + first.id).expect(200)).body.data.runs).toEqual([]);
    await api('get', '/1001/runs?ruleId=bad').expect(400);
  });
  it('returns sanitized connection health without requiring automation storage or provider writes', async () => {
    const result = (await api('get', '/1001/readiness').expect(200)).body.data;
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'connection', ready: true }), expect.objectContaining({ id: 'rollout', ready: true })]));
    expect(JSON.stringify(result)).not.toContain('fixture-token'); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('verifies current webhook fields on an explicit read-only connection check', async () => {
    subscribedFields = ['messages', 'messaging_postbacks'];
    const result = (await api('get', '/1001/readiness?verify=1').expect(200)).body.data;
    expect(result).toMatchObject({ messages: true, comments: false });
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'events', ready: false, action: 'reconnect' })]));
    expect(providerCalls()).toHaveLength(1); expect(providerWrites()).toHaveLength(0);
    await api('get', '/1001/readiness?verify=no').expect(400);
  });
  it('returns the selected account overview without serializing tokens or making provider requests', async () => {
    const response = await api('get').expect(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        account: { id: '1001', username: 'test_1001' },
        profiles: [],
        rules: [],
        readiness: { enabled: true, messages: true, comments: true },
        stats: { triggers: 0, sent: 0, failed: 0, skipped: 0, pending: 0, uncertain: 0 },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('fixture-token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('requires authentication, exact account ownership and an authorized business profile', async () => {
    await request(app).get(`${base}/1001`).expect(401);
    await api('get', '/1001', 103).expect(403);
    await api('get', '/1001', 103, 'fixture-other').expect(404);
    await api('get', '/1003', 101).expect(404);
    await api('get', '/1001', 102).expect(404);
    await api('get', '/1003', 102).expect(200);
    await api('get', '/invalid-account').expect(404);
    await api('get', '/9999').expect(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not redirect account-bound data after the publishing default changes', async () => {
    await createRule();
    await fixture.query('UPDATE channel_credentials SET is_selected=(account_identifier=$1)', [
      '1002',
    ]);
    expect((await api('get', '/1001/rules').expect(200)).body.data).toHaveLength(1);
    expect((await api('get', '/1002/rules').expect(200)).body.data).toEqual([]);
  });

  it.each(['icebreakers', 'menu'] as const)(
    'saves, reloads and revises the %s draft without provider writes',
    async (kind) => {
      expect((await api('get', `/1001/profiles/${kind}`).expect(200)).body.data).toBeNull();
      const config = profile(kind);
      const first = await api('put', `/1001/profiles/${kind}`)
        .send({ config, revision: 0, publish: false })
        .expect(200);
      expect(first.body.data).toMatchObject({
        kind,
        config,
        publishedConfig: null,
        revision: 1,
        syncStatus: 'draft',
      });
      const updated = structuredClone(config);
      if (kind === 'icebreakers')
        updated.locales[0].questions[0].question = 'Where are you located?';
      else updated.locales[0].items[0].title = 'See prices';
      await api('put', `/1001/profiles/${kind}`)
        .send({ config: updated, revision: 1, publish: false })
        .expect(200);
      expect((await api('get', `/1001/profiles/${kind}`).expect(200)).body.data).toMatchObject({
        config: updated,
        revision: 2,
        syncStatus: 'draft',
      });
      await api('put', `/1001/profiles/${kind}`)
        .send({ config, revision: 1, publish: true })
        .expect(409);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  );

  it.each(['icebreakers', 'menu'] as const)(
    'publishes %s only after accepted provider write and matching readback',
    async (kind) => {
      const config = profile(kind);
      const response = await api('put', `/1001/profiles/${kind}`)
        .send({ config, revision: 0, publish: true })
        .expect(200);
      expect(response.body.data).toMatchObject({
        config,
        publishedConfig: config,
        revision: 1,
        syncStatus: 'published',
        syncError: null,
      });
      expect(response.body.data.syncedAt).toBeTruthy();
      expect(providerCalls()).toHaveLength(3);
      expect(providerWrites()).toHaveLength(1);
      expect(
        providerCalls().every(([url]) => new URL(String(url)).pathname.includes('/1001/'))
      ).toBe(true);
    }
  );

  it.each(['reject', 'readback', 'network'] as const)(
    'retains the changed draft and last published mapping after %s failure',
    async (failure) => {
      const config = profile('menu');
      await api('put', '/1001/profiles/menu')
        .send({ config, revision: 0, publish: true })
        .expect(200);
      const changed = structuredClone(config);
      changed.locales[0].items[0].title = 'Updated prices';
      providerFailure = failure;
      const response = await api('put', '/1001/profiles/menu')
        .send({ config: changed, revision: 1, publish: true })
        .expect(200);
      expect(response.body.data).toMatchObject({
        config: changed,
        publishedConfig: config,
        revision: 2,
        syncStatus: 'error',
        syncError: expect.any(String),
      });
      expect(response.body.data.syncError).not.toContain('Sensitive provider diagnostic');
      expect((await api('get', '/1001/profiles/menu').expect(200)).body.data).toMatchObject({
        config: changed,
        publishedConfig: config,
        syncStatus: 'error',
      });
    }
  );

  it.each(['icebreakers', 'menu'] as const)(
    'deletes published %s with optimistic revision and confirmed provider readback',
    async (kind) => {
      const config = profile(kind);
      await api('put', `/1001/profiles/${kind}`)
        .send({ config, revision: 0, publish: true })
        .expect(200);
      await api('delete', `/1001/profiles/${kind}`).send({ revision: 0 }).expect(409);
      const removed = await api('delete', `/1001/profiles/${kind}`)
        .send({ revision: 1 })
        .expect(200);
      expect(removed.body.data).toMatchObject({
        revision: 2,
        publishedConfig: null,
        syncStatus: 'draft',
      });
      expect(providerWrites().filter(([, options]) => options?.method === 'DELETE')).toHaveLength(
        1
      );
    }
  );

  it('keeps prior publication when a provider delete is rejected', async () => {
    const config = profile('menu');
    await api('put', '/1001/profiles/menu')
      .send({ config, revision: 0, publish: true })
      .expect(200);
    providerFailure = 'reject';
    const removed = await api('delete', '/1001/profiles/menu').send({ revision: 1 }).expect(200);
    expect(removed.body.data).toMatchObject({
      revision: 2,
      publishedConfig: config,
      syncStatus: 'error',
    });
  });

  it('rejects unknown profile kinds, malformed configs and invalid revisions before persistence or Meta', async () => {
    await api('get', '/1001/profiles/unknown').expect(400);
    await api('put', '/1001/profiles/unknown')
      .send({ config: profile('menu'), revision: 0 })
      .expect(400);
    for (const body of [
      {},
      { config: { locales: [] }, revision: 0 },
      { config: profile('menu'), revision: -1 },
      { config: profile('menu'), revision: '0' },
    ])
      await api('put', '/1001/profiles/menu').send(body).expect(400);
    expect(
      (await fixture.query('SELECT count(*) FROM instagram_automation_profiles')).rows[0].count
    ).toBe('0');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['comment_dm', 'comment_reply'] as const)(
    'creates %s paused, edits with revisions, lists it and deletes it',
    async (kind) => {
      const value = definition();
      value.kind = kind;
      if (kind === 'comment_reply') value.publicReplies = ['Thank you!'];
      const created = await api('post', '/1001/rules')
        .send({ definition: value, status: 'active' })
        .expect(200);
      expect(created.body.data).toMatchObject({
        accountId: '1001',
        status: 'paused',
        revision: 1,
        definition: value,
      });
      const id = created.body.data.id;
      value.name = 'Edited rule';
      const edited = await api('put', `/1001/rules/${id}`)
        .send({ definition: value, revision: 1, status: 'paused' })
        .expect(200);
      expect(edited.body.data).toMatchObject({ revision: 2, definition: value });
      expect((await api('get', '/1001/rules').expect(200)).body.data).toHaveLength(1);
      await api('delete', `/1001/rules/${id}`).send({ revision: 1 }).expect(409);
      await api('delete', `/1001/rules/${id}`)
        .send({ revision: 2 })
        .expect(200, { success: true, data: { deleted: true } });
      expect((await api('get', '/1001/rules').expect(200)).body.data).toEqual([]);
      expect(
        (await fixture.query('SELECT status,deleted_at,revision FROM instagram_automation_rules'))
          .rows[0]
      ).toMatchObject({ status: 'paused', revision: 3, deleted_at: expect.any(Date) });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  );

  it('rejects a stale edit without changing the saved rule', async () => {
    const saved = await createRule();
    await api('put', `/1001/rules/${saved.id}`)
      .send({
        definition: { ...saved.definition, name: 'First editor' },
        status: 'paused',
        revision: 1,
      })
      .expect(200);
    await api('put', `/1001/rules/${saved.id}`)
      .send({
        definition: { ...saved.definition, name: 'Stale editor' },
        status: 'paused',
        revision: 1,
      })
      .expect(409);
    expect((await api('get', '/1001/rules').expect(200)).body.data[0].definition.name).toBe(
      'First editor'
    );
  });

  it.each(['comment_dm', 'comment_reply'] as const)(
    'activates and pauses a %s rule through actual readiness checks',
    async (kind) => {
      const value = definition();
      value.kind = kind;
      if (kind === 'comment_reply') value.publicReplies = ['Thanks!'];
      const saved = await createRule(value);
      subscribedFields = kind === 'comment_reply' ? ['comments'] : allFields;
      const activated = await api('put', `/1001/rules/${saved.id}`)
        .send({ definition: value, revision: 1, status: 'active' })
        .expect(200);
      expect(activated.body.data).toMatchObject({ status: 'active', revision: 2 });
      expect(providerCalls()).toHaveLength(1);
      await api('put', `/1001/rules/${saved.id}`)
        .send({ definition: value, revision: 2, status: 'paused' })
        .expect(200);
      expect(providerCalls()).toHaveLength(1);
    }
  );

  it.each(['scope', 'review', 'subscription', 'rollout', 'expired'] as const)(
    'keeps a rule paused when %s readiness is unavailable',
    async (missing) => {
      const saved = await createRule();
      if (missing === 'scope')
        await fixture.query(
          "UPDATE channel_credentials SET granted_scopes='[]'::jsonb WHERE account_identifier='1001'"
        );
      if (missing === 'review')
        await fixture.query(
          "UPDATE admin_api_credentials SET config=jsonb_set(config,'{appReviewPermissions}','{}'::jsonb)"
        );
      if (missing === 'subscription') subscribedFields = ['messages', 'comments'];
      if (missing === 'rollout') process.env.INSTAGRAM_AUTOMATIONS_ENABLED = 'false';
      if (missing === 'expired')
        await fixture.query(
          "UPDATE channel_credentials SET token_expiry=now()-interval '1 day' WHERE account_identifier='1001'"
        );
      const failed = await api('put', `/1001/rules/${saved.id}`)
        .send({ definition: saved.definition, revision: 1, status: 'active' })
        .expect(409);
      expect(failed.body.error).toBeTruthy();
      expect((await api('get', '/1001/rules').expect(200)).body.data[0]).toMatchObject({
        status: 'paused',
        revision: 1,
      });
      if (missing !== 'subscription') expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  );

  it('verifies selected media ownership on activation and rejects foreign media', async () => {
    const value = definition();
    value.trigger.scope = 'specific';
    value.trigger.mediaIds = ['foreign-media'];
    const saved = await createRule(value);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await api('put', `/1001/rules/${saved.id}`)
      .send({ definition: value, revision: 1, status: 'active' })
      .expect(400);
    expect((await api('get', '/1001/rules').expect(200)).body.data[0].status).toBe('paused');
    value.trigger.mediaIds = ['media-1'];
    await api('put', `/1001/rules/${saved.id}`)
      .send({ definition: value, revision: 1, status: 'active' })
      .expect(200);
  });

  it('preserves advanced fields in paused drafts and rejects invalid content', async () => {
    const value = definition();
    value.message = {
      ...emptyInstagramMessage(),
      format: 'buttons',
      text: 'Your guide',
      buttons: [{ title: 'Read guide', url: 'https://example.test/guide' }],
    };
    value.trigger = {
      keywords: ['guide', 'price'],
      negativeKeywords: ['spam'],
      matchMode: 'exact',
      scope: 'reels',
      mediaIds: [],
    };
    value.followGate.enabled = true;
    value.filters = {
      followers: 'any',
      skipPreviouslyMessaged: true,
      maxPerDay: 1,
      cooldownMinutes: 60,
    };
    value.tags = ['lead', 'guide'];
    value.publicReplies = ['Check your DMs!', 'Sent your guide.'];
    expect((await createRule(value)).definition).toEqual(value);
    await api('post', '/1001/rules')
      .send({ definition: { ...value, followGate: { ...value.followGate, enabled: false } } })
      .expect(400);
    await api('post', '/1001/rules')
      .send({ definition: { ...value, trigger: { ...value.trigger, keywords: [] } } })
      .expect(400);
    await api('post', '/1001/rules')
      .send({ definition: { ...value, filters: { ...value.filters, maxPerDay: -1 } } })
      .expect(400);
    await api('put', '/1001/rules/1')
      .send({ definition: value, status: 'invalid', revision: 1 })
      .expect(400);
    await api('put', '/1001/rules/NaN')
      .send({ definition: value, status: 'paused', revision: 1 })
      .expect(400);
    await api('delete', '/1001/rules/1').send({ revision: 0 }).expect(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('enforces account boundaries on rule edits, deletion and reorder, even for the same owner', async () => {
    const saved = await createRule();
    await api('put', `/1002/rules/${saved.id}`)
      .send({ definition: saved.definition, revision: 1, status: 'paused' })
      .expect(409);
    await api('delete', `/1002/rules/${saved.id}`).send({ revision: 1 }).expect(409);
    await api('put', '/1002/rules/order')
      .send({ ids: [saved.id] })
      .expect(409);
    await api('put', `/1003/rules/${saved.id}`, 102)
      .send({ definition: saved.definition, revision: 1, status: 'paused' })
      .expect(409);
    expect((await api('get', '/1001/rules').expect(200)).body.data[0]).toMatchObject({
      revision: 1,
      status: 'paused',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reorders through the literal order route, increments revisions and rejects incomplete lists', async () => {
    const one = await createRule(definition('One'));
    const two = await createRule(definition('Two'));
    const three = await createRule(definition('Three'));
    const reordered = await api('put', '/1001/rules/order')
      .send({ ids: [three.id, one.id, two.id] })
      .expect(200);
    expect(reordered.body.data.map((row: any) => row.id)).toEqual([three.id, one.id, two.id]);
    expect(reordered.body.data.every((row: any) => row.revision === 2)).toBe(true);
    await api('put', '/1001/rules/order')
      .send({ ids: [one.id] })
      .expect(409);
    await api('put', '/1001/rules/order')
      .send({ ids: [one.id, one.id] })
      .expect(400);
    await api('put', '/1001/rules/order')
      .send({ ids: ['1', '2', '3'] })
      .expect(400);
    expect(
      (await api('get', '/1001/rules').expect(200)).body.data.map((row: any) => row.id)
    ).toEqual([three.id, one.id, two.id]);
  });

  it('keeps scope precedence ahead of user ordering in returned rule lists', async () => {
    const any = await createRule();
    const reel = definition('Reels');
    reel.trigger.scope = 'reels';
    const onlyReels = await createRule(reel);
    const exact = definition('Selected post');
    exact.trigger.scope = 'specific';
    exact.trigger.mediaIds = ['media-1'];
    const selected = await createRule(exact);
    const ordered = await api('put', '/1001/rules/order')
      .send({ ids: [any.id, onlyReels.id, selected.id] })
      .expect(200);
    expect(ordered.body.data.map((row: any) => row.id)).toEqual([
      selected.id,
      onlyReels.id,
      any.id,
    ]);
  });

  it('paginates account media and rejects malformed cursors without querying Meta', async () => {
    const first = await api('get', '/1001/media').expect(200);
    expect(first.body.data).toEqual({
      media: [
        { id: 'media-1', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/fixture1/' },
      ],
      nextCursor: 'next-page',
    });
    const next = await api('get', '/1001/media?after=next-page').expect(200);
    expect(next.body.data).toEqual({
      media: [
        {
          id: 'media-2',
          media_type: 'VIDEO',
          permalink: 'https://www.instagram.com/reel/fixture2/',
          media_product_type: 'REELS',
        },
      ],
      nextCursor: null,
    });
    expect(new URL(String(providerCalls()[1][0])).searchParams.get('after')).toBe('next-page');
    const calls = providerCalls().length;
    await api('get', '/1001/media?after[x]=invalid').expect(400);
    await api('get', `/1001/media?after=${'x'.repeat(2001)}`).expect(400);
    await api('get', '/1004/media').expect(404);
    expect(providerCalls()).toHaveLength(calls);
  });

  it('returns a sanitized provider failure from media retrieval', async () => {
    providerFailure = 'reject';
    const response = await api('get', '/1001/media').expect(502);
    expect(response.body.error).toContain('not authorized');
    expect(JSON.stringify(response.body)).not.toMatch(
      /Sensitive provider diagnostic|fixture-token/
    );
  });

  it('paginates execution history with effects and excludes unmatched or other-account runs', async () => {
    await fixture.query(`INSERT INTO instagram_automation_runs(user_id,business_profile_id,account_id,source_key,rule_name,definition,context,sender_id,status)
      SELECT 9,101,'1001','event-'||i,'Rule', '{}'::jsonb,'{}'::jsonb,'sender-'||i,'sent' FROM generate_series(1,52) i;
      INSERT INTO instagram_automation_runs(user_id,business_profile_id,account_id,source_key,rule_name,definition,context,sender_id,status)
      VALUES(9,101,'1001','unmatched','Rule','{}','{}','reader','unmatched'),(9,101,'1002','other-account','Rule','{}','{}','reader','sent'),(9,102,'1003','other-profile','Rule','{}','{}','reader','sent');
      INSERT INTO instagram_automation_effects(user_id,business_profile_id,run_id,effect_key,status,provider_message_id) VALUES(9,101,52,'private','sent','provider-52');`);
    const first = (
      await api('get', '/1001/runs').expect((response) => {
        if (response.status !== 200)
          throw (
            (logError.mock.calls[0]?.[0] as { err?: Error })?.err ||
            new Error(`History returned ${response.status}`)
          );
      })
    ).body.data;
    expect(first.runs).toHaveLength(50);
    expect(first.runs[0]).toMatchObject({
      id: 52,
      sourceKey: 'event-52',
      status: 'sent',
      effects: [{ kind: 'private', status: 'sent', error: null }],
    });
    expect(first.nextCursor).toBe(3);
    const next = (await api('get', `/1001/runs?cursor=${first.nextCursor}`).expect(200)).body.data;
    expect(next.runs.map((row: any) => row.id)).toEqual([2, 1]);
    expect(next.nextCursor).toBeNull();
    await api('get', '/1001/runs?cursor=invalid').expect(400);
    await api('get', '/1001/runs?cursor=0').expect(400);
    await api('get', `/1001/runs?cursor=${Number.MAX_SAFE_INTEGER}`).expect(400);
    await api('get', '/1001/runs?cursor=1e2').expect(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports observed effect counts and run outcomes without inventing read metrics', async () => {
    await fixture.query(`INSERT INTO instagram_automation_runs(user_id,business_profile_id,account_id,source_key,rule_name,definition,context,sender_id,status)
      VALUES(9,101,'1001','sent','Rule','{}','{}','reader','sent'),(9,101,'1001','failed','Rule','{}','{}','reader','failed'),
      (9,101,'1001','skipped','Rule','{}','{}','reader','skipped'),(9,101,'1001','follow','Rule','{}','{}','reader','waiting_follow'),
      (9,101,'1001','uncertain','Rule','{}','{}','reader','uncertain'),(9,101,'1001','unmatched','Rule','{}','{}','reader','unmatched');
      INSERT INTO instagram_automation_effects(user_id,business_profile_id,run_id,effect_key,status) VALUES(9,101,1,'private','sent'),(9,101,1,'public','sent'),(9,101,2,'private','failed'),(9,101,5,'private','uncertain');`);
    const response = await api('get').expect(200);
    expect(response.body.data.stats).toEqual({
      triggers: 5,
      sent: 2,
      failed: 1,
      skipped: 1,
      pending: 1,
      uncertain: 1,
    });
  });

  if (process.env.INSTAGRAM_AUTOMATIONS_BROWSER_QA === '1')
    it(
      'browser audit harness',
      async () => {
        const port = Number(process.env.INSTAGRAM_AUTOMATIONS_BROWSER_QA_PORT || 8087);
        if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
          throw new Error('Choose a valid local fixture port.');
        let stop: () => void = () => undefined;
        const stopped = new Promise<void>((resolve) => {
          stop = resolve;
        });
        app.get('/__audit/health', (_req, res) =>
          res.json({ ready: true, accountId: '1001', businessProfileId: 101 })
        );
        app.post('/__audit/stop', (_req, res) => {
          res.json({ stopped: true });
          stop();
        });
        app.post('/__audit/reset', async (_req, res, next) => {
          try {
            await resetFixture();
            res.json({ reset: true });
          } catch (error) {
            next(error);
          }
        });
        app.post('/__audit/provider', async (req, res, next) => {
          try {
            if ('failure' in req.body) {
              if (![null, 'reject', 'readback', 'network'].includes(req.body.failure))
                return res.status(400).json({ error: 'Invalid fixture failure.' });
              providerFailure = req.body.failure;
            }
            if (Array.isArray(req.body.subscribedFields))
              subscribedFields = req.body.subscribedFields;
            if (typeof req.body.enabled === 'boolean')
              process.env.INSTAGRAM_AUTOMATIONS_ENABLED = String(req.body.enabled);
            if (Array.isArray(req.body.grantedScopes))
              await fixture.query(
                "UPDATE channel_credentials SET granted_scopes=$1::jsonb WHERE account_identifier='1001'",
                [JSON.stringify(req.body.grantedScopes)]
              );
            if (req.body.appReviewPermissions && typeof req.body.appReviewPermissions === 'object')
              await fixture.query(
                "UPDATE admin_api_credentials SET config=jsonb_set(config,'{appReviewPermissions}',$1::jsonb)",
                [JSON.stringify(req.body.appReviewPermissions)]
              );
            res.json({
              failure: providerFailure,
              subscribedFields,
              enabled: process.env.INSTAGRAM_AUTOMATIONS_ENABLED === 'true',
            });
          } catch (error) {
            next(error);
          }
        });
        app.post('/__audit/runs', async (req, res, next) => {
          try {
            const count = req.body.count ?? 56;
            if (!Number.isSafeInteger(count) || count < 1 || count > 100)
              return res.status(400).json({ error: 'Use 1–100 fixture runs.' });
            await fixture.query('TRUNCATE instagram_automation_effects,instagram_automation_runs RESTART IDENTITY CASCADE');
            const states = ['sent', 'waiting_follow', 'failed', 'skipped', 'uncertain'];
            for (let i = 1; i <= count; i++) {
              const status = states[(i - 1) % states.length];
              const reason = status === 'failed' ? 'Meta did not authorize this operation.'
                : status === 'skipped' ? 'Daily message limit reached.'
                  : status === 'uncertain' ? 'Delivery could not be confirmed. Review the receipt before retrying.'
                    : status === 'waiting_follow' ? 'Waiting for a verified follow.' : null;
              const receipt = status === 'sent' ? `fixture-message-${i}` : null;
              await fixture.query(`INSERT INTO instagram_automation_runs(user_id,business_profile_id,account_id,source_key,rule_name,definition,context,sender_id,status,reason,private_message_id)
                VALUES(9,101,'1001',$1,'Share the guide','{}'::jsonb,'{}'::jsonb,$2,$3,$4,$5)`, [`audit-event-${i}`, `fixture-reader-${i}`, status, reason, receipt]);
              if (['sent', 'failed', 'uncertain'].includes(status)) await fixture.query(`INSERT INTO instagram_automation_effects(user_id,business_profile_id,run_id,effect_key,status,provider_message_id,error)
                VALUES(9,101,$1,'private',$2,$3,$4)`, [i, status, receipt, reason]);
            }
            res.json({ seeded: count });
          } catch (error) {
            next(error);
          }
        });
        app.get('/__audit/state', async (_req, res, next) => {
          try {
            const [profiles, rules, runs] = await Promise.all([
              fixture.query(
                'SELECT account_id,kind,config,published_config,revision,sync_status,sync_error FROM instagram_automation_profiles ORDER BY id'
              ),
              fixture.query(
                'SELECT id,account_id,definition,status,revision,priority,deleted_at FROM instagram_automation_rules ORDER BY id'
              ),
              fixture.query(
                'SELECT id,account_id,rule_name,status,reason FROM instagram_automation_runs ORDER BY id'
              ),
            ]);
            res.json({
              profiles: profiles.rows,
              rules: rules.rows,
              runs: runs.rows,
              providerCalls: providerCalls().length,
              providerWrites: providerWrites().length,
            });
          } catch (error) {
            next(error);
          }
        });
        browserServer = await new Promise<Server>((resolve, reject) => {
          const server = app.listen(port, '127.0.0.1', () => resolve(server));
          server.once('error', reject);
        });
        console.info(
          `Instagram fixture API ready at http://127.0.0.1:${port}; use Authorization: Bearer fixture-owner and x-business-profile-id: 101. POST /__audit/stop completes cleanup.`
        );
        await stopped;
      },
      60 * 60 * 1000
    );
});
