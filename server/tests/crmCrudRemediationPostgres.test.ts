import { afterAll,beforeAll,beforeEach,describe,expect,it,jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Pool,defaults,types } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig,PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope } from '../tenancy/businessContext.ts';
import { createBusinessScopedPool } from '../tenancy/scopedPool.ts';
import { DEFAULT_CRM_CONFIGURATION } from '../../shared/crmConfiguration.ts';
import { crmContactSchema,crmContactCreateSchema,crmActivitySchema,bulkUpdateSchema } from '../middleware/schemas.ts';
import { leadsTable } from '../models/leads/schema.ts';
import { crmContactsTable } from '../models/crmContacts/schema.ts';
import { crmActivitiesTable } from '../models/crmActivities/schema.ts';
import { crmActivityRemindersTable } from '../models/crmActivityReminders/schema.ts';
import { crmContactImportsTable } from '../models/crmContactImports/schema.ts';
import { crmContactImportDetailsTable } from '../models/crmContactImportDetails/schema.ts';
import { crmContactChannelIdentitiesTable } from '../models/crmContactChannelIdentities/schema.ts';
import { outreachConversationsTable,outreachMessagesTable } from '../models/outreachConversations/schema.ts';
import { sentMessagesTable } from '../models/sentMessages/schema.ts';
import { proposalsTable } from '../models/proposals/schema.ts';
import { supportTicketsTable } from '../models/supportTickets/schema.ts';
import { crmAlertLogsTable } from '../models/crmAlertLogs/schema.ts';
import { crmAutomationLogsTable } from '../models/crmAutomationLogs/schema.ts';
// @ts-expect-error Custom JavaScript migration.
import * as importRecoveryMigration from '../migrations/330_crm_import_recovery.js';

let database:any;
const proxy=new Proxy({}, { get(_target,key) { const value=database[key];return typeof value==='function'?value.bind(database):value; } });
const fireEvent=jest.fn<any>().mockResolvedValue(undefined);
const evaluateTriggers=jest.fn<any>().mockResolvedValue(undefined);
jest.unstable_mockModule('../models/db.ts',()=>({db:proxy}));
jest.unstable_mockModule('../services/SentimentAnalysisService',()=>({sentimentAnalysisService:{}}));
jest.unstable_mockModule('../services/AlertService',()=>({alertService:{fireEvent},ALERT_EVENT_TYPES:[]}));
jest.unstable_mockModule('../services/AutomationService',()=>({automationService:{evaluateTriggers}}));
jest.unstable_mockModule('../services/ICPGenerationService',()=>({ICPGenerationService:class{}}));
jest.unstable_mockModule('../services/credentialService',()=>({getApifyKey:jest.fn()}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory',()=>({LLMProviderFactory:{}}));
jest.unstable_mockModule('../services/NotificationService.ts',()=>({NotificationService:{leadsImported:jest.fn()}}));
jest.unstable_mockModule('../services/dashboardCache.ts',()=>({invalidateDashboardCache:jest.fn<any>().mockResolvedValue(undefined)}));
jest.unstable_mockModule('../utils/logger.ts',()=>({logger:{error:jest.fn(),warn:jest.fn(),info:jest.fn()}}));
const {crmService}=await import('../services/CRMService.ts');
const crmController=await import('../controllers/crmController.ts');
const leadController=await import('../controllers/leadController.ts');
const {LeadModel}=await import('../models/leads/functions.ts');

const inProfile=<T>(work:()=>T,profile=101)=>withBusinessScope({userId:9,businessProfileId:profile,actorUserId:29,role:'member'},work);
const tables=[leadsTable,crmContactsTable,crmActivitiesTable,crmActivityRemindersTable,crmContactImportsTable,crmContactImportDetailsTable,
  crmContactChannelIdentitiesTable,outreachConversationsTable,outreachMessagesTable,sentMessagesTable,proposalsTable,supportTicketsTable,crmAlertLogsTable,crmAutomationLogsTable];
let admin:Pool;let fixture:Pool;let runtime:Pool;
const schema=`crm_crud_${randomBytes(8).toString('hex')}`;
async function invoke(method:any,body:any={},params:any={id:'1'},query:any={},headers:any={}) {
  const res:any={_status:200,_json:undefined,_text:undefined,_headers:{},status(code:number){this._status=code;return this;},json(data:any){this._json=data;return this;},
    setHeader(name:string,value:string){this._headers[name]=value;return this;},send(data:any){this._text=data;return this;}};
  await inProfile(()=>method({user:{id:29},params,body,query,headers},res));
  return res;
}

(process.env.CRM_CRUD_LOCAL_QA==='1' ? describe : describe.skip)('CRM mutation acceptance in isolated PostgreSQL',()=>{
  beforeAll(async()=>{
    defaults.parseInputDatesAsUTC=true;types.setTypeParser(1114,value=>new Date(value.replace(' ','T')+'Z'));
    if (!['127.0.0.1','localhost','::1'].includes(process.env.DB_HOST || '') || !/^(crm_audit|test_)/.test(process.env.DB_NAME || '')) throw new Error('CRM CRUD QA requires an explicitly selected local test database.');
    const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT || 5432),user:process.env.DB_USER,database:process.env.DB_NAME,connectionTimeoutMillis:5000};
    admin=new Pool({...connection,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture=new Pool({...connection,max:1,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`});
    runtime=createBusinessScopedPool(new Pool({...connection,max:2,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`}));
    database=drizzle(runtime);
    await fixture.query(`CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE SQL AS $$SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer$$;
      CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE SQL AS $$SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer$$;
      CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE SQL AS $$SELECT current_user<>'salesmarketing_business_runtime'$$;
      CREATE TABLE company_settings(id int PRIMARY KEY,user_id int,category_id int,subcategory_id int,crm_configuration jsonb,updated_at timestamp DEFAULT now());
      CREATE TABLE users(id int PRIMARY KEY,name text,email text,deleted_at timestamp);
      CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id int,user_id int,email text,role text,status text);
      CREATE TABLE followup_sequences(id serial PRIMARY KEY,user_id int,business_profile_id int DEFAULT app_business_profile_id(),lead_id int,completed boolean DEFAULT false,replied_at timestamp,updated_at timestamp DEFAULT now());
      CREATE TABLE sequence_executions(id serial PRIMARY KEY,user_id int,business_profile_id int DEFAULT app_business_profile_id(),lead_id int,status text DEFAULT 'active',updated_at timestamp DEFAULT now());
      CREATE TABLE campaign_crm_contacts(id serial PRIMARY KEY,user_id int,business_profile_id int DEFAULT app_business_profile_id(),contact_id int,thread_id int,UNIQUE(contact_id,thread_id));
      CREATE TABLE crm_contact_identity_conflicts(id serial PRIMARY KEY,user_id int,business_profile_id int DEFAULT app_business_profile_id(),conversation_id int,identifier_type text,identifier_fingerprint text,candidate_contact_ids jsonb,status text,created_at timestamp,updated_at timestamp);
      CREATE UNIQUE INDEX conflict_uq ON crm_contact_identity_conflicts(business_profile_id,user_id,identifier_type,identifier_fingerprint) WHERE status='pending_review';`);
    for (const table of tables) {
      const definition=getTableConfig(table);
      const columns=definition.columns.map(column=>{
        const value=column.default;
        const d=value&&typeof value==='object'&&'queryChunks' in value?new PgDialect().sqlToQuery(value as any).sql:value===undefined?undefined:
          typeof value==='number'||typeof value==='boolean'?String(value):`'${(typeof value==='string'?value:JSON.stringify(value)).replace(/'/g,"''")}'`;
        return `"${column.name}" ${column.getSQLType()}${column.primary?' PRIMARY KEY':''}${d===undefined?'':` DEFAULT ${d}`}`;
      });
      await fixture.query(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    // The composed importer requires the actual durable row-receipt identities.
    await importRecoveryMigration.up(fixture);
    await fixture.query(`ALTER TABLE crm_activities ADD FOREIGN KEY(contact_id) REFERENCES crm_contacts(id);
      CREATE UNIQUE INDEX activity_idempotency ON crm_activities(business_profile_id,user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;`);
    const migration=readFileSync(resolve(process.cwd(), 'migrations/299_business_profile_isolation.js'),'utf8');
    const start=migration.indexOf('CREATE OR REPLACE FUNCTION enforce_business_ownership()');
    await fixture.query(migration.slice(start,migration.indexOf('END $$',start)+6));
    const scoped=[...tables.map(table=>getTableConfig(table).name),'followup_sequences','sequence_executions','campaign_crm_contacts','crm_contact_identity_conflicts'];
    for (const name of [...scoped,'company_settings']) {
      const col=name==='company_settings'?'id':'business_profile_id';
      await fixture.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;
        CREATE POLICY isolation ON ${name} USING(current_user<>'salesmarketing_business_runtime' OR (${col}=app_business_profile_id()${name==='crm_contact_import_details'?'':' AND user_id=app_business_user_id()'}))
        WITH CHECK(current_user<>'salesmarketing_business_runtime' OR (${col}=app_business_profile_id()${name==='crm_contact_import_details'?'':' AND user_id=app_business_user_id()'}));`);
    }
    // Execute the actual production ownership function for the foreign contact relation.
    const spec=JSON.stringify({table_name:'crm_activities',owner_column:'user_id',global_read:false,parent_links:[{parent:'crm_contacts',child_columns:['contact_id'],parent_columns:['id']}]});
    await fixture.query(`CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON crm_activities FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}');`);
    for(const name of ['leads','crm_contacts']) {
      const spec=JSON.stringify({table_name:name,owner_column:'user_id',global_read:false,parent_links:name==='crm_contacts'?[{parent:'leads',child_columns:['lead_id'],parent_columns:['id']}]:[]});
      await fixture.query(`CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${name} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}');`);
    }
  },30000);
  afterAll(async()=>{await runtime?.end();await fixture?.end();if(admin)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin?.end();});
  beforeEach(async()=>{
    fireEvent.mockReset().mockResolvedValue(undefined);evaluateTriggers.mockReset().mockResolvedValue(undefined);
    await fixture.query(`TRUNCATE company_settings,users,business_profile_memberships,${tables.map(table=>getTableConfig(table).name).join(',')},followup_sequences,sequence_executions,campaign_crm_contacts,crm_contact_identity_conflicts RESTART IDENTITY CASCADE;
      INSERT INTO company_settings(id,user_id,crm_configuration) VALUES(101,9,'${JSON.stringify(DEFAULT_CRM_CONFIGURATION)}'),(102,9,'${JSON.stringify(DEFAULT_CRM_CONFIGURATION)}');
      INSERT INTO users(id,name,email) VALUES(9,'Owner','owner@example.test'),(29,'Member','member@example.test'),(19,'Outside','outside@example.test');
      INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES(101,29,'member@example.test','member','active'),(102,19,'outside@example.test','member','active');
      INSERT INTO leads(id,user_id,business_profile_id,name,first_name,email,company,status,lead_status,source) VALUES(11,9,101,'Ada','Ada','ada@example.test','Original','new','new','fixture');
      INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id,first_name,last_name,email,phone,company,notes,tags,pipeline_status,status,currency,deal_value)
        VALUES(1,9,101,11,'Ada','Lovelace','ada@example.test',NULL,'Original','Keep this note','["VIP"]','new','new','INR',120),
        (4,9,102,NULL,'Other',NULL,'other@example.test',NULL,'Other',NULL,'[]','new','new','USD',900);
      INSERT INTO followup_sequences(user_id,business_profile_id,lead_id) VALUES(9,101,11);
      INSERT INTO sequence_executions(user_id,business_profile_id,lead_id) VALUES(9,101,11);
      INSERT INTO crm_activities(id,user_id,business_profile_id,contact_id,type,subject,metadata) VALUES(1,9,101,1,'note','Original note','{"actorUserId":29}');
      SELECT setval('crm_contacts_id_seq',100,true),setval('crm_activities_id_seq',100,true),setval('leads_id_seq',100,true);`);
  });
  it('R01 persists accepted create fields and validates membership',async()=>{
    const body=crmContactCreateSchema.parse({email:'new@example.test',pipelineStatus:'won',dealValue:'75.00',currency:'INR',assignedTo:29,nextFollowUpAt:'2030-01-02T00:00:00Z'});
    const res=await invoke(crmController.createContact,body);
    expect(res._status).toBe(201);
    expect(res._json.data).toMatchObject({pipelineStatus:'won',dealValue:'75.00',currency:'INR',assignedTo:29,nextFollowUpAt:new Date('2030-01-02T00:00:00Z')});
  });
  it('R02 CRM won transition synchronizes both lead lifecycle fields and filters',async()=>{
    await inProfile(()=>crmService.updateContact(9,1,{pipelineStatus:'won'}));
    expect((await fixture.query('SELECT status,lead_status FROM leads WHERE id=11')).rows[0]).toEqual({status:'converted',lead_status:'converted'});
    const res=await invoke(leadController.getLeads,{}, {},{status:'converted'});
    expect(res._json.total).toBe(1);
  });
  it('R03 lead profile and lifecycle edits synchronize materialized CRM',async()=>{
    const res=await invoke(leadController.updateLead,{firstName:'Changed',company:'Changed company',status:'converted'},{id:'11'});
    expect(res._status).toBe(200);
    expect(await inProfile(()=>crmService.getContactById(9,1))).toMatchObject({firstName:'Changed',company:'Changed company',pipelineStatus:'won'});
  });
  it('R03 internal lead model profile and lifecycle edits synchronize materialized CRM',async()=>{
    const lead=await inProfile(()=>LeadModel.update(11,{name:'Internal Update',company:'Internal company',status:'converted'}));
    expect(lead).toMatchObject({name:'Internal Update',company:'Internal company',status:'converted',leadStatus:'converted'});
    expect(await inProfile(()=>crmService.getContactById(9,1))).toMatchObject({firstName:'Internal',lastName:'Update',company:'Internal company',pipelineStatus:'won'});
  });
  it('R04 minimal CSV update preserves unmapped existing fields',async()=>{
    const result=await inProfile(()=>crmService.importContactsFromCSV(9,[{Email:'ada@example.test',Company:'Updated'}],{Email:'email',Company:'company'},'synthetic.csv',{updateExisting:true}));
    expect(result.successCount).toBe(1);
    expect((await fixture.query('SELECT first_name,last_name,notes,tags,deal_value FROM crm_contacts WHERE id=1')).rows[0])
      .toEqual({first_name:'Ada',last_name:'Lovelace',notes:'Keep this note',tags:['VIP'],deal_value:'120.00'});
  });
  it('R05 imported stage changes apply linked lifecycle, pause and history',async()=>{
    const result=await inProfile(()=>crmService.importContactsFromCSV(9,[{Email:'ada@example.test',Company:'Updated',Status:'won'}],{Email:'email',Company:'company',Status:'status'},'synthetic.csv',{updateExisting:true}));
    expect(result.successCount).toBe(1);
    expect((await fixture.query('SELECT pipeline_status FROM crm_contacts WHERE id=1')).rows[0].pipeline_status).toBe('won');
    expect((await fixture.query('SELECT status,lead_status FROM leads WHERE id=11')).rows[0]).toEqual({status:'converted',lead_status:'converted'});
    expect((await fixture.query('SELECT status FROM sequence_executions')).rows[0].status).toBe('paused');
    expect((await fixture.query("SELECT count(*)::int n FROM crm_activities WHERE type='pipeline_change'")).rows[0].n).toBe(1);
  });
  it.todo('R06 configured import-stage mapping (Data-owned integration gate)');
  it('R07 activity task dates persist and update as UTC instants',async()=>{
    const body=crmActivitySchema.parse({type:'task',subject:'Synthetic task',dueAt:'2030-01-02T00:00:00Z'});
    const res=await invoke(crmController.addActivity,body,{contactId:'1'});
    expect(res._status).toBe(201);expect(res._json.data.dueAt.toISOString()).toBe('2030-01-02T00:00:00.000Z');
    const patch=await invoke(crmController.updateActivity,crmActivitySchema.partial().parse({dueAt:'2030-01-02T00:00:00Z'}),{id:String(res._json.data.id)});
    expect(patch._status).toBe(200);
  });
  it('R08 rejects activity identity and actor forgery at schema and service boundaries',async()=>{
    const forged={id:77,type:'pipeline_change',metadata:{actorUserId:19,oldStatus:'new',newStatus:'won'}};
    expect(crmActivitySchema.partial().safeParse(forged).success).toBe(false);
    const res=await invoke(crmController.updateActivity,forged);
    expect(res._status).toBe(400);
    expect((await fixture.query('SELECT id,type,metadata FROM crm_activities WHERE id=1')).rows[0]).toMatchObject({id:1,type:'note',metadata:{actorUserId:29}});
  });
  it('R09 reports committed pipeline changes truthfully when automation evaluation fails',async()=>{
    evaluateTriggers.mockRejectedValueOnce(new Error('Synthetic automation runtime lookup outage')).mockImplementation(async(_user:any,_contact:any,_event:any,recovery:any)=>{if(!await recovery.beforeActions())return {mode:'claimed'};return {mode:'legacy',failed:false};});
    const first=await invoke(crmController.updatePipelineStatus,{pipelineStatus:'won'});
    expect(first._status).toBe(200);expect(first._json.data.automationReviewRequired).toBe(true);
    expect((await fixture.query('SELECT pipeline_status FROM crm_contacts WHERE id=1')).rows[0].pipeline_status).toBe('won');
    const retry=await invoke(crmController.updatePipelineStatus,{pipelineStatus:'won'});
    expect(retry._status).toBe(200);expect(retry._json.data.automationHandoff.status).toBe('completed');expect(evaluateTriggers).toHaveBeenCalledTimes(2);
    await invoke(crmController.updatePipelineStatus,{pipelineStatus:'won'});expect(evaluateTriggers).toHaveBeenCalledTimes(2);
    expect((await fixture.query("SELECT count(*)::int n FROM crm_activities WHERE type='pipeline_change'")).rows[0].n).toBe(1);
  });
  it('R10 stale virtual activity requests never recreate a deleted contact',async()=>{
    await inProfile(()=>crmService.softDeleteContact(9,1));
    expect(await inProfile(()=>crmService.getContactById(9,-11))).toBeNull();
    const res=await invoke(crmController.addActivity,{type:'note',subject:'Late retry'},{contactId:'-11'});
    expect(res._status).toBe(404);
    expect(await inProfile(()=>crmService.getContactById(9,-11))).toBeNull();
  });
  it('R11 lead bulk assignment rejects outsiders without changing ownership',async()=>{
    const res=await invoke(leadController.bulkUpdateLeads,bulkUpdateSchema.parse({ids:[11],updates:{assignedTo:19}}));
    expect(res._status).toBe(400);
    expect((await fixture.query('SELECT assigned_to FROM leads WHERE id=11')).rows[0].assigned_to).toBeNull();
    await expect(inProfile(()=>crmService.updateContact(9,1,{assignedTo:19}))).rejects.toMatchObject({status:400});
  });
  it('R12 replayed create returns the prior contact without duplicate alerts',async()=>{
    const payload={email:'repeat@example.test',firstName:'Retry'};
    const headers={'idempotency-key':'synthetic-create-001'};
    const [a,b]=await Promise.all([invoke(crmController.createContact,payload,{}, {},headers),invoke(crmController.createContact,payload,{}, {},headers)]);
    expect(a._status).toBe(201);expect(b._status).toBe(201);expect(a._json.data.id).toBe(b._json.data.id);
    expect((await fixture.query("SELECT count(*)::int n FROM crm_contacts WHERE email='repeat@example.test' AND deleted_at IS NULL")).rows[0].n).toBe(1);
    expect(fireEvent).toHaveBeenCalledTimes(1);
    expect((await invoke(crmController.createContact,{...payload,firstName:'Changed'}, {}, {},headers))._status).toBe(409);
  });
  it('R12 never recreates a deleted contact through an old create receipt, but permits a new intentional operation',async()=>{
    const headers={'idempotency-key':'synthetic-delete-001'};
    const body={email:'replayed-deleted@example.test'};
    const first=await invoke(crmController.createContact,body,{}, {},headers);
    expect(first._headers['Content-Request-Confirmed']).toBe('true');
    await inProfile(()=>crmService.softDeleteContact(9,first._json.data.id));
    expect((await invoke(crmController.createContact,body,{}, {},headers))._status).toBe(410);
    const next=await invoke(crmController.createContact,body,{}, {},{'idempotency-key':'synthetic-delete-002'});
    expect(next._status).toBe(201);expect(next._json.data.id).not.toBe(first._json.data.id);
  });
  it('R12 scopes the same create key independently to each business profile',async()=>{
    const body={email:'shared-key@example.test'};
    const request={key:'synthetic-shared-profile-key'};
    const [first,second]=await Promise.all([101,102].map(businessProfileId=>withBusinessScope(
      {userId:9,businessProfileId,actorUserId:9,role:'owner'},()=>crmService.createContact(9,body,request))));
    expect(first.id).not.toBe(second.id);
    expect(first.businessProfileId).toBe(101);expect(second.businessProfileId).toBe(102);
  });
  it('R12 alert dispatch failure cannot turn a committed creation into a failed save',async()=>{
    fireEvent.mockRejectedValueOnce(new Error('Synthetic alert outage'));
    const headers={'idempotency-key':'synthetic-alert-outage'};
    const body={email:'alert-outage@example.test'};
    const first=await invoke(crmController.createContact,body,{}, {},headers);
    const replay=await invoke(crmController.createContact,body,{}, {},headers);
    expect(first._status).toBe(201);expect(replay._status).toBe(201);
    expect(first._json.data.id).toBe(replay._json.data.id);expect(fireEvent).toHaveBeenCalledTimes(1);
  });
  it('R11 explicit unassignment takes precedence over the compatibility owner alias in bulk edits',async()=>{
    const result=await inProfile(()=>crmService.bulkUpdateContacts(9,{contactIds:[1],assignedTo:null,ownerUserId:19}));
    expect(result.contacts[0].assignedTo).toBeNull();
  });
  it('R01 rejects invalid stage and outside owner before creating a record',async()=>{
    expect((await invoke(crmController.createContact,{email:'invalid-owner@example.test',assignedTo:19}))._status).toBe(400);
    expect((await invoke(crmController.createContact,{email:'invalid-stage@example.test',pipelineStatus:'not_configured'}))._status).toBe(400);
    expect((await fixture.query("SELECT count(*)::int n FROM crm_contacts WHERE email LIKE 'invalid-%'")).rows[0].n).toBe(0);
  });
  it('R01 explicit deal fields survive an exact-phone match and update the canonical lifecycle',async()=>{
    await fixture.query("UPDATE crm_contacts SET phone='+14155550100' WHERE id=1");
    const res=await invoke(crmController.createContact,{email:'alias-create@example.test',phone:'14155550100',pipelineStatus:'won',dealValue:'75.00',currency:'USD',assignedTo:29});
    expect(res._status).toBe(201);expect(res._json.data).toMatchObject({id:1,pipelineStatus:'won',dealValue:'75.00',currency:'USD',assignedTo:29});
    expect((await fixture.query('SELECT status,lead_status FROM leads WHERE id=11')).rows[0]).toEqual({status:'converted',lead_status:'converted'});
  });
  it('R08 system transition records remain immutable through ordinary activity editing',async()=>{
    await inProfile(()=>crmService.updateContact(9,1,{pipelineStatus:'won'}));
    const event=(await fixture.query("SELECT id,metadata FROM crm_activities WHERE type='pipeline_change'")).rows[0];
    expect((await invoke(crmController.updateActivity,{subject:'Forged correction'},{id:String(event.id)}))._status).toBe(409);
    expect((await fixture.query('SELECT metadata FROM crm_activities WHERE id=$1',[event.id])).rows[0].metadata).toEqual(event.metadata);
  });
  it('R07 task completion and clearing a due date persist without touching actor identity',async()=>{
    const res=await invoke(crmController.addActivity,{type:'task',subject:'Synthetic work',dueAt:'2030-01-02T10:00:00+05:30'},{contactId:'1'});
    expect(res._json.data.dueAt.toISOString()).toBe('2030-01-02T04:30:00.000Z');
    const saved=await invoke(crmController.updateActivity,{dueAt:null,completedAt:'2030-01-03T00:00:00Z'},{id:String(res._json.data.id)});
    expect(saved._status).toBe(200);expect(saved._json.data.dueAt).toBeNull();expect(saved._json.data.completedAt.toISOString()).toBe('2030-01-03T00:00:00.000Z');
    expect(saved._json.data.metadata.actorUserId).toBe(29);
  });
  it('R10 concurrent delete and virtual activity never leave a resurrected active contact',async()=>{
    await Promise.all([inProfile(()=>crmService.softDeleteContact(9,1)),invoke(crmController.addActivity,{type:'note',subject:'Concurrent note'},{contactId:'-11'})]);
    expect((await fixture.query('SELECT count(*)::int n FROM crm_contacts WHERE lead_id=11 AND deleted_at IS NULL')).rows[0].n).toBe(0);
  });
  it('R02 explicit canonical associations keep channel-lead lifecycle and follow-up work consistent',async()=>{
    await fixture.query(`INSERT INTO leads(id,user_id,business_profile_id,name,email,status,lead_status,source) VALUES(12,9,101,'Alias','alias@example.test','new','new','fixture');
      INSERT INTO outreach_conversations(id,user_id,business_profile_id,lead_id,crm_contact_id,channel) VALUES(1,9,101,12,1,'email');
      INSERT INTO followup_sequences(user_id,business_profile_id,lead_id) VALUES(9,101,12);
      INSERT INTO sequence_executions(user_id,business_profile_id,lead_id) VALUES(9,101,12);`);
    await inProfile(()=>crmService.updateContact(9,1,{pipelineStatus:'won'}));
    expect((await fixture.query('SELECT status,lead_status FROM leads WHERE id IN (11,12)')).rows).toEqual([
      {status:'converted',lead_status:'converted'},{status:'converted',lead_status:'converted'},
    ]);
    expect((await fixture.query('SELECT status FROM sequence_executions WHERE lead_id IN (11,12)')).rows.every(row=>row.status==='paused')).toBe(true);
  });
  it.todo('R13 formula-safe lead CSV (Data-owned integration gate)');
  it('R14 history redaction is invariant when query parameters are omitted',async()=>{
    await fixture.query(`INSERT INTO outreach_conversations(id,user_id,business_profile_id,lead_id,crm_contact_id,channel,total_messages) VALUES(1,9,101,11,1,'email',1);
      INSERT INTO outreach_messages(id,user_id,business_profile_id,conversation_id,direction,content,redacted_content,html_content,status)
        VALUES(1,9,101,1,'inbound','Synthetic secret 123456','Synthetic [REDACTED]','<b>Synthetic secret 123456</b>','received');`);
    const legacy=await invoke(crmController.getContactConversations,{}, {id:'1'},{});
    const paginated=await invoke(crmController.getContactConversations,{}, {id:'1'},{page:'1',limit:'10'});
    expect(legacy._status).toBe(200);expect(paginated._status).toBe(200);
    expect(JSON.stringify(legacy._json)).not.toContain('Synthetic secret 123456');
    expect(JSON.stringify(paginated._json)).not.toContain('Synthetic secret 123456');
  });
  it.todo('R15 interrupted import ledger (Data-owned integration gate)');
  it('C01 strict DTO and real ownership trigger both reject cross-profile contact reassociation',async()=>{
    expect(crmActivitySchema.partial().safeParse({contactId:4}).success).toBe(false);
    const res=await invoke(crmController.updateActivity,{contactId:4});
    expect(res._status).toBe(400);
    await expect(inProfile(()=>runtime.query("UPDATE crm_activities SET contact_id=4 WHERE id=1"))).rejects.toThrow();
    expect((await fixture.query('SELECT contact_id FROM crm_activities WHERE id=1')).rows[0].contact_id).toBe(1);
    expect(await inProfile(()=>crmService.getContactById(9,4))).toBeNull();
  });
  it('C03 different-owner records stay hidden and mixed-tenant bulk mutations roll back',async()=>{
    await fixture.query(`INSERT INTO company_settings(id,user_id,crm_configuration) VALUES(201,19,'${JSON.stringify(DEFAULT_CRM_CONFIGURATION)}');
      INSERT INTO leads(id,user_id,business_profile_id,name,email,status,source) VALUES(22,19,201,'Foreign','foreign@example.test','new','fixture');
      INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id,email,status) VALUES(5,19,201,22,'foreign@example.test','new');`);
    expect(await inProfile(()=>crmService.getContactById(9,5))).toBeNull();
    expect((await invoke(leadController.getLead,{}, {id:'22'}))._status).toBe(404);
    expect((await invoke(leadController.updateLead,{company:'Must not persist'}, {id:'22'}))._status).toBe(404);
    expect((await invoke(crmController.updateContact,{company:'Must not persist'}, {id:'5'}))._status).toBe(404);
    await expect(inProfile(()=>crmService.bulkUpdateContacts(9,{contactIds:[1,5],addTags:['Must not persist']}))).rejects.toMatchObject({status:404});
    expect((await fixture.query('SELECT tags FROM crm_contacts WHERE id=1')).rows[0].tags).toEqual(['VIP']);
  });
  it('C04 exact-phone merge keeps the survivor, redirect and business boundary',async()=>{
    await fixture.query("UPDATE crm_contacts SET phone='+1 (415) 555-0100' WHERE id IN (1,4)");
    const result=await inProfile(()=>crmService.createContact(9,{email:'alias@example.test',phone:'14155550100',notes:'Synthetic merge note'}));
    expect(result.id).toBe(1);
    const retired=(await fixture.query('SELECT id,merged_into_contact_id FROM crm_contacts WHERE merged_into_contact_id=1')).rows;
    expect(retired).toHaveLength(1);
    expect((await inProfile(()=>crmService.getContactById(9,retired[0].id)))?.id).toBe(1);
    expect((await fixture.query('SELECT deleted_at FROM crm_contacts WHERE id=4')).rows[0].deleted_at).toBeNull();
    expect((await fixture.query('SELECT notes FROM crm_contacts WHERE id=1')).rows[0].notes).toContain('Synthetic merge note');
  });
  (process.env.CRM_AUDIT_BROWSER_BRIDGE==='1'?it:it.skip)('C02 browser create/edit flows through real controllers and disposable PostgreSQL',async()=>{
    const {chromium}=createRequire(import.meta.url)('playwright-core');
    const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
    try {
      const context=await browser.newContext({viewport:{width:1440,height:900}});
      await context.route('**/*',async(route:any)=>{
        const request=route.request();const url=new URL(request.url());
        if(url.origin!=='http://127.0.0.1:3000')return route.abort();
        if(!url.pathname.startsWith('/api/'))return route.continue();
        const path=url.pathname;const query=Object.fromEntries(url.searchParams);let value:any={};let status=200;
        if(path==='/api/auth/me')value={user:{id:29,email:'member@example.test',name:'Synthetic Member',isSetupComplete:true,isApproved:true,hasBusinessProfile:true,hasBrandToolkit:true}};
        else if(path==='/api/platform/access')value={maintenance:{enabled:false},modules:['campaigns','lead_generation','crm','outreach','support','billing','storage'].map(key=>({key,name:key,enabled:true,status:'available',mode:'enabled'}))};
        else if(path==='/api/settings/business-profiles')value=[{id:101,name:'Synthetic audit',companyName:'Synthetic audit',isDefault:true,role:'member'}];
        else if(path==='/api/settings/preferences')value={theme:'light',language:'en',timezone:'UTC'};
        else if(path==='/api/organizations')value={organizations:[]};
        else if(path==='/api/wallet')value={balance:0};
        else if(path==='/api/chat/threads')value={threads:[],total:0};
        else if(path==='/api/crm/configuration')value={success:true,data:DEFAULT_CRM_CONFIGURATION};
        else if(path==='/api/crm/assignees')value={success:true,data:[{id:9,name:'Owner'},{id:29,name:'Member'}]};
        else if(path==='/api/crm/analytics')value={success:true,data:{totalContacts:2,winRate:0,pipelineValueByCurrency:{INR:'120'}}};
        else if(path==='/api/crm/contacts'&&request.method()==='GET'){
          const res=await invoke(crmController.getContacts,{}, {},query);value=res._json;status=res._status;
        } else if(path==='/api/crm/contacts'&&request.method()==='POST'){
          const res=await invoke(crmController.createContact,crmContactCreateSchema.parse(request.postDataJSON()),{}, {},request.headers());
          return route.fulfill({status:res._status,headers:res._headers,json:JSON.parse(JSON.stringify(res._json))});
        } else if(/^\/api\/crm\/contacts\/\d+$/.test(path)&&request.method()==='PUT'){
          const res=await invoke(crmController.updateContact,crmContactSchema.partial().parse(request.postDataJSON()),{id:path.split('/').at(-1)});value=res._json;status=res._status;
        } else if(request.method()!=='GET')return route.fulfill({status:409,json:{error:'AUDIT_EXTERNAL_ACTION_DISABLED'}});
        return route.fulfill({status,json:JSON.parse(JSON.stringify(value))});
      });
      const page=await context.newPage();
      await page.goto('http://127.0.0.1:3000/dashboard/crm/contacts');
      await page.getByRole('button',{name:'Add Contact',exact:true}).first().click();
      await page.getByLabel('First name',{exact:true}).fill('Bridge');
      await page.getByLabel('Last name',{exact:true}).fill('Fixture');
      await page.getByLabel('Email',{exact:true}).fill('bridge@example.test');
      await page.getByRole('dialog').getByRole('button',{name:'Add Contact',exact:true}).click();
      await page.getByText('Bridge Fixture',{exact:true}).waitFor();
      const contact=(await fixture.query("SELECT id FROM crm_contacts WHERE email='bridge@example.test'")).rows[0];
      expect(contact.id).toBeGreaterThan(100);
      await page.getByRole('button',{name:'Edit Bridge Fixture',exact:true}).click();
      await page.getByRole('textbox',{name:'Company',exact:true}).fill('Persisted through UI');
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByText('Persisted through UI',{exact:true}).waitFor();
      expect((await fixture.query('SELECT company FROM crm_contacts WHERE id=$1',[contact.id])).rows[0].company).toBe('Persisted through UI');
      if(process.env.CRM_QA_SCREENSHOT_DIR)await page.screenshot({path:resolve(process.env.CRM_QA_SCREENSHOT_DIR,'browser-db-bridge.png'),fullPage:true});
    } finally {await browser.close();}
  },90000);
});
