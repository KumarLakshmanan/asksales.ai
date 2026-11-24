import type { Pool } from 'pg';

/** The relevant migration 299 functions/policy, inside an exclusively owned QA schema. */
export async function localBusinessFunctions(pool: Pool) {
  await pool.query(`CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
    CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
    CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$`);
}

export async function localBusinessIsolation(pool: Pool, schema: string, tables: string[]) {
  if (!/^[a-z_]+_[a-f0-9]{16}$/.test(schema) || tables.some(table => !/^[a-z_]+$/.test(table))) {
    throw new Error('Business QA isolation requires an owned random schema and known table names.');
  }
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime') THEN
      CREATE ROLE salesmarketing_business_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime'
      AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
      RAISE EXCEPTION 'Unsafe local business runtime role';
    END IF;
    END $$;
    GRANT salesmarketing_business_runtime TO CURRENT_USER`);
  const access = `(app_business_system() OR (business_profile_id=app_business_profile_id() AND
    EXISTS(SELECT 1 FROM company_settings b WHERE b.id=business_profile_id AND b.user_id=app_business_user_id())))`;
  for (const table of tables) {
    await pool.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS business_profile_id integer;
      ALTER TABLE "${table}" ALTER COLUMN business_profile_id SET DEFAULT app_business_profile_id();
      ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    const policies = await pool.query('SELECT policyname FROM pg_policies WHERE schemaname=$1 AND tablename=$2', [schema, table]);
    if (policies.rows.length) {
      // Upgrade the old tenant-only document policy; do not leave permissive OR access.
      for (const { policyname } of policies.rows) {
        await pool.query(`ALTER POLICY "${String(policyname).replaceAll('"', '""')}" ON "${table}"
          USING ${access} WITH CHECK ${access}`);
      }
    } else {
      await pool.query(`CREATE POLICY business_isolation ON "${table}" FOR ALL USING ${access} WITH CHECK ${access}`);
    }
    if (table === 'content_templates') {
      // The production exception is read-only and requires approved predefined globals.
      await pool.query(`CREATE POLICY global_template_read ON content_templates FOR SELECT USING
        (business_profile_id IS NULL AND user_id IS NULL AND is_predefined=TRUE AND is_approved=TRUE)`);
    }
  }
  await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO salesmarketing_business_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO salesmarketing_business_runtime`);
}
