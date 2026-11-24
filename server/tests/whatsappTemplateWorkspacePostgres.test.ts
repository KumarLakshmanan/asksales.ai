/** Real controller/Drizzle/RLS integration in a disposable local schema.
 * Session identities and Meta responses are fixtures. Never contacts Meta. */
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import express, { type Request } from 'express';
import request from 'supertest';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const local = process.env.WHATSAPP_TEMPLATE_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase, admin: Pool, fixture: Pool, runtime: Pool, schema: string;
const databaseProxy = new Proxy({} as NodePgDatabase, { get(_target, key) {
  const value = database[key as keyof NodePgDatabase];
  return typeof value === 'function' ? value.bind(database) : value;
} });
jest.unstable_mockModule('../models/db.js', () => ({ db: databaseProxy }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: async () => ({ apiKey: 'fixture-app', config: { apiVersion: 'v25.0' } }) }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: {
  resolveCreds: async () => ({ accessToken: 'fixture-only', businessAccountId: 'fixture-waba' }), ensureTokenValidity: async () => 'fixture-only',
} }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: { getInstance: () => ({}) } }));
const handlers = await import('../controllers/whatsappTemplateController.js');
// @ts-expect-error JavaScript migration uses the custom runner.
const migration = await import('../migrations/320_whatsapp_template_workspace.js');
const app = express().use(express.json()).use((req, _res, next) => {
  const profile = req.headers['x-profile'] === '102' ? 102 : 101;
  req.user = { id: 9 } as Request['user'];
  withBusinessScope({ userId: 9, businessProfileId: profile }, next);
});
app.get('/templates', handlers.getTemplates);
app.get('/templates/:id', handlers.getTemplate);
app.post('/templates', handlers.createTemplate);
app.put('/templates/:id', handlers.updateTemplate);
app.post('/templates/:id/submit', handlers.submitTemplate);
app.post('/templates/:id/refresh', handlers.refreshTemplate);
const payload = { name: 'qa_message', language: 'en_US', category: 'UTILITY', body: 'Hello {{1}}', examples: { 'body:1': 'Alex' }, headerType: 'NONE' };
const create = async (override = {}, profile = 101) => (await request(app).post('/templates').set('x-profile', String(profile)).send({ ...payload, ...override }).expect(200)).body.template;
local('WhatsApp workspace persistence and HTTP contracts', () => {
  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true, quiet: true });
    if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('Only explicitly configured local PostgreSQL is allowed.');
    const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', max: 3, connectionTimeoutMillis: 5000 };
    schema = `wa_workspace_${randomBytes(8).toString('hex')}`;
    admin = new Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture = new Pool({ ...connection, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` });
    await fixture.query(`CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE SQL AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE TABLE whatsapp_templates (
        business_profile_id integer DEFAULT app_business_profile_id(), id serial PRIMARY KEY, user_id integer NOT NULL,
        name varchar(255) NOT NULL, language varchar(50) NOT NULL DEFAULT 'en_US', category varchar(50) NOT NULL DEFAULT 'MARKETING', status varchar(50) NOT NULL DEFAULT 'DRAFT',
        header text, header_type varchar(20), header_media_url text, body text NOT NULL, footer text, buttons jsonb, examples jsonb,
        waba_template_id varchar(255), meta_status varchar(50), submission_status varchar(30) NOT NULL DEFAULT 'local_draft', submitted_at timestamp, meta_rejection_reason text, last_synced_at timestamp,
        has_local_changes boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT NOW(), updated_at timestamp NOT NULL DEFAULT NOW(),
        UNIQUE(business_profile_id,user_id,name));
      ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY; ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
      CREATE POLICY template_profile ON whatsapp_templates
        USING(business_profile_id=app_business_profile_id() AND user_id=NULLIF(current_setting('app.current_user_id',true),'')::integer)
        WITH CHECK(business_profile_id=app_business_profile_id() AND user_id=NULLIF(current_setting('app.current_user_id',true),'')::integer);
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON whatsapp_templates TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;`);
    await migration.up(fixture);
    runtime = new Pool({ ...connection, options: `-c search_path=${schema},pg_catalog -c timezone=UTC` });
    database = drizzle(createBusinessScopedPool(runtime));
  },30000);
  beforeEach(async () => { await fixture.query('TRUNCATE whatsapp_templates RESTART IDENTITY'); });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    await runtime?.end(); await fixture?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });
  it('saves unfinished drafts and refuses strict submission before provider IO', async () => {
    const template = await create({ body: '', examples: { '1': '' }, buttons: [{ type: 'URL', text: '', url: '' }], draftOnly: true });
    expect(template.body).toBe(''); expect(template.revision).toBeTruthy();
    const provider = jest.spyOn(globalThis,'fetch');
    await request(app).post(`/templates/${template.id}/submit`).expect(400);
    expect(provider).not.toHaveBeenCalled();
    const saved = (await request(app).get(`/templates/${template.id}`).expect(200)).body.template;
    expect(saved.buttons[0].text).toBe(''); expect(saved.activityHistory[0].action).toBe('created');
  });
  it('retains examples and variable labels across reload and permits incomplete variable sequences in a draft', async () => {
    const template = await create();
    const edited = await request(app).put(`/templates/${template.id}`).send({ ...payload, body: 'Hello {{2}}', draftOnly: true, clientRevision: template.revision, examples: { 'body:2': '' }, variableLabels: { 'body:2':'Customer name' } }).expect(200);
    expect(edited.body.template.variableLabels).toEqual({ 'body:2':'Customer name' });
    expect(edited.body.template.activityHistory).toHaveLength(2);
    await request(app).post(`/templates/${template.id}/submit`).expect(400);
  });
  it('rejects stale saves instead of silently overwriting another browser', async () => {
    const template = await create();
    await request(app).put(`/templates/${template.id}`).send({ ...payload, body:'First update', examples: {}, clientRevision:template.revision }).expect(200);
    await request(app).put(`/templates/${template.id}`).send({ ...payload, body:'Stale overwrite', clientRevision:template.revision }).expect(409);
    expect((await request(app).get(`/templates/${template.id}`)).body.template.body).toBe('First update');
  });
  it('filters, sorts, paginates and counts inside the selected profile; search characters are literal', async () => {
    await create({ name:'a_message', body:'Literal 100%_ result', language:'ta' });
    await create({ name:'b_message', body:'Second result' });
    await create({ name:'secret_other_profile' },102);
    const result = await request(app).get('/templates?page=1&pageSize=1&sort=name_asc').expect(200);
    expect(result.body.total).toBe(2); expect(result.body.templates[0].name).toBe('a_message');
    expect(result.body.statusCounts.DRAFT).toBe(2); expect(result.body.languages).toEqual(['en_US','ta']);
    const literal = await request(app).get('/templates?page=1&search=100%25_').expect(200);
    expect(literal.body.total).toBe(1);
    const page2 = await request(app).get('/templates?page=2&pageSize=1&sort=name_asc').expect(200);
    expect(page2.body.templates[0].name).toBe('b_message');
    await request(app).get('/templates?page=-1').expect(400);
  });
  it('does not expose or refresh another profile template, even for the same owner', async () => {
    const template = await create({},102);
    const provider = jest.spyOn(globalThis,'fetch');
    await request(app).get(`/templates/${template.id}`).expect(404);
    await request(app).post(`/templates/${template.id}/refresh`).expect(404);
    expect(provider).not.toHaveBeenCalled();
  });
  it('captures an approved snapshot and preserves it after local edits', async () => {
    const template = await create();
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({ id:'fixture-meta',status:'APPROVED' })));
    const submitted = await request(app).post(`/templates/${template.id}/submit`).expect(202);
    expect(submitted.body.template.approvedSnapshot.body).toBe(payload.body);
    const edited = await request(app).put(`/templates/${template.id}`).send({ ...payload, body:'New version', examples:{},clientRevision:submitted.body.template.revision }).expect(200);
    expect(edited.body.template.approvedSnapshot.body).toBe(payload.body);
    expect(edited.body.template.body).toBe('New version');
  });
  it('keeps an unmatched uncertain submission locked when refreshing provider status', async () => {
    const template = await create();
    await fixture.query("UPDATE whatsapp_templates SET submission_status='submission_uncertain',waba_template_id='fixture-meta' WHERE id=$1",[template.id]);
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({ data:[{ id:'fixture-meta',name:template.name,language:template.language,category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'Older approved message'}] }] })));
    const refresh = await request(app).post(`/templates/${template.id}/refresh`).expect(200);
    expect(refresh.body.template.submissionStatus).toBe('submission_uncertain');
    expect(refresh.body.template.body).toBe(payload.body);
    await request(app).post(`/templates/${template.id}/submit`).expect(409);
  });
  it.each(['COPY_CODE','ONE_TAP'])('sends the real %s authentication component shape', async (otpType) => {
    const template = await create({ category:'AUTHENTICATION',body:'',examples:{}, authConfig:{ otpType,buttonText:'Copy code',autofillText:'Autofill',packageName:'com.example.app',signatureHash:'K8a/AINcGX7',codeExpirationMinutes:5,addSecurityRecommendation:true } });
    const provider = jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({ id:'fixture-auth',status:'PENDING' })));
    await request(app).post(`/templates/${template.id}/submit`).expect(202);
    const body=JSON.parse(String(provider.mock.calls[0][1]?.body));
    expect(body.components[0]).toEqual({ type:'BODY',add_security_recommendation:true });
    expect(body.components[1]).toEqual({ type:'FOOTER',code_expiration_minutes:5 });
    expect(body.components[2].buttons[0]).toMatchObject({ type:'OTP',otp_type:otpType });
    if (otpType==='ONE_TAP') expect(body.components[2].buttons[0].supported_apps).toEqual([{package_name:'com.example.app',signature_hash:'K8a/AINcGX7'}]);
    expect(body.components[2].buttons[0]).not.toHaveProperty('package_name');
  });
  it('adds metadata safely on a legacy table without claiming the tenancy prerequisites exist', async () => {
    const client = await fixture.connect();
    await client.query('BEGIN');
    try {
      await client.query(`CREATE TEMP TABLE whatsapp_templates (id serial PRIMARY KEY,user_id integer,updated_at timestamp);
        INSERT INTO whatsapp_templates(user_id,updated_at) VALUES(9,NOW());`);
      await migration.up(client);
      expect((await client.query('SELECT user_id,auth_config,activity_history FROM pg_temp.whatsapp_templates')).rows).toEqual([{user_id:9,auth_config:null,activity_history:[]}]);
      expect((await client.query("SELECT to_regclass('pg_temp.whatsapp_templates_owner_updated_idx') AS index")).rows[0].index).toBeTruthy();
      await migration.down(client);
      expect((await client.query('SELECT user_id FROM pg_temp.whatsapp_templates')).rows).toEqual([{user_id:9}]);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('applies migration idempotently and rolls back new fields in the isolated schema', async () => {
    await migration.up(fixture); await migration.down(fixture);
    expect((await fixture.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='whatsapp_templates' AND column_name='auth_config'",[schema])).rows).toHaveLength(0);
    await migration.up(fixture);
  });
});
