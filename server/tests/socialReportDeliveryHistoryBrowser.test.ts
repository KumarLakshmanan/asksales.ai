import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
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
async function report() {
  const result=await http.post(base).send({name:'Fixture report',filters:{relativeDays:7,timezone:'UTC'},scheduleCron:'0 9 * * 1',deliveryChannel:'in_app'});
  expect(result.status).toBe(201);return result.body.data as {id:string};
}

suite('Report delivery history in production UI and mounted APIs',()=>{
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

  const browserTest=process.env.SOCIAL_INSIGHTS_QA_BROWSER_URL?it:it.skip;
  for(const viewport of [{width:1440,height:900},{width:390,height:844},{width:320,height:757}])browserTest(`keeps delivery history errors and targeted retry inside preview at ${viewport.width}px`,async()=>{
    const web=process.env.SOCIAL_INSIGHTS_QA_BROWSER_URL!;
    if(!['localhost','127.0.0.1'].includes(new URL(web).hostname))throw new Error('Local browser fixture only');
    const directory=process.env.SOCIAL_INSIGHTS_QA_EVIDENCE_DIR||'/tmp/social-report-history';await mkdir(directory,{recursive:true});
    await pool.query(`INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,credential_type,account_identifier,is_active) VALUES(22,17,1701,'instagram_api','oauth','account-a',true)`);
    const saved=await report();
    await pool.query(`INSERT INTO social_report_deliveries(report_id,user_id,business_profile_id,delivery_key,status,attempted_at) VALUES($1,17,1701,'fixture-existing-delivery','sent','2026-10-23T09:00:00Z')`,[saved.id]);
    const {chromium,expect:check}=await import('@playwright/test');
    const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page=await browser.newPage({viewport,deviceScaleFactor:1,serviceWorkers:'block'});
    let historyReads=0,exports=0,release=()=>{};
    const pendingRetry=new Promise<void>(resolve=>release=resolve),pageErrors:string[]=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    try {
      await page.routeWebSocket('**',socket=>new URL(socket.url()).pathname==='/_next/webpack-hmr'?socket.connectToServer():socket.close());
      await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.pathname.startsWith('/api/')){
          const cors={'access-control-allow-origin':web,'access-control-allow-credentials':'true','access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS','access-control-allow-headers':request.headers()['access-control-request-headers']||'*'};
          if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
          if(url.pathname.startsWith('/api/social-analytics/reports')){
            if(url.pathname.endsWith('/export'))exports++;
            if(url.pathname.endsWith('/deliveries')){
              historyReads++;
              if(historyReads===1)moduleEnabled=false;
              let response;
              try{response=await route.fetch({url:`${origin}${url.pathname}${url.search}`});}
              finally{moduleEnabled=true;}
              if(historyReads===2)await pendingRetry;
              return route.fulfill({response,headers:{...response.headers(),...cors}});
            }
            const response=await route.fetch({url:`${origin}${url.pathname}${url.search}`});return route.fulfill({response,headers:{...response.headers(),...cors}});
          }
          let json:unknown=[];
          if(url.pathname==='/api/auth/me')json={user:{id:17,name:'Audit owner',email:'audit@example.test',isSetupComplete:true,isApproved:true,hasBusinessProfile:true,hasBrandToolkit:true}};
          else if(url.pathname==='/api/platform/access')json={maintenance:{enabled:false},modules:['content','integrations','performance_marketing','crm'].map(key=>({key,name:key,enabled:true,status:'available',mode:'enabled'}))};
          else if(url.pathname==='/api/settings/business-profiles')json=[{id:1701,name:'Audit business',companyName:'Audit business',isDefault:true,role:'owner'}];
          else if(url.pathname==='/api/settings/preferences')json={theme:'light',language:'en',timezone:'UTC'};
          else if(url.pathname==='/api/organizations')json={organizations:[]};
          else if(url.pathname==='/api/notifications/unread/count')json={count:0};
          else if(url.pathname==='/api/wallet')json={balance:1000};
          else if(url.pathname==='/api/channel-accounts/instagram_api')json=[{id:22,accountIdentifier:'account-a',accountName:'Account A',analyticsReady:true,isSelected:true}];
          else if(url.pathname==='/api/social-analytics/dashboard')json={summary:{},trends:[],recommendation:{recommendation:null,citations:[]},freshness:{latestSnapshotAt:null,snapshotCount:0,evidenceSourceCount:0},sync:null};
          else if(url.pathname==='/api/social-analytics/content')json={items:[],totalPosts:0,metricTotals:{},metricCoverage:{},formats:[],timeline:[],topContent:[],sync:null};
          else if(!['GET','HEAD'].includes(request.method()))throw new Error(`Unrelated effect blocked: ${url.pathname}`);
          return route.fulfill({json,headers:cors});
        }
        if(url.origin!==web)return route.abort();return route.continue();
      });
      await page.goto(`${web}/dashboard/marketing/analytics?tab=reports&platform=instagram&account=22&start=2026-10-01&end=2026-10-22`);
      await page.getByRole('button',{name:'Edit',exact:true}).click({timeout:30000});
      const editor=page.getByRole('dialog');
      await check(editor.getByLabel('Five-field UTC cron')).toHaveValue('0 9 * * 1');
      await check(editor.getByLabel('Local time')).toHaveCount(0);await check(editor.getByLabel('Timezone',{exact:true})).toHaveCount(0);
      await editor.getByLabel('Five-field UTC cron').fill('0,,15 9 * * *');
      await check(editor.getByRole('alert')).toContainText('valid five-field UTC cron');
      await check(editor.getByRole('button',{name:'Save report'})).toBeDisabled();
      await editor.getByLabel('Five-field UTC cron').fill('30 10 * * 1');
      await editor.getByRole('button',{name:'Save report'}).focus();await page.keyboard.press('Enter');await check(editor).toHaveCount(0);
      expect((await pool.query('SELECT schedule_cron,filters FROM social_saved_reports WHERE id=$1',[saved.id])).rows[0]).toMatchObject({schedule_cron:'30 10 * * 1',filters:{timezone:'UTC'}});
      await page.getByRole('button',{name:'Preview',exact:true}).click({timeout:30000});
      const dialog=page.getByRole('dialog');
      await check(dialog.getByRole('alert')).toContainText('This module is not available for this account.');
      await check(dialog.getByText('No scheduled deliveries yet.')).toHaveCount(0);
      await page.screenshot({path:`${directory}/history-error-${viewport.width}.png`});
      const retry=dialog.getByRole('button',{name:'Retry delivery history'});await retry.focus();await page.keyboard.press('Enter');
      await check(dialog.getByRole('status')).toContainText('Loading delivery history');
      await check(dialog.getByText('No scheduled deliveries yet.')).toHaveCount(0);
      expect(exports).toBe(1);release();
      await check(dialog.getByText(/sent/)).toBeVisible();await check(dialog.getByRole('alert')).toHaveCount(0);
      expect(historyReads).toBe(2);expect(exports).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS count FROM social_report_exports')).rows[0].count).toBe(1);
      expect(notify).not.toHaveBeenCalled();expect(sendEmail).not.toHaveBeenCalled();
      expect(await page.evaluate('({zoom:window.devicePixelRatio,width:window.innerWidth,scroll:document.documentElement.scrollWidth})')).toEqual({zoom:1,width:viewport.width,scroll:viewport.width});
      await page.screenshot({path:`${directory}/history-recovered-${viewport.width}.png`});
      await page.keyboard.press('Escape');await check(dialog).toHaveCount(0);await page.reload();
      await check(page.getByText('Fixture report',{exact:true})).toBeVisible();expect(exports).toBe(1);expect(pageErrors).toEqual([]);
      await writeFile(`${directory}/history-${viewport.width}.json`,JSON.stringify({viewport,historyReads,exports,pageErrors,actual:'Next UI -> production report registration -> content gate -> scoped PostgreSQL; existing sent history retained',mocked:'session/module configuration, shell/account catalog/overview/content, providers/sends'},null,2));
    } catch(error) {await page.screenshot({path:`${directory}/history-failure-${viewport.width}.png`});throw error;}
    finally{release();await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  },90000);
});
