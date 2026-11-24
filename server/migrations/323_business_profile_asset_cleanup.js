/** Keep object cleanup durable after an unused profile and its setup files disappear. */
export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS business_profile_asset_cleanup (
    id bigserial PRIMARY KEY, user_id integer NOT NULL,
    storage_key text NOT NULL, storage_backend text NOT NULL,
    attempts integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id,storage_key,storage_backend)
  );
  INSERT INTO business_scope_accounts(table_name) VALUES('business_profile_asset_cleanup') ON CONFLICT DO NOTHING;
  ALTER TABLE business_profile_asset_cleanup ENABLE ROW LEVEL SECURITY;
  ALTER TABLE business_profile_asset_cleanup FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS cleanup_access ON business_profile_asset_cleanup;
  CREATE POLICY cleanup_access ON business_profile_asset_cleanup FOR ALL
    USING(app_business_system() OR user_id=app_business_user_id())
    WITH CHECK(app_business_system() OR user_id=app_business_user_id());
  GRANT SELECT,INSERT,UPDATE,DELETE ON business_profile_asset_cleanup TO salesmarketing_business_runtime;
  GRANT USAGE,SELECT ON SEQUENCE business_profile_asset_cleanup_id_seq TO salesmarketing_business_runtime;`);
}
export async function down(client) {
  const pending = await client.query('SELECT 1 FROM business_profile_asset_cleanup LIMIT 1');
  if (pending.rowCount) throw new Error('Process pending profile asset cleanup before rolling back.');
  await client.query(`DROP TABLE business_profile_asset_cleanup;
    DELETE FROM business_scope_accounts WHERE table_name='business_profile_asset_cleanup';`);
}
