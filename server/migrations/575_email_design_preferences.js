export async function up(client) {
  await client.query(`ALTER TABLE outreach_settings ADD COLUMN IF NOT EXISTS email_design_preferences jsonb NOT NULL DEFAULT '{"outreach":"classic","assistant":"classic","revision":"initial"}'::jsonb`);
}
export async function down(client) {
  await client.query('ALTER TABLE outreach_settings DROP COLUMN IF EXISTS email_design_preferences');
}
