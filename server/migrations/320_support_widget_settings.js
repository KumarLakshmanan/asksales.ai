/** Widget appearance and loader installation signal are per support team. */
export async function up(client) {
  await client.query(`ALTER TABLE support_teams
    ADD COLUMN IF NOT EXISTS widget_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS widget_installation JSONB;`);
}
export async function down(client) {
  await client.query(`ALTER TABLE support_teams
    DROP COLUMN IF EXISTS widget_installation,
    DROP COLUMN IF EXISTS widget_settings;`);
}
