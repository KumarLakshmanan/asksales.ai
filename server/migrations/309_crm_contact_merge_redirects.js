export async function up(client) {
  await client.query(`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS merged_into_contact_id INTEGER
    REFERENCES crm_contacts(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS crm_contacts_merge_target_idx ON crm_contacts(merged_into_contact_id)
      WHERE merged_into_contact_id IS NOT NULL`);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS crm_contacts_merge_target_idx');
  await client.query('ALTER TABLE crm_contacts DROP COLUMN IF EXISTS merged_into_contact_id');
}
