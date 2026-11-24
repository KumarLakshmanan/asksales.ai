export async function up(client) {
  await client.query(`
    ALTER TABLE instagram_webhook_events
    ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE SET NULL;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS instagram_webhook_events_user_id_idx
    ON instagram_webhook_events (user_id);
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS instagram_webhook_events_user_id_idx;
  `);
  await client.query(`
    ALTER TABLE instagram_webhook_events DROP COLUMN IF EXISTS user_id;
  `);
}
