export async function up(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS instagram_webhook_events_created_at_idx
    ON instagram_webhook_events (created_at);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS instagram_webhook_events_processed_at_idx
    ON instagram_webhook_events (processed_at);
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS instagram_webhook_events_processed_at_idx;');
  await client.query('DROP INDEX IF EXISTS instagram_webhook_events_created_at_idx;');
}
