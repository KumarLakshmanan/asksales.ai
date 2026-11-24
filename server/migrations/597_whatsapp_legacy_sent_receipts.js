// WhatsApp delivery receipts updated outreach_messages but never the older
// sent_messages rows, so those stayed "sent" forever. Campaign reports then
// counted messages WhatsApp had rejected (for example error 131049, Meta's
// marketing-message limit) as accepted. On one account, about 33,000 rejected
// attempts showed as accepted.
//
// 1. Index sent_messages by WhatsApp message id so the status webhook can find
//    the row. Built CONCURRENTLY: no write lock on sent_messages.
// 2. Backfill delivery state from the receipts already stored in
//    instagram_webhook_events. A delivered or read receipt wins over a failure.
export const transaction = false;

const name = 'sent_messages_whatsapp_message_id_idx';

export async function up(client) {
  const invalid = await client.query(
    'SELECT 1 FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid', [name],
  );
  if (invalid.rows.length) await client.query(`DROP INDEX CONCURRENTLY ${name}`);
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
       ON sent_messages (user_id, message_id)
       WHERE channel = 'whatsapp' AND message_id IS NOT NULL`,
  );
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.business_system','on',true)");
    await client.query(`
      WITH receipt AS (
        SELECT e.message_id, e.user_id,
          bool_or(e.event_type IN ('whatsapp_delivered','whatsapp_read')) AS delivered,
          min(e.timestamp) FILTER (WHERE e.event_type IN ('whatsapp_delivered','whatsapp_read')) AS delivered_at,
          min(e.timestamp) FILTER (WHERE e.event_type = 'whatsapp_failed') AS failed_at,
          (array_agg(e.raw_data::jsonb #>> '{status,errors,0,message}') FILTER (WHERE e.event_type = 'whatsapp_failed'))[1] AS reason
        FROM instagram_webhook_events e
        WHERE e.event_type IN ('whatsapp_delivered','whatsapp_read','whatsapp_failed')
          AND e.message_id IS NOT NULL AND e.user_id IS NOT NULL
        GROUP BY e.message_id, e.user_id
      )
      UPDATE sent_messages s SET
        delivery_status = CASE WHEN r.delivered THEN 'delivered' ELSE 'failed' END,
        delivered_at = CASE WHEN r.delivered THEN COALESCE(s.delivered_at, r.delivered_at) ELSE s.delivered_at END,
        bounced_at = CASE WHEN r.delivered THEN s.bounced_at ELSE COALESCE(s.bounced_at, r.failed_at) END,
        bounce_reason = CASE WHEN r.delivered THEN s.bounce_reason
          ELSE COALESCE(s.bounce_reason, left(COALESCE(r.reason, 'WhatsApp delivery failed'), 1000)) END,
        updated_at = NOW()
      FROM receipt r
      WHERE s.channel = 'whatsapp' AND s.user_id = r.user_id AND s.message_id = r.message_id
        AND s.delivered_at IS NULL
        AND COALESCE(s.delivery_status, '') NOT IN ('delivered', 'failed')
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// The backfill records what WhatsApp reported; there is nothing to undo.
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS ${name}`);
}
