/** Preserve each campaign upload and its resolved contacts without copying file contents. */
export async function up(client) {
  await client.query(`
    CREATE TABLE campaign_lead_imports (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      thread_id integer REFERENCES chat_threads(id) ON DELETE SET NULL,
      file_name varchar(500) NOT NULL,
      total_records integer NOT NULL,
      request_id varchar(100),
      request_fingerprint varchar(64) NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX campaign_lead_import_request_uq ON campaign_lead_imports(business_profile_id,user_id,request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX campaign_lead_import_thread_idx ON campaign_lead_imports(business_profile_id,user_id,thread_id,created_at);
    CREATE TABLE campaign_lead_import_members (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      import_id integer NOT NULL REFERENCES campaign_lead_imports(id) ON DELETE CASCADE,
      lead_id integer REFERENCES leads(id) ON DELETE SET NULL,
      recipient_lead_id integer REFERENCES leads(id) ON DELETE SET NULL,
      contact_id integer REFERENCES crm_contacts(id) ON DELETE SET NULL,
      UNIQUE(import_id,lead_id)
    );
    CREATE INDEX campaign_lead_import_member_lead_idx ON campaign_lead_import_members(business_profile_id,lead_id);
    CREATE INDEX campaign_lead_import_member_contact_idx ON campaign_lead_import_members(business_profile_id,contact_id);
    CREATE INDEX outreach_crm_import_contact_idx ON crm_contact_import_details(business_profile_id,created_contact_id,import_id) WHERE status IN ('success','warning');
    CREATE INDEX outreach_legacy_campaign_import_idx ON leads(business_profile_id,user_id,(campaign_data->>'threadId')) WHERE source='import' AND campaign_data->>'source'='csv_import';
  `);
  for (const [table, links] of [
    ['campaign_lead_imports', [{ parent: 'chat_threads', child_columns: ['thread_id'], parent_columns: ['id'] }]],
    ['campaign_lead_import_members', [
      { parent: 'campaign_lead_imports', child_columns: ['import_id'], parent_columns: ['id'] },
      { parent: 'leads', child_columns: ['lead_id'], parent_columns: ['id'] },
      { parent: 'leads', child_columns: ['recipient_lead_id'], parent_columns: ['id'] },
      { parent: 'crm_contacts', child_columns: ['contact_id'], parent_columns: ['id'] },
    ]],
  ]) {
    const spec = { table_name: table, owner_column: 'user_id', global_read: false, parent_links: links, legacy_business_column: null };
    await client.query('INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)', [table, 'user_id', JSON.stringify(links)]);
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
  const { rows } = await client.query('SELECT 1 FROM campaign_lead_imports LIMIT 1');
  if (rows.length) throw new Error('Campaign upload history exists. Retain it and roll forward.');
  await client.query(`DROP INDEX outreach_crm_import_contact_idx,outreach_legacy_campaign_import_idx;
    DROP TABLE campaign_lead_import_members,campaign_lead_imports;
    DELETE FROM business_scope_tables WHERE table_name IN ('campaign_lead_import_members','campaign_lead_imports');`);
}
