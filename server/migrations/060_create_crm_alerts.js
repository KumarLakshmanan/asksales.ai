/**
 * Migration: create_crm_alerts
 * Creates crm_alerts table for user-configured alert rules
 * and crm_alert_logs table for triggered alert history.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      event_type VARCHAR(100) NOT NULL,
      conditions JSONB DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT true,
      notify_user BOOLEAN NOT NULL DEFAULT true,
      notify_contact BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_alerts_user_id ON crm_alerts(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_alerts_event_type ON crm_alerts(event_type)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_alerts_enabled ON crm_alerts(enabled)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_alert_logs (
      id SERIAL PRIMARY KEY,
      alert_id INTEGER NOT NULL REFERENCES crm_alerts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      event_type VARCHAR(100) NOT NULL,
      event_data JSONB DEFAULT '{}'::jsonb,
      notified_user BOOLEAN NOT NULL DEFAULT false,
      notified_contact BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_alert_logs_alert_id ON crm_alert_logs(alert_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_alert_logs_user_id ON crm_alert_logs(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_alert_logs_created_at ON crm_alert_logs(created_at)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS crm_alert_logs CASCADE`);
  await client.query(`DROP TABLE IF EXISTS crm_alerts CASCADE`);
}
