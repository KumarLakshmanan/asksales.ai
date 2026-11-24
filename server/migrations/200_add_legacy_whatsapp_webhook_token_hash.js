/**
 * Preserve old per-tenant WhatsApp callback URLs across WEBHOOK_SECRET
 * rotations without storing their bearer tokens.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE channel_credentials
      ADD COLUMN IF NOT EXISTS legacy_webhook_token_hash VARCHAR(64);

    ALTER TABLE channel_credentials
      DROP CONSTRAINT IF EXISTS channel_credentials_legacy_webhook_token_hash_check;
    ALTER TABLE channel_credentials
      ADD CONSTRAINT channel_credentials_legacy_webhook_token_hash_check
      CHECK (
        legacy_webhook_token_hash IS NULL
        OR legacy_webhook_token_hash ~ '^[a-f0-9]{64}$'
      );

    CREATE INDEX IF NOT EXISTS channel_credentials_legacy_webhook_token_hash_idx
      ON channel_credentials(legacy_webhook_token_hash)
      WHERE platform = 'whatsapp'
        AND is_active = TRUE
        AND legacy_webhook_token_hash IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS channel_credentials_legacy_webhook_token_hash_idx;
    ALTER TABLE channel_credentials
      DROP CONSTRAINT IF EXISTS channel_credentials_legacy_webhook_token_hash_check,
      DROP COLUMN IF EXISTS legacy_webhook_token_hash;
  `);
}
