import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import dotenv from 'dotenv';
import {Pool} from 'pg';
import {drizzle,type NodePgDatabase} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import type {Request,Response} from 'express';
import {createBusinessScopedPool} from '../tenancy/scopedPool.js';
import {withBusinessScope} from '../tenancy/businessContext.js';
import {DEFAULT_CRM_CONFIGURATION} from '../../shared/crmConfiguration.js';
import {type AutomationAction,type AutomationDefinition} from '../../shared/crmAutomations.js';

const postgres=process.env.CRM_AUTOMATIONS_LOCAL_QA==='1' ? describe : describe.skip;
let database:NodePgDatabase,fixture:Pool,admin:Pool,runtime:Pool,schema:string,createdRole=false,grantedRole=false;
let crashAfterTicket=false,crashCommit=false,senderReady=true,ticketGate:Promise<void>|null=null,ticketEntered:(()=>void)|null=null;
const proxy=new Proxy({} as NodePgDatabase,{get(_target,key){
  if (key==='transaction') return async(work:Parameters<NodePgDatabase['transaction']>[0])=>{
    const result=await database.transaction(work);
    if (crashCommit) {crashCommit=false;throw Object.assign(new Error('Simulated lost commit response'),{code:'08006'});}
    return result;
  };
  const value=database[key as keyof NodePgDatabase];return typeof value==='function' ? value.bind(database) : value;
}});
const emailSend=jest.fn<any>(),smsSend=jest.fn<any>(),waSend=jest.fn<any>(),charge=jest.fn<any>(),refund=jest.fn<any>(),webhook=jest.fn<any>();
jest.unstable_mockModule('../models/db.js',()=>({db:proxy}));
jest.unstable_mockModule('../events/EventBus.js',()=>({eventBus:{publish:async()=>undefined},EVENT_CHANNELS:{CRM_AUTOMATION_UPDATED:'events:crm:automation:updated'}}));
const getAutomationJob=jest.fn<any>();
jest.unstable_mockModule('../queues/index.js',()=>({queueRegistry:{addJob:jest.fn(),getQueue:()=>({getJob:getAutomationJob})},QUEUE_NAMES:{CRM_AUTOMATIONS:'crm-automations'}}));
jest.unstable_mockModule('../utils/logger.js',()=>({logger:{error:jest.fn(),warn:jest.fn(),info:jest.fn(),debug:jest.fn()}}));
jest.unstable_mockModule('../services/SupportService.js',()=>({supportService:{createTicket:async(userId:number,input:{contactId:number;subject:string;priority:string},context:{database:NodePgDatabase})=>{
  if(ticketGate) {ticketEntered?.();await ticketGate;}
  const result=await context.database.execute(sql`INSERT INTO support_tickets(user_id,business_profile_id,contact_id,ticket_number,subject,priority,status)
    VALUES(${userId},101,${input.contactId},${`TKT-${randomBytes(4).toString('hex')}`},${input.subject},${input.priority},'open') RETURNING id,ticket_number`);
  if (crashAfterTicket) {crashAfterTicket=false;crashCommit=true;}
  return {id:result.rows[0].id,ticketNumber:result.rows[0].ticket_number};
}}}));
jest.unstable_mockModule('../services/subscriptions/service.js',()=>({requireSubscriptionForOperation:async()=>undefined}));
jest.unstable_mockModule('../services/CreditService.js',()=>({creditService:{deductOnceForResource:charge,refundDeduction:refund}}));
jest.unstable_mockModule('../services/SmartThrottlingService.js',()=>({SmartThrottlingService:{getInstance:()=>({isAllowed:async()=>({allowed:true}),claimRequest:async()=>({allowed:true}),recordRequest:async()=>undefined})}}));
jest.unstable_mockModule('../services/emailService.js',()=>({emailService:{sendEmailWithUserCredentials:emailSend}}));
jest.unstable_mockModule('../services/smsService.js',()=>({sendSMS:smsSend}));
jest.unstable_mockModule('../services/whatsappApiService.js',()=>({whatsappApiService:{sendTemplate:waSend,listApprovedTemplates:async()=>[{id:'meta-template',name:'hello',language:'en',body:'Hello {{1}}',headerType:'TEXT',buttons:[]}]}}));
jest.unstable_mockModule('../utils/safeRemoteFetch.js',()=>({assertPublicHttpUrl:async(value:string)=>new URL(value),fetchPublicHttpUrl:webhook}));
jest.unstable_mockModule('../services/outreach/CreationService.js',()=>({getCreationOptions:async(_user:number,channel:string)=>({accounts:[{senderId:channel==='email' ? 7 : undefined,providerAccountId:channel==='email' ? 'example.test' : `${channel}-account`,label:channel,ready:senderReady}]}),
  resolveCreationAccount:async(_user:number,channel:string,selection:{senderId?:number;providerAccountId?:string})=>({account:{senderId:selection.senderId,providerAccountId:channel==='email' ? 'example.test' : `${channel}-account`,ready:senderReady,reason:'Sender disconnected'},binding:senderReady ? {} : null}),
  validateCreationTemplate:()=> 'Hello Alex'}));
jest.unstable_mockModule('../models/channelCredentials/functions.js',()=>({ChannelCredentialModel:{findActiveAccountByIdentifier:async()=>({accountIdentifier:'SMSAPP',sessionData:{flowId:'flow-1'},isActive:senderReady})}}));
jest.unstable_mockModule('../utils/msg91Credentials.js',()=>({inspectMSG91Credential:()=>({settings:{senderId:'SMSAPP',flowId:'flow-1'},ready:senderReady,issue:'Sender disconnected'})}));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js',()=>({decryptChannelCredentialSession:(value:unknown)=>value}));

const {processAutomationEvent,dispatchAutomationEvents}=await import('../services/automations/AutomationEngine.js');
const {queueRegistry}=await import('../queues/index.js');
const {AutomationActionError}=await import('../services/automations/AutomationDelivery.js');
const {recordAutomationReceipt}=await import('../services/automations/AutomationReceipts.js');
const {automationService}=await import('../services/AutomationService.js');
const {getRuns,getRun}=await import('../controllers/crmAutomationsController.js');
const {saveCrmConfiguration}=await import('../services/CRMConfigurationService.js');
// @ts-expect-error JavaScript migration modules are used by the migration runner.
const migration=await import('../migrations/314_crm_automation_builder.js');
const scope=<T>(work:()=>T,profile=101)=>withBusinessScope({userId:9,businessProfileId:profile},work);
const tag:AutomationAction={id:'tag',type:'update_tags',config:{tags:['qualified']}};
const hook:AutomationAction={id:'hook',type:'webhook',config:{url:'https://example.test/hook',body:{name:'{{contact.name}}'},headers:{}}};
const rule=(actions:AutomationAction[]):AutomationDefinition=>({version:2,trigger:{type:'pipeline_status_change',config:{toStatus:'qualified_custom'}},conditions:{match:'all',rules:[]},actions});
const createRule=async(actions:AutomationAction[],priority=0)=>scope(async()=>{
  const created=await automationService.createAutomation(9,{name:'Qualified workflow',definition:rule(actions),priority});
  return (await automationService.updateAutomation(9,created.id,{isActive:true}))!;
});
const emit=async(source='source-1')=>scope(async()=>{
  await database.execute(sql`SELECT crm_automation_emit(to_jsonb(contact),'pipeline_status_change',${source},
    '{"event":{"oldValue":"new","newValue":"qualified_custom"}}'::jsonb,contact.id) FROM crm_contacts contact WHERE id=42`);
  const result=await database.execute(sql`SELECT id FROM crm_automation_events WHERE source_key=${source}`);return Number(result.rows[0].id);
});
const inspect=async()=>{
  const [runs,steps,contacts,logs]=await Promise.all([fixture.query('SELECT * FROM crm_automation_runs ORDER BY id'),fixture.query('SELECT * FROM crm_automation_run_steps ORDER BY position'),
    fixture.query('SELECT * FROM crm_contacts WHERE id=42'),fixture.query('SELECT * FROM crm_automation_logs')]);
  return {runs:runs.rows,steps:steps.rows,contact:contacts.rows[0],logs:logs.rows};
};

postgres('Durable CRM automation runtime in isolated PostgreSQL',()=>{
  beforeAll(async()=>{
    dotenv.config({path:resolve(process.cwd(),'.env.development'),override:true,quiet:true});dotenv.config({path:resolve(process.cwd(),'.env'),override:true,quiet:true});
    if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('Automation QA requires local PostgreSQL.');
    const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT || 5432),database:process.env.DB_NAME || process.env.DB_DATABASE,user:process.env.DB_USER,password:process.env.DB_PASSWORD || '',connectionTimeoutMillis:5000};
    schema=`crm_automation_${randomBytes(8).toString('hex')}`;admin=new Pool({...connection,max:1,options:'-c search_path=pg_catalog'});
    const role=await admin.query("SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime'");
    if (!role.rows.length) {await admin.query('CREATE ROLE salesmarketing_business_runtime NOLOGIN');createdRole=true;}
    const membership=await admin.query("SELECT pg_has_role(current_user,'salesmarketing_business_runtime','MEMBER') AS member");
    if (!membership.rows[0].member) {await admin.query(`GRANT salesmarketing_business_runtime TO ${process.env.DB_USER}`);grantedRole=true;}
    await admin.query(`CREATE SCHEMA ${schema}`);fixture=new Pool({...connection,max:1,options:`-c search_path=${schema},public,pg_catalog`});
    await fixture.query(`CREATE TABLE users(id integer PRIMARY KEY,name text,email text);
      CREATE TABLE outreach_settings(user_id integer,business_profile_id integer,daily_email_limit integer,
        PRIMARY KEY(user_id,business_profile_id));
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,crm_configuration jsonb,updated_at timestamptz DEFAULT now());
      CREATE TABLE business_scope_accounts(table_name text PRIMARY KEY);
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read boolean,parent_links jsonb);
      CREATE TABLE business_profile_memberships(business_profile_id integer,user_id integer,email text,status text);
      CREATE FUNCTION ${schema}.app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION ${schema}.app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
      CREATE FUNCTION ${schema}.app_business_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('app.business_system',true)='on' $$;
      CREATE FUNCTION ${schema}.app_business_access(profile integer) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_user<>'salesmarketing_business_runtime' OR current_setting('app.business_system',true)='on'
          OR (profile=NULLIF(current_setting('app.business_profile_id',true),'')::integer) $$;`);
    const ownership=readFileSync(resolve(process.cwd(),'migrations/299_business_profile_isolation.js'),'utf8')
      .match(/CREATE OR REPLACE FUNCTION enforce_business_ownership\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$[\s\S]*?END \$\$/)?.[0];
    if (!ownership) throw new Error('Could not locate business ownership guard source');
    await fixture.query(`${ownership.replace('FUNCTION enforce_business_ownership()',`FUNCTION ${schema}.enforce_business_ownership()`)};`);
    const base=['crm_contacts','crm_pipeline_automations','crm_automation_logs','outreach_messages','outreach_conversations','support_tickets','handoff_queue','outreach_campaigns','leads','whatsapp_templates','channel_credentials','wallet_transactions','crm_alerts'];
    for (const table of base) {
      await fixture.query(`CREATE TABLE ${table}(LIKE public.${table} INCLUDING DEFAULTS);ALTER TABLE ${table} ADD PRIMARY KEY(id);
        CREATE SEQUENCE ${table}_fixture_seq OWNED BY ${table}.id;ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_fixture_seq');
        ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS business_profile_id integer;`);
    }
    await fixture.query(`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS business_profile_id integer;
      ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS message_kind varchar(24) DEFAULT 'outreach';
      ALTER TABLE outreach_conversations ADD COLUMN IF NOT EXISTS session_ended_at timestamptz;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_member_id integer;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS outreach_conversation_id integer;
      ALTER TABLE channel_credentials ADD COLUMN IF NOT EXISTS business_profile_id integer;
      ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS business_profile_id integer;
      ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS organization_id integer;
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;`);
    await fixture.query(`INSERT INTO users VALUES(9,'Owner','owner@example.test');INSERT INTO company_settings(id,user_id) VALUES(101,9),(102,9);
      INSERT INTO crm_pipeline_automations(id,user_id,business_profile_id,name,trigger_type,trigger_config,action,action_config,is_active,priority)
      VALUES(73,9,101,'Preserved legacy','pipeline_status_change','{"fromStatus":"any","toStatus":"won"}','update_tags','{"tags":["won"]}',true,9);
      INSERT INTO crm_automation_logs(user_id,business_profile_id,automation_id,action_taken,result) VALUES(9,101,73,'update_tags','success');`);
    await migration.up(fixture);
    const preserved=(await fixture.query('SELECT * FROM crm_pipeline_automations WHERE id=73')).rows[0];
    expect(preserved.is_active).toBe(true);expect(preserved.priority).toBe(9);expect(preserved.definition.actions[0].config).toEqual({tags:['won']});
    expect(preserved.definition.trigger.config).toEqual({toStatus:'won'});expect((await fixture.query('SELECT count(*) FROM crm_automation_logs')).rows[0].count).toBe('1');
    expect((await fixture.query('SELECT enabled FROM crm_automation_runtime')).rows[0].enabled).toBe(false);
    for (const table of [...base.filter(name=>!['wallet_transactions'].includes(name)),'outreach_settings']) {
      await fixture.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY fixture_isolation ON ${table} FOR ALL USING(current_user<>'salesmarketing_business_runtime' OR (business_profile_id=NULLIF(current_setting('app.business_profile_id',true),'')::integer AND user_id=9))
        WITH CHECK(current_user<>'salesmarketing_business_runtime' OR (business_profile_id=NULLIF(current_setting('app.business_profile_id',true),'')::integer AND user_id=9));`);
    }
    runtime=createBusinessScopedPool(new Pool({...connection,max:3,options:`-c search_path=${schema},public,pg_catalog`}));database=drizzle(runtime);
  },30_000);
  afterAll(async()=>{await runtime?.end();await fixture?.end();if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    if(grantedRole) await admin.query(`REVOKE salesmarketing_business_runtime FROM ${process.env.DB_USER}`);
    if(createdRole) await admin.query('DROP ROLE salesmarketing_business_runtime');await admin?.end();});
  beforeEach(async()=>{
    jest.clearAllMocks();senderReady=true;crashAfterTicket=false;crashCommit=false;ticketGate=null;ticketEntered=null;
    emailSend.mockResolvedValue({success:true,providerMessageId:'email-receipt',rfcMessageId:'<msg@example.test>',threadId:'gmail-thread'});
    smsSend.mockResolvedValue({success:true,messageId:'sms-receipt',deliveryAttempted:true,outcomeUncertain:false});waSend.mockResolvedValue({messages:[{id:'wa-receipt'}]});
    charge.mockResolvedValue({success:true,transactionId:99});refund.mockResolvedValue({success:true});webhook.mockResolvedValue({response:{ok:true,status:200,body:null}});
    await fixture.query('TRUNCATE crm_automation_run_steps,crm_automation_runs,crm_automation_events,crm_automation_receipts,crm_automation_logs,crm_pipeline_automations,crm_contacts,outreach_messages,outreach_conversations,support_tickets,leads,channel_credentials,whatsapp_templates RESTART IDENTITY CASCADE');
    await fixture.query('TRUNCATE outreach_settings;INSERT INTO outreach_settings VALUES(9,101,10),(9,202,0)');
    const configuration={...DEFAULT_CRM_CONFIGURATION,stages:[...DEFAULT_CRM_CONFIGURATION.stages,{key:'qualified_custom',label:'Qualified',type:'active',color:'#129877',inFlow:true}]};
    await fixture.query('UPDATE company_settings SET crm_configuration=$1',[JSON.stringify(configuration)]);
    await fixture.query(`UPDATE crm_automation_runtime SET enabled=true,cutover_at=now();INSERT INTO business_profile_memberships VALUES(101,9,'owner@example.test','active') ON CONFLICT DO NOTHING;
      INSERT INTO crm_contacts(id,user_id,business_profile_id,first_name,last_name,email,phone,status,pipeline_status,tags)
      VALUES(42,9,101,'Alex','Morgan','alex@example.test','+919876543210','new','new','[]');
      INSERT INTO channel_credentials(user_id,business_profile_id,platform,credential_type,account_identifier,account_name,is_active,session_data)
      VALUES(9,101,'msg91_sms','api_key','SMSAPP','Alerts',true,'{"flowId":"flow-1"}');
      INSERT INTO whatsapp_templates(id,user_id,business_profile_id,name,language,body,header_type,waba_template_id,status,meta_status,has_local_changes)
      VALUES(12,9,101,'hello','en','Hello {{1}}','TEXT','meta-template','APPROVED','APPROVED',false);`);
  });
  it('records only committed changes, suppresses generated loops, and deduplicates source events',async()=>{
    const before=Number((await fixture.query('SELECT count(*) FROM crm_automation_events')).rows[0].count);
    await expect(scope(()=>database.transaction(async tx=>{await tx.execute(sql`UPDATE crm_contacts SET pipeline_status='qualified_custom' WHERE id=42`);throw new Error('rollback');}))).rejects.toThrow('rollback');
    expect(Number((await fixture.query('SELECT count(*) FROM crm_automation_events')).rows[0].count)).toBe(before);
    await createRule([tag]);const eventId=await emit();expect(await emit()).toBe(eventId);
    await scope(()=>processAutomationEvent(9,eventId));await scope(()=>processAutomationEvent(9,eventId));
    const data=await inspect();expect(data.contact.tags).toEqual(['qualified']);expect(data.runs).toHaveLength(1);expect(data.logs).toHaveLength(1);
    expect((await fixture.query("SELECT count(*) FROM crm_automation_events WHERE event_type='contact_updated'")).rows[0].count).toBe('0');
  });
  it('requires a legacy active rule to be paused before editing its steps during cutover',async()=>{
    const created=await createRule([tag]);
    await fixture.query('UPDATE crm_automation_runtime SET enabled=false,cutover_at=NULL');
    await expect(scope(()=>automationService.updateAutomation(9,created.id,{definition:rule([tag,hook])})))
      .rejects.toThrow('Pause this automation');
    const paused=await scope(()=>automationService.updateAutomation(9,created.id,{isActive:false}));
    expect(paused?.isActive).toBe(false);
    const edited=await scope(()=>automationService.updateAutomation(9,created.id,{definition:rule([tag,hook])}));
    expect(edited?.definition.actions).toHaveLength(2);
  });
  it('captures a support handoff even when the inbox conversation has no CRM contact',async()=>{
    await scope(()=>database.execute(sql`INSERT INTO handoff_queue(user_id,business_profile_id,conversation_id,channel,status)
      VALUES(9,101,-17,'web','waiting')`));
    const event=(await fixture.query("SELECT event_type,context,contact_id FROM crm_automation_events WHERE event_type='conversation_handoff'")).rows[0];
    expect(event.event_type).toBe('conversation_handoff');expect(event.context.conversation.id).toBe(-17);expect(event.contact_id).toBeNull();
  });
  it('dispatches each committed outbox event once to the dedicated queue',async()=>{
    const eventId=await emit('dispatch-source');
    const pending=Number((await fixture.query("SELECT count(*) FROM crm_automation_events WHERE status='pending'")).rows[0].count);
    expect(await dispatchAutomationEvents()).toBe(pending);expect(await dispatchAutomationEvents()).toBe(0);
    expect(queueRegistry.addJob).toHaveBeenCalledWith('crm-automations','crm-automation-event',
      expect.objectContaining({userId:9,businessProfileId:101,eventId}),expect.objectContaining({attempts:1}));
    expect((await fixture.query('SELECT status FROM crm_automation_events WHERE id=$1',[eventId])).rows[0].status).toBe('queued');
  });
  it('does not duplicate a queued event whose existing job is still waiting',async()=>{
    const eventId=await emit('dispatch-backlog');
    await fixture.query("UPDATE crm_automation_events SET status='queued',dispatch_count=1,claimed_at=now()-interval '3 minutes' WHERE id=$1",[eventId]);
    getAutomationJob.mockResolvedValueOnce({getState:async()=>'waiting'});
    await dispatchAutomationEvents();
    const row=(await fixture.query('SELECT status,dispatch_count FROM crm_automation_events WHERE id=$1',[eventId])).rows[0];
    expect(row).toEqual(expect.objectContaining({status:'queued',dispatch_count:1}));
    expect(getAutomationJob).toHaveBeenCalledWith(`crm-event-${eventId}-1`);
  });
  it('stops after failure while retaining completed actions and the definition revision snapshot',async()=>{
    const created=await createRule([tag,hook,{id:'never',type:'remove_tags',config:{tags:['qualified']}}]);const eventId=await emit();
    webhook.mockResolvedValue({response:{ok:false,status:400,body:null}});await scope(()=>processAutomationEvent(9,eventId));
    await scope(()=>automationService.updateAutomation(9,created.id,{definition:rule([{...tag,config:{tags:['edited']}}])}));
    const data=await inspect();expect(data.steps.map(step=>step.status)).toEqual(['success','failed','cancelled']);expect(data.contact.tags).toEqual(['qualified']);
    expect(data.runs[0].definition.actions).toHaveLength(3);expect(data.runs[0].revision).toBe(2);
  });
  it('retries definitively rejected attempts with a bound and never replays a completed step',async()=>{
    await createRule([tag,hook]);const eventId=await emit();webhook.mockResolvedValue({response:{ok:false,status:429,body:null}});
    for (let attempt=0;attempt<3;attempt++) {await scope(()=>processAutomationEvent(9,eventId));await fixture.query("UPDATE crm_automation_events SET available_at=now()-interval '1 second';UPDATE crm_automation_run_steps SET available_at=now()-interval '1 second'");}
    const data=await inspect();expect(data.runs[0].status).toBe('failed');expect(data.steps[0].attempts).toBe(1);expect(data.steps[1].attempts).toBe(3);expect(webhook).toHaveBeenCalledTimes(3);
  });
  it('holds ambiguous dispatch outcomes for reconciliation and stops remaining actions',async()=>{
    await createRule([hook,tag]);const eventId=await emit();webhook.mockRejectedValue(new Error('connection reset'));
    await scope(()=>processAutomationEvent(9,eventId));const data=await inspect();expect(data.runs[0].status).toBe('uncertain');expect(data.steps.map(step=>step.status)).toEqual(['uncertain','pending']);
    await scope(()=>processAutomationEvent(9,eventId));expect(webhook).toHaveBeenCalledTimes(1);expect(refund).not.toHaveBeenCalled();
  });
  it('treats a webhook server error as uncertain because the receiver may have committed',async()=>{
    await createRule([hook,tag]);const eventId=await emit();webhook.mockResolvedValue({response:{ok:false,status:503,body:null}});
    await scope(()=>processAutomationEvent(9,eventId));const data=await inspect();
    expect(data.runs[0].status).toBe('uncertain');expect(data.steps.map(step=>step.status)).toEqual(['uncertain','pending']);
    expect(webhook).toHaveBeenCalledTimes(1);
  });
  it('marks a restarted provider dispatch uncertain instead of sending again',async()=>{
    await createRule([hook,tag]);const eventId=await emit();const delivery={prepare:async()=>({kind:'webhook',url:'https://example.test/hook',body:{}}),start:async()=>undefined,
      send:async()=>{throw new AutomationActionError('unknown',true);},refund:async()=>undefined};
    await scope(()=>processAutomationEvent(9,eventId,delivery));
    await fixture.query(`UPDATE crm_automation_run_steps SET status='running',dispatch_started=true WHERE action_type='webhook';UPDATE crm_automation_runs SET status='running',completed_at=NULL;
      UPDATE crm_automation_events SET status='processing',claimed_at=now()-interval '10 minutes'`);
    await scope(()=>processAutomationEvent(9,eventId));expect(webhook).not.toHaveBeenCalled();expect((await inspect()).runs[0].status).toBe('uncertain');
  });
  it('does not dispatch a webhook twice when an expired lease overlaps provider work',async()=>{
    await createRule([hook]);const eventId=await emit();let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
    webhook.mockImplementation(async()=>{entered();await gate;return {response:{ok:true,status:200,body:null}};});
    const first=scope(()=>processAutomationEvent(9,eventId));await started;
    const originalLease=(await fixture.query('SELECT lease_token FROM crm_automation_events WHERE id=$1',[eventId])).rows[0].lease_token;
    await fixture.query("UPDATE crm_automation_events SET claimed_at=now()-interval '10 minutes' WHERE id=$1",[eventId]);
    const second=scope(()=>processAutomationEvent(9,eventId));
    let recoveredLease=originalLease;
    for(let attempt=0;attempt<50 && recoveredLease===originalLease;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,10));
      recoveredLease=(await fixture.query('SELECT lease_token FROM crm_automation_events WHERE id=$1',[eventId])).rows[0].lease_token;
    }
    expect(recoveredLease).not.toBe(originalLease);release();await Promise.all([first,second]);
    expect(webhook).toHaveBeenCalledTimes(1);expect(['success','uncertain']).toContain((await inspect()).runs[0].status);
  });
  it('does not duplicate ticket creation after a lost transaction commit response',async()=>{
    await createRule([{id:'ticket',type:'create_ticket',config:{subject:'Help {{contact.name}}',priority:'high'}},tag]);const eventId=await emit();crashAfterTicket=true;
    await scope(()=>processAutomationEvent(9,eventId));await scope(()=>processAutomationEvent(9,eventId));
    expect((await fixture.query('SELECT count(*) FROM support_tickets')).rows[0].count).toBe('1');expect((await inspect()).runs[0].status).toBe('success');
    expect((await fixture.query("SELECT count(*) FROM crm_automation_events WHERE event_type='ticket_created'")).rows[0].count).toBe('0');
  });
  it('keeps ticket creation idempotent when an expired event lease overlaps two workers',async()=>{
    await createRule([{id:'ticket',type:'create_ticket',config:{subject:'Help',priority:'high'}}]);const eventId=await emit();
    let release!:()=>void,entered!:()=>void;
    ticketGate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});ticketEntered=entered;
    const first=scope(()=>processAutomationEvent(9,eventId));await started;
    await fixture.query("UPDATE crm_automation_events SET claimed_at=now()-interval '10 minutes' WHERE id=$1",[eventId]);
    const second=scope(()=>processAutomationEvent(9,eventId));release();await Promise.all([first,second]);
    expect((await fixture.query('SELECT count(*) FROM support_tickets')).rows[0].count).toBe('1');
    expect((await fixture.query('SELECT count(*) FROM crm_automation_logs')).rows[0].count).toBe('1');
  });
  it('pausing between actions cancels remaining steps and retains accepted work',async()=>{
    const created=await createRule([hook,tag]);const eventId=await emit();webhook.mockImplementation(async()=>{await fixture.query('UPDATE crm_pipeline_automations SET is_active=false WHERE id=$1',[created.id]);return {response:{ok:true,status:200,body:null}};});
    await scope(()=>processAutomationEvent(9,eventId));const data=await inspect();expect(data.runs[0].status).toBe('cancelled');expect(data.steps.map(step=>step.status)).toEqual(['success','cancelled']);expect(data.contact.tags).toEqual([]);
  });
  it('isolates rules, events, steps, and parent references by business profile',async()=>{
    const created=await createRule([tag]),eventId=await emit();await scope(()=>processAutomationEvent(9,eventId),102);
    expect(await scope(()=>automationService.getAutomation(9,created.id),102)).toBeNull();expect((await inspect()).runs).toEqual([]);
    await expect(scope(()=>database.execute(sql`INSERT INTO crm_automation_runs(user_id,business_profile_id,automation_id,automation_name,revision,event_id,event_type,definition,context)
      VALUES(9,102,${created.id},'Invalid',1,${eventId},'pipeline_status_change','{}','{}')`),102)).rejects.toThrow();
    await scope(()=>processAutomationEvent(9,eventId));const hidden=await scope(()=>database.execute(sql`SELECT * FROM crm_automation_run_steps`),102);expect(hidden.rows).toEqual([]);
  });
  it('serves scoped paginated run summaries and ordered step details',async()=>{
    const created=await createRule([tag,hook]);const eventId=await emit();await scope(()=>processAutomationEvent(9,eventId));
    const response=()=>{const res={status:jest.fn(),json:jest.fn()};res.status.mockReturnValue(res);return res;};
    const list=response();await scope(()=>getRuns({user:{id:9},params:{id:String(created.id)},query:{limit:'1'}} as unknown as Request,list as unknown as Response));
    const page=list.json.mock.calls[0][0] as {data:{runs:Array<{id:number}>;nextCursor:number|null}};
    expect(page).toHaveProperty('data');
    expect(page.data.runs).toHaveLength(1);expect(page.data.nextCursor).toBeNull();
    const detail=response();await scope(()=>getRun({user:{id:9},params:{runId:String(page.data.runs[0].id)}} as unknown as Request,detail as unknown as Response));
    expect((detail.json.mock.calls[0][0] as {data:{steps:Array<{position:number}>}}).data.steps.map(step=>step.position)).toEqual([0,1]);
    const hidden=response();await scope(()=>getRuns({user:{id:9},params:{id:String(created.id)},query:{}} as unknown as Request,hidden as unknown as Response),102);
    expect(hidden.status).toHaveBeenCalledWith(404);
  });
  it.each(['email','whatsapp','sms'].flatMap(channel=>['contact','fixed'].map(mode=>[channel,mode])))('tracks accepted %s notifications for %s recipients with correct lead/history behavior',async(channel,mode)=>{
    const action:AutomationAction={id:'notice',type:'send_notification',config:{channel,recipient:{mode,value:channel==='email' ? 'manager@example.test' : '+919876543210'},
      ...(channel==='email' ? {senderId:7,subject:'Notice',message:'Hello {{contact.name}}'} : channel==='sms' ? {providerAccountId:'SMSAPP',flowId:'flow-1',message:'Hello {{contact.name}}'} : {providerAccountId:'whatsapp-account',templateId:12,language:'en',variables:{'body:1':'{{contact.name}}'}})}};
    await createRule([action,tag]);const eventId=await emit();await scope(()=>processAutomationEvent(9,eventId));const data=await inspect();
    expect(data.steps.map(step=>step.error_message)).toEqual([null,null]);expect(data.runs[0].status).toBe('success');expect(data.steps[0].provider_status).toBe('accepted');expect(charge).toHaveBeenCalledTimes(1);
    const leads=await fixture.query('SELECT * FROM leads'),messages=await fixture.query('SELECT * FROM outreach_messages');
    expect(leads.rows).toHaveLength(mode==='contact' ? 1 : 0);expect(messages.rows).toHaveLength(mode==='contact' ? 1 : 0);
    if (mode==='contact') {expect(messages.rows[0].provider_call_state).toBe('confirmed');expect(messages.rows[0].metadata.origin).toBe('crm_automation');}
    const expected=channel==='email' ? emailSend : channel==='sms' ? smsSend : waSend;expect(expected).toHaveBeenCalledTimes(1);
  });
  it.each(['zero allowance','unavailable settings'])('fails closed before email dispatch with %s',async failure=>{
    const action:AutomationAction={id:'mail',type:'send_notification',config:{channel:'email',recipient:{mode:'contact'},senderId:7,subject:'Notice',message:'Hello'}};
    await createRule([action,tag]);const eventId=await emit();
    if(failure==='zero allowance')await fixture.query('UPDATE outreach_settings SET daily_email_limit=0 WHERE business_profile_id=101');
    else await fixture.query('ALTER TABLE outreach_settings RENAME TO outreach_settings_unavailable');
    try {await scope(()=>processAutomationEvent(9,eventId));}
    finally {if(failure==='unavailable settings')await fixture.query('ALTER TABLE outreach_settings_unavailable RENAME TO outreach_settings');}
    const data=await inspect();expect(data.runs[0].status).toBe('failed');
    expect(data.steps.map(step=>step.status)).toEqual(['failed','cancelled']);
    expect(data.steps[0].dispatch_started).toBe(false);expect(emailSend).not.toHaveBeenCalled();
    expect(data.steps[0].error_message).toBe(failure==='zero allowance' ? 'The daily notification limit has been reached.' : 'The action could not be completed.');
    expect(charge).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);expect(data.steps[0].refund_pending).toBe(false);
  });
  it('retains receipts arriving before provider acceptance and prevents later status regressions',async()=>{
    const action:AutomationAction={id:'notice',type:'send_notification',config:{channel:'sms',recipient:{mode:'fixed',value:'+919876543210'},providerAccountId:'SMSAPP',flowId:'flow-1',message:'Hello'}};
    await createRule([action]);const eventId=await emit();await scope(()=>recordAutomationReceipt(9,{channel:'sms',accountId:'SMSAPP',messageId:'sms-receipt',status:'read'}));
    await scope(()=>processAutomationEvent(9,eventId));await scope(()=>recordAutomationReceipt(9,{channel:'sms',accountId:'SMSAPP',messageId:'sms-receipt',status:'delivered'}));
    await scope(()=>recordAutomationReceipt(9,{channel:'sms',accountId:'wrong',messageId:'sms-receipt',status:'failed'}));expect((await inspect()).steps[0].provider_status).toBe('read');
  });
  it('fails a contact notification with no destination before billing or provider dispatch',async()=>{
    await fixture.query('UPDATE crm_contacts SET email=NULL WHERE id=42');
    const action:AutomationAction={id:'mail',type:'send_notification',config:{channel:'email',recipient:{mode:'contact'},senderId:7,subject:'Notice',message:'Hello'}};
    await createRule([action,tag]);const eventId=await emit();await scope(()=>processAutomationEvent(9,eventId));
    const data=await inspect();expect(data.runs[0].status).toBe('failed');expect(data.steps.map(step=>step.status)).toEqual(['failed','cancelled']);
    expect(emailSend).not.toHaveBeenCalled();expect(charge).not.toHaveBeenCalled();
  });
  it('rejects an unapproved WhatsApp template and a disconnected sender',async()=>{
    const action:AutomationAction={id:'wa',type:'send_notification',config:{channel:'whatsapp',recipient:{mode:'fixed',value:'+919876543210'},
      providerAccountId:'whatsapp-account',templateId:12,language:'en',variables:{'body:1':'Alex'}}};
    await fixture.query("UPDATE whatsapp_templates SET meta_status='REJECTED' WHERE id=12");
    await expect(scope(()=>automationService.createAutomation(9,{name:'Invalid template',definition:rule([action])}))).rejects.toThrow('approved');
    await fixture.query("UPDATE whatsapp_templates SET meta_status='APPROVED' WHERE id=12");
    const created=await createRule([action]);senderReady=false;const eventId=await emit();await scope(()=>processAutomationEvent(9,eventId));
    expect((await inspect()).runs[0].status).toBe('failed');expect(waSend).not.toHaveBeenCalled();expect(charge).not.toHaveBeenCalled();
    expect(created.isActive).toBe(true);
  });
  it('protects custom stages referenced by the new definition',async()=>{
    await createRule([tag]);const configuration={...DEFAULT_CRM_CONFIGURATION};await expect(scope(()=>saveCrmConfiguration(9,configuration))).rejects.toThrow('CRM rules');
  });
  it('keeps stages referenced by a queued run snapshot after its rule is edited',async()=>{
    const created=await createRule([hook]);const eventId=await emit();webhook.mockResolvedValue({response:{ok:false,status:429,body:null}});
    await scope(()=>processAutomationEvent(9,eventId));
    await scope(()=>automationService.updateAutomation(9,created.id,{definition:{...rule([tag]),trigger:{type:'pipeline_status_change',config:{toStatus:'won'}}}}));
    await expect(scope(()=>saveCrmConfiguration(9,{...DEFAULT_CRM_CONFIGURATION}))).rejects.toThrow('CRM rules');
  });
  it('keeps new rules paused and blocks disconnected sender activation',async()=>{
    const created=await scope(()=>automationService.createAutomation(9,{name:'Paused',definition:rule([tag]),isActive:true}));expect(created.isActive).toBe(false);
    const action:AutomationAction={id:'notice',type:'send_notification',config:{channel:'email',recipient:{mode:'fixed',value:'manager@example.test'},senderId:7,subject:'Notice',message:'Hello'}};
    const draft=await scope(()=>automationService.createAutomation(9,{name:'Sender check',definition:rule([action])}));senderReady=false;
    await expect(scope(()=>automationService.updateAutomation(9,draft.id,{isActive:true}))).rejects.toThrow();expect(charge).not.toHaveBeenCalled();
  });
});
