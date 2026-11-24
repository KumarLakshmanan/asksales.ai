import {afterAll,beforeAll,describe,expect,it} from '@jest/globals';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {localBusinessFunctions,localBusinessIsolation} from './helpers/localBusinessPostgres.js';
import {contactImportPhoneMatch} from '../utils/contactImportPhoneMatch.js';
import {contactPhoneCandidateIds} from '../utils/contactPhoneCandidates.js';
// @ts-expect-error Application migration uses the JavaScript migration runner.
const migration=await import('../migrations/581_contact_import_phone_lookup_indexes.js');
const run=process.env.OUTREACH_QUEUE_LOCAL_QA==='1' ? describe : describe.skip;
let admin:Pool,fixture:Pool,schema:string;

async function queryAsBusiness(text:string,values:unknown[]=[]) {
  const client=await fixture.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE salesmarketing_business_runtime');
    await client.query("SELECT set_config('app.current_user_id','991',true),set_config('app.business_profile_id','1',true)");
    const result=await client.query(text,values);
    await client.query('COMMIT');return result;
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
const match="user_id=$1 AND business_profile_id=$2 AND deleted_at IS NULL AND phone_lookup_digits=ANY($3::text[])";
const findIndex=(plan:any,name:string):any=>plan['Index Name']===name ? plan : (plan.Plans||[]).map((child:any)=>findIndex(child,name)).find(Boolean);
const contactFullScan=(plan:any):boolean=>(plan['Node Type']==='Seq Scan' && plan['Relation Name']==='crm_contacts') || (plan.Plans||[]).some(contactFullScan);

run('normalized contact import phone lookup indexes under business RLS',()=>{
  beforeAll(async()=>{
    const url=process.env.OUTREACH_QA_DATABASE_URL;
    if(!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || new URL(url).pathname!='/implementation_synthetic')throw new Error('Explicit isolated loopback fixture required');
    schema=`import_phone_${randomBytes(8).toString('hex')}`;
    const connection={connectionString:url,connectionTimeoutMillis:5000};
    admin=new Pool({...connection,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    fixture=new Pool({...connection,max:1,options:`-c search_path=${schema},pg_catalog`});
    await localBusinessFunctions(fixture);
    await fixture.query(`CREATE TABLE company_settings(id int PRIMARY KEY,user_id int);
      INSERT INTO company_settings VALUES(1,991),(2,991),(3,992);
      CREATE TABLE crm_contacts(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id int,business_profile_id int,phone text,deleted_at timestamp);
      CREATE TABLE leads(LIKE crm_contacts INCLUDING ALL);
      CREATE TABLE crm_contact_channel_identities(user_id int,business_profile_id int,contact_id int,identifier_type text,identifier_fingerprint text,verification_level text);
      CREATE INDEX identity_lookup_idx ON crm_contact_channel_identities(user_id,identifier_type,identifier_fingerprint);
      INSERT INTO crm_contacts(user_id,business_profile_id,phone)
        SELECT 991,1,'+91'||(9000000000+number)::text FROM generate_series(1,30000) number;
      INSERT INTO crm_contacts(user_id,business_profile_id,phone,deleted_at) VALUES
        (991,1,'9000000001',NULL),(991,2,'+919000000001',NULL),(992,3,'+919000000001',NULL),
        (991,1,'+919000000001',now());
      INSERT INTO leads(user_id,business_profile_id,phone,deleted_at) SELECT user_id,business_profile_id,phone,deleted_at FROM crm_contacts;
      INSERT INTO crm_contact_channel_identities VALUES(991,1,30,'phone','verified-match','provider'),
        (991,1,30,'phone','verified-match','owner_verified'),(991,1,40,'phone','verified-match','unverified'),
        (991,2,30002,'phone','verified-match','provider'),(992,3,30003,'phone','verified-match','provider');`);
    await migration.up(fixture);
    await localBusinessIsolation(fixture,schema,['crm_contacts','leads','crm_contact_channel_identities']);
    await fixture.query('ANALYZE crm_contacts;ANALYZE leads');
  },30000);
  afterAll(async()=>{
    await fixture?.end();
    if(admin && /^import_phone_[a-f0-9]{16}$/.test(schema))await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  for(const [table,index] of [['crm_contacts','contact_import_phone_lookup_idx'],['leads','lead_import_phone_lookup_idx']]) {
    it(`uses the normalized ${table} index for a business-scoped phone lookup`,async()=>{
      const query=new PgDialect().sqlToQuery(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM ${sql.identifier(table)}
        WHERE user_id=${991} AND business_profile_id=${1} AND deleted_at IS NULL
          AND ${contactImportPhoneMatch(sql.identifier(table),'919000000020','IN')} LIMIT 2`);
      const result=await queryAsBusiness(query.sql,query.params);
      const plan=result.rows[0]['QUERY PLAN'][0].Plan;
      const indexed=findIndex(plan,index);
      expect(indexed).toBeDefined();
      expect(indexed['Index Cond']).toContain('phone_lookup_digits');
    });
    it(`preserves active ambiguity detection and business isolation in ${table}`,async()=>{
      const active=await queryAsBusiness(`SELECT id,phone FROM ${table} WHERE ${match} LIMIT 2`,[991,1,['919000000001','9000000001','09000000001','00919000000001']]);
      expect(active.rows).toHaveLength(2);
      expect((await queryAsBusiness(`SELECT id FROM ${table} WHERE ${match}`,[991,2,['919000000001']])).rows).toEqual([]);
      expect((await queryAsBusiness(`SELECT id FROM ${table} WHERE ${match}`,[992,3,['919000000001']])).rows).toEqual([]);
    });
  }
  it('indexes both canonical identity routes without a full contact scan or cross-business matches',async()=>{
    const query=new PgDialect().sqlToQuery(sql`SELECT candidate.id FROM crm_contacts candidate
      WHERE candidate.user_id=${991} AND candidate.deleted_at IS NULL
        AND candidate.business_profile_id IS NOT DISTINCT FROM ${1}::integer
        AND candidate.id IN (${contactPhoneCandidateIds(991,1,'919000000020','verified-match')})
        AND (candidate.phone_lookup_digits=${'919000000020'} OR EXISTS(SELECT 1 FROM crm_contact_channel_identities identity
          WHERE identity.contact_id=candidate.id AND identity.user_id=${991}
            AND identity.business_profile_id IS NOT DISTINCT FROM candidate.business_profile_id
            AND identity.identifier_type='phone' AND identity.identifier_fingerprint=${'verified-match'}
            AND identity.verification_level IN('provider','customer_verified','owner_verified')))
      ORDER BY candidate.id FOR UPDATE OF candidate`);
    expect((await queryAsBusiness(query.sql,query.params)).rows.map(row=>row.id)).toEqual([20,30]);
    const result=await queryAsBusiness('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query.sql,query.params);
    const plan=result.rows[0]['QUERY PLAN'][0].Plan;
    expect(findIndex(plan,'contact_import_phone_lookup_idx')).toBeDefined();
    expect(contactFullScan(plan)).toBe(false);
  });
  it('updates lookup keys with phone edits and safely retains invalid free-form values',async()=>{
    await fixture.query("UPDATE crm_contacts SET phone='+９１ (９００００) ０００９９' WHERE id=20");
    expect((await queryAsBusiness(`SELECT id FROM crm_contacts WHERE ${match} ORDER BY id`,[991,1,['919000000099']])).rows.map(row=>row.id)).toEqual([20,99]);
    const raw='9'.repeat(10000);
    const invalid=await fixture.query('INSERT INTO leads(user_id,business_profile_id,phone) VALUES(991,1,$1) RETURNING phone,phone_lookup_digits',[raw]);
    expect(invalid.rows).toEqual([{phone:raw,phone_lookup_digits:null}]);
  });
  it('rolls back and reapplies only the generated keys and indexes',async()=>{
    const before=await fixture.query('SELECT id,phone FROM crm_contacts ORDER BY id');
    await migration.down(fixture);
    expect((await fixture.query('SELECT id,phone FROM crm_contacts ORDER BY id')).rows).toEqual(before.rows);
    await migration.up(fixture);
    expect((await queryAsBusiness(`SELECT id FROM crm_contacts WHERE ${match} ORDER BY id`,[991,1,['919000000099']])).rows.map(row=>row.id)).toEqual([20,99]);
  });
});
