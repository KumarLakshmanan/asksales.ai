/** Preserve exact delivery identity; existing receipts remain historical evidence. */
export async function up(client) {
  await client.query(`ALTER TABLE sent_messages
    ADD COLUMN IF NOT EXISTS recipient_address text,
    ADD COLUMN IF NOT EXISTS rfc_message_id text,
    ADD COLUMN IF NOT EXISTS references_header text;
    CREATE INDEX IF NOT EXISTS sent_messages_recipient_suppression_idx
      ON sent_messages(business_profile_id,user_id,lower(recipient_address))
      WHERE channel IN ('email','gmail','resend') AND (bounced_at IS NOT NULL OR status IN ('bounced','complained') OR delivery_status IN ('bounced','complained'));`);
}
export async function down(client) {
  // Receipt identity is evidence: rollback must not destroy it.
  await client.query('SELECT 1');
}
