import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const migrationRoot=new URL('../migrations/',import.meta.url).href;
const database=process.env.BUSINESS_ISOLATION_TEST_DATABASE;
if (!database?.startsWith('salesmarketing_business_isolation_qa_')) throw new Error('Use a disposable schema-only business isolation QA database.');
const client=new Client({host:'/tmp',database});
await client.connect();
try {
  await client.query('BEGIN');
  for (const name of ['297_unified_outreach_inbox.js','298_pricing_subscriptions.js']) {
    await (await import(migrationRoot+name)).up(client);
  }
  await client.query(`
    INSERT INTO users(id,email,password,name) VALUES(910001,'architect-migration@example.invalid','fixture','Architect fixture');
    INSERT INTO company_settings(id,user_id,name,is_default) VALUES(910011,910001,'Default fixture',true),(910012,910001,'Nondefault fixture',false);
    INSERT INTO chat_threads(id,user_id,business_id,title) VALUES(910021,910001,910012,'Nondefault thread');
    INSERT INTO chat_messages(id,user_id,thread_id,role,content) VALUES(910031,910001,910021,'user','fixture');
    INSERT INTO content_assets(id,user_id,thread_id,type,title,content,channel,status) VALUES(910041,910001,910021,'text','Thread content','fixture','email','draft');
    INSERT INTO content_assets(id,user_id,parent_asset_id,type,title,content,channel,status) VALUES(910042,910001,910041,'text','Child content','fixture','email','draft');
    INSERT INTO support_teams(id,user_id,name) VALUES(910051,910001,'Default support');
    INSERT INTO team_members(id,team_id,user_id,name,email) VALUES(910061,910051,910001,'Fixture member','member-migration@example.invalid');
    INSERT INTO support_chat_sessions(id,member_id,title) VALUES(910021,910061,'Default support session with same id as other business thread');
    INSERT INTO conversation_request_scopes(scope_key,lease_token,lease_expires_at) VALUES
      ('910001:campaign:910021','11111111-1111-4111-8111-111111111111','2030-01-01T00:00:00Z'),
      ('910001:campaign_init:request_init_0001','22222222-2222-4222-8222-222222222222','2030-02-01T00:00:00Z'),
      ('910001:campaign_init:request_init_zero','33333333-3333-4333-8333-333333333333','2030-03-01T00:00:00Z'),
      ('910001:support_advisory:910021',null,null),
      ('910001:support_advisory:-910021',null,null);
    INSERT INTO conversation_requests(id,user_id,scope_key,kind,conversation_id,request_id,input_hash,status,response,error_code) VALUES
      (910071,910001,'910001:campaign:910021','campaign',910021,'request_campaign_completed','completed-hash','completed','{"preserved":"completed"}',null),
      (910072,910001,'910001:campaign_init:request_init_0001','campaign_init',910021,'request_init_0001','uncertain-hash','uncertain','{"preserved":"uncertain"}','lease_expired'),
      (910073,910001,'910001:campaign_init:request_init_zero','campaign_init',0,'request_init_zero','queued-hash','queued',null,null),
      (910074,910001,'910001:support_advisory:910021','support_advisory',910021,'request_support_positive','support-hash','completed','{"preserved":"support"}',null),
      (910075,910001,'910001:support_advisory:-910021','support_advisory',-910021,'request_support_negative','negative-hash','queued',null,null);
  `);
  await client.query('COMMIT');
  console.log('Fixtures created with migrations 297 and 298');
  await client.query('BEGIN');
  await (await import(migrationRoot+'299_business_profile_isolation.js')).up(client);
  await client.query('COMMIT');
  console.log('Migration 299 committed');
  for (const table of ['chat_threads','chat_messages','content_assets']) {
    const rows=(await client.query(`SELECT business_profile_id FROM ${table}`)).rows;
    assert(rows.length>0 && rows.every(row=>row.business_profile_id===910012),`${table} lost non-default ownership`);
  }
  const receipts=(await client.query(`SELECT r.*,s.business_profile_id AS lease_profile,s.lease_token FROM conversation_requests r JOIN conversation_request_scopes s USING(scope_key) ORDER BY r.id`)).rows;
  assert.deepEqual(receipts.map(row=>row.business_profile_id),[910012,910012,910011,910011,910011]);
  for (const row of receipts) {
    assert.equal(row.lease_profile,row.business_profile_id);
    assert(row.scope_key.startsWith(`910001:${row.business_profile_id}:`));
  }
  assert.equal(receipts[0].status,'completed');
  assert.equal(receipts[0].response.preserved,'completed');
  assert.equal(receipts[0].lease_token,'11111111-1111-4111-8111-111111111111');
  assert.equal(receipts[1].status,'uncertain');
  assert.equal(receipts[1].error_code,'lease_expired');
  for (const [name,query] of Object.entries({
    ownership:`SELECT 'chat_threads' AS entity,id,business_profile_id FROM chat_threads UNION ALL SELECT 'chat_messages',id,business_profile_id FROM chat_messages UNION ALL SELECT 'content_assets',id,business_profile_id FROM content_assets ORDER BY entity,id`,
    receipts:`SELECT r.id,r.scope_key,r.kind,r.conversation_id,r.business_profile_id,r.status,r.input_hash,r.response,r.error_code,s.business_profile_id AS lease_profile,s.lease_token,s.lease_expires_at FROM conversation_requests r JOIN conversation_request_scopes s USING(scope_key) ORDER BY r.id`,
    coverage:`SELECT count(*) AS scoped_count, count(*) FILTER(WHERE NOT c.relrowsecurity OR NOT c.relforcerowsecurity) AS unprotected_count FROM business_scope_tables m JOIN pg_class c ON c.oid=('public.'||m.table_name)::regclass`,
    issues:`SELECT * FROM business_scope_migration_issues`,
  })) console.log(name,JSON.stringify((await client.query(query)).rows));
} catch(error) {
  await client.query('ROLLBACK');
  console.error('QA FAILURE',error.code,error.message,error.detail || '');
  process.exitCode=1;
} finally {await client.end();}
