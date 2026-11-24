import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as proxyRequest, type Server } from 'node:http';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { Worker } from 'bullmq';
import { chromium } from 'playwright-core';
import { withBusinessScope, currentBusinessScope } from '../tenancy/businessContext.js';
import { currentBillingScope } from '../tenancy/billingContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';
let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({}, {get:(_t,key)=>{const v=Reflect.get(fixtureDb,key);return typeof v==='function'?v.bind(fixtureDb):v;}})}));
// Only login/session establishment is synthetic; authorization lookup, scope, router and widget persistence are real.
jest.unstable_mockModule('../middleware/auth.js',()=>({authenticateToken:async(req:any,res:any,next:any)=>{
  if(req.get('Authorization')!=='Bearer synthetic-audit-session'&&!String(req.get('Cookie')||'').includes('audit_session=synthetic')) return res.status(401).json({error:'Synthetic session required'});
  const {resolveBusinessScope}=await import('../tenancy/businessScopeResolver.js');
  const scope=await resolveBusinessScope(9,Number(req.get('X-Business-Profile-Id')||91));
  if(!scope)return res.status(403).json({error:'Business unavailable'});
  req.user={id:9};req.businessScope=scope;return withBusinessScope(scope,next);
}}));
const {default:router}=await import('../routes/supportWidget.routes.js');
const {responseWrapper}=await import('../middleware/responseWrapper.js');
const {csrfProtection}=await import('../middleware/csrf.js');
const {widgetInstallationCors,isWidgetInstallationRequest}=await import('../middleware/widgetInstallationCors.js');
const {closeRedisConnections,getRedisConnection}=await import('../infrastructure/redis.js');
const {queueRegistry,QUEUE_NAMES}=await import('../queues/index.js');
const {runBusinessJob}=await import('../tenancy/jobBusinessScope.js');
const {processSupportWidgetTurn}=await import('../workers/outreach/supportWidgetProcessor.js');
const {supportTeamsTable}=await import('../models/supportTeams/schema.js');
const {teamMembersTable}=await import('../models/teamMembers/schema.js');
const {supportChatSessionsTable}=await import('../models/supportChatSessions/schema.js');
const {supportChatMessagesTable}=await import('../models/supportChatMessages/schema.js');
const {supportTicketsTable}=await import('../models/supportTickets/schema.js');
const {supportTicketMessagesTable}=await import('../models/supportTicketMessages/schema.js');
const {outreachMessagesTable,outreachConversationsTable}=await import('../models/outreachConversations/schema.js');
const {companySettings}=await import('../models/companySettings/schema.js');
const support=await import('../models/supportOrchestration/schema.js');
// @ts-expect-error JS migration
const {up:turnMigration}=await import('../migrations/293_support_conversation_turns.js');
const token='a'.repeat(64), otherToken='b'.repeat(64), evidence=process.env.SUPPORT_WIDGET_FIX_EVIDENCE_DIR||'/tmp/widget-boundary-regression-evidence';
const app=express();let failTokens=false;const trace:any[]=[];
app.use((req,res,next)=>isWidgetInstallationRequest(req)?widgetInstallationCors(req,res,next):cors({origin:'http://127.0.0.1:55880',credentials:true})(req,res,next));
app.use(csrfProtection);app.use(express.json());app.use('/api',responseWrapper);
app.use((req,res,next)=>{trace.push({method:req.method,path:req.path,profile:req.get('X-Business-Profile-Id')||null,hasOwnerCookie:String(req.get('Cookie')||'').includes('asksales_session='),hasAuthorization:Boolean(req.get('Authorization'))});
  if(req.path==='/api/support-widget/generate-token'||req.method==='DELETE')return res.status(418).json({error:'Audit forbids key mutation'});
  if(failTokens&&req.path==='/api/support-widget/token'){failTokens=false;return res.status(503).json({error:'Synthetic token lookup outage'});}next();});
app.use('/api/support-widget',router);
// The same-origin deployment shape uses the actual Next page/assets, not a rewritten API mock.
app.use((req,res,next)=>{
  if(req.method!=='GET'||!['/support-widget/','/_next/'].some(prefix=>req.path.startsWith(prefix)))return next();
  const upstream=proxyRequest({hostname:'127.0.0.1',port:55880,path:req.originalUrl,method:'GET'},reply=>{
    res.status(reply.statusCode||502);for(const [key,value] of Object.entries(reply.headers))if(value!==undefined)res.setHeader(key,value);reply.pipe(res);
  });upstream.on('error',next);upstream.end();
});
app.get('/fixture-host',(_req,res)=>res.type('html').send(`<html><body><h1>Synthetic customer site</h1><script src="http://127.0.0.1:55881/api/support-widget/embed.js?token=${token}"></script></body></html>`));
app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({error:error.message}));
(process.env.SUPPORT_PUBLIC_WIDGET_QA_DATABASE_URL?describe:describe.skip)('widget boundary regressions through mounted HTTP/PostgreSQL/Redis',()=>{
  let admin:Pool,pool:Pool,schema:string,server:Server,worker:Worker;const captured:any[]=[];
  beforeAll(async()=>{
    mkdirSync(evidence,{recursive:true});
    const connectionString=process.env.SUPPORT_PUBLIC_WIDGET_QA_DATABASE_URL!;
    const endpoint=new URL(connectionString);
    if(endpoint.hostname!=='127.0.0.1'||endpoint.port!=='55432'||endpoint.pathname!=='/support_ai_audit'
      ||process.env.REDIS_HOST!=='127.0.0.1'||process.env.REDIS_PORT!=='56379')throw Error('Dedicated loopback audit database and Redis required');
    process.env.SUPPORT_PII_ENCRYPTION_KEY='synthetic-widget-audit-encryption-key-32-chars';
    process.env.SUPPORT_CONVERSATION_TURN_CHANNELS='web';process.env.SUPPORT_ASSISTANTS_ENABLED='false';
    // Fail closed before any provider. No external request may occur in this fixture.
    jest.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('External fetch forbidden in audit');});
    schema=`widget_second_pass_${randomBytes(8).toString('hex')}`;admin=new Pool({connectionString,max:1});await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new Pool({connectionString,max:10,options:`-c search_path=${schema},pg_catalog`});await localBusinessFunctions(pool);await pool.query(`CREATE FUNCTION app_billing_organization_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.billing_organization_id',true),'')::integer $$`);
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,deleted_at TIMESTAMP,is_approved BOOLEAN DEFAULT TRUE);
      INSERT INTO users(id) VALUES(9),(10),(17);
      CREATE TABLE business_profile_memberships(id SERIAL,business_profile_id INTEGER,user_id INTEGER,status TEXT,role TEXT);
      CREATE TABLE business_profile_preferences(user_id INTEGER,default_business_profile_id INTEGER);
      CREATE TABLE billing_organizations(id INTEGER PRIMARY KEY,name TEXT,owner_user_id INTEGER,default_for_user_id INTEGER,billing_eligibility_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE billing_organization_memberships(organization_id INTEGER,user_id INTEGER,status TEXT,role TEXT);
      INSERT INTO billing_organizations(id,name,owner_user_id) VALUES(100,'Synthetic payer',9),(200,'Other payer',10);
      INSERT INTO billing_organization_memberships VALUES(100,9,'active','owner'),(200,10,'active','owner');
      CREATE TABLE handoff_queue(id SERIAL,user_id INTEGER,conversation_id INTEGER,status TEXT,ai_reply_enabled BOOLEAN,support_ticket_id INTEGER,created_at TIMESTAMP DEFAULT NOW());`);
    const tables=[companySettings,supportTeamsTable,teamMembersTable,supportChatSessionsTable,supportChatMessagesTable,supportTicketsTable,supportTicketMessagesTable,
      outreachMessagesTable,outreachConversationsTable,support.supportPrivacyVaultTable,support.supportPrivacyAccessLogsTable,support.supportPlaybookRunsTable,support.supportPlaybookVersionsTable];
    const names:string[]=[];
    for(const table of tables){const d=getTableConfig(table);names.push(d.name);const columns=d.columns.map(c=>{const v=c.default;
      const def=v instanceof SQL?new PgDialect().sqlToQuery(v).sql:v===undefined?undefined:typeof v==='number'||typeof v==='boolean'?String(v):`'${(typeof v==='string'?v:JSON.stringify(v)).replace(/'/g,"''")}'`;
      return `"${c.name}" ${c.getSQLType()}${c.primary?' PRIMARY KEY':''}${def===undefined?'':` DEFAULT ${def}`}`;});await pool.query(`CREATE TABLE "${d.name}" (${columns.join(',')})`);}
    await pool.query(`INSERT INTO company_settings(id,user_id,name,company_name,is_default,billing_organization_id) VALUES(91,9,'Synthetic profile','Synthetic help',true,100),(92,9,'Second profile','Second help',false,100),(101,10,'Other profile','Other help',true,200);
      CREATE UNIQUE INDEX widget_session_identity ON support_chat_sessions(client_session_key);
      CREATE UNIQUE INDEX widget_message_identity ON support_chat_messages(session_id,request_id) WHERE request_id IS NOT NULL;
      CREATE UNIQUE INDEX widget_vault_identity ON support_privacy_vault(business_profile_id,user_id,channel,provider_message_id);
      CREATE UNIQUE INDEX active_run ON support_playbook_runs(user_id,conversation_id) WHERE status='active';
      INSERT INTO support_teams(id,business_profile_id,user_id,name,is_active,widget_token) VALUES(1,91,9,'Synthetic help',true,'${token}'),(2,101,10,'Other help',true,'${otherToken}');
      INSERT INTO team_members(id,business_profile_id,team_id,user_id,is_active) VALUES(1,91,1,9,true),(2,101,2,10,true);`);
    await turnMigration(pool);
    // Exact initial assistant/binding DDL from migration 311, without provisioning or migration rollout effects.
    await pool.query('CREATE TABLE ai_agent_configs(id INTEGER PRIMARY KEY)');
    const assistantDdl=readFileSync(new URL('../migrations/311_outreach_assistants.js',import.meta.url),'utf8').split('await client.query(`')[1].split('CREATE TABLE outreach_assistant_audit')[0];
    await pool.query(assistantDdl);names.push('outreach_assistants','outreach_assistant_revisions','outreach_assistant_bindings');
    await localBusinessIsolation(pool,schema,[...names.filter(n=>n!=='company_settings'),'handoff_queue','support_conversation_turns','support_conversation_turn_inputs','support_conversation_turn_runs']);
    fixtureDb=drizzle(createBusinessScopedPool(pool));await getRedisConnection().flushdb();await queueRegistry.initialize();
    server=await new Promise(resolve=>{const s=app.listen(55881,'127.0.0.1',()=>resolve(s));});
  },60000);
  afterAll(async()=>{
    writeFileSync(`${evidence}/mounted-trace.json`,JSON.stringify({trace,captured},null,2));
    await worker?.close();await queueRegistry.close();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await closeRedisConnections();await pool?.end();if(admin&&schema){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}jest.restoreAllMocks();
  },30000);
  it('mounted setup reads are tenant scoped and the real config excludes private capability fields',async()=>{
    const list=await request(app).get('/api/support-widget/token').set('Authorization','Bearer synthetic-audit-session').set('X-Business-Profile-Id','91');
    expect(list.status).toBe(200);expect(list.body.data.map((x:any)=>x.teamId)).toEqual([1]);
    const empty=await request(app).get('/api/support-widget/token').set('Authorization','Bearer synthetic-audit-session').set('X-Business-Profile-Id','92');expect(empty.body.data).toEqual([]);
    expect((await request(app).get('/api/support-widget/token').set('Authorization','Bearer synthetic-audit-session').set('X-Business-Profile-Id','101')).status).toBe(403);
    expect((await request(app).get('/api/support-widget/token')).status).toBe(401);
    const config=await request(app).get('/api/support-widget/config').query({token});expect(config.status).toBe(200);expect(JSON.stringify(config.body)).not.toContain('publicToken');
    writeFileSync(`${evidence}/mounted-config.json`,JSON.stringify(config.body,null,2));
  });
  it('real queue captures immutable widget identity and actual disabled-assistant routing completes without a customer answer',async()=>{
    const response=await request(app).post('/api/support-widget/chat').send({token,message:'Synthetic hours question',requestId:'second-pass-queue',clientSessionKey:'second-pass-session',userId:10,businessProfileId:101,billingOrganizationId:200});
    expect(response.status).toBe(202);const queue=queueRegistry.getQueue(QUEUE_NAMES.OUTREACH)!;const jobs=await queue.getJobs(['waiting','delayed']);expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toMatchObject({userId:9,businessProfileId:91,businessActorUserId:9,billingActorUserId:9,billingOrganizationId:100});
    const settled=new Promise<any>((resolve,reject)=>{worker=new Worker(QUEUE_NAMES.OUTREACH,async job=>runBusinessJob(job.data,async()=>{
      captured.push({data:job.data,business:currentBusinessScope(),billing:currentBillingScope()});return processSupportWidgetTurn(job);
    }),{connection:getRedisConnection() as any});worker.on('completed',(_j,result)=>resolve(result));worker.on('failed',(_j,error)=>reject(error));});
    const result=await settled;expect(result).toMatchObject({success:true,method:'no_op'});
    const messages=await pool.query('SELECT role,content,processing_status FROM support_chat_messages ORDER BY id');expect(messages.rows).toHaveLength(1);expect(messages.rows[0].processing_status).toBe('completed');
    const history=await request(app).get(`/api/support-widget/session/${response.body.data.sessionId}/messages`).query({token,sessionToken:response.body.data.sessionToken});expect(history.status).toBe(200);
    writeFileSync(`${evidence}/actual-disabled-assistant.json`,JSON.stringify({response:response.body,result,messages:messages.rows,history:history.body},null,2));
    await worker.close();worker=undefined as any;
  },30000);
  it('enabled runtime without a published web binding is accepted by config but real router finishes silently',async()=>{
    process.env.SUPPORT_ASSISTANTS_ENABLED='true';delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
    const reply=await request(app).post('/api/support-widget/chat').send({token,message:'Synthetic unassigned question',requestId:'second-pass-unassigned',clientSessionKey:'unassigned-session'});expect(reply.status).toBe(202);
    const {resolveTurnAssistant}=await import('../services/assistants/AssistantResolver.js');
    await expect(withBusinessScope({userId:9,businessProfileId:91},()=>resolveTurnAssistant({userId:9,conversationId:-reply.body.data.sessionId,channel:'web',text:'Synthetic',metadata:{}} as any))).rejects.toThrow('No unique live assistant');
    const result=await new Promise<any>((resolve,reject)=>{worker=new Worker(QUEUE_NAMES.OUTREACH,job=>runBusinessJob(job.data,()=>processSupportWidgetTurn(job)),{connection:getRedisConnection() as any});worker.on('completed',(_j,r)=>resolve(r));worker.on('failed',(_j,e)=>reject(e));});
    expect(result).toMatchObject({success:true,method:'no_op'});await worker.close();worker=undefined as any;
    const messages=(await pool.query('SELECT role,content,processing_status FROM support_chat_messages WHERE session_id=$1',[reply.body.data.sessionId])).rows;expect(messages).toHaveLength(1);expect(messages[0].processing_status).toBe('completed');
    writeFileSync(`${evidence}/actual-unassigned-assistant.json`,JSON.stringify({response:reply.body,result,messages},null,2));
  },30000);
  (process.env.SUPPORT_PUBLIC_WIDGET_QA_BROWSER==='1'?it:it.skip)('real loader and public iframe at normal zoom dismisses from iframe Escape and restores launcher focus',async()=>{
    const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
    const results:any[]=[];
    worker=new Worker(QUEUE_NAMES.OUTREACH,async job=>runBusinessJob(job.data,()=>processSupportWidgetTurn(job)),{connection:getRedisConnection() as any});
    try{for(const width of [320,390,768,1440]){const page=await browser.newPage({viewport:{width,height:900}});await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort('blockedbyclient'));await page.goto('http://127.0.0.1:55881/fixture-host');
      const fab=page.locator('#support-widget-fab');await fab.waitFor();await fab.focus();await page.keyboard.press('Enter');
      const frame=page.frameLocator('iframe');const input=frame.locator('textarea');await input.waitFor();await input.focus();
      if(width===320){
        await input.fill('Synthetic browser no-op question');await input.press('Enter');
        await page.waitForResponse(r=>r.url().includes('/messages?')&&r.status()===200);
        await frame.getByText('Preparing a response…',{exact:true}).waitFor({state:'hidden',timeout:25000});
        const publicTextAfterCompletedNoOp=await frame.locator('body').innerText();expect(publicTextAfterCompletedNoOp).toContain('Your message was saved, but an automated reply is not available.');
        const customerFrame=page.frames().find(f=>f.url().includes('/support-widget/'))!;await customerFrame.goto(customerFrame.url());await frame.getByLabel('Message to support').waitFor();await frame.getByText('Synthetic browser no-op question',{exact:true}).waitFor();
        const publicTextAfterReload=await frame.locator('body').innerText();expect(publicTextAfterReload).toContain('Your message was saved, but an automated reply is not available.');results.push({publicTextAfterCompletedNoOp,publicTextAfterReload});
      }
      // A different origin, source window or message type must not close the widget.
      for(const script of [
        "window.dispatchEvent(new MessageEvent('message',{origin:'https://untrusted.example',source:document.querySelector('iframe').contentWindow,data:{type:'asksales:support-widget:close'}}))",
        "window.dispatchEvent(new MessageEvent('message',{origin:'http://127.0.0.1:55880',source:window,data:{type:'asksales:support-widget:close'}}))",
        "window.dispatchEvent(new MessageEvent('message',{origin:'http://127.0.0.1:55880',source:document.querySelector('iframe').contentWindow,data:{type:'unknown-command'}}))",
      ]){await page.evaluate(script);expect(await fab.getAttribute('aria-expanded')).toBe('true');}
      await input.focus();await input.press('Escape');
      await page.waitForFunction("document.getElementById('support-widget-fab').getAttribute('aria-expanded') === 'false'",null,{timeout:2000});
      expect(await page.evaluate('document.activeElement.id')).toBe('support-widget-fab');
      const escapeInside=await fab.getAttribute('aria-expanded');await page.screenshot({path:`${evidence}/embed-${width}-escape.png`});
      await fab.focus();await page.keyboard.press('Enter');await fab.focus();await page.keyboard.press('Escape');const escapeParent=await fab.getAttribute('aria-expanded');
      results.push({width,devicePixelRatio:await page.evaluate<number>('window.devicePixelRatio'),escapeInside,escapeParent,overflow:await page.evaluate<boolean>('document.documentElement.scrollWidth>innerWidth')});
      expect(escapeParent).toBe('false');expect(escapeInside).toBe('false');await page.close();}
      const installation=await pool.query('SELECT widget_settings FROM support_teams WHERE id=1');results.push({installation:installation.rows});
      writeFileSync(`${evidence}/iframe-keyboard.json`,JSON.stringify(results,null,2));
    }finally{await browser.close();await worker.close();worker=undefined as any;}
  },120000);
  (process.env.SUPPORT_PUBLIC_WIDGET_QA_BROWSER==='1'?it:it.skip)('omits ambient owner cookies from same-origin public config, restoration and polling',async()=>{
    const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
    try{
      const session=(await pool.query('SELECT id,public_token FROM support_chat_sessions ORDER BY id LIMIT 1')).rows[0];
      const page=await browser.newPage();await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort('blockedbyclient'));await page.context().addCookies([{name:'asksales_session',value:'synthetic-owner-session',url:'http://127.0.0.1:55881',httpOnly:true,sameSite:'Lax'}]);
      await page.addInitScript(`localStorage.setItem('sw_session_${token}',${JSON.stringify(String(session.id))});localStorage.setItem('sw_session_${token}_token',${JSON.stringify(session.public_token)});`);
      const start=trace.length;await page.goto(`http://127.0.0.1:55881/support-widget/${token}`);await page.getByLabel('Message to support').waitFor();
      const reads=trace.slice(start).filter(t=>t.method==='GET'&&t.path.startsWith('/api/support-widget/'));expect(reads.length).toBeGreaterThanOrEqual(2);
      writeFileSync(`${evidence}/public-read-cookies.json`,JSON.stringify(reads,null,2));
      expect(reads.map(t=>t.hasOwnerCookie)).toEqual(reads.map(()=>false));expect(reads.some(t=>t.hasAuthorization)).toBe(false);
    }finally{await browser.close();}
  },30000);
  (process.env.SUPPORT_PUBLIC_WIDGET_QA_BROWSER==='1'?it:it.skip)('opens assistant settings from real scoped embed reads without key mutation',async()=>{
    const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});const observations:unknown[]=[];
    try{for(const width of [390,1440]){
      const page=await browser.newPage({viewport:{width,height:1000}});await page.context().addCookies([{name:'audit_session',value:'synthetic',url:'http://127.0.0.1:55881'}]);
      await page.routeWebSocket('**/*',route=>route.close());await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.fallback():route.abort('blockedbyclient'));
      const user={id:9,name:'Synthetic owner',email:'audit@example.test',isSetupComplete:true,isApproved:true,hasBusinessProfile:true,hasBrandToolkit:true};
      await page.route('**/api/**',async route=>{
        const path=new URL(route.request().url()).pathname;if(path.startsWith('/api/support-widget/'))return route.continue();
        let body:unknown={success:true,data:[]};
        if(path==='/api/auth/me')body={user};
        if(path==='/api/settings/business-profiles')body=[{id:91,name:'Synthetic profile',companyName:'Synthetic help',isDefault:true,role:'owner'}];
        if(path==='/api/platform/access')body={maintenance:{enabled:false,message:''},modules:['support_ai','support','crm','billing','storage','integrations','outreach'].map(key=>({key,name:key,enabled:true,status:'available',mode:'enabled'}))};
        if(path==='/api/settings/preferences')body={theme:'light',language:'en',timezone:'UTC'};
        if(path==='/api/wallet')body={balance:1000};
        if(path==='/api/notifications/unread/count')body={count:0};
        if(path==='/api/settings/outreach/assistants/catalog')body={runtimeEnabled:false,presets:[],accounts:[],models:[],knowledge:[],playbooks:[],templates:[],documents:[],galleries:[],tools:[],permissions:{canManage:false}};
        if(path==='/api/settings/outreach/assistants')body={assistants:[],runtimeEnabled:false,nextCursor:null};
        return route.fulfill({json:body});
      });
      await page.addInitScript(`localStorage.setItem('user',${JSON.stringify(JSON.stringify(user))});localStorage.setItem('hasBusinessProfile','true');localStorage.setItem('hasBrandToolkit','true');sessionStorage.setItem('active-business-profile:9','91');`);
      await page.goto('http://127.0.0.1:55880/dashboard/support-ai/embed');await page.getByRole('heading',{name:'Embed & integrate',exact:true}).waitFor();await page.getByRole('button',{name:'Rotate widget key for Synthetic help'}).waitFor();
      const link=page.getByRole('link',{name:'Assistant settings',exact:true});expect(await link.getAttribute('href')).toBe('/dashboard/settings/outreach');
      const overflow=await page.evaluate<boolean>('document.documentElement.scrollWidth>innerWidth');expect(overflow).toBe(false);await page.screenshot({path:`${evidence}/embed-assistant-settings-${width}.png`,fullPage:true});
      await page.getByRole('link',{name:'Customize widget',exact:true}).click();await page.waitForURL('**/support-ai/widget-settings?team=1');await page.getByLabel('Greeting',{exact:true}).waitFor();await page.screenshot({path:`${evidence}/widget-settings-${width}.png`,fullPage:true});await page.goBack();await page.getByRole('heading',{name:'Embed & integrate',exact:true}).waitFor();
      await link.click();await page.waitForURL('**/dashboard/settings/outreach');observations.push({width,overflow,destination:page.url()});await page.close();
    }expect(trace.filter(t=>t.path==='/api/support-widget/generate-token'||t.method==='DELETE')).toEqual([]);writeFileSync(`${evidence}/assistant-navigation.json`,JSON.stringify(observations,null,2));
    }finally{await browser.close();}
  },60000);
  it('actual migration 304 blocks payer drift and widget recovery retains immutable originating business',async()=>{
    const response=await request(app).post('/api/support-widget/chat').send({token,message:'Synthetic recovery question',requestId:'second-pass-recovery',clientSessionKey:'recovery-session'});expect(response.status).toBe(202);
    const queue=queueRegistry.getQueue(QUEUE_NAMES.OUTREACH)!;const before=await queue.getJobs(['waiting','delayed']);expect(before).toHaveLength(1);expect(before[0].data.billingOrganizationId).toBe(100);
    const original=before[0].data;await before[0].remove(); // Real Redis wake-up loss, no provider execution.
    const inbox=(await pool.query("SELECT i.payload,s.scope_key FROM support_conversation_turn_inputs i JOIN support_conversation_turns s USING(scope_key) WHERE (i.payload->>'sessionId')::int=$1",[response.body.data.sessionId])).rows[0];
    expect(inbox.payload.businessProfileId).toBeUndefined();expect(inbox.payload.billingOrganizationId).toBeUndefined();expect(inbox.payload.businessActorUserId).toBeUndefined();
    const guard=readFileSync(new URL('../migrations/304_business_profile_memberships.js',import.meta.url),'utf8').split('CREATE OR REPLACE FUNCTION billing_resource_organization_guard()')[1].split('CREATE OR REPLACE FUNCTION billing_capacity_authorize')[0];
    await pool.query(`CREATE OR REPLACE FUNCTION billing_resource_organization_guard()${guard}CREATE TRIGGER billing_organization_guard BEFORE INSERT OR UPDATE ON company_settings FOR EACH ROW EXECUTE FUNCTION billing_resource_organization_guard('user_id');`);
    await pool.query(`INSERT INTO billing_organizations(id,name,owner_user_id) VALUES(300,'Changed synthetic payer',9);INSERT INTO billing_organization_memberships VALUES(300,9,'active','owner');`);
    let denial:any;try{await pool.query('UPDATE company_settings SET billing_organization_id=300 WHERE id=91');}catch(e:any){denial={code:e.code,message:e.message};}
    expect(denial).toMatchObject({code:'42501',message:'Business ownership and its billing account cannot be reassigned'});
    await pool.query("UPDATE support_conversation_turns SET updated_at=NOW()-INTERVAL '2 minutes' WHERE scope_key=$1",[inbox.scope_key]);
    const {recoverSupportConversationTurns}=await import('../services/agents/orchestration/SupportConversationTurn.js');
    const count=await withBusinessScope({userId:9,businessProfileId:91},()=>recoverSupportConversationTurns());expect(count).toBe(1);
    const after=await queue.getJobs(['waiting','delayed']);expect(after).toHaveLength(1);expect(after[0].data.billingOrganizationId).toBe(100);
    writeFileSync(`${evidence}/recovery-authority-guarded.json`,JSON.stringify({status:'Payer drift blocked by real migration 304 guard; missing inbox identity is a shared static contract review, not a reproduced widget defect',denial,original,inbox:inbox.payload,recovered:after[0].data},null,2));await after[0].remove();
  },30000);

});
