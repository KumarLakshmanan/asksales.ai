/** Bring V7 creative research into V8's business isolation contract. */
export async function up(client) {
  const { rows: prerequisites } = await client.query(`SELECT
    to_regprocedure('app_business_access(integer)') AS access,
    to_regprocedure('enforce_business_ownership()') AS guard,
    to_regclass('business_scope_tables') AS manifest`);
  if (Object.values(prerequisites[0]).some(value => value === null)) {
    throw new Error('Creative research requires business isolation migrations 299 and 304.');
  }
  for (const [table, links] of [
    ['ad_creative_research_runs', []],
    ['ad_creative_briefs', []],
    ['ad_creative_brief_assets', [
      { parent: 'ad_creative_briefs', child_columns: ['brief_id', 'user_id'], parent_columns: ['id', 'user_id'] },
      { parent: 'content_assets', child_columns: ['content_asset_id'], parent_columns: ['id'] },
    ]],
  ]) {
    await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE;
      ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS business_profile_id INTEGER;
      ALTER TABLE ${table} ALTER COLUMN business_profile_id SET DEFAULT app_business_profile_id();`);
    const { rows: unassigned } = await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE business_profile_id IS NULL`);
    if (unassigned[0].count) {
      throw new Error(`Assign verified business ownership to existing ${table} records before migrating.`);
    }
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='${table}_business_profile_fk') THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${table}_business_profile_fk FOREIGN KEY(business_profile_id) REFERENCES company_settings(id) ON DELETE CASCADE;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS ${table}_business_idx ON ${table}(business_profile_id,user_id);`);
    const spec = { table_name: table, owner_column: 'user_id', global_read: false, parent_links: links, legacy_business_column: null };
    await client.query(`INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links)
      VALUES($1,'user_id',false,$2::jsonb) ON CONFLICT(table_name) DO UPDATE SET owner_column='user_id',global_read=false,parent_links=EXCLUDED.parent_links`, [table, JSON.stringify(links)]);
    const literal = JSON.stringify(spec).replaceAll("'", "''");
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS business_isolation ON ${table};
      CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
      DROP TRIGGER IF EXISTS zz_business_ownership ON ${table};
      DROP TRIGGER IF EXISTS business_ownership_guard ON ${table};
      CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO salesmarketing_business_runtime;`);
    if (table !== 'ad_creative_brief_assets') {
      await client.query(`GRANT USAGE,SELECT ON SEQUENCE ${table}_id_seq TO salesmarketing_business_runtime;`);
    }
  }
}
export async function down() {
  throw new Error('Creative business ownership must be retained. Use a reviewed forward migration.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
