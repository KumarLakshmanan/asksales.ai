export async function up(client) {
  await client.query(`
    ALTER TABLE outreach_messages DROP CONSTRAINT IF EXISTS outreach_messages_follow_up_kind_check;
    ALTER TABLE outreach_messages ADD CONSTRAINT outreach_messages_follow_up_kind_check CHECK (
      (message_kind = 'follow_up' AND follow_up_origin_message_id IS NOT NULL AND follow_up_step IS NOT NULL AND follow_up_step > 0)
      OR (message_kind IN ('outreach','reply','proposal') AND follow_up_origin_message_id IS NULL)
    ) NOT VALID;
    ALTER TABLE outreach_messages VALIDATE CONSTRAINT outreach_messages_follow_up_kind_check;
    CREATE INDEX IF NOT EXISTS support_delivery_outbox_proposal_lookup
      ON support_delivery_outbox(user_id, ((payload->'metadata'->>'proposalId')))
      WHERE payload->'metadata'->>'dispatchKind'='proposal_delivery';
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_proposal_delivery_once
      ON wallet_transactions(user_id,reference_type,reference_id)
      WHERE type='deduction' AND reference_type='proposal_delivery';
  `);
}

export async function down(client) {
  // Preserve proposal receipts and message identities when reverting application code.
  await client.query('SELECT 1');
}
