import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';
import crypto from 'node:crypto';
import { normalizeCapacityError } from '../services/billing/entitlements.js';

// A disposable DATABASE is required because migration helpers pin public in
// their search_path. Never point this suite at a shared/project database.
const suite = process.env.CAPACITY_LOCAL_QA === '1' ? describe : describe.skip;
const resourceTables = ['crm_contacts','storage_files','ai_agent_configs','team_members','support_teams',
  'outreach_assistants','instagram_automation_rules','crm_pipeline_automations','workflows','knowledge_base','knowledge_documents','channel_credentials','meta_page_connections','email_senders','api_credentials'];

suite('organization capacity with isolated PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let name: string;
  const limits = { businessProfiles: 3, workspaces: 2, contacts: 2, storageBytes: 100,
    channelAccounts: 2, aiAssistants: 2, members: 2, supportAgents: 2, supportTeams: 2, automations: 2, knowledgeSources: 2 };

  beforeAll(async () => {
    const host = process.env.CAPACITY_QA_HOST || '/tmp';
    if (!['/tmp','localhost','127.0.0.1','::1'].includes(host)) throw new Error('Capacity QA requires local PostgreSQL');
    const config = { host, user: process.env.CAPACITY_QA_USER || process.env.USER, port: Number(process.env.CAPACITY_QA_PORT || 5432) };
    admin = new Pool({ ...config, database: 'postgres', max: 1 });
    name = `asksales_capacity_qa_${crypto.randomBytes(7).toString('hex')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    pool = new Pool({ ...config, database: name, max: 8 });
    await pool.query(`
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime') THEN
        CREATE ROLE salesmarketing_business_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
      CREATE TABLE users(id integer PRIMARY KEY);
      CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer NOT NULL);
      CREATE TABLE billing_organization_memberships(id integer PRIMARY KEY,organization_id integer,user_id integer,email text,role text,status text);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,billing_organization_id integer);
      CREATE TABLE ai_visibility_workspaces(id integer PRIMARY KEY,owner_user_id integer,billing_organization_id integer,status text);
      CREATE TABLE business_scope_accounts(table_name text PRIMARY KEY);
      CREATE TABLE subscription_settings(id integer PRIMARY KEY,capacity_enforced boolean DEFAULT false);
      CREATE TABLE subscription_plans(version integer,slug text,limits jsonb);
      CREATE TABLE billing_subscriptions(id text PRIMARY KEY,organization_id integer,version integer,slug text);
      CREATE TABLE subscription_accounts(organization_id integer,current_subscription_id text);
      CREATE TABLE subscription_charges(subscription_id text,organization_id integer,period_start timestamptz,period_end timestamptz,paid_at timestamptz);
      CREATE TABLE storage_plans(id integer PRIMARY KEY,max_storage_bytes bigint,is_default boolean);
      CREATE TABLE storage_quotas(user_id integer PRIMARY KEY,plan_id integer,max_storage_bytes bigint);
      CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$;
      CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
      CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION app_billing_actor_user_id() RETURNS integer LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('app.billing_actor_user_id',true),'')::integer $$;
      INSERT INTO users VALUES(1),(2),(3);
      INSERT INTO billing_organizations VALUES(1,1),(2,2);
      INSERT INTO billing_organization_memberships VALUES(1,1,1,'one@example.test','owner','active'),(2,2,2,'two@example.test','owner','active');
      INSERT INTO company_settings VALUES(1,1,1),(2,1,1),(3,2,2);
      INSERT INTO storage_plans VALUES(1,75,true);
      INSERT INTO subscription_settings VALUES(1,false);
    `);
    for (const table of resourceTables) {
      await pool.query(`CREATE TABLE ${table}(id integer PRIMARY KEY,user_id integer,business_profile_id integer,
        state text DEFAULT 'draft',status text DEFAULT 'paused',legacy_config_id integer,deleted_at timestamptz,is_deleted boolean DEFAULT false,file_size_bytes bigint DEFAULT 0,enabled boolean DEFAULT false,
        is_active boolean DEFAULT true,legacy_entry_id integer,platform text,account_identifier text,session_data jsonb,
        deactivation_reason text,page_id text,facebook_active boolean DEFAULT true,instagram_active boolean DEFAULT false,
        instagram_account_id text,email text,service_name text,config jsonb)`);
      await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY business_isolation ON ${table} USING(app_business_system() OR business_profile_id=app_business_profile_id())
          WITH CHECK(app_business_system() OR business_profile_id=app_business_profile_id())`);
    }
    await pool.query('ALTER TABLE knowledge_documents ADD FOREIGN KEY(legacy_entry_id) REFERENCES knowledge_base(id) ON DELETE SET NULL');
    await pool.query('INSERT INTO crm_contacts(id,user_id,business_profile_id) VALUES(99,1,1)');
    await pool.query('GRANT USAGE ON SCHEMA public TO salesmarketing_business_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO salesmarketing_business_runtime');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // @ts-expect-error migrations are JavaScript modules.
      const migration = await import('../migrations/302_organization_capacity.js');
      await migration.up(client);
      // Modern resources had no capacity trigger before this migration.
      expect((await client.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='outreach_assistants'::regclass AND tgname='zz_billing_capacity'")).rows[0].n).toBe(0);
      // @ts-expect-error migrations are JavaScript modules.
      const modern = await import('../migrations/341_modern_resource_capacity.js');
      await modern.up(client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    expect(Number((await pool.query("SELECT usage FROM billing_capacity_totals WHERE organization_id=1 AND resource_key='contacts'")).rows[0]?.usage)).toBe(1);
  }, 30000);

  afterAll(async () => {
    await pool?.end();
    if (admin && name) await admin.query(`DROP DATABASE "${name}"`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('UPDATE subscription_settings SET capacity_enforced=false');
    for (const table of resourceTables) await pool.query(`DELETE FROM ${table}`);
    await pool.query(`DELETE FROM billing_storage_reservations; DELETE FROM billing_capacity_items WHERE source_table='billing_storage_reservations';
      UPDATE billing_capacity_totals SET usage=0 WHERE resource_key='storageBytes';
      DELETE FROM ai_visibility_workspaces;
      DELETE FROM billing_organization_memberships WHERE id>2;
      UPDATE company_settings SET billing_organization_id=CASE WHEN id=3 THEN 2 ELSE 1 END;
      DELETE FROM company_settings WHERE id>3;
      TRUNCATE subscription_charges,subscription_accounts,billing_subscriptions,subscription_plans;
      INSERT INTO billing_subscriptions VALUES('paid-one',1,2,'starter'),('paid-two',2,2,'starter');
      INSERT INTO subscription_accounts VALUES(1,'paid-one'),(2,'paid-two');
      INSERT INTO subscription_charges VALUES('paid-one',1,now()-interval '2 days',now()+interval '28 days',now()-interval '2 days'),
        ('paid-two',2,now()-interval '2 days',now()+interval '28 days',now()-interval '2 days');
      UPDATE subscription_settings SET capacity_enforced=true`);
    await pool.query("INSERT INTO subscription_plans VALUES(2,'starter',$1)", [limits]);
  });

  async function scoped<T>(profile: number, user: number, work: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE salesmarketing_business_runtime');
      await client.query("SELECT set_config('app.business_profile_id',$1,true),set_config('app.current_user_id',$2,true),set_config('app.billing_actor_user_id',$2,true)", [String(profile), String(user)]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const insertContact = (id: number, profile = 1, user = 1) => scoped(profile,user,c => c.query('INSERT INTO crm_contacts(id,user_id,business_profile_id) VALUES($1,$2,$3)', [id,user,profile]));
  async function used(resource: string, org = 1) {
    return Number((await pool.query('SELECT usage FROM billing_capacity_totals WHERE organization_id=$1 AND resource_key=$2',[org,resource])).rows[0]?.usage || 0);
  }
  async function reconciliation(org = 1) {
    return scoped(org === 1 ? 1 : 3,org,c => c.query('SELECT billing_capacity_reconciliation($1) AS mismatches',[org])).then(r => r.rows[0].mismatches);
  }

  it('atomically caps modern assistant activation across businesses', async () => {
    const results=await Promise.allSettled([1,2,3].map(id=>scoped(id===2?2:1,1,c=>c.query(
      "INSERT INTO outreach_assistants(id,user_id,business_profile_id,state) VALUES($1,1,$2,'live')",[id,id===2?2:1]))));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
    expect(await used('aiAssistants')).toBe(2);
    const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(normalizeCapacityError(failure.reason)).toMatchObject({code:'PLAN_LIMIT_EXCEEDED',resource:'aiAssistants',limit:2});
    expect(await reconciliation()).toEqual([]);
  });
  it('deduplicates migrated legacy assistants and frees modern paused capacity', async () => {
    await scoped(1,1,c=>c.query("INSERT INTO ai_agent_configs(id,user_id,business_profile_id,enabled) VALUES(1,1,1,true); INSERT INTO outreach_assistants(id,user_id,business_profile_id,state,legacy_config_id) VALUES(1,1,1,'live',1)"));
    expect(await used('aiAssistants')).toBe(1);
    await scoped(1,1,c=>c.query("INSERT INTO outreach_assistants(id,user_id,business_profile_id,state) VALUES(2,1,1,'live')"));
    await expect(scoped(1,1,c=>c.query("INSERT INTO outreach_assistants(id,user_id,business_profile_id,state) VALUES(3,1,1,'live')"))).rejects.toMatchObject({code:'P0001'});
    await scoped(1,1,c=>c.query("UPDATE outreach_assistants SET state='paused' WHERE id=2; INSERT INTO outreach_assistants(id,user_id,business_profile_id,state) VALUES(3,1,1,'live')"));
    expect(await used('aiAssistants')).toBe(2); expect(await reconciliation()).toEqual([]);
  });
  it('shares automation capacity with Instagram rules, releasing only inactive or deleted rules', async () => {
    await scoped(1,1,c=>c.query("INSERT INTO workflows(id,user_id,business_profile_id,is_active) VALUES(1,1,1,true); INSERT INTO instagram_automation_rules(id,user_id,business_profile_id,status) VALUES(1,1,1,'active')"));
    expect(await used('automations')).toBe(2);
    await expect(scoped(1,1,c=>c.query("INSERT INTO instagram_automation_rules(id,user_id,business_profile_id,status) VALUES(2,1,1,'active')"))).rejects.toMatchObject({code:'P0001'});
    await scoped(1,1,c=>c.query("UPDATE instagram_automation_rules SET deleted_at=now() WHERE id=1; INSERT INTO instagram_automation_rules(id,user_id,business_profile_id,status) VALUES(2,1,1,'active')"));
    expect(await used('automations')).toBe(2);
    await expect(scoped(1,1,c=>c.query("UPDATE instagram_automation_rules SET deleted_at=NULL WHERE id=1"))).rejects.toMatchObject({code:'P0001'});
    expect(await reconciliation()).toEqual([]);
  });

  it('enforces concurrent increases across businesses without cross-business reads', async () => {
    const results = await Promise.allSettled([insertContact(1),insertContact(2,2),insertContact(3),insertContact(4,2)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    for (const result of results) if (result.status === 'rejected') expect(normalizeCapacityError(result.reason)).toMatchObject({code:'PLAN_LIMIT_EXCEEDED',resource:'contacts',current:2,requestedIncrease:1,limit:2});
    expect(await used('contacts')).toBe(2);
    await expect(scoped(1,1,c => c.query('INSERT INTO crm_contacts(id,user_id,business_profile_id) VALUES(9,2,3)'))).rejects.toMatchObject({code:'42501'});
    expect(await reconciliation()).toEqual([]);
  });

  it('accounts report-only usage and blocks only increases when over the new cap', async () => {
    await pool.query('UPDATE subscription_settings SET capacity_enforced=false');
    await insertContact(1); await insertContact(2); await insertContact(3);
    await pool.query('UPDATE subscription_settings SET capacity_enforced=true');
    await scoped(1,1,c => c.query('UPDATE crm_contacts SET deleted_at=now() WHERE id=1'));
    expect(await used('contacts')).toBe(2);
    await expect(scoped(1,1,c => c.query('UPDATE crm_contacts SET deleted_at=NULL WHERE id=1'))).rejects.toMatchObject({code:'P0001'});
    await scoped(1,1,c => c.query('DELETE FROM crm_contacts WHERE id=2'));
    await scoped(1,1,c => c.query('UPDATE crm_contacts SET deleted_at=NULL WHERE id=1'));
    expect(await used('contacts')).toBe(2);
  });

  it('rolls back the whole bulk import when a row exceeds the allowance', async () => {
    await expect(scoped(1,1,c => c.query('INSERT INTO crm_contacts(id,user_id,business_profile_id) VALUES(1,1,1),(2,1,1),(3,1,1)'))).rejects.toMatchObject({code:'P0001'});
    expect(await used('contacts')).toBe(0);
    expect(await reconciliation()).toEqual([]);
  });

  it('counts legacy knowledge plus its v2 document once and ignores document versions', async () => {
    await scoped(1,1,async c => {
      await c.query('INSERT INTO knowledge_base(id,user_id,business_profile_id) VALUES(1,1,1),(2,1,1)');
      await c.query('INSERT INTO knowledge_documents(id,user_id,business_profile_id,legacy_entry_id) VALUES(10,1,1,1)');
      await c.query('UPDATE knowledge_documents SET legacy_entry_id=2 WHERE id=10');
    });
    expect(await used('knowledgeSources')).toBe(2);
    await expect(scoped(1,1,c => c.query('INSERT INTO knowledge_documents(id,user_id,business_profile_id) VALUES(11,1,1)'))).rejects.toMatchObject({code:'P0001'});
    await scoped(1,1,c => c.query('DELETE FROM knowledge_base WHERE id=2'));
    expect(await used('knowledgeSources')).toBe(1);
    const retained = await scoped(1,1,c => c.query('SELECT deleted_at FROM knowledge_documents WHERE id=10'));
    expect(retained.rows[0].deleted_at).not.toBeNull();
    await scoped(1,1,c => c.query('DELETE FROM knowledge_documents WHERE id=10'));
    expect(await used('knowledgeSources')).toBe(1);
  });

  it('deduplicates mirrored Meta and Gmail accounts and excludes provider API keys', async () => {
    await scoped(1,1,async c => {
      await c.query("INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,account_identifier) VALUES(1,1,1,'facebook_api','page-1'),(2,1,1,'gmail_api','Mail@Example.test'),(3,1,1,'meta','parent'),(4,1,1,'openai','api-key')");
      await c.query("INSERT INTO meta_page_connections(id,user_id,business_profile_id,page_id) VALUES(1,1,1,'page-1')");
      await c.query("INSERT INTO email_senders(id,user_id,business_profile_id,email) VALUES(1,1,1,'mail@example.test')");
      await c.query("UPDATE channel_credentials SET is_active=false,deactivation_reason='token_expired' WHERE id=1");
    });
    expect(await used('channelAccounts')).toBe(2);
    await expect(scoped(1,1,c => c.query("INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,account_identifier) VALUES(5,1,1,'instagram_api','new-account')"))).rejects.toMatchObject({code:'P0001'});
    // A mirror still points at page-1, so a third distinct account is rejected.
    await expect(scoped(1,1,c => c.query("UPDATE channel_credentials SET account_identifier='replacement-page' WHERE id=1"))).rejects.toMatchObject({code:'P0001'});
  });

  it('counts active/invited organization seats and separate enabled support logins', async () => {
    await scoped(1,1,c => c.query("INSERT INTO billing_organization_memberships VALUES(3,1,NULL,'invite@example.test','member','invited')"));
    await expect(scoped(1,1,c => c.query("INSERT INTO billing_organization_memberships VALUES(4,1,NULL,'extra@example.test','member','invited')"))).rejects.toMatchObject({code:'P0001'});
    await scoped(1,1,async c => {
      await c.query("UPDATE billing_organization_memberships SET user_id=3,status='active' WHERE id=3");
      await c.query('INSERT INTO team_members(id,user_id,business_profile_id) VALUES(1,1,1),(2,1,1)');
    });
    expect(await used('members')).toBe(2);
    expect(await used('supportAgents')).toBe(2);
    await scoped(1,1,c => c.query('UPDATE team_members SET is_active=false WHERE id=1'));
    expect(await used('supportAgents')).toBe(1);
  });

  it('counts the legacy WhatsApp path once with its channel mirror and releases explicit disconnects', async () => {
    await scoped(1,1,async c => {
      await c.query(`INSERT INTO api_credentials(id,user_id,business_profile_id,service_name,config)
        VALUES(1,1,1,'whatsapp','{"phoneNumberId":"phone-1"}'),(2,1,1,'openai','{}')`);
      await c.query("INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,account_identifier) VALUES(1,1,1,'whatsapp','phone-1')");
      await c.query("INSERT INTO channel_credentials(id,user_id,business_profile_id,platform,account_identifier) VALUES(2,1,1,'youtube','channel-1')");
    });
    expect(await used('channelAccounts')).toBe(2);
    await scoped(1,1,c => c.query("UPDATE channel_credentials SET is_active=false,deactivation_reason='user_disconnected' WHERE id=2"));
    expect(await used('channelAccounts')).toBe(1);
    await scoped(1,1,c => c.query('UPDATE channel_credentials SET is_active=true WHERE id=2'));
    expect(await used('channelAccounts')).toBe(2);
    expect(await reconciliation()).toEqual([]);
  });

  it('shares automation capacity across CRM rules/workflows and counts enabled assistants/teams', async () => {
    await scoped(1,1,async c => {
      await c.query('INSERT INTO crm_pipeline_automations(id,user_id,business_profile_id) VALUES(1,1,1)');
      await c.query('INSERT INTO workflows(id,user_id,business_profile_id) VALUES(1,1,1)');
      await c.query('INSERT INTO ai_agent_configs(id,user_id,business_profile_id,enabled) VALUES(1,1,1,true),(2,1,1,false)');
      await c.query('INSERT INTO support_teams(id,user_id,business_profile_id,is_active) VALUES(1,1,1,true),(2,1,1,false)');
    });
    await expect(scoped(2,1,c => c.query('INSERT INTO workflows(id,user_id,business_profile_id) VALUES(2,1,2)'))).rejects.toMatchObject({code:'P0001'});
    expect(await used('automations')).toBe(2); expect(await used('aiAssistants')).toBe(1); expect(await used('supportTeams')).toBe(1);
  });

  it('permits a net-zero assistant replacement after a downgrade without allowing new capacity', async () => {
    await pool.query('UPDATE subscription_settings SET capacity_enforced=false');
    await scoped(1,1,c => c.query('INSERT INTO ai_agent_configs(id,user_id,business_profile_id,enabled) VALUES(1,1,1,true),(2,1,1,true),(3,1,1,true),(4,1,1,false)'));
    await pool.query('UPDATE subscription_settings SET capacity_enforced=true');
    await scoped(1,1,async c => {
      await c.query('UPDATE ai_agent_configs SET enabled=false WHERE id=1');
      await c.query('UPDATE ai_agent_configs SET enabled=true WHERE id=4');
    });
    expect(await used('aiAssistants')).toBe(3);
    await expect(scoped(1,1,c => c.query('UPDATE ai_agent_configs SET enabled=true WHERE id=1'))).rejects.toMatchObject({code:'P0001'});
    await scoped(1,1,c => c.query('UPDATE ai_agent_configs SET enabled=false WHERE id=2'));
    await expect(scoped(1,1,c => c.query('UPDATE ai_agent_configs SET enabled=true WHERE id=2'))).rejects.toMatchObject({code:'P0001'});
    expect(await used('aiAssistants')).toBe(2);
  });

  it('keeps storage reservations atomic through commit, replacement, failure and delete', async () => {
    const reserved = await scoped(1,1,c => c.query('SELECT billing_reserve_storage(1,1,80) AS id'));
    const id = reserved.rows[0].id;
    await expect(scoped(2,1,c => c.query('SELECT billing_reserve_storage(2,1,21)'))).rejects.toMatchObject({code:'P0001'});
    expect(await used('storageBytes')).toBe(80);
    await expect(scoped(1,1,async c => {
      await c.query('SELECT billing_release_storage($1,1,1)',[id]);
      await c.query('INSERT INTO storage_files(id,user_id,business_profile_id,file_size_bytes) VALUES(1,1,1,101)');
    })).rejects.toMatchObject({code:'P0001'});
    expect(await used('storageBytes')).toBe(80); // rollback restores reservation
    await scoped(1,1,async c => {
      await c.query('SELECT billing_release_storage($1,1,1)',[id]);
      await c.query('INSERT INTO storage_files(id,user_id,business_profile_id,file_size_bytes) VALUES(1,1,1,80)');
    });
    expect(await used('storageBytes')).toBe(80);
    await scoped(1,1,c => c.query('UPDATE storage_files SET file_size_bytes=30 WHERE id=1'));
    expect(await used('storageBytes')).toBe(30);
    await scoped(1,1,c => c.query('UPDATE storage_files SET is_deleted=true WHERE id=1'));
    expect(await used('storageBytes')).toBe(0);
    expect(await reconciliation()).toEqual([]);
  });

  it('serializes concurrent storage reservations and rejects direct registry tampering', async () => {
    const results = await Promise.allSettled([scoped(1,1,c => c.query('SELECT billing_reserve_storage(1,1,60)')),scoped(2,1,c => c.query('SELECT billing_reserve_storage(2,1,60)'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await used('storageBytes')).toBe(60);
    await expect(scoped(1,1,c => c.query("UPDATE billing_capacity_totals SET usage=0 WHERE organization_id=1"))).rejects.toMatchObject({code:'42501'});
    await expect(scoped(1,1,c => c.query("SELECT billing_sync_capacity('crm_contacts','1',1,NULL,1,'[]')"))).rejects.toMatchObject({code:'42501'});
  });

  it('moves live resources, leaves pending reservations at their original organization, and rejects excess destination usage', async () => {
    await insertContact(1); await insertContact(2);
    const reservation = await scoped(1,1,c => c.query('SELECT billing_reserve_storage(1,1,10) AS id'));
    await insertContact(3,3,2);
    await expect(pool.query('UPDATE company_settings SET billing_organization_id=2 WHERE id=1')).rejects.toMatchObject({code:'P0001'});
    expect(await used('contacts',1)).toBe(2); expect(await used('contacts',2)).toBe(1);
    await pool.query('DELETE FROM crm_contacts WHERE id=3');
    await pool.query('UPDATE company_settings SET billing_organization_id=2 WHERE id=1');
    expect(await used('contacts',1)).toBe(0); expect(await used('contacts',2)).toBe(2);
    expect(await used('storageBytes',1)).toBe(10); expect(await used('storageBytes',2)).toBe(0);
    await scoped(1,1,c => c.query('SELECT billing_release_storage($1,1,1)',[reservation.rows[0].id]));
    expect(await used('storageBytes',1)).toBe(0);
    expect(await reconciliation(2)).toEqual([]);
  });

  it('retains paid caps after expiry and preserves legacy storage overrides', async () => {
    await pool.query("UPDATE subscription_charges SET period_start=now()-interval '2 months',period_end=now()-interval '1 month'");
    const current = await scoped(1,1,c => c.query('SELECT billing_organization_entitlements(1) AS e'));
    expect(current.rows[0].e.limits.contacts).toBe(2);
    await pool.query("UPDATE billing_subscriptions SET version=1; INSERT INTO subscription_plans VALUES(1,'starter','{}'); INSERT INTO storage_quotas VALUES(1,1,50)");
    await pool.query('UPDATE subscription_settings SET capacity_enforced=false');
    await expect(scoped(1,1,c => c.query('SELECT billing_reserve_storage(1,1,51)'))).rejects.toMatchObject({code:'P0001'});
    const legacy = await scoped(1,1,c => c.query('SELECT billing_organization_entitlements(1) AS e'));
    expect(legacy.rows[0].e.limits.storageBytes).toBe(50);
  });

  it('retries a write whose business changes organization while waiting for capacity', async () => {
    const mover = await pool.connect();
    const writer = await pool.connect();
    try {
      await mover.query('BEGIN');
      await mover.query('SELECT id FROM billing_organizations ORDER BY id FOR UPDATE');
      await writer.query('BEGIN');
      await writer.query('SET LOCAL ROLE salesmarketing_business_runtime');
      await writer.query("SELECT set_config('app.business_profile_id','1',true),set_config('app.current_user_id','1',true)");
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiting = writer.query('INSERT INTO crm_contacts(id,user_id,business_profile_id) VALUES(1,1,1)')
        .then(() => null, error => error);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);
        if (activity.rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
        await pool.query('SELECT pg_sleep(0.01)');
      }
      expect(blocked).toBe(true);
      await mover.query('UPDATE company_settings SET billing_organization_id=2 WHERE id=1');
      await mover.query('COMMIT');
      expect(await waiting).toMatchObject({code:'40001'});
      await writer.query('ROLLBACK');
      expect(await used('contacts',1)).toBe(0);
      expect(await used('contacts',2)).toBe(0);
      expect(await reconciliation(2)).toEqual([]);
    } finally {
      await mover.query('ROLLBACK'); await writer.query('ROLLBACK'); mover.release(); writer.release();
    }
  });

  it('reconciles against actual RLS-protected rows and restores authorization scope', async () => {
    await insertContact(1); await insertContact(2,2);
    await scoped(1,1,async c => {
      expect((await c.query('SELECT count(*) AS n FROM crm_contacts')).rows[0].n).toBe('1');
      expect((await c.query('SELECT billing_capacity_reconciliation(1) AS mismatches')).rows[0].mismatches).toEqual([]);
      expect((await c.query('SELECT count(*) AS n FROM crm_contacts')).rows[0].n).toBe('1');
    });
    await pool.query("UPDATE billing_capacity_items SET amount=5 WHERE source_table='crm_contacts' AND source_id='1'");
    expect(await reconciliation()).toEqual([{resource:'contacts',actual:2,registry:6,counter:2}]);
    await expect(scoped(1,1,c => c.query('SELECT billing_organization_entitlements(2)'))).rejects.toMatchObject({code:'42501'});
    await expect(scoped(1,1,c => c.query('SELECT billing_capacity_reconciliation(2)'))).rejects.toMatchObject({code:'42501'});
  });
});
