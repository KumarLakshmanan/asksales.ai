import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {drizzle,type NodePgDatabase} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {createBusinessScopedPool} from '../tenancy/scopedPool.js';
import {requireBusinessScope,withBusinessScope} from '../tenancy/businessContext.js';
import {localBusinessFunctions,localBusinessIsolation} from './helpers/localBusinessPostgres.js';
import {BillingOrganizationError} from '../services/billing/organizations.js';
import {syntheticCampaignSnapshot} from './helpers/campaignSnapshotFixture.js';
// @ts-expect-error JavaScript migration uses the application migration runner.
const migration=await import('../migrations/580_dashboard_operations.js');
let database:NodePgDatabase,admin:Pool,fixture:Pool,runtime:Pool,schema:string;
let rejectOrigin=false;
const addJob=jest.fn<any>().mockResolvedValue('job-1'),importRows=jest.fn<any>();
const resolveAccount=jest.fn<any>(),approvedTemplates=jest.fn<any>();
let exportSource=syntheticCampaignSnapshot();
const exportReport=jest.fn<(...args:any[])=>Promise<any>>(),renderFormat=jest.fn<(...args:any[])=>Promise<Buffer>>();
jest.unstable_mockModule('../services/outreach/CampaignReportingService.js',()=>({getCampaignReport:exportReport,validateReportScope:async()=>{}}));
jest.unstable_mockModule('../services/outreach/CustomerEngagementService.js',()=>({getCampaignCustomers:async()=>({items:exportSource.customers}),getCampaignHistory:async()=>({items:exportSource.history})}));
jest.unstable_mockModule('../services/outreach/CampaignReportFormats.js',()=>({renderCampaignReport:renderFormat}));
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({},{get(_target,key){const value=Reflect.get(database,key);return typeof value==='function' ? value.bind(database) : value;}})}));
jest.unstable_mockModule('../queues/index.js',()=>({QUEUE_NAMES:{GENERAL:'general'},queueRegistry:{initialize:jest.fn<any>().mockResolvedValue(undefined),addJob}}));
jest.unstable_mockModule('../tenancy/jobBusinessScope.js',()=>({
  captureJobBusiness:async(data:any)=>{
    const scope=requireBusinessScope();return {...data,userId:scope.userId,businessProfileId:scope.businessProfileId,
      businessActorUserId:data.businessActorUserId || scope.actorUserId || scope.userId,billingOrganizationId:data.billingOrganizationId || 8,
      billingActorUserId:data.billingActorUserId || scope.actorUserId || scope.userId};
  },
  runBusinessJob:async(origin:any,work:any)=>{
    if(rejectOrigin)throw new BillingOrganizationError('Original staff access was removed.');
    expect(origin).toMatchObject({userId:991,businessProfileId:1,billingOrganizationId:8});
    return withBusinessScope({userId:origin.userId,businessProfileId:origin.businessProfileId,actorUserId:origin.businessActorUserId},()=>work(origin));
  },
}));
jest.unstable_mockModule('../services/CRMService.js',()=>({crmService:{importContactsFromCSV:importRows}}));
class CrmImportInterruptedError extends Error {constructor(){super('Interrupted');}}
jest.unstable_mockModule('../services/CrmImportLedger.js',()=>({beginCrmImport:jest.fn<any>().mockResolvedValue({id:7})}));
jest.unstable_mockModule('../services/outreach/CreationService.js',()=>({resolveCreationAccount:resolveAccount,getCreationTemplates:approvedTemplates}));
const operations=await import('../services/operations/DashboardOperations.js');
const preparation=await import('../services/outreach/PreparedOutreachService.js');
const exportsService=await import('../services/outreach/CampaignExportService.js');
const scope=<T>(work:()=>T)=>withBusinessScope({userId:991,businessProfileId:1},work);
const run=process.env.OUTREACH_QUEUE_LOCAL_QA==='1' ? describe : describe.skip;
const file=(text='Name,Phone\nA,9000000001\nAgain,+919000000001\nMissing,12')=>({name:'contacts.csv',buffer:Buffer.from(text)});
async function create(text?:string,key=randomUUID()) {return scope(()=>operations.createContactAnalysis([file(text)],{defaultCountry:'IN'},key));}
async function processOperation(id:string) {
  const row=await scope(()=>operations.ownedDashboardOperation(id));
  return scope(()=>operations.processDashboardOperation({...row.origin,operationId:id}));
}
run('dashboard operations with real migration, RLS and durable checkpoints',()=>{
  beforeAll(async()=>{
    const url=process.env.OUTREACH_QA_DATABASE_URL;
    if(!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || new URL(url).pathname!='/implementation_synthetic')throw new Error('Explicit isolated loopback fixture required');
    schema=`dashboard_operation_${randomBytes(8).toString('hex')}`;
    const connection={connectionString:url,connectionTimeoutMillis:5000};
    admin=new Pool({...connection,max:1,options:'-c search_path=pg_catalog'});await admin.query(`CREATE SCHEMA ${schema}`);
    fixture=new Pool({...connection,max:1,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`});
    await localBusinessFunctions(fixture);
    await fixture.query(`CREATE TABLE users(id int PRIMARY KEY);INSERT INTO users VALUES(991),(992),(993);
      CREATE TABLE company_settings(id int PRIMARY KEY,user_id int,billing_organization_id int);INSERT INTO company_settings VALUES(1,991,8),(2,991,8),(3,992,9);
      CREATE TABLE billing_organizations(id int PRIMARY KEY,storage_limit bigint NOT NULL DEFAULT 1000000000);INSERT INTO billing_organizations(id) VALUES(8),(9);
      CREATE TABLE billing_storage_reservations(id uuid PRIMARY KEY,organization_id int,business_profile_id int,user_id int,bytes bigint,created_at timestamptz DEFAULT now(),expires_at timestamptz DEFAULT now()+interval '1 hour');
      CREATE TABLE billing_capacity_items(source_table text,source_id text,resource_key text,identity_key text,organization_id int,business_profile_id int,amount bigint);
      CREATE TABLE billing_capacity_totals(organization_id int,resource_key text,usage bigint,updated_at timestamptz DEFAULT now(),PRIMARY KEY(organization_id,resource_key));
      CREATE FUNCTION billing_assert_capacity(org int,resource text,amount bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF amount+COALESCE((SELECT usage FROM billing_capacity_totals WHERE organization_id=org AND resource_key=resource),0)>
          (SELECT storage_limit FROM billing_organizations WHERE id=org) THEN RAISE EXCEPTION 'Storage capacity exceeded'; END IF;
      END $$;
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read bool,parent_links jsonb);
      CREATE FUNCTION app_business_access(profile int) RETURNS boolean LANGUAGE SQL STABLE AS $$SELECT app_business_system() OR
        (profile=app_business_profile_id() AND EXISTS(SELECT 1 FROM company_settings WHERE id=profile AND user_id=app_business_user_id()))$$;
      CREATE TABLE sent_messages(business_profile_id int,user_id int,outreach_message_id int,is_reply bool);
      CREATE TABLE outreach_messages(business_profile_id int,user_id int,campaign_id int,created_at timestamp,direction text,message_kind text);
      CREATE TABLE outreach_conversations(business_profile_id int,user_id int,lead_id int,channel text,provider_account_id text);
      CREATE TABLE leads(id int PRIMARY KEY,user_id int,business_profile_id int,deleted_at timestamp,source text,campaign_data jsonb,
        legacy_campaign_thread_key text GENERATED ALWAYS AS (CASE WHEN length(campaign_data->>'threadId') BETWEEN 1 AND 10 THEN campaign_data->>'threadId' END) STORED);
      CREATE TABLE crm_contacts(id int PRIMARY KEY,user_id int,business_profile_id int,lead_id int,deleted_at timestamp,merged_into_contact_id int);
      CREATE TABLE crm_contact_imports(id int PRIMARY KEY,user_id int,business_profile_id int,file_name text);
      CREATE TABLE crm_contact_import_details(import_id int,business_profile_id int,created_contact_id int,status text);`);
    await localBusinessIsolation(fixture,schema,[]);
    const guard=readFileSync('migrations/299_business_profile_isolation.js','utf8').match(/CREATE OR REPLACE FUNCTION enforce_business_ownership\(\)[\s\S]*?END \$\$/)?.[0];
    if(!guard)throw new Error('Production ownership guard unavailable');await fixture.query(guard);
    const nativeStorage=readFileSync('migrations/302_organization_capacity.js','utf8').match(/CREATE FUNCTION billing_reserve_storage\([\s\S]*?(?=\s*CREATE FUNCTION billing_capacity_reconciliation)/)?.[0];
    if(!nativeStorage)throw new Error('Production storage reservations unavailable');
    await fixture.query(nativeStorage.replaceAll('SET search_path=public,pg_catalog',`SET search_path=${schema},pg_catalog`));
    await migration.up({query:(query:string,values?:unknown[])=>fixture.query(query.replaceAll('SET search_path=public,pg_catalog',`SET search_path=${schema},pg_catalog`),values)});
    runtime=createBusinessScopedPool(new Pool({...connection,max:3,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`}));database=drizzle(runtime);
  },30000);
  afterAll(async()=>{
    await runtime?.end();await fixture?.end();
    if(admin && /^dashboard_operation_[a-f0-9]{16}$/.test(schema))await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  beforeEach(async()=>{
    jest.clearAllMocks();rejectOrigin=false;addJob.mockResolvedValue('job-1');
    exportSource=syntheticCampaignSnapshot();exportReport.mockImplementation(async()=>exportSource.report);
    renderFormat.mockImplementation(async(snapshot:any,format:string)=>Buffer.from(JSON.stringify({snapshot,format})));
    await fixture.query('TRUNCATE dashboard_contact_rows,dashboard_operation_files,dashboard_operations,dashboard_operation_inputs,billing_storage_reservations,billing_capacity_items,billing_capacity_totals,leads,crm_contacts,crm_contact_imports,crm_contact_import_details RESTART IDENTITY');
    await fixture.query('UPDATE billing_organizations SET storage_limit=1000000000');
    resolveAccount.mockResolvedValue({account:{id:'account-1',providerAccountId:'account-1',ready:true,reason:null},binding:{providerAccountId:'account-1'}});
    approvedTemplates.mockResolvedValue([{id:'template-1',name:'approved_offer',language:'en',body:'Welcome'},{id:'followup-1',name:'approved_reminder',language:'en',body:'Reminder'}]);
    importRows.mockImplementation(async(_user:number,rows:any[],_mapping:any,_name:string,options:any)=>({importId:7,totalRecords:rows.length,
      successCount:Math.min(rows.length,options.startIndex+options.batchSize),duplicateCount:0,errorCount:0,skippedCount:0,warningCount:0,issues:[],importStatus:'processing'}));
  });
  it('accepts an idempotent upload, analyzes without importing, and exposes paged source rows',async()=>{
    const key=randomUUID(),first=await create(undefined,key),again=await create(undefined,key);expect(again.id).toBe(first.id);
    await expect(create('Name,Phone\nOther,9000000002',key)).rejects.toThrow('different files');
    await processOperation(first.id);
    const row=await scope(()=>operations.ownedDashboardOperation(first.id));
    expect(row.status).toBe('ready');expect(row.result).toMatchObject({totals:{rows:3,uniqueContacts:1,duplicateRows:1,invalidRows:1}});
    expect(importRows).not.toHaveBeenCalled();expect(addJob.mock.calls[0][2]).not.toHaveProperty('files');
    const page=await scope(()=>operations.analysisRows(first.id,{pageSize:1}));expect(page.items).toHaveLength(1);expect(page.nextCursor).toBe(1);
    const invalid=await scope(()=>operations.analysisRows(first.id,{status:'invalid'}));expect(invalid.items[0].rowNumber).toBe(4);
    const view=operations.dashboardOperationView(row);expect(view).not.toHaveProperty('origin');expect(view).not.toHaveProperty('payload');
    const status=await scope(()=>operations.dashboardOperationStatus(first.id,['contact_analysis']));
    expect(status).toMatchObject({status:'ready',result:{totals:{uniqueContacts:1}}});expect(status).not.toHaveProperty('payload');
    const history=await scope(()=>operations.listDashboardOperations(['contact_analysis']));
    expect(history[0]).toMatchObject({id:first.id,result:null,analysisTotals:{uniqueContacts:1}});
  });
  it('keeps uploads durable when Redis is unavailable and recovers using the original actor',async()=>{
    addJob.mockRejectedValueOnce(new Error('Redis unavailable'));
    const operation=await withBusinessScope({userId:991,businessProfileId:1,actorUserId:993},()=>operations.createContactAnalysis([file()],{defaultCountry:'IN'},randomUUID()));
    await scope(()=>database.execute(sql`UPDATE dashboard_operations SET updated_at=now()-interval '3 minutes' WHERE id=${operation.id}::uuid`));
    expect(await scope(()=>operations.recoverDashboardOperations())).toEqual({recovered:1});
    expect(addJob.mock.calls.at(-1)![2]).toMatchObject({userId:991,businessProfileId:1,businessActorUserId:993,billingActorUserId:993,billingOrganizationId:8});
    expect((await scope(()=>operations.ownedDashboardOperation(operation.id))).status).toBe('queued');
  });
  it('enforces RLS and the real parent ownership trigger for files, rows and operations',async()=>{
    const operation=await create();await processOperation(operation.id);
    await withBusinessScope({userId:991,businessProfileId:2},async()=>{
      await expect(operations.ownedDashboardOperation(operation.id)).rejects.toThrow('not found');
      expect((await database.execute(sql`SELECT * FROM dashboard_operation_files`)).rows).toEqual([]);
      expect((await database.execute(sql`SELECT * FROM dashboard_contact_rows`)).rows).toEqual([]);
      expect((await database.execute(sql`SELECT * FROM dashboard_operation_inputs`)).rows).toEqual([]);
      const input=(await fixture.query('SELECT id FROM dashboard_operation_inputs LIMIT 1')).rows[0].id;
      await expect(database.execute(sql`INSERT INTO dashboard_operation_files(id,user_id,business_profile_id,operation_id,name,hash,ordinal,input_id)
        VALUES(${randomUUID()}::uuid,991,2,${operation.id}::uuid,'bad.csv',${'0'.repeat(64)},9,${input}::uuid)`)).rejects.toThrow();
    });
    const row=await scope(()=>operations.ownedDashboardOperation(operation.id));
    await expect(scope(()=>operations.processDashboardOperation({...row.origin,businessActorUserId:993,operationId:row.id}))).rejects.toThrow('authority');
  });
  it('holds an operation when its original authority is revoked instead of replacing that actor',async()=>{
    const operation=await create();rejectOrigin=true;
    await scope(()=>database.execute(sql`UPDATE dashboard_operations SET updated_at=now()-interval '3 minutes' WHERE id=${operation.id}::uuid`));
    await scope(()=>operations.recoverDashboardOperations());
    const held=await scope(()=>operations.ownedDashboardOperation(operation.id));
    expect(held).toMatchObject({status:'review',error:'Original staff access was removed.'});
    expect(held.origin.businessActorUserId).toBe(991);expect(addJob).toHaveBeenCalledTimes(1);expect(importRows).not.toHaveBeenCalled();
  });
  it('freezes the reviewed ready audience and never imports flagged or duplicate rows',async()=>{
    const analysis=await create();await processOperation(analysis.id);
    const imported=await scope(()=>operations.createContactImport(analysis.id,`import-${analysis.id}`));
    const replay=await scope(()=>operations.createContactImport(analysis.id,`import-${analysis.id}`));expect(replay.id).toBe(imported.id);
    const row=await scope(()=>operations.ownedDashboardOperation(imported.id));expect(row.payload.rows).toHaveLength(1);
    expect((row.payload.rows as any[])[0]).toMatchObject({phone:'+919000000001',_sourceFile:'contacts.csv',_sourceSheet:'Contacts',_sourceRow:'2'});
    await Promise.all([processOperation(imported.id),processOperation(imported.id)]);expect(importRows).toHaveBeenCalledTimes(1);
    expect((await scope(()=>operations.ownedDashboardOperation(imported.id))).status).toBe('completed');
  });
  it('resumes a failed chunk from its saved cursor without repeating earlier chunks',async()=>{
    const text='Name,Phone\n'+Array.from({length:501},(_,i)=>`Guest ${i},+919${String(i).padStart(9,'0')}`).join('\n');
    const analysis=await create(text);await processOperation(analysis.id);const imported=await scope(()=>operations.createContactImport(analysis.id,randomUUID()));
    const success=importRows.getMockImplementation()!;
    importRows.mockImplementationOnce(success).mockRejectedValueOnce(new CrmImportInterruptedError());
    await expect(processOperation(imported.id)).rejects.toThrow('Interrupted');
    const checkpoint=await scope(()=>operations.ownedDashboardOperation(imported.id));
    expect(checkpoint.status).toBe('queued');
    expect(checkpoint.cursor).toBeGreaterThan(0);expect(checkpoint.cursor).toBeLessThanOrEqual(25);expect(checkpoint.processed).toBe(checkpoint.cursor);
    await processOperation(imported.id);
    const starts=importRows.mock.calls.map(call=>(call[4] as {startIndex:number}).startIndex);
    expect(starts.slice(0,3)).toEqual([0,checkpoint.cursor,checkpoint.cursor]);
    expect(starts.slice(2).every((start,index,array)=>index===0 || start>array[index-1])).toBe(true);
    expect(importRows.mock.calls.every(call=>(call[4] as {batchSize:number}).batchSize<=25)).toBe(true);
    expect(await scope(()=>operations.ownedDashboardOperation(imported.id))).toMatchObject({status:'completed',cursor:501,processed:501});
  });
  it('accepts more than 10,000 contacts and preserves every staged row',async()=>{
    const text='Name,Phone\n'+Array.from({length:10001},(_,i)=>`Guest ${i},+919${String(i).padStart(9,'0')}`).join('\n');
    const analysis=await create(text);await processOperation(analysis.id);
    expect(await scope(()=>operations.ownedDashboardOperation(analysis.id))).toMatchObject({status:'ready',total:10001,processed:10001});
    const imported=await scope(()=>operations.createContactImport(analysis.id,randomUUID()));
    expect((await scope(()=>operations.ownedDashboardOperation(imported.id))).total).toBe(10001);
  },30000);
  it('creates a fresh corrected preview while an already reviewed import remains immutable',async()=>{
    const original=await create();await processOperation(original.id);const imported=await scope(()=>operations.createContactImport(original.id,randomUUID()));
    const summary=(await scope(()=>operations.ownedDashboardOperation(original.id))).result as any;
    const revised=await scope(()=>operations.reviseContactAnalysis(original.id,{defaultCountry:'IN',rows:[{fileHash:summary.files[0].hash,sheetName:'Contacts',rowNumber:4,contact:{phone:'9000000002'}}]},randomUUID()));
    await processOperation(revised.id);expect((await scope(()=>operations.ownedDashboardOperation(revised.id))).result).toMatchObject({totals:{uniqueContacts:2,readyContacts:2,invalidRows:0}});
    expect((await scope(()=>operations.ownedDashboardOperation(imported.id))).payload.rows).toHaveLength(1);
  });
  it('expires staged PII, refuses late access and retains the operation summary',async()=>{
    const operation=await create();await processOperation(operation.id);
    await scope(()=>database.execute(sql`UPDATE dashboard_operations SET expires_at=now()-interval '1 day' WHERE id=${operation.id}::uuid`));
    await scope(()=>database.execute(sql`UPDATE dashboard_operation_inputs SET expires_at=now()-interval '1 day'`));
    await scope(()=>operations.recoverDashboardOperations());
    await expect(scope(()=>operations.analysisRows(operation.id))).rejects.toThrow('expired');
    expect((await fixture.query('SELECT count(*)::int n FROM dashboard_operation_files')).rows[0].n).toBe(0);
    expect((await fixture.query('SELECT count(*)::int n FROM dashboard_contact_rows')).rows[0].n).toBe(0);
    expect((await fixture.query('SELECT count(*)::int n FROM dashboard_operation_inputs')).rows[0].n).toBe(0);
    expect((await fixture.query('SELECT usage::int FROM billing_capacity_totals WHERE organization_id=8')).rows[0].usage).toBe(0);
    expect((await scope(()=>operations.ownedDashboardOperation(operation.id))).result).toMatchObject({totals:{uniqueContacts:1}});
    await expect(migration.down(fixture)).rejects.toThrow('history exists');
  });
  it('charges identical file bytes once across duplicate uploads and revised previews, and rejects quota overflow atomically',async()=>{
    const source=file(),operation=await scope(()=>operations.createContactAnalysis([source,{...source,name:'copy.csv'}],{defaultCountry:'IN'},randomUUID()));
    await processOperation(operation.id);
    const summary=(await scope(()=>operations.ownedDashboardOperation(operation.id))).result as any;
    await scope(()=>operations.reviseContactAnalysis(operation.id,{defaultCountry:'IN',rows:[{fileHash:summary.files[0].hash,sheetName:'Contacts',rowNumber:4,excluded:true}]},randomUUID()));
    expect((await fixture.query('SELECT count(*)::int n FROM dashboard_operation_inputs')).rows[0].n).toBe(1);
    expect((await fixture.query('SELECT usage::int FROM billing_capacity_totals WHERE organization_id=8')).rows[0].usage).toBe(source.buffer.length);
    const stored=(await fixture.query('SELECT * FROM billing_storage_reservations')).rows;
    expect(stored).toHaveLength(1);expect(new Date(stored[0].expires_at).getTime()-Date.now()).toBeGreaterThan(29*86400000);
    await fixture.query('UPDATE billing_organizations SET storage_limit=$1 WHERE id=8',[source.buffer.length+1]);
    await expect(create('Name,Phone\nB,9000000002')).rejects.toThrow();
    expect((await fixture.query('SELECT count(*)::int n FROM dashboard_operations')).rows[0].n).toBe(2);
    expect((await fixture.query('SELECT count(*)::int n FROM dashboard_operation_inputs')).rows[0].n).toBe(1);
  });
  it('forbids callers from changing staged bytes or reservation identities',async()=>{
    await create();const input=(await fixture.query('SELECT * FROM dashboard_operation_inputs')).rows[0];
    await expect(scope(()=>database.execute(sql`UPDATE dashboard_operation_inputs SET bytes=${Buffer.from('changed')} WHERE id=${input.id}::uuid`))).rejects.toThrow();
    await expect(scope(()=>database.execute(sql`UPDATE dashboard_operation_inputs SET storage_reservation_id=${randomUUID()}::uuid WHERE id=${input.id}::uuid`))).rejects.toThrow();
    expect((await fixture.query('SELECT usage::int FROM billing_capacity_totals WHERE organization_id=8')).rows[0].usage).toBe(file().buffer.length);
  });
  it('prepares the full imported audience without sending, preserves account/template/timing and never duplicates a replay',async()=>{
    await fixture.query(`INSERT INTO crm_contact_imports VALUES(7,991,1,'Guests.xlsx'),(8,991,2,'Foreign.xlsx');
      INSERT INTO leads SELECT n,991,1,NULL,'crm_import',NULL FROM generate_series(1,575) n;
      INSERT INTO crm_contacts SELECT n,991,1,n,NULL,NULL FROM generate_series(1,575) n;
      INSERT INTO crm_contact_import_details SELECT 7,1,n,'success' FROM generate_series(1,575) n;`);
    const input=preparation.preparedOutreachSchema.parse({name:'Imported audience QA',audience:{source:'crm',importId:7},channel:'whatsapp',providerAccountId:'account-1',templateId:'template-1',
      followUps:[{delayMinutes:1440,templateId:'followup-1'}],scheduledFor:new Date(Date.now()+3600000).toISOString(),requestKey:'prepare-575-contacts'});
    const first=await scope(()=>preparation.prepareOutreach(input)),replayed=await scope(()=>preparation.prepareOutreach(input));
    expect(first.id).toBe(replayed.id);expect(first.audience).toMatchObject({count:575,name:'Guests.xlsx',importId:7});
    expect(first.draft).toMatchObject({accountId:'account-1',providerAccountId:'account-1',templateId:'template-1',sendWhen:'later',scheduledFor:input.scheduledFor,optInConfirmed:false,
      followUps:{whatsapp:{enabled:true,steps:[{delayValue:1440,delayUnit:'minutes',templateId:'followup-1'}]}}});
    expect(first.draft.leadIds).toHaveLength(575);expect(first.card.actions?.[0].href).toBe(`/dashboard/outreach/prepared/${first.id}`);
    expect(addJob).not.toHaveBeenCalled();expect(importRows).not.toHaveBeenCalled();
    const hash='a'.repeat(64);
    expect(await scope(()=>preparation.claimPreparedOutreachLaunch(first.id,hash))).toBeNull();
    await expect(scope(()=>preparation.claimPreparedOutreachLaunch(first.id,'b'.repeat(64)))).rejects.toThrow('already submitted');
    await scope(()=>preparation.recordPreparedOutreachLaunch(first.id,hash,{total:575,queued:575,errors:0,results:[{leadId:1,messageId:1,status:'queued'}]}));
    expect(await scope(()=>preparation.claimPreparedOutreachLaunch(first.id,hash))).toMatchObject({total:575,queued:575});
    expect(await scope(()=>preparation.getPreparedOutreach(first.id))).toMatchObject({launch:{status:'submitted',receipt:{total:575,queued:575}}});
    await expect(scope(()=>preparation.prepareOutreach({...input,templateId:'followup-1'}))).rejects.toThrow('different preparation');
    await withBusinessScope({userId:991,businessProfileId:2},async()=>{
      await expect(preparation.getPreparedOutreach(first.id)).rejects.toThrow('not found');
      await expect(preparation.prepareOutreach({...input,requestKey:'prepare-foreign-read'})).rejects.toThrow('not found');
    });
  });
  it('refuses incomplete imports and withdrawn templates and resolves merged contacts to their saved canonical lead',async()=>{
    await fixture.query(`INSERT INTO crm_contact_imports VALUES(7,991,1,'Merged.xlsx');
      INSERT INTO leads VALUES(1,991,1,NULL,'crm_import',NULL),(2,991,1,NULL,'crm_import',NULL);
      INSERT INTO crm_contacts VALUES(1,991,1,1,now(),2),(2,991,1,2,NULL,NULL);
      INSERT INTO crm_contact_import_details VALUES(7,1,1,'success');`);
    const input=preparation.preparedOutreachSchema.parse({name:'Merged audience QA',audience:{source:'crm',importId:7},channel:'whatsapp',providerAccountId:'account-1',templateId:'template-1',requestKey:'prepare-merged-contacts'});
    expect((await scope(()=>preparation.prepareOutreach(input))).draft.leadIds).toEqual([2]);
    await expect(scope(()=>preparation.prepareOutreach({...input,templateId:'withdrawn',requestKey:'prepare-withdrawn-template'}))).rejects.toThrow('no longer approved');
    const analysis=await create();await processOperation(analysis.id);const imported=await scope(()=>operations.createContactImport(analysis.id,randomUUID()));
    await expect(scope(()=>preparation.prepareOutreach({...input,audience:{importOperationId:imported.id},requestKey:'prepare-incomplete-import'}))).rejects.toThrow('complete');
    await scope(()=>database.execute(sql`UPDATE dashboard_operations SET status='completed',result='{"importId":7}'::jsonb WHERE id=${imported.id}::uuid`));
    expect((await scope(()=>preparation.prepareOutreach({...input,audience:{importOperationId:imported.id},requestKey:'prepare-completed-import'}))).draft.leadIds).toEqual([2]);
  });
  it('stores all campaign formats under native quota and RLS from one immutable snapshot',async()=>{
    const input=exportsService.campaignExportSchema.parse({name:'Synthetic report',requestKey:'export-native-once',filters:{messageKind:'outreach'}});
    const created=await scope(()=>exportsService.createCampaignExport(input));await processOperation(created.id);
    const completed=await scope(()=>exportsService.getCampaignExport(created.id));expect(completed.status).toBe('completed');expect(completed.files).toHaveLength(4);expect(completed.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(exportReport).toHaveBeenCalledTimes(1);
    for(const format of ['pdf','docx','xlsx','html'] as const) {
      const file=await scope(()=>exportsService.downloadCampaignExport(created.id,format));
      expect(JSON.parse(file.bytes.toString()).snapshot.report.counts).toMatchObject({accepted:2,delivered:1,awaitingConfirmation:1});
      expect(JSON.parse(file.bytes.toString()).snapshot.checkedAt).toBe(completed.snapshotAt);
    }
    const custody=(await fixture.query('SELECT COUNT(*)::int AS files,SUM(octet_length(bytes))::bigint AS bytes FROM dashboard_operation_inputs')).rows[0];expect(custody.files).toBe(5);
    const held=(await fixture.query('SELECT SUM(bytes)::bigint AS bytes FROM billing_storage_reservations')).rows[0];expect(held.bytes).toBe(custody.bytes);
    await expect(withBusinessScope({userId:991,businessProfileId:2},()=>exportsService.downloadCampaignExport(created.id,'pdf'))).rejects.toThrow('not found');
    expect((await scope(()=>exportsService.createCampaignExport(input))).id).toBe(created.id);expect(renderFormat).toHaveBeenCalledTimes(4);
  });
  it('resumes interrupted generation without recapturing newer live counts or duplicating files',async()=>{
    renderFormat.mockImplementationOnce(async(snapshot:any,format:string)=>Buffer.from(JSON.stringify({snapshot,format}))).mockRejectedValueOnce(new Error('Synthetic renderer interruption'));
    const created=await scope(()=>exportsService.createCampaignExport(exportsService.campaignExportSchema.parse({name:'Resume report',requestKey:'export-resume-native',filters:{}})));
    await expect(processOperation(created.id)).rejects.toThrow('interruption');
    expect((await scope(()=>exportsService.getCampaignExport(created.id))).files).toHaveLength(1);
    exportSource.report.counts.delivered=2;exportSource.report.counts.awaitingConfirmation=0;
    await scope(()=>exportsService.resumeCampaignExport(created.id));await processOperation(created.id);
    expect(exportReport).toHaveBeenCalledTimes(1);expect((await fixture.query('SELECT COUNT(*)::int AS count FROM dashboard_operation_inputs')).rows[0].count).toBe(5);
    const file=await scope(()=>exportsService.downloadCampaignExport(created.id,'xlsx'));
    expect(JSON.parse(file.bytes.toString()).snapshot.report.counts).toMatchObject({delivered:1,awaitingConfirmation:1});
  });
  it('does not create partial snapshot custody when native storage capacity is exhausted',async()=>{
    await fixture.query('UPDATE billing_organizations SET storage_limit=1 WHERE id=8');
    const created=await scope(()=>exportsService.createCampaignExport(exportsService.campaignExportSchema.parse({requestKey:'export-quota-native',filters:{}})));
    await expect(processOperation(created.id)).rejects.toThrow();expect((await fixture.query('SELECT COUNT(*)::int AS count FROM dashboard_operation_inputs')).rows[0].count).toBe(0);
    expect((await scope(()=>exportsService.getCampaignExport(created.id))).status).toBe('review');expect(renderFormat).not.toHaveBeenCalled();
  });
});
