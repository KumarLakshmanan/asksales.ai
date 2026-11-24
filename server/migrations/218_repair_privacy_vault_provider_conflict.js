/**
 * Make the privacy-vault idempotency index usable by PostgreSQL's plain
 * ON CONFLICT (user_id, channel, provider_message_id) inference.
 *
 * Migration 118 created this as a partial unique index. PostgreSQL cannot
 * infer a partial index unless the INSERT repeats the predicate, so inbound
 * messages containing PII failed before their support job could be queued.
 * A normal unique index remains safe because PostgreSQL treats NULL values as
 * distinct, while non-null provider message IDs retain exactly-once behavior.
 */
export async function up(client) {
  await client.query(`DROP INDEX IF EXISTS support_privacy_vault_provider_message_uq`);
  await client.query(`
    CREATE UNIQUE INDEX support_privacy_vault_provider_message_uq
      ON support_privacy_vault(user_id, channel, provider_message_id)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS support_privacy_vault_provider_message_uq`);
  await client.query(`
    CREATE UNIQUE INDEX support_privacy_vault_provider_message_uq
      ON support_privacy_vault(user_id, channel, provider_message_id)
      WHERE provider_message_id IS NOT NULL
  `);
}
