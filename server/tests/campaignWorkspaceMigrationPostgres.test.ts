import { beforeAll, beforeEach, afterAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
// @ts-expect-error JavaScript migration is executed by the custom runner.
const migration = await import('../migrations/317_campaign_workspace_links.js');
const local = process.env.CAMPAIGN_WORKSPACE_LOCAL_QA === '1' ? describe : describe.skip;
local('campaign association migration in disposable local schema', () => {
  let admin: Pool, fixture: Pool, schema: string;
  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true, quiet: true });
    if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('Only local PostgreSQL is allowed.');
    const connection = { host:process.env.DB_HOST, port:Number(process.env.DB_PORT || 5432), database:process.env.DB_NAME || process.env.DB_DATABASE, user:process.env.DB_USER, password:process.env.DB_PASSWORD || '', max:1, connectionTimeoutMillis:5000 };
    schema=`campaign_workspace_${randomBytes(8).toString('hex')}`;
    admin=new Pool({...connection,options:'-c search_path=pg_catalog'});
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture=new Pool({...connection,options:`-c search_path=${schema},pg_catalog`});
    await fixture.query(`CREATE TABLE users(id integer PRIMARY KEY);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer);
      CREATE TABLE crm_contacts(id integer PRIMARY KEY,user_id integer,business_profile_id integer,deleted_at timestamp);
      CREATE TABLE chat_threads(id integer PRIMARY KEY,user_id integer,business_profile_id integer,deleted_at timestamp);
      CREATE TABLE support_tickets(id serial PRIMARY KEY,user_id integer,business_profile_id integer,deleted_at timestamp);
      CREATE TABLE business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read boolean,parent_links jsonb,legacy_business_column text);
      INSERT INTO business_scope_tables VALUES('support_tickets','user_id',false,'[]',null);
      CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE SQL AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE SQL AS $$ SELECT NULLIF(current_setting('app.business_user_id',true),'')::integer $$;
      CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE SQL AS $$ SELECT false $$;
      CREATE FUNCTION app_business_access(profile integer) RETURNS boolean LANGUAGE SQL AS $$ SELECT profile=app_business_profile_id() $$;
      INSERT INTO users VALUES(9),(10); INSERT INTO company_settings VALUES(101,9),(102,9),(201,10);
      INSERT INTO crm_contacts VALUES(8,9,101,NULL),(18,9,102,NULL),(28,10,201,NULL);
      INSERT INTO chat_threads VALUES(12,9,101,NULL),(22,9,102,NULL),(32,10,201,NULL);
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime;`);
    // Exercise the real production parent-ownership trigger, not a permissive test replacement.
    const source=readFileSync(resolve(process.cwd(),'migrations/299_business_profile_isolation.js'),'utf8');
    const guard=source.match(/CREATE OR REPLACE FUNCTION enforce_business_ownership\(\)[\s\S]*?END \$\$/)?.[0];
    if (!guard) throw new Error('Production ownership guard was not found.');
    await fixture.query(guard);
    await migration.up(fixture);
    await fixture.query("SELECT set_config('app.business_profile_id','101',false),set_config('app.business_user_id','9',false)");
  },30000);
  beforeEach(async () => {
    await fixture.query("SELECT set_config('app.business_profile_id','101',false),set_config('app.business_user_id','9',false)");
  });
  afterAll(async () => {
    await fixture?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });
  it('persists manual contacts in the campaign scope and deduplicates memberships', async () => {
    await fixture.query('INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id) VALUES(9,101,8,12) ON CONFLICT(contact_id,thread_id) DO NOTHING');
    await fixture.query('INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id) VALUES(9,101,8,12) ON CONFLICT(contact_id,thread_id) DO NOTHING');
    const result=await fixture.query('SELECT contact_id FROM campaign_crm_contacts WHERE user_id=9 AND thread_id=12');
    expect(result.rows).toEqual([{contact_id:8}]);
  });
  it('rejects another profile or account even for raw SQL foreign-key writes', async () => {
    await expect(fixture.query('INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id) VALUES(9,101,18,12)')).rejects.toMatchObject({code:'23514'});
    await expect(fixture.query('INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id) VALUES(9,101,8,32)')).rejects.toMatchObject({code:'23514'});
    await expect(fixture.query('INSERT INTO support_tickets(user_id,business_profile_id,chat_thread_id) VALUES(9,101,22)')).rejects.toMatchObject({code:'23514'});
  });
  it('links support tickets to a real campaign reference and rolls back cleanly', async () => {
    await fixture.query('INSERT INTO support_tickets(user_id,business_profile_id,chat_thread_id) VALUES(9,101,12)');
    expect((await fixture.query('SELECT chat_thread_id FROM support_tickets')).rows).toEqual([{chat_thread_id:12}]);
    await migration.down(fixture);
    expect((await fixture.query("SELECT to_regclass('campaign_crm_contacts') AS relation")).rows[0].relation).toBeNull();
    expect((await fixture.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='support_tickets' AND column_name='chat_thread_id'",[schema])).rows).toHaveLength(0);
    await migration.up(fixture);
  });
});
