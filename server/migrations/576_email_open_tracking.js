export async function up(client) {
  await client.query(`CREATE TABLE email_open_tracking (
    id uuid PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id),
    business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id),
    intent_key text NOT NULL, provider_account_id text NOT NULL, provider_message_id text, rfc_message_id text,
    accepted_at timestamptz, opened_at timestamptz, last_opened_at timestamptz,
    open_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(business_profile_id,user_id,intent_key)
  );
  CREATE INDEX email_open_tracking_provider ON email_open_tracking(business_profile_id,user_id,provider_message_id);
  CREATE INDEX email_open_tracking_rfc ON email_open_tracking(business_profile_id,user_id,rfc_message_id);`);
  const table = 'email_open_tracking';
  const spec = { table_name: table, owner_column: 'user_id', global_read: false, parent_links: [], legacy_business_column: null };
  await client.query("INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,'user_id',false,'[]'::jsonb)", [table]);
  const literal = JSON.stringify(spec).replaceAll("'", "''");
  await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
    CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;`);
}
export async function down(client) {
  const result = await client.query('SELECT 1 FROM email_open_tracking LIMIT 1');
  if (result.rows.length) throw new Error('Retain email tracking receipts; roll forward instead.');
  await client.query("DROP TABLE email_open_tracking; DELETE FROM business_scope_tables WHERE table_name='email_open_tracking'");
}
