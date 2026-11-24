/**
 * Migration 107: Persist per-user notification preferences.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL
    DEFAULT '{"emailNotifications":true,"leadAlerts":true,"campaignUpdates":true,"weeklyReports":false}'::jsonb
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS notification_preferences`);
}
