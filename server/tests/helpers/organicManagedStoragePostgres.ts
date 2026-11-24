import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import { storageFilesTable } from '../../models/storageFiles/schema.js';
import { storageQuotasTable } from '../../models/storageQuotas/schema.js';
import { localBusinessIsolation } from './localBusinessPostgres.js';

/** Canonical migration480/RLS in a disposable publication namespace. No Storage API is mocked. */
export async function installOrganicManagedStorageFixtures(pool: Pool, schema: string) {
  for (const table of [storageFilesTable, storageQuotasTable]) {
    const definition = getTableConfig(table);
    const columns = definition.columns.map(column => {
      if (column.name === 'id') return 'id SERIAL PRIMARY KEY';
      const value = column.default;
      const defaultSql = value instanceof SQL ? new PgDialect().sqlToQuery(value).sql : value === undefined ? undefined : typeof value === 'number' || typeof value === 'boolean' ? String(value) : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
      return `"${column.name}" ${column.getSQLType()}${defaultSql === undefined ? '' : ` DEFAULT ${defaultSql}`}`;
    });
    await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS business_scope_tables(table_name text PRIMARY KEY,owner_column text,global_read boolean,parent_links jsonb);
    CREATE TABLE IF NOT EXISTS brand_toolkits(id integer PRIMARY KEY,user_id integer,business_profile_id integer,logo_url text,logo_urls jsonb,image_assets jsonb,website_screenshot_url text);
    CREATE TABLE IF NOT EXISTS content_template_versions(id integer PRIMARY KEY,user_id integer,business_profile_id integer,snapshot jsonb);
    ALTER TABLE social_publish_attempts ADD CONSTRAINT fixture_attempt_asset FOREIGN KEY(asset_id) REFERENCES content_assets(id) ON DELETE SET NULL`);
  const source = await readFile('migrations/299_business_profile_isolation.js', 'utf8');
  const ownership = source.match(/CREATE OR REPLACE FUNCTION enforce_business_ownership\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$[\s\S]*?END \$\$/)?.[0];
  if (!ownership) throw Error('Canonical ownership function is unavailable');
  await pool.query(ownership);
  await localBusinessIsolation(pool, schema, ['storage_files']);
  // This is the actual published migration, not a parallel schema/ledger implementation.
  // @ts-expect-error Migration modules are JavaScript.
  const migration = await import('../../migrations/480_storage_managed_references.js');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await migration.up(client); await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

/** Actual current capacity SQL for exercising the canonical upload API. Only
 * function search_path is adapted to the disposable namespace; no API stubs. */
export async function installOrganicUploadCapacityFixtures(pool: Pool, schema: string) {
  const source = await readFile('migrations/302_organization_capacity.js', 'utf8');
  const members = await readFile('migrations/304_business_profile_memberships.js', 'utf8');
  const modern = await readFile('migrations/341_modern_resource_capacity.js', 'utf8');
  const retained = await readFile('migrations/340_live_capacity_plan_retention.js', 'utf8');
  for (const table of ['billing_capacity_items','billing_capacity_totals','billing_storage_reservations']) {
    const definition=source.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n    \\);`))?.[0];
    if(!definition)throw Error(`Canonical ${table} definition missing`);
    await pool.query(definition);
  }
  await pool.query(`CREATE TABLE subscription_settings(id integer PRIMARY KEY,capacity_enforced boolean);
    INSERT INTO subscription_settings VALUES(1,false);
    CREATE TABLE subscription_charges(subscription_id text,organization_id integer,period_start timestamp,paid_at timestamp);
    CREATE TABLE billing_subscriptions(id text,version integer,slug text,mode text);
    CREATE TABLE subscription_plans(version integer,slug text,limits jsonb);
    CREATE TABLE subscription_accounts(organization_id integer,current_subscription_id text);
    CREATE TABLE billing_admin_plan_terms(organization_id integer,version integer,slug text,starts_at timestamp,ends_at timestamp,cancelled_at timestamp);
    CREATE TABLE storage_plans(id serial PRIMARY KEY,name text,max_storage_bytes bigint,is_default boolean)`);
  const install=async(text:string,name:string)=>{
    const definition=text.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name}\\([\\s\\S]*?\\$\\$;`))?.[0];
    if(!definition)throw Error(`Canonical function ${name} missing`);
    await pool.query(definition.replaceAll('search_path=public,pg_catalog',`search_path=${schema},pg_catalog`));
  };
  for(const name of ['billing_capacity_authorize','billing_capacity_plan','billing_assert_capacity','billing_capacity_units','billing_capacity_apply_deltas','billing_sync_capacity','billing_transfer_profile_capacity','billing_capacity_resource_trigger','billing_organization_entitlements','billing_reserve_storage','billing_release_storage'])await install(source,name);
  await install(members,'app_business_actor_user_id'); await install(members,'app_business_access'); await install(members,'billing_capacity_authorize');
  await pool.query('ALTER FUNCTION billing_capacity_units(text,jsonb) RENAME TO billing_capacity_units_v302'); await install(members,'billing_capacity_units');
  await pool.query('ALTER FUNCTION billing_capacity_units(text,jsonb) RENAME TO billing_capacity_units_before_modern'); await install(modern,'billing_capacity_units');
  await install(retained,'billing_capacity_plan');
  await pool.query(`CREATE TRIGGER zz_billing_capacity AFTER INSERT OR UPDATE OR DELETE ON storage_files FOR EACH ROW EXECUTE FUNCTION billing_capacity_resource_trigger();
    GRANT SELECT ON billing_capacity_items,billing_capacity_totals,billing_storage_reservations,subscription_settings,subscription_charges,billing_subscriptions,subscription_plans,subscription_accounts,billing_admin_plan_terms,storage_plans TO salesmarketing_business_runtime;
    REVOKE INSERT,UPDATE,DELETE ON billing_capacity_items,billing_capacity_totals,billing_storage_reservations FROM salesmarketing_business_runtime;
    REVOKE ALL ON FUNCTION billing_capacity_apply_deltas(jsonb),billing_sync_capacity(text,text,integer,integer,integer,jsonb),billing_transfer_profile_capacity(integer,integer),billing_reserve_storage(integer,integer,bigint),billing_release_storage(uuid,integer,integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION billing_capacity_apply_deltas(jsonb),billing_sync_capacity(text,text,integer,integer,integer,jsonb),billing_transfer_profile_capacity(integer,integer),billing_reserve_storage(integer,integer,bigint),billing_release_storage(uuid,integer,integer) TO salesmarketing_business_runtime`);
}
