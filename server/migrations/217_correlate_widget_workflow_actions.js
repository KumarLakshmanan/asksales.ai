/** Correlate durable review widgets with the exact conversation workflow action. */
export async function up(client) {
  await client.query(`
    ALTER TABLE widget_states
      ADD COLUMN IF NOT EXISTS run_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS action_id VARCHAR(160),
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS widget_states_run_action_idx
      ON widget_states(user_id, thread_id, run_id, action_id)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS widget_states_user_idempotency_uq
      ON widget_states(user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS widget_states_user_idempotency_uq');
  await client.query('DROP INDEX IF EXISTS widget_states_run_action_idx');
  await client.query(`
    ALTER TABLE widget_states
      DROP COLUMN IF EXISTS idempotency_key,
      DROP COLUMN IF EXISTS action_id,
      DROP COLUMN IF EXISTS run_id
  `);
}
