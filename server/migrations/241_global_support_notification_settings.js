/**
 * Workspace-wide support notification switches.
 *
 * External support alerts are opt-in per tenant and limited to assignment and
 * reassignment events. Member destinations remain encrypted in the existing
 * destination vault.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_channel_settings (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel VARCHAR(24) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      enabled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      enabled_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_notification_channel_settings_channel_ck
        CHECK (channel IN ('email', 'whatsapp')),
      UNIQUE (user_id, channel)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS support_notification_channel_settings_enabled_idx
      ON support_notification_channel_settings(user_id, channel) WHERE enabled IS TRUE
  `);
  await client.query(`ALTER TABLE support_notification_channel_settings ENABLE ROW LEVEL SECURITY`);
  await client.query(`ALTER TABLE support_notification_channel_settings FORCE ROW LEVEL SECURITY`);
  await client.query(`
    DROP POLICY IF EXISTS support_notification_channel_settings_tenant_policy
      ON support_notification_channel_settings
  `);
  await client.query(`
    CREATE POLICY support_notification_channel_settings_tenant_policy
      ON support_notification_channel_settings
      USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER)
      WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS support_notification_channel_settings');
}
