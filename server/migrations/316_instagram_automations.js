/** Account-bound Instagram configuration and durable, at-most-once provider effects. */
export async function up(client) {
  const { rows: prerequisites } = await client.query(`SELECT
    to_regprocedure('app_business_profile_id()') AS profile_scope,
    to_regprocedure('app_business_access(integer)') AS membership_access,
    to_regprocedure('enforce_business_ownership()') AS ownership_guard,
    to_regclass('business_scope_tables') AS scope_manifest`);
  if (Object.values(prerequisites[0]).some(value => value === null)) {
    throw new Error(
      'Instagram automations require the business isolation and membership migrations (299 and 304). Apply their prerequisites before migration 316.'
    );
  }
  await client.query(`
    CREATE TABLE instagram_automation_profiles (
      id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      account_id varchar(255) NOT NULL, kind varchar(20) NOT NULL CHECK(kind IN ('icebreakers','menu')),
      config jsonb NOT NULL, published_config jsonb, revision integer NOT NULL DEFAULT 1,
      sync_status varchar(20) NOT NULL DEFAULT 'draft', sync_remove boolean NOT NULL DEFAULT false, sync_error text, synced_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(business_profile_id,user_id,account_id,kind)
    );
    CREATE TABLE instagram_automation_rules (
      id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      account_id varchar(255) NOT NULL, definition jsonb NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'paused' CHECK(status IN ('paused','active')),
      priority integer NOT NULL DEFAULT 0, revision integer NOT NULL DEFAULT 1, deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX instagram_automation_rules_account_idx ON instagram_automation_rules(business_profile_id,user_id,account_id,status);
    CREATE TABLE instagram_automation_runs (
      id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      account_id varchar(255) NOT NULL, source_key varchar(1000) NOT NULL,
      rule_id integer REFERENCES instagram_automation_rules(id), rule_name varchar(120) NOT NULL,
      definition jsonb NOT NULL, context jsonb NOT NULL, conversation_id integer,
      sender_id varchar(255) NOT NULL, recipient_id varchar(255), status varchar(30) NOT NULL DEFAULT 'queued', reason text,
      private_message_id varchar(1000), public_message_id varchar(1000),
      claimed_at timestamptz, reserved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(business_profile_id,user_id,account_id,source_key)
    );
    CREATE INDEX instagram_automation_runs_history_idx ON instagram_automation_runs(business_profile_id,user_id,account_id,id DESC);
    CREATE INDEX instagram_automation_runs_recipient_idx ON instagram_automation_runs(business_profile_id,account_id,sender_id,rule_id,created_at);
    CREATE TABLE instagram_automation_effects (
      id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      run_id integer NOT NULL REFERENCES instagram_automation_runs(id) ON DELETE CASCADE,
      effect_key varchar(1000) NOT NULL, status varchar(20) NOT NULL DEFAULT 'sending',
      provider_message_id varchar(1000), recipient_id varchar(255), error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,effect_key)
    );
  `);
  for (const [table, links] of [
    ['instagram_automation_profiles', []],
    ['instagram_automation_rules', []],
    [
      'instagram_automation_runs',
      [
        {
          parent: 'instagram_automation_rules',
          child_columns: ['rule_id'],
          parent_columns: ['id'],
        },
      ],
    ],
    [
      'instagram_automation_effects',
      [{ parent: 'instagram_automation_runs', child_columns: ['run_id'], parent_columns: ['id'] }],
    ],
  ]) {
    const spec = {
      table_name: table,
      owner_column: 'user_id',
      global_read: false,
      parent_links: links,
      legacy_business_column: null,
    };
    await client.query(
      'INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)',
      [table, 'user_id', JSON.stringify(links)]
    );
    const literal = JSON.stringify(spec).replaceAll("'", "''");
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
      CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON SEQUENCE ${table}_id_seq TO salesmarketing_business_runtime;`);
  }
}
export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS instagram_automation_effects,instagram_automation_runs,instagram_automation_rules,instagram_automation_profiles;
    DELETE FROM business_scope_tables WHERE table_name IN ('instagram_automation_effects','instagram_automation_runs','instagram_automation_rules','instagram_automation_profiles');`);
}
