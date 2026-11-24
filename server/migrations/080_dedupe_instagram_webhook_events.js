/**
 * Migration 080: dedupe Instagram webhook events + tighten processed_at semantics
 *
 * - Adds a partial unique index on (message_id) so duplicate Meta webhook deliveries
 *   for the same DM are silently ignored via ON CONFLICT DO NOTHING.
 * - Backfills existing duplicates by keeping the oldest row.
 * - Sets processed_at = NULL for rows where processed = false so a future async
 *   worker can use processed_at IS NULL as a clean queue indicator.
 */

export async function up(client) {
  // 1. Backfill: drop duplicate rows that share message_id, keeping the oldest id.
  await client.query(`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (PARTITION BY message_id ORDER BY id ASC) AS rn
      FROM instagram_webhook_events
      WHERE message_id IS NOT NULL
    )
    DELETE FROM instagram_webhook_events
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  `);

  // 2. Partial unique index on message_id (NULL message_ids are allowed for non-DM events).
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS instagram_webhook_events_message_id_unique
    ON instagram_webhook_events (message_id)
    WHERE message_id IS NOT NULL;
  `);

  // 3. Reset processed_at for unprocessed rows so async workers can rely on IS NULL.
  await client.query(`
    UPDATE instagram_webhook_events
    SET processed_at = NULL
    WHERE is_processed = false
      AND processed_at IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS instagram_webhook_events_message_id_unique;
  `);
}
