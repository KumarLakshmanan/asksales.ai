/**
 * Keep Meta webhook processing/audit updates observable. The runtime has long
 * written this column when it marks Instagram and Facebook events processed,
 * but older production schemas did not contain it and silently discarded that
 * final audit update.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE instagram_webhook_events
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  `);
  await client.query(`
    UPDATE instagram_webhook_events
    SET updated_at = COALESCE(processed_at, created_at, timestamp, NOW())
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE instagram_webhook_events
      DROP COLUMN IF EXISTS updated_at
  `);
}
