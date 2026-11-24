/** Explicit campaign workspace relationships, with the same RLS/parent guards as other tenant data. */
async function installGuard(client, table, links) {
  const { rows } = await client.query('SELECT * FROM business_scope_tables WHERE table_name=$1', [table]);
  const spec = { ...rows[0], parent_links: links };
  await client.query('UPDATE business_scope_tables SET parent_links=$2::jsonb WHERE table_name=$1', [table, JSON.stringify(links)]);
  const literal = JSON.stringify(spec).replaceAll("'", "''");
  await client.query(`DROP TRIGGER IF EXISTS zz_business_ownership ON ${table};
    DROP TRIGGER IF EXISTS business_ownership_guard ON ${table};
    CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');`);
}
export async function up(client) {
  const { rows } = await client.query(`SELECT to_regprocedure('enforce_business_ownership()') AS guard, to_regclass('business_scope_tables') AS manifest`);
  if (!rows[0].guard || !rows[0].manifest) throw new Error('Campaign workspace links require business isolation migrations 299 and 304.');
  await client.query(`CREATE TABLE campaign_crm_contacts (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
    contact_id integer NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
    thread_id integer NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    created_at timestamp NOT NULL DEFAULT NOW(), UNIQUE(contact_id,thread_id));
    CREATE INDEX campaign_crm_contacts_thread_idx ON campaign_crm_contacts(business_profile_id,thread_id);
    ALTER TABLE campaign_crm_contacts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_crm_contacts FORCE ROW LEVEL SECURITY;
    CREATE POLICY business_isolation ON campaign_crm_contacts FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
    INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES('campaign_crm_contacts','user_id',false,'[]');
    GRANT SELECT,INSERT,UPDATE,DELETE ON campaign_crm_contacts TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON SEQUENCE campaign_crm_contacts_id_seq TO salesmarketing_business_runtime;
    ALTER TABLE support_tickets ADD COLUMN chat_thread_id integer REFERENCES chat_threads(id) ON DELETE SET NULL;
    CREATE INDEX support_tickets_chat_thread_idx ON support_tickets(business_profile_id,chat_thread_id) WHERE deleted_at IS NULL;`);
  await installGuard(client, 'campaign_crm_contacts', [
    { parent:'crm_contacts',child_columns:['contact_id'],parent_columns:['id'] },
    { parent:'chat_threads',child_columns:['thread_id'],parent_columns:['id'] },
  ]);
  const { rows: support } = await client.query("SELECT parent_links FROM business_scope_tables WHERE table_name='support_tickets'");
  await installGuard(client, 'support_tickets', [...support[0].parent_links, {parent:'chat_threads',child_columns:['chat_thread_id'],parent_columns:['id']}]);
}
export async function down(client) {
  const { rows } = await client.query("SELECT parent_links FROM business_scope_tables WHERE table_name='support_tickets'");
  await installGuard(client, 'support_tickets', rows[0].parent_links.filter(link => !link.child_columns.includes('chat_thread_id')));
  await client.query(`DROP INDEX IF EXISTS support_tickets_chat_thread_idx;
    ALTER TABLE support_tickets DROP COLUMN IF EXISTS chat_thread_id;
    DROP TABLE IF EXISTS campaign_crm_contacts;
    DELETE FROM business_scope_tables WHERE table_name='campaign_crm_contacts';`);
}
