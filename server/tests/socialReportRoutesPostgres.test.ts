import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

// Opt-in disposable local fixture. Application environment files are never read.
const connectionString = process.env.SOCIAL_INSIGHTS_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `social_insights_${randomBytes(8).toString('hex')}`;
let pool: Pool;
let database: NodePgDatabase;
let moduleEnabled = true;
const errors: unknown[] = [];
const notify = jest.fn();
const sendEmail = jest.fn();
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute: (...args: Parameters<NodePgDatabase['execute']>) => database.execute(...args),
  select: (...args: Parameters<NodePgDatabase['select']>) => database.select(...args),
  transaction: (callback: Parameters<NodePgDatabase['transaction']>[0]) => database.transaction(callback),
} }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({
  getEffectiveModuleAccess: async () => [{key:'content',enabled:moduleEnabled,status:'available'}],
  getMaintenanceSettings: async () => ({enabled:false}),
}));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: { notify } }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: { sendEmailWithUserCredentials: sendEmail } }));
const {registerSocialReportRoutes} = await import('../routes/socialReports.routes.js');
const {businessProfileScope} = await import('../middleware/businessProfileScope.js');
const {businessPermissions} = await import('../middleware/businessPermissions.js');
const {requireModuleAccess} = await import('../middleware/platformAccess.js');
const {responseWrapper} = await import('../middleware/responseWrapper.js');
const app = express();app.use(express.json());app.use('/api',responseWrapper);
// Only session establishment is synthetic; resolver, permission gate, production
// report registration, controller, scoped pool and PostgreSQL/RLS are actual.
registerSocialReportRoutes(app,(req,res,next)=>{
  if(req.get('x-qa-user')==='0')return res.status(401).json({error:'Session required'});
  req.user={id:Number(req.get('x-qa-user')||17)} as typeof req.user;
  return businessProfileScope(req,res,()=>businessPermissions(req,res,next));
},requireModuleAccess('content'));
// Exercise the existing global boundary verbatim without booting unrelated
// workers/providers. TypeScript is stripped; only logging is replaced.
const indexSource=await readFile(new URL('../index.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('index.ts',indexSource,ts.ScriptTarget.Latest,true);
const boundary=parsed.statements.find(statement=>ts.isExpressionStatement(statement)
  && statement.getText(parsed).includes("'Global error handler'"));
if(!boundary)throw new Error('Production HTTP error boundary not found');
const {normalizeCapacityError}=await import('../services/billing/entitlements.js');
new Function('app','processLogger','normalizeCapacityError',ts.transpile(boundary.getText(parsed)))(app,{
  error:(detail:unknown)=>errors.push(detail),warn:()=>{},
},normalizeCapacityError);
const registration=await readFile(new URL('../routes.ts',import.meta.url),'utf8');
if(!registration.includes("registerSocialReportRoutes(app, authenticateToken, requireModuleAccess('content'))"))
  throw new Error('Report route registration is not connected to the production server');
const http = supertest(app);
const base = '/api/social-analytics/reports';
const missing = '00000000-0000-4000-8000-000000000000';
async function report() {
  const result=await http.post(base).send({name:'Fixture report',filters:{}});
  expect(result.status).toBe(201);return result.body.data as {id:string};
}

suite('Mounted production report routes with disposable PostgreSQL',()=>{
  beforeAll(async () => {
    const target = new URL(connectionString!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/social_insights_audit')
      throw new Error('Only the disposable local social_insights_audit database is allowed');
    pool = new Pool({ connectionString, max: 8, options:`-c search_path=${schema},pg_catalog` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamptz,is_approved boolean DEFAULT true); INSERT INTO users VALUES(17),(18)');
    await pool.query('CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,archived_at timestamptz,is_default boolean DEFAULT true); INSERT INTO company_settings VALUES(1701,17),(1702,17),(1801,18)');
    await pool.query(`CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id integer,user_id integer,role text,status text); CREATE TABLE business_profile_preferences(user_id integer,default_business_profile_id integer)`);
    await localBusinessFunctions(pool);
    const columns = Object.values(getTableColumns(channelCredentialsTable)).map(column => `"${column.name}" ${column.getSQLType()}`).join(',');
    await pool.query(`CREATE TABLE channel_credentials(${columns}); ALTER TABLE channel_credentials ADD PRIMARY KEY(id)`);
    // Use the shipped report/listening DDL, plus only the supporting fixture tables.
    for (const migration of ['180_create_social_listening_and_competitors', '181_create_social_reports',
      '183_harden_social_report_delivery_idempotency', '185_harden_social_competitor_snapshot_integrity',
      '228_add_social_report_timezone_schedule', '246_create_social_content_insights', '272_social_reporting_periods',
      '282_social_insights_management','570_social_report_preparation_fence']) {
      const { up } = await import(`../migrations/${migration}.js`);
      await up({ query: (text: string, values?: unknown[]) => pool.query(text, values) });
    }
    await pool.query(`CREATE TABLE social_metric_snapshots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id integer,
      platform text,account_identifier text,metric_window_start timestamptz,metric_window_end timestamptz,source text,
      source_snapshot_id text,metrics jsonb,captured_at timestamptz DEFAULT NOW(),timezone text);
      CREATE TABLE social_comment_workflows(user_id integer,credential_id integer,post_id text,comment_id text,status text);
      ALTER TABLE social_saved_reports DROP CONSTRAINT social_saved_reports_user_id_name_key;
      ALTER TABLE social_listening_events DROP CONSTRAINT social_listening_events_user_id_platform_provider_event_id_key;
      ALTER TABLE social_competitors DROP CONSTRAINT social_competitors_user_id_platform_public_handle_key`);
    // Exercise the production scoped pool against real RLS; this is a bounded
    // fixture, not a claim to have applied the full application's migration chain.
    const scopedTables=['social_saved_reports', 'social_report_exports', 'social_report_deliveries',
      'social_listening_events', 'social_competitors', 'social_competitor_snapshots', 'social_metric_snapshots',
      'social_content_items', 'social_comment_workflows', 'channel_credentials'];
    await localBusinessIsolation(pool,schema,scopedTables);
    await pool.query(`CREATE UNIQUE INDEX report_scope_name ON social_saved_reports(business_profile_id,user_id,name);
      CREATE UNIQUE INDEX listening_scope_event ON social_listening_events(business_profile_id,user_id,platform,provider_event_id);
      CREATE UNIQUE INDEX competitor_scope_handle ON social_competitors(business_profile_id,user_id,platform,public_handle)`);
    database = drizzle(createBusinessScopedPool(pool));
  });
  beforeEach(async () => {
    jest.clearAllMocks(); errors.length=0;
    moduleEnabled = true;
    await pool.query('TRUNCATE social_saved_reports,social_listening_events,social_metric_snapshots,social_competitors,channel_credentials,social_comment_workflows RESTART IDENTITY CASCADE');
  });
  afterAll(async () => { if(pool) {try {await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);} finally {await pool.end();}} });

  it('validates report/export identifiers before SQL and retains missing/foreign 404s',async()=>{
    for(const [method,path] of [
      ['get','/not-a-uuid/deliveries'],['post','/not-a-uuid/export'],
      ['patch','/not-a-uuid'],['delete','/not-a-uuid'],
      ['get',`/${missing}/exports/not-a-uuid`],['get',`/not-a-uuid/exports/${missing}`],
    ] as const) expect((await http[method](base+path).send({}).timeout({response:1000,deadline:2000})).status).toBe(400);
    expect(errors).toEqual([]);
    expect((await http.get(`${base}/${missing}/deliveries`)).status).toBe(404);
    const saved=await report();
    expect((await http.get(`${base}/${saved.id}/deliveries`).set('x-business-profile-id','1702')).status).toBe(404);
    expect((await http.get(`${base}/${saved.id}/exports/${missing}`)).status).toBe(404);
    expect((await http.get(`${base}/${saved.id}/deliveries`)).body.data).toEqual([]);
  });
  it.each(['0,,15 9 * * *','0- 9 * * *','1e1 9 * * *'])('rejects malformed numeric cron tokens: %s',async scheduleCron=>{
    const result=await http.post(base).send({name:'Invalid cron',filters:{relativeDays:7},scheduleCron,deliveryChannel:'in_app'});
    expect(result.status).toBe(400);
  });
  it('preserves session, selected-business and content access gates',async()=>{
    expect((await http.get(base).set('x-qa-user','0')).status).toBe(401);
    expect((await http.get(base).set('x-business-profile-id','1801')).status).toBe(403);
    moduleEnabled=false;expect((await http.get(base)).status).toBe(403);moduleEnabled=true;
    expect((await http.get(base)).status).toBe(200);
  });
  for(const [method,path,table] of [
    ['get','','social_saved_reports'],['post','','social_saved_reports'],
    ['get','/:id/deliveries','social_report_deliveries'],['post','/:id/export','social_metric_snapshots'],
    ['patch','/:id','social_saved_reports'],['delete','/:id','social_saved_reports'],
    ['get',`/:id/exports/${missing}`,'social_report_exports'],
  ] as const) it(`forwards ${method.toUpperCase()} ${path||'/'} SQL failure to HTTP error middleware and recovers`,async()=>{
    const saved=await report();
    await pool.query(`ALTER TABLE ${table} RENAME TO fixture_unavailable`);
    try {
      const result=await http[method](base+path.replace(':id',saved.id)).send({name:'Failure fixture',filters:{}}).timeout({response:1000,deadline:2000});
      expect(result.status).toBe(500);expect(result.body).toEqual({success:false,error:'Something went wrong'});
      expect(errors).toHaveLength(1);
    } finally {await pool.query(`ALTER TABLE fixture_unavailable RENAME TO ${table}`);}
    expect((await http.get(base)).status).toBe(200);
    expect((await http.get(`${base}/${saved.id}/deliveries`)).status).toBe(200);
    expect(notify).not.toHaveBeenCalled();expect(sendEmail).not.toHaveBeenCalled();
  });
});
