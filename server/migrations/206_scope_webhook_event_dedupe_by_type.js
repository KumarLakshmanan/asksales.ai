/**
 * Migration 206: preserve each WhatsApp delivery-state transition.
 *
 * Meta uses one provider message ID for sent, delivered, read, and failed
 * callbacks. The legacy message-only unique index therefore discarded every
 * transition after the first. Scope idempotency by event type so duplicate
 * deliveries of the same transition remain suppressed without collapsing the
 * delivery lifecycle.
 */

export async function up(client) {
  await client.query(`
    DROP INDEX IF EXISTS instagram_webhook_events_message_id_unique;

    CREATE UNIQUE INDEX instagram_webhook_events_type_message_unique
      ON instagram_webhook_events (event_type, message_id)
      WHERE message_id IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (PARTITION BY message_id ORDER BY id ASC) AS rn
      FROM instagram_webhook_events
      WHERE message_id IS NOT NULL
    )
    DELETE FROM instagram_webhook_events
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

    DROP INDEX IF EXISTS instagram_webhook_events_type_message_unique;

    CREATE UNIQUE INDEX instagram_webhook_events_message_id_unique
      ON instagram_webhook_events (message_id)
      WHERE message_id IS NOT NULL;
  `);
}
