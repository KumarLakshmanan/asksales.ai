import {afterAll,beforeAll,describe,expect,it,jest} from '@jest/globals';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import type {SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {localBusinessFunctions,localBusinessIsolation} from './helpers/localBusinessPostgres.js';

jest.unstable_mockModule('../models/db.js',()=>({db:{}}));
const {getSuppressedRecipients}=await import('../services/outreach/RecipientSuppressionService.js');
// @ts-expect-error Application migration uses the JavaScript migration runner.
const migration=await import('../migrations/584_outreach_suppression_read_indexes.js');
const run=process.env.OUTREACH_QUEUE_LOCAL_QA==='1' ? describe : describe.skip;
let admin:Pool,fixture:Pool,schema:string,lastQuery:{sql:string;params:unknown[]};
const dialect=new PgDialect();

async function scopedQuery(text:string,values:unknown[]=[]) {
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
const executor={execute:async(query:SQL)=>{lastQuery=dialect.sqlToQuery(query);return scopedQuery(lastQuery.sql,lastQuery.params);}};
const suppressed=(channel:string,addresses:string[],userId=991)=>getSuppressedRecipients(userId,channel,addresses,executor as never);
const allNodes=(plan:any):any[]=>[plan,...(plan.Plans||[]).flatMap(allNodes)];

run('large-audience suppression lookups under business RLS',()=>{
  beforeAll(async()=>{
    const url=process.env.OUTREACH_QA_DATABASE_URL;
    if(!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || new URL(url).pathname!='/implementation_synthetic')throw new Error('Explicit isolated loopback fixture required');
    schema=`suppression_read_${randomBytes(8).toString('hex')}`;
    const connection={connectionString:url,connectionTimeoutMillis:5000};
    admin=new Pool({...connection,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    fixture=new Pool({...connection,max:1,options:`-c search_path=${schema},pg_catalog`});
    await localBusinessFunctions(fixture);
    await fixture.query(`CREATE TABLE company_settings(id int PRIMARY KEY,user_id int);
      INSERT INTO company_settings VALUES(1,991),(2,991),(3,992);
      CREATE TABLE leads(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id int,business_profile_id int,
        phone text,whatsapp text,email text,blacklisted boolean,do_not_contact boolean,email_unsubscribed boolean,deleted_at timestamp);
      CREATE TABLE sent_messages(user_id int,business_profile_id int,channel text,recipient_address text,lead_name text,
        bounced_at timestamp,status text,delivery_status text);
      INSERT INTO leads(user_id,business_profile_id,phone,email)
        SELECT 991,1,'+91'||(9000000000+number)::text,'guest'||number||'@example.test' FROM generate_series(1,30202) number;
      INSERT INTO leads(user_id,business_profile_id,phone,email,blacklisted,do_not_contact,email_unsubscribed,deleted_at) VALUES
        (991,1,'+91 (90000) 00001',' GUEST1@EXAMPLE.TEST ',true,false,false,now()),
        (991,1,'9000000002','guest2@example.test',false,true,false,NULL),
        (991,1,'+919000000003','guest3@example.test',false,false,true,NULL),
        (991,2,'+919000000004','guest4@example.test',true,false,false,NULL),
        (992,3,'+919000000005','guest5@example.test',true,false,false,NULL);
      INSERT INTO sent_messages VALUES(991,1,'email',' BOUNCED@EXAMPLE.TEST ',NULL,now(),'bounced','bounced'),
        (991,2,'email','foreign@example.test',NULL,now(),'bounced','bounced');`);
    await migration.up(fixture);
    await localBusinessIsolation(fixture,schema,['leads','sent_messages']);
    await fixture.query('ANALYZE leads;ANALYZE sent_messages');
  },30000);
  afterAll(async()=>{
    await fixture?.end();
    if(admin && /^suppression_read_[a-f0-9]{16}$/.test(schema))await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  it('retains destination-wide opt-outs, including retired leads, without expanding SMS normalization to WhatsApp',async()=>{
    const phones=['919000000001','919000000002','919000000003','919000000004','919000000005','9000000002'];
    expect(await suppressed('whatsapp',phones)).toEqual(new Set(['919000000001','9000000002']));
    expect(await suppressed('sms',phones)).toEqual(new Set(['919000000001','919000000002']));
    expect(await suppressed('whatsapp',phones,992)).toEqual(new Set());
  });
  it('preserves email-only opt-outs and failed-delivery suppression within the active business',async()=>{
    expect(await suppressed('email',['guest1@example.test','GUEST2@example.test','guest3@example.test','guest4@example.test','guest5@example.test','bounced@example.test','foreign@example.test']))
      .toEqual(new Set(['guest1@example.test','guest2@example.test','guest3@example.test','bounced@example.test']));
  });
  it.each(['whatsapp','email'])('indexes and materializes the small suppressed subset once for a 200-recipient %s chunk',async channel=>{
    const addresses=Array.from({length:200},(_,i)=>channel==='email' ? `guest${i+1}@example.test` : `91${9000000001+i}`);
    await suppressed(channel,addresses);
    const result=await scopedQuery('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+lastQuery.sql,lastQuery.params);
    const nodes=allNodes(result.rows[0]['QUERY PLAN'][0].Plan);
    const index=channel==='email' ? 'lead_outreach_email_suppression_idx' : 'lead_outreach_phone_suppression_idx';
    expect(nodes.some(node=>node['Index Name']===index || channel==='whatsapp' && node['Index Name']==='lead_outreach_email_suppression_idx')).toBe(true);
    expect(nodes.filter(node=>node['Relation Name']==='leads').some(node=>node['Node Type']==='Seq Scan')).toBe(false);
    const materialized=nodes.find(node=>node['Subplan Name']==='CTE suppressed_leads');
    expect(materialized).toBeDefined();expect(materialized['Actual Loops']).toBe(1);
    // WhatsApp projects phone and WhatsApp aliases for each of the two blocked
    // leads, including empty aliases. Email also includes the email-only opt-out.
    expect(materialized['Actual Rows']).toBeLessThanOrEqual(channel==='whatsapp' ? 4 : 3);
  });
  it('can roll back and reapply the read indexes without altering preferences',async()=>{
    const before=(await fixture.query('SELECT count(*)::int count FROM leads WHERE blacklisted OR do_not_contact OR email_unsubscribed')).rows;
    await migration.down(fixture);await migration.up(fixture);
    expect((await fixture.query('SELECT count(*)::int count FROM leads WHERE blacklisted OR do_not_contact OR email_unsubscribed')).rows).toEqual(before);
    expect(await suppressed('whatsapp',['919000000001'])).toEqual(new Set(['919000000001']));
  });
});
