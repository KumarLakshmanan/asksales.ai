/** Timestamp pagination for a mixed timeline of provider messages and unsent drafts. */
export async function up(db) {
  await db.query(`CREATE INDEX IF NOT EXISTS outreach_messages_timeline_idx
    ON outreach_messages (business_profile_id, conversation_id, (COALESCE(sent_at,created_at)) DESC, id DESC)`);
  // Install the narrower account boundary before retiring the legacy global constraint.
  // Existing global uniqueness guarantees that building this index introduces no conflicts.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_waba_account_message_uq
    ON outreach_messages (business_profile_id,user_id,phone_number_id,waba_message_id) WHERE waba_message_id IS NOT NULL`);
  await db.query('ALTER TABLE outreach_messages DROP CONSTRAINT IF EXISTS outreach_messages_waba_message_id_unique');
}
export async function down(db) {
  // Refuse rollback if newer account-scoped identities cannot satisfy the old constraint.
  await db.query('ALTER TABLE outreach_messages ADD CONSTRAINT outreach_messages_waba_message_id_unique UNIQUE (waba_message_id)');
  await db.query('DROP INDEX IF EXISTS outreach_messages_waba_account_message_uq');
  await db.query('DROP INDEX IF EXISTS outreach_messages_timeline_idx');
}
