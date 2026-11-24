/**
 * Migration 100: System Alerts and Outreach settings extensions
 *
 * Adds auto_ticket_dedup_window_minutes, block_on_zero_credit, and slack_webhook_url to outreach_settings.
 * Creates the system_alerts table.
 */

export async function up(client) {
  // 1. Add settings columns to outreach_settings
  await client.query(`
    ALTER TABLE outreach_settings
    ADD COLUMN IF NOT EXISTS auto_ticket_dedup_window_minutes INTEGER DEFAULT 30,
    ADD COLUMN IF NOT EXISTS block_on_zero_credit BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS slack_webhook_url TEXT;
  `);

  // 2. Create system_alerts table
  await client.query(`
    CREATE TABLE IF NOT EXISTS system_alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id INTEGER,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(50) NOT NULL DEFAULT 'info',
      severity VARCHAR(50) NOT NULL DEFAULT 'medium',
      read BOOLEAN NOT NULL DEFAULT false,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_system_alerts_user_id ON system_alerts(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_system_alerts_created_at ON system_alerts(created_at)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS system_alerts`);

  await client.query(`
    ALTER TABLE outreach_settings
    DROP COLUMN IF EXISTS auto_ticket_dedup_window_minutes,
    DROP COLUMN IF EXISTS block_on_zero_credit,
    DROP COLUMN IF EXISTS slack_webhook_url;
  `);
}
