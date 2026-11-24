/** Bound CRM status synchronization to the selected contact's lead aliases. */
export async function up(client) {
  await client.query(`
    CREATE INDEX crm_status_conversation_alias_idx ON outreach_conversations
      (user_id,business_profile_id,crm_contact_id,lead_id) WHERE crm_contact_id IS NOT NULL;
    CREATE INDEX crm_status_retired_alias_idx ON crm_contacts
      (user_id,business_profile_id,merged_into_contact_id,lead_id) WHERE merged_into_contact_id IS NOT NULL;
  `);
}
export async function down(client) {
  await client.query('DROP INDEX crm_status_conversation_alias_idx,crm_status_retired_alias_idx');
}
