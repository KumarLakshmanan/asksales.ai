import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {spawn} from 'node:child_process';
import type {AddressInfo} from 'node:net';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

// Opt-in disposable local fixture. Application environment files are never read.
const connectionString = process.env.SOCIAL_INSIGHTS_QA_DATABASE_URL;
// Enable only with Data's safe-envelope dependency composed. Never auto-skip based on implementation.
const suite = connectionString && process.env.SOCIAL_INSIGHTS_QA_ERROR_ENVELOPE === '1' ? describe : describe.skip;
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
const {listSocialContentComments} = await import('../controllers/socialContentController.js');
const {businessProfileScope} = await import('../middleware/businessProfileScope.js');
const {businessPermissions} = await import('../middleware/businessPermissions.js');
const {requireModuleAccess} = await import('../middleware/platformAccess.js');
const {responseWrapper} = await import('../middleware/responseWrapper.js');
const app = express();app.use(express.json());app.use('/api',responseWrapper);
// Only session establishment is synthetic; resolver, permission gate, production
// report registration, controller, scoped pool and PostgreSQL/RLS are actual.
const authenticate=(req:express.Request,res:express.Response,next:express.NextFunction)=>{
  req.user={id:17} as typeof req.user;
  return businessProfileScope(req,res,()=>businessPermissions(req,res,next));
};
let reads=0,providerCalls=0,gatewayReads=0;
const productionRoutes=await readFile(new URL('../routes.ts',import.meta.url),'utf8');
const commentRoute=productionRoutes.split('\n').find(line=>line.includes("app.get('/api/social-analytics/content/:id/comments',"));
if(!commentRoute)throw new Error('Mounted comments route not found');
app.use('/api/social-analytics/content/99/comments',(_req,_res,next)=>{reads++;next();});
new Function('app','authenticateToken','requireModuleAccess','listSocialContentComments',commentRoute)(app,authenticate,requireModuleAccess,listSocialContentComments);
app.get('/api/social-envelope-gateway-fixture',(_req,res)=>{
  gatewayReads++;return gatewayReads===1?res.status(503).json({error:'Fixture restart'}):res.json({ok:true});
});
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
const http=supertest(app);
async function clientRead(endpoint:string) {
  const child=spawn(process.execPath,['--import','tsx','tests/helpers/socialProviderReadFixture.mts',endpoint],{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  let output='',stderr='';child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>stderr+=String(chunk));
  const code=await new Promise<number|null>(resolve=>child.once('close',resolve));
  if(code!==0)throw new Error(`Client fixture failed: ${stderr}`);
  return JSON.parse(output.trim());
}

suite('Social consumer acceptance of Data safe error envelope',()=>{
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

  it('preserves provider identity through mounted SQL/controller/wrapper and makes one actual frontend read',async()=>{
    await pool.query(`INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,credential_type,account_identifier,is_active,access_token) VALUES(22,17,1701,'instagram_api','oauth','account-a',true,'synthetic-provider-token');
      INSERT INTO social_content_items(user_id,business_profile_id,credential_id,provider_id,platform,content_type,published_at) VALUES(17,1701,22,'99','instagram','reel','2026-10-21')`);
    const realFetch=globalThis.fetch.bind(globalThis);
    const transport=jest.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
      const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
      if(target.hostname==='127.0.0.1')return realFetch(input,options);
      if(!['graph.facebook.com','graph.instagram.com'].includes(target.hostname))throw new Error('Unrelated external transport blocked');
      providerCalls++;throw new Error('Synthetic provider timeout');
    });
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    try {
      const path='/api/social-analytics/content/99/comments?credentialId=22&platform=instagram';
      const response=await http.get(path);
      expect(response.status).toBe(503);expect(response.body.code).toBe('SOCIAL_PROVIDER_TIMEOUT');
      const beforeReads=reads,beforeProvider=providerCalls;
      const result=await clientRead(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
      expect(result).toEqual({outcome:'rejected',status:503,code:'SOCIAL_PROVIDER_TIMEOUT'});
      expect(reads-beforeReads).toBe(1);expect(providerCalls-beforeProvider).toBe(2);expect(errors).toEqual([]);
      expect(notify).not.toHaveBeenCalled();expect(sendEmail).not.toHaveBeenCalled();
    }finally{transport.mockRestore();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  },15000);
  it('retains a bounded real frontend retry for an unclassified gateway failure',async()=>{
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    try {
      const result=await clientRead(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/social-envelope-gateway-fixture`);
      expect(result).toEqual({outcome:'resolved',result:{ok:true}});expect(gatewayReads).toBe(2);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  },15000);
});
