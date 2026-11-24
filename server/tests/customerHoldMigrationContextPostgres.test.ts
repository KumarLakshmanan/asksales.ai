import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

const url = process.env.ASSISTANT_MIGRATION_QA_DATABASE_URL;
const suite = url ? describe : describe.skip;
const schema = `customer_hold_${randomBytes(8).toString('hex')}`;
let client: Client;
let createdRole = false;
// @ts-expect-error The production migration runner imports plain JavaScript migrations.
const assistantHold = await import('../migrations/571_hold_unreviewed_customer_delivery.js');
// @ts-expect-error The production migration runner imports plain JavaScript migrations.
const manualHold = await import('../migrations/572_campaign_manual_follow_ups.js');

suite('historical holds with the actual business ownership trigger', () => {
  beforeAll(async () => {
    if (url !== 'postgresql://postgres@127.0.0.1:55446/assistant_gate_qa') throw new Error('Only the recovery-owned synthetic database is allowed.');
    client = new Client({ connectionString: url }); await client.connect();
    if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime'")).rowCount) {
      await client.query('CREATE ROLE salesmarketing_business_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS'); createdRole = true;
    }
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog;
      CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
      CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$;
      CREATE FUNCTION app_business_access(integer) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_business_system() OR $1=app_business_profile_id() $$;
      CREATE TABLE users(id integer PRIMARY KEY); INSERT INTO users VALUES(9),(10);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer); INSERT INTO company_settings VALUES(7,9),(8,10);
      CREATE TABLE chat_threads(id integer PRIMARY KEY,user_id integer,business_profile_id integer);
      INSERT INTO chat_threads VALUES(11,9,7),(12,10,8);
      CREATE TABLE outreach_campaigns(id integer PRIMARY KEY,user_id integer,business_profile_id integer);
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read boolean,parent_links jsonb);
      CREATE TABLE schema_migrations(name text PRIMARY KEY);
      CREATE TABLE outreach_jobs(id int,user_id int,business_profile_id int,status text,is_dead_letter boolean,error text,metadata jsonb,updated_at timestamptz,external_message_id text);
      CREATE TABLE outreach_messages(id int,user_id int,business_profile_id int,direction text,message_kind text,status text,error_message text,metadata jsonb,updated_at timestamptz,provider_call_state text,manual_review_required boolean,provider_message_id text,external_message_id text);
      CREATE TABLE support_delivery_outbox(id int,user_id int,business_profile_id int,status text,next_attempt_at timestamptz,lease_expires_at timestamptz,last_error text,updated_at timestamptz,attempt_count int,provider_message_id text,payload jsonb);
      CREATE TABLE social_follow_up_schedules(id int,user_id int,business_profile_id int,status text,steps jsonb,cancellation_reason text,cancelled_at timestamptz,version int,updated_at timestamptz);
      INSERT INTO outreach_jobs VALUES(1,9,7,'pending',false,NULL,'{}',now(),NULL),(2,10,8,'pending',false,NULL,'{}',now(),NULL);
      INSERT INTO outreach_messages(id,user_id,business_profile_id,direction,message_kind,status,metadata,provider_call_state,manual_review_required) VALUES
        (1,9,7,'outbound','outreach','queued','{}','not_started',false),(2,10,8,'outbound','outreach','queued','{}','not_started',false);
      INSERT INTO support_delivery_outbox(id,user_id,business_profile_id,status,attempt_count,payload) VALUES(1,9,7,'pending',0,'{}'),(2,10,8,'pending',0,'{}');
      INSERT INTO social_follow_up_schedules VALUES(1,9,7,'active','[{"templateId":1}]',NULL,NULL,1,now()),(2,10,8,'active','[{"templateId":2}]',NULL,NULL,1,now());`);
    await client.query(`ALTER TABLE outreach_jobs ADD COLUMN parent_id integer;
      UPDATE outreach_jobs SET parent_id=CASE id WHEN 1 THEN 11 ELSE 12 END;
      INSERT INTO outreach_jobs(id,user_id,business_profile_id,status,metadata,external_message_id,parent_id) VALUES
        (3,9,7,'sent','{}','confirmed',11),(4,9,7,'pending','{"providerCallStarted":true}',NULL,11),
        (5,10,8,'pending','{"deliveryReview":{"assistant":{"bindingId":4}}}',NULL,12),(6,10,8,'pending','{}','confirmed',12);
      INSERT INTO outreach_messages(id,user_id,business_profile_id,direction,message_kind,status,metadata,provider_call_state,manual_review_required,provider_message_id) VALUES
        (3,9,7,'outbound','outreach','sent','{}','confirmed',false,'confirmed'),
        (4,9,7,'outbound','outreach','sending','{}','started',false,NULL),
        (5,10,8,'outbound','outreach','manual_review','{}','unknown',true,NULL),
        (6,10,8,'outbound','outreach','scheduled','{}','not_started',false,'confirmed'),
        (7,10,8,'inbound','reply','pending','{}','not_started',false,NULL);
      INSERT INTO support_delivery_outbox(id,user_id,business_profile_id,status,attempt_count,provider_message_id,payload) VALUES
        (3,9,7,'uncertain',1,NULL,'{}'),(4,10,8,'sent',1,'confirmed','{}'),
        (5,10,8,'drafted',0,NULL,'{"metadata":{"assistant":{"bindingId":4}}}');`);
    const source = readFileSync(new URL('../migrations/299_business_profile_isolation.js', import.meta.url), 'utf8');
    const start = source.indexOf('CREATE OR REPLACE FUNCTION enforce_business_ownership()');
    const end = source.indexOf('END $$', start) + 'END $$'.length;
    await client.query(source.slice(start, end));
    for (const table of ['outreach_jobs','outreach_messages','support_delivery_outbox','social_follow_up_schedules']) {
      const spec = JSON.stringify({ owner_column: 'user_id', global_read: false,
        parent_links: table==='outreach_jobs' ? [{parent:'chat_threads',child_columns:['parent_id'],parent_columns:['id']}] : [], legacy_business_column: null });
      await client.query(`CREATE TRIGGER ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}');
        CREATE CONSTRAINT TRIGGER ownership_after AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}');
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY business_isolation ON ${table} USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));`);
    }
  });
  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK'); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (createdRole) await client.query('DROP ROLE salesmarketing_business_runtime');
    await client.end();
  });
  it('rolls back hold writes and tracking after an error without leaking system context', async () => {
    await client.query('BEGIN');
    await expect(assistantHold.up({query:(sql:string,values?:unknown[])=>client.query(
      sql.includes('UPDATE outreach_jobs SET') ? `${sql}\nSELECT 1/0` : sql,values)})).rejects.toMatchObject({code:'22012'});
    await client.query('ROLLBACK');
    expect((await client.query('SELECT status FROM outreach_jobs WHERE id IN (1,2) ORDER BY id')).rows.map(row=>row.status)).toEqual(['pending','pending']);
    expect((await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(0);
    expect((await client.query('SELECT app_business_system() AS enabled')).rows[0].enabled).toBe(false);
  });
  it('requires the trusted context and keeps 571 holds scoped to the migration transaction', async () => {
    await expect(client.query("UPDATE outreach_jobs SET status='setup_required'")).rejects.toMatchObject({ code: '42501' });
    const protectedJobs=(await client.query('SELECT * FROM outreach_jobs WHERE id>2 ORDER BY id')).rows;
    const protectedMessages=(await client.query('SELECT * FROM outreach_messages WHERE id>2 ORDER BY id')).rows;
    const protectedOutbox=(await client.query('SELECT * FROM support_delivery_outbox WHERE id>2 ORDER BY id')).rows;
    await client.query('BEGIN'); await assistantHold.up(client);
    expect((await client.query('SELECT status FROM outreach_jobs WHERE id IN(1,2) ORDER BY id')).rows.map(row=>row.status)).toEqual(['setup_required','setup_required']);
    expect((await client.query('SELECT status FROM support_delivery_outbox WHERE id IN(1,2) ORDER BY id')).rows.map(row=>row.status)).toEqual(['setup_required','setup_required']);
    expect((await client.query('SELECT app_business_system() AS enabled')).rows[0].enabled).toBe(false);
    await client.query("INSERT INTO schema_migrations VALUES('571')");
    await client.query('COMMIT');
    expect((await client.query('SELECT * FROM outreach_jobs WHERE id>2 ORDER BY id')).rows).toEqual(protectedJobs);
    expect((await client.query('SELECT * FROM outreach_messages WHERE id>2 ORDER BY id')).rows).toEqual(protectedMessages);
    expect((await client.query('SELECT * FROM support_delivery_outbox WHERE id>2 ORDER BY id')).rows).toEqual(protectedOutbox);
    expect((await client.query('SELECT app_business_system() AS enabled')).rows[0].enabled).toBe(false);
    await expect(client.query("UPDATE outreach_jobs SET error='still guarded'")).rejects.toMatchObject({ code: '42501' });
  });
  it('retains a pre-existing local system context only until caller rollback', async () => {
    await client.query("BEGIN; SELECT set_config('app.business_system','on',true)");
    await assistantHold.up(client);
    expect((await client.query('SELECT app_business_system() AS enabled')).rows[0].enabled).toBe(true);
    await client.query('ROLLBACK');
    expect((await client.query('SELECT app_business_system() AS enabled')).rows[0].enabled).toBe(false);
  });
  it('rolls back the tracking insert with writes when completion fails', async () => {
    await client.query('BEGIN'); await assistantHold.up(client);
    await client.query("INSERT INTO schema_migrations VALUES('completion-fault')");
    await expect(client.query('SELECT 1/0')).rejects.toMatchObject({code:'22012'});
    await client.query('ROLLBACK');
    expect((await client.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='completion-fault'")).rows[0].n).toBe(0);
    expect((await client.query('SELECT app_business_system() AS enabled')).rows[0].enabled).toBe(false);
  });
  it('still rejects a cross-business parent under trusted system context', async () => {
    await client.query("BEGIN; SELECT set_config('app.business_system','on',true)");
    await expect(client.query('UPDATE outreach_jobs SET parent_id=12 WHERE id=1')).rejects.toMatchObject({code:'23514'});
    await client.query('ROLLBACK');
    expect((await client.query('SELECT user_id,business_profile_id,parent_id FROM outreach_jobs WHERE id=1')).rows[0]).toEqual({user_id:9,business_profile_id:7,parent_id:11});
    expect((await client.query('SELECT app_business_system() AS enabled')).rows[0].enabled).toBe(false);
  });
  it('runs the full 572 migration with existing guards and clears privilege at commit', async () => {
    await client.query(`BEGIN; SELECT set_config('app.business_system','on',true);
      UPDATE outreach_messages SET message_kind='follow_up',status='pending',metadata='{"configuredFollowUpDispatch":{"payload":{"followUpProvenance":{"templateId":1}}}}' WHERE id IN(1,2); COMMIT`);
    await client.query('BEGIN'); await manualHold.up(client); await client.query('COMMIT');
    expect((await client.query('SELECT status,manual_review_required FROM outreach_messages WHERE id IN(1,2) ORDER BY id')).rows).toEqual([
      {status:'manual_review',manual_review_required:true},{status:'manual_review',manual_review_required:true}]);
    expect((await client.query('SELECT status FROM social_follow_up_schedules ORDER BY id')).rows.map(row=>row.status)).toEqual(['cancelled','cancelled']);
    expect((await client.query('SELECT app_business_system() AS enabled')).rows[0].enabled).toBe(false);
    await expect(client.query("UPDATE social_follow_up_schedules SET status='active'")).rejects.toMatchObject({code:'42501'});
  });
});
