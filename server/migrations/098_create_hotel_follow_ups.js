/**
 * Migration 098: proactive follow-up automation for the WhatsApp Sales Agent.
 *
 * The agent schedules a follow-up when a customer goes quiet mid-journey:
 *   - payment_reminder : a booking is pending_payment but unpaid ("did you get a chance to pay?")
 *   - re_engagement    : the customer was quoted/shown rooms but didn't book ("want me to hold the room?")
 *
 * A background cron (cron-hotel-follow-ups) scans for due rows, re-checks stop
 * conditions (customer replied / booking confirmed), sends a WhatsApp nudge, and
 * either completes or schedules the next attempt.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS hotel_follow_ups (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL,
      lead_id          INTEGER,
      conversation_id  INTEGER NOT NULL,
      phone_number_id  TEXT,
      recipient_phone  TEXT,
      type             TEXT NOT NULL,                          -- payment_reminder | re_engagement | hold_room
      status           TEXT NOT NULL DEFAULT 'scheduled',      -- scheduled | sent | cancelled | failed
      attempt          INTEGER NOT NULL DEFAULT 0,
      max_attempts     INTEGER NOT NULL DEFAULT 1,
      due_at           TIMESTAMPTZ NOT NULL,
      context          JSONB DEFAULT '{}'::jsonb,
      last_message     TEXT,
      cancel_reason    TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      sent_at          TIMESTAMPTZ
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_hotel_follow_ups_due ON hotel_follow_ups (status, due_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_hotel_follow_ups_conv ON hotel_follow_ups (conversation_id)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS hotel_follow_ups`);
}
