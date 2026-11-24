/** Durable, coalesced Gmail notifications and cross-process mailbox cooldowns. */
export async function up(client) {
  await client.query(`ALTER TABLE channel_credentials
    ADD COLUMN IF NOT EXISTS gmail_sync_history_id numeric(40,0),
    ADD COLUMN IF NOT EXISTS gmail_sync_due_at timestamptz,
    ADD COLUMN IF NOT EXISTS gmail_cooldown_until timestamptz,
    ADD COLUMN IF NOT EXISTS gmail_sync_lease_token uuid,
    ADD COLUMN IF NOT EXISTS gmail_sync_lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS gmail_sync_failures integer NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS gmail_mailbox_sync_due ON channel_credentials(gmail_sync_due_at)
      WHERE platform='gmail_api' AND is_active IS TRUE AND gmail_sync_history_id IS NOT NULL;`);
}
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS gmail_mailbox_sync_due;
    ALTER TABLE channel_credentials DROP COLUMN IF EXISTS gmail_sync_history_id,
      DROP COLUMN IF EXISTS gmail_sync_due_at, DROP COLUMN IF EXISTS gmail_cooldown_until,
      DROP COLUMN IF EXISTS gmail_sync_lease_token, DROP COLUMN IF EXISTS gmail_sync_lease_until,
      DROP COLUMN IF EXISTS gmail_sync_failures;`);
}
