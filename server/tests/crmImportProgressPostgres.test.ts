import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {drizzle,type NodePgDatabase} from 'drizzle-orm/node-postgres';
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import {sql,SQL} from 'drizzle-orm';
import {createBusinessScopedPool} from '../tenancy/scopedPool.js';
import {withBusinessScope} from '../tenancy/businessContext.js';
import {localBusinessFunctions,localBusinessIsolation} from './helpers/localBusinessPostgres.js';
import {crmContactImportsTable} from '../models/crmContactImports/schema.js';
import {crmContactImportDetailsTable} from '../models/crmContactImportDetails/schema.js';
// @ts-expect-error Application migration uses the JavaScript runner.
const migration=await import('../migrations/583_crm_import_progress_reads.js');
let database:NodePgDatabase,admin:Pool,fixture:Pool,runtime:Pool,schema:string,lastQuery:SQL;
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({},{get(_target,key){
  if(key==='execute')return (query:SQL)=>{lastQuery=query;return database.execute(query);};
  const value=Reflect.get(database,key);return typeof value==='function' ? value.bind(database) : value;
}})}));
const ledger=await import('../services/CrmImportLedger.js');
const scope=<T>(work:()=>T)=>withBusinessScope({userId:991,businessProfileId:1},work);
const progress=()=>scope(()=>ledger.readCrmImportProgress(991,1));
const run=process.env.OUTREACH_QUEUE_LOCAL_QA==='1' ? describe : describe.skip;
const receiptNodes=(plan:any):any[]=>[...(plan['Relation Name']==='crm_contact_import_details' ? [plan] : []),...(plan.Plans||[]).flatMap(receiptNodes)];

run('receipt-derived import progress without repeated successful-row scans',()=>{
  beforeAll(async()=>{
    const url=process.env.OUTREACH_QA_DATABASE_URL;
    if(!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || new URL(url).pathname!='/implementation_synthetic')throw new Error('Explicit isolated loopback fixture required');
    schema=`import_progress_${randomBytes(8).toString('hex')}`;
    const connection={connectionString:url,connectionTimeoutMillis:5000};admin=new Pool({...connection,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    fixture=new Pool({...connection,max:1,options:`-c search_path=${schema},pg_catalog`});
    await localBusinessFunctions(fixture);await fixture.query('CREATE TABLE company_settings(id int PRIMARY KEY,user_id int);INSERT INTO company_settings VALUES(1,991),(2,991),(3,992)');
    for(const table of [crmContactImportsTable,crmContactImportDetailsTable]) {
      const definition=getTableConfig(table),columns=definition.columns.map(column=>{
        const value=column.default;
        const fallback=value instanceof SQL ? new PgDialect().sqlToQuery(value).sql : value===undefined ? undefined : typeof value==='number' || typeof value==='boolean' ? String(value) : `'${(typeof value==='string' ? value : JSON.stringify(value)).replaceAll("'","''")}'`;
        return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${fallback===undefined ? '' : ` DEFAULT ${fallback}`}`;
      });await fixture.query(`CREATE TABLE ${definition.name}(${columns.join(',')})`);
    }
    await fixture.query(`CREATE UNIQUE INDEX crm_import_row_receipt_uq ON crm_contact_import_details(import_id,row_number);
      INSERT INTO crm_contact_imports(id,user_id,business_profile_id,file_name,total_records,processed_records,success_count,error_count,skipped_count,import_status)
        VALUES(1,991,1,'synthetic.xlsx',30202,999,999,0,0,'processing'),(2,991,2,'other-profile.xlsx',1,0,0,0,0,'processing'),(3,992,3,'other-owner.xlsx',1,0,0,0,0,'processing');
      INSERT INTO crm_contact_import_details(import_id,business_profile_id,row_number,status)
        SELECT 1,1,number+1,'success' FROM generate_series(1,30000) number;
      INSERT INTO crm_contact_import_details(import_id,business_profile_id,row_number,status,error_message) VALUES
        (1,1,30002,'warning','Review status'),(1,1,30003,'duplicate','Duplicate email'),(1,1,30004,'skipped','Missing identifier'),
        (1,1,30005,'failed','Invalid value'),(1,1,30006,'blocked','Capacity hold'),(1,1,30007,'pending',NULL),
        (2,2,2,'warning','Other business'),(3,3,2,'failed','Other owner');`);
    await localBusinessIsolation(fixture,schema,['crm_contact_imports','crm_contact_import_details']);
    await migration.up(fixture);await fixture.query('ANALYZE crm_contact_imports;ANALYZE crm_contact_import_details');
    runtime=createBusinessScopedPool(new Pool({...connection,max:4,options:`-c search_path=${schema},pg_catalog`}));database=drizzle(runtime);
  },30000);
  beforeEach(async()=>{
    await fixture.query(`DELETE FROM crm_contact_import_details WHERE (import_id=1 AND row_number>30007) OR import_id=4;
      DELETE FROM crm_contact_imports WHERE id=4;
      UPDATE crm_contact_imports SET processed_records=30004,success_count=30001,error_count=1,skipped_count=1,import_status='processing',completed_at=NULL WHERE id=1;`);
  });
  afterAll(async()=>{
    await runtime?.end();await fixture?.end();if(admin && /^import_progress_[a-f0-9]{16}$/.test(schema))await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin?.end();
  });
  it('returns exact terminal totals, warning counts and bounded issue history',async()=>{
    expect(await progress()).toMatchObject({totalRecords:30202,processedRecords:30004,successCount:30001,duplicateCount:1,skippedCount:1,errorCount:1,warningCount:1,importStatus:'processing'});
    expect((await progress()).issues.map(issue=>issue.type)).toEqual(['warning','duplicate','skipped','error','error']);
    expect((await fixture.query('SELECT app_business_system() active')).rows[0].active).toBe(false);
  });
  it('reads only the indexed warning/issue subset rather than 30,000 successful receipts',async()=>{
    await progress();const query=new PgDialect().sqlToQuery(lastQuery);
    const result=await scope(()=>runtime.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query.sql,query.params));
    const nodes=receiptNodes(result.rows[0]['QUERY PLAN'][0].Plan);expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every(node=>node['Node Type']!=='Seq Scan')).toBe(true);
    expect(nodes.reduce((sum,node)=>sum+Number(node['Actual Rows'])+Number(node['Rows Removed by Filter']||0),0)).toBeLessThanOrEqual(26);
  });
  it('does not expose another business or owner through the cached counters or issues',async()=>{
    await expect(scope(()=>ledger.readCrmImportProgress(991,2))).rejects.toBeInstanceOf(ledger.CrmImportInterruptedError);
    await expect(scope(()=>ledger.readCrmImportProgress(992,3))).rejects.toBeInstanceOf(ledger.CrmImportInterruptedError);
    const own=await withBusinessScope({userId:991,businessProfileId:2},()=>ledger.readCrmImportProgress(991,2));
    expect(own).toMatchObject({processedRecords:1,successCount:1,warningCount:1});
  });
  it('counts a concurrent row replay once with the receipt and counter in one transaction',async()=>{
    const commit=()=>scope(()=>database.transaction(async tx=>{
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('crm-contact-resolution'),991)`);
      if(!await ledger.importRowCommitted(tx,1,30008))await ledger.saveCrmImportReceipt(tx,{importId:1,rowNumber:30008,status:'success'});
    }));await Promise.all([commit(),commit()]);
    expect(await progress()).toMatchObject({processedRecords:30005,successCount:30002,duplicateCount:1,errorCount:1});
  });
  it('rolls back both the receipt and cached counters on a failed transaction',async()=>{
    const before=await progress();await expect(scope(()=>database.transaction(async tx=>{
      await ledger.saveCrmImportReceipt(tx,{importId:1,rowNumber:30008,status:'warning',errorMessage:'Not committed'});throw new Error('fixture rollback');
    }))).rejects.toThrow('fixture rollback');expect(await progress()).toEqual(before);
  });
  it('replaces a blocked receipt without counting the blocked attempt twice',async()=>{
    await scope(()=>database.transaction(tx=>ledger.saveCrmImportReceipt(tx,{importId:1,rowNumber:30008,status:'blocked',errorMessage:'Held'})));
    expect(await progress()).toMatchObject({processedRecords:30004,successCount:30001,importStatus:'failed'});
    await scope(()=>database.transaction(tx=>ledger.saveCrmImportReceipt(tx,{importId:1,rowNumber:30008,status:'warning',errorMessage:'Resumed'})));
    expect(await progress()).toMatchObject({processedRecords:30005,successCount:30002,warningCount:2,duplicateCount:1,importStatus:'processing'});
  });
  it('marks completion using the same atomic receipt counters',async()=>{
    await fixture.query("INSERT INTO crm_contact_imports(id,user_id,business_profile_id,file_name,total_records) VALUES(4,991,1,'complete.csv',1)");
    await scope(()=>database.transaction(tx=>ledger.saveCrmImportReceipt(tx,{importId:4,rowNumber:2,status:'success'})));
    expect(await scope(()=>ledger.readCrmImportProgress(991,4))).toMatchObject({processedRecords:1,successCount:1,duplicateCount:0,warningCount:0,importStatus:'completed'});
  });
  it('reconciles historical counters from receipts and preserves them through index rollback',async()=>{
    const before=await progress();await fixture.query('UPDATE crm_contact_imports SET processed_records=999,success_count=998,error_count=0,skipped_count=0 WHERE id=1');
    await migration.down(fixture);await migration.up(fixture);expect(await progress()).toEqual(before);
    expect((await fixture.query('SELECT app_business_system() active')).rows[0].active).toBe(false);
  });
});
