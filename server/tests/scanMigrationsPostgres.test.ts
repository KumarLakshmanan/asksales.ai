import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error repository migrations are JavaScript modules
import { up as secureRouting } from '../migrations/578_secure_meta_routing.js';
// @ts-expect-error repository migrations are JavaScript modules
import { up as rotateTokens } from '../migrations/579_rotate_exposed_webhook_capabilities.js';

const url = process.env.OUTREACH_QA_DATABASE_URL;
const local = url ? describe : describe.skip;
let client: Client;
const schema = `scan_migration_${randomBytes(8).toString('hex')}`;
async function migrate(up: (client: Client) => Promise<void>) {
  await client.query('BEGIN');
  try {
    await up(client);
    expect((await client.query("SELECT current_setting('app.business_system',true) AS value")).rows[0].value).not.toBe('on');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
local('scan remediation migrations in disposable PostgreSQL tables', () => {
  beforeAll(async () => {
    if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Explicit local QA database required');
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog`);
    await client.query(`CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
      CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
      CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$;
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer); INSERT INTO company_settings VALUES(11,1),(22,2);
      CREATE TABLE users(id integer PRIMARY KEY,webhook_token_nonce text,updated_at timestamptz DEFAULT NOW());
      CREATE TABLE channel_credentials(id serial,user_id integer,business_profile_id integer,platform text,
        credential_type text,account_identifier text,is_active boolean DEFAULT true,is_selected boolean DEFAULT true,
        legacy_webhook_token_hash text,updated_at timestamptz DEFAULT NOW());
      CREATE TABLE meta_page_connections(id serial,user_id integer,business_profile_id integer,page_id text,
        instagram_account_id text,is_active boolean DEFAULT true,facebook_active boolean DEFAULT true,
        instagram_active boolean DEFAULT true,updated_at timestamptz DEFAULT NOW());
      INSERT INTO users VALUES(1,'old-capability',NOW()),(2,'another-old-capability',NOW());
      INSERT INTO channel_credentials(user_id,business_profile_id,platform,credential_type,account_identifier,legacy_webhook_token_hash)
        VALUES(1,11,'instagram_api','manual','forged-ig',NULL),(1,11,'whatsapp','oauth','phone','old-hash');
      INSERT INTO meta_page_connections(user_id,business_profile_id,page_id,instagram_account_id)
        VALUES(1,11,'forged-page','forged-ig'),(1,11,'duplicate-page','dup-1'),(2,22,'duplicate-page','dup-2'),(1,11,'verified-page','verified-ig');`);
    // Exercise the actual ownership trigger that rejected the production bulk
    // update, including both its before and constraint-trigger invocations.
    const source = readFileSync(new URL('../migrations/299_business_profile_isolation.js', import.meta.url), 'utf8');
    const start = source.indexOf('CREATE OR REPLACE FUNCTION enforce_business_ownership()');
    const end = source.indexOf('END $$', start) + 'END $$'.length;
    if (start < 0 || end <= start) throw new Error('Ownership trigger definition not found');
    await client.query(source.slice(start, end));
    for (const table of ['channel_credentials', 'meta_page_connections']) {
      const spec = JSON.stringify({ table_name: table, owner_column: 'user_id', global_read: false, parent_links: [], legacy_business_column: null });
      await client.query(`CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}');
        CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table}
        NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}')`);
    }
  });
  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });
  it('quarantines legacy manual/ambiguous routes and enforces global active identities', async () => {
    await expect(client.query("UPDATE channel_credentials SET is_active=false WHERE credential_type='manual'")).rejects.toMatchObject({ code: '42501' });
    await migrate(secureRouting);
    const active = await client.query('SELECT page_id FROM meta_page_connections WHERE is_active');
    expect(active.rows).toEqual([{ page_id: 'verified-page' }]);
    const manual = await client.query("SELECT is_active,is_selected FROM channel_credentials WHERE credential_type='manual'");
    expect(manual.rows).toEqual([{ is_active: false, is_selected: false }]);
    await client.query("SELECT set_config('app.business_system','on',false)");
    try {
      await expect(client.query("INSERT INTO meta_page_connections(user_id,business_profile_id,page_id,instagram_account_id) VALUES(2,22,'verified-page','new-ig')")).rejects.toMatchObject({ code: '23505' });
      await expect(client.query("INSERT INTO meta_page_connections(user_id,business_profile_id,page_id,instagram_account_id) VALUES(2,22,'new-page','verified-ig')")).rejects.toMatchObject({ code: '23505' });
    } finally { await client.query("SELECT set_config('app.business_system','off',false)"); }
  });
  it('invalidates all previously disclosed webhook capabilities and legacy hashes', async () => {
    await migrate(rotateTokens);
    const nonces = await client.query('SELECT webhook_token_nonce FROM users ORDER BY id');
    expect(nonces.rows.every(row => /^[0-9a-f]{64}$/.test(row.webhook_token_nonce))).toBe(true);
    expect(nonces.rows[0].webhook_token_nonce).not.toBe(nonces.rows[1].webhook_token_nonce);
    expect((await client.query("SELECT legacy_webhook_token_hash FROM channel_credentials WHERE platform='whatsapp'")).rows).toEqual([{ legacy_webhook_token_hash: null }]);
  });
});
