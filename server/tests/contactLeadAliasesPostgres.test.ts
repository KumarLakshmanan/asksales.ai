import {afterAll,beforeAll,describe,expect,it} from '@jest/globals';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {localBusinessFunctions,localBusinessIsolation} from './helpers/localBusinessPostgres.js';
import {contactLeadAliasIds} from '../utils/contactLeadAliases.js';
// @ts-expect-error Application migration uses the JavaScript runner.
const migration=await import('../migrations/582_crm_contact_lead_alias_indexes.js');
const run=process.env.OUTREACH_QUEUE_LOCAL_QA==='1' ? describe : describe.skip;
let admin:Pool,fixture:Pool,schema:string;
async function queryAsBusiness(text:string,values:unknown[]=[]) {
  const client=await fixture.connect();
  try {
    await client.query('BEGIN');await client.query('SET LOCAL ROLE salesmarketing_business_runtime');
    await client.query("SELECT set_config('app.current_user_id','991',true),set_config('app.business_profile_id','1',true)");
    const result=await client.query(text,values);await client.query('COMMIT');return result;
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
function aliasQuery(contactId=20,leadId:number|null=20) {
  return new PgDialect().sqlToQuery(sql`SELECT DISTINCT lead.id FROM leads lead
    WHERE lead.user_id=${991} AND lead.business_profile_id=${1} AND lead.deleted_at IS NULL
      AND lead.id IN (${contactLeadAliasIds(991,1,contactId,leadId)}) ORDER BY lead.id`);
}
const fullContactScan=(plan:any):boolean=>(plan['Node Type']==='Seq Scan' && ['leads','crm_contacts','outreach_conversations'].includes(plan['Relation Name'])) || (plan.Plans||[]).some(fullContactScan);
run('CRM status lead aliases use bounded lookups under business RLS',()=>{
  beforeAll(async()=>{
    const url=process.env.OUTREACH_QA_DATABASE_URL;
    if(!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || new URL(url).pathname!='/implementation_synthetic')throw new Error('Explicit isolated loopback fixture required');
    schema=`contact_alias_${randomBytes(8).toString('hex')}`;
    const connection={connectionString:url,connectionTimeoutMillis:5000};admin=new Pool({...connection,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);fixture=new Pool({...connection,max:1,options:`-c search_path=${schema},pg_catalog`});
    await localBusinessFunctions(fixture);
    await fixture.query(`CREATE TABLE company_settings(id int PRIMARY KEY,user_id int);INSERT INTO company_settings VALUES(1,991),(2,991),(3,992);
      CREATE TABLE leads(id int PRIMARY KEY,user_id int,business_profile_id int,deleted_at timestamp);
      CREATE TABLE crm_contacts(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id int,business_profile_id int,lead_id int,merged_into_contact_id int,deleted_at timestamp);
      CREATE TABLE outreach_conversations(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id int,business_profile_id int,lead_id int,crm_contact_id int);
      INSERT INTO leads SELECT number,991,1,NULL FROM generate_series(1,30000) number;
      UPDATE leads SET deleted_at=now() WHERE id=27;
      INSERT INTO crm_contacts(user_id,business_profile_id,lead_id) SELECT 991,1,number FROM generate_series(1,30000) number;
      INSERT INTO outreach_conversations(user_id,business_profile_id,lead_id,crm_contact_id) SELECT 991,1,number,number FROM generate_series(1,30000) number;
      INSERT INTO crm_contacts(user_id,business_profile_id,lead_id,merged_into_contact_id,deleted_at) VALUES
        (991,1,22,20,now()),(991,1,24,20,NULL),(991,2,25,20,now()),(992,3,26,20,now());
      INSERT INTO outreach_conversations(user_id,business_profile_id,lead_id,crm_contact_id) VALUES
        (991,1,21,20),(991,1,21,20),(991,2,23,20),(992,3,26,20),(991,1,27,20);`);
    await migration.up(fixture);await localBusinessIsolation(fixture,schema,['leads','crm_contacts','outreach_conversations']);
    await fixture.query('ANALYZE leads;ANALYZE crm_contacts;ANALYZE outreach_conversations');
  },30000);
  afterAll(async()=>{
    await fixture?.end();if(admin && /^contact_alias_[a-f0-9]{16}$/.test(schema))await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin?.end();
  });
  it('includes the direct lead, conversation aliases and retired aliases once, within the selected business',async()=>{
    const query=aliasQuery();expect((await queryAsBusiness(query.sql,query.params)).rows.map(row=>row.id)).toEqual([20,21,22,24]);
    const legacy=await queryAsBusiness(`SELECT DISTINCT lead.id FROM leads lead WHERE lead.user_id=991 AND lead.business_profile_id=1 AND lead.deleted_at IS NULL
      AND (lead.id=20 OR EXISTS(SELECT 1 FROM outreach_conversations conversation WHERE conversation.user_id=991
        AND conversation.business_profile_id=1 AND conversation.lead_id=lead.id AND conversation.crm_contact_id=20)
      OR EXISTS(SELECT 1 FROM crm_contacts retired WHERE retired.user_id=991 AND retired.business_profile_id=1
        AND retired.lead_id=lead.id AND retired.merged_into_contact_id=20)) ORDER BY lead.id`);
    expect((await queryAsBusiness(query.sql,query.params)).rows).toEqual(legacy.rows);
  });
  it('avoids scanning the full lead, contact and conversation tables',async()=>{
    const query=aliasQuery(),result=await queryAsBusiness('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query.sql,query.params);
    expect(fullContactScan(result.rows[0]['QUERY PLAN'][0].Plan)).toBe(false);
  });
  it('supports a CRM-only contact with no direct lead and excludes unavailable leads',async()=>{
    const aliases=aliasQuery(20,null);expect((await queryAsBusiness(aliases.sql,aliases.params)).rows.map(row=>row.id)).toEqual([20,21,22,24]);
    const none=aliasQuery(999999,null);expect((await queryAsBusiness(none.sql,none.params)).rows).toEqual([]);
  });
  it('rolls back and reapplies the indexes without changing contact links',async()=>{
    const before=await fixture.query('SELECT count(*)::int count FROM crm_contacts');await migration.down(fixture);await migration.up(fixture);
    expect((await fixture.query('SELECT count(*)::int count FROM crm_contacts')).rows).toEqual(before.rows);
    const query=aliasQuery();expect((await queryAsBusiness(query.sql,query.params)).rows.map(row=>row.id)).toEqual([20,21,22,24]);
  });
});
