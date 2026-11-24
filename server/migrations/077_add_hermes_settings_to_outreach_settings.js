export async function up(client) {
  await client.query(`
    ALTER TABLE outreach_settings
    ADD COLUMN IF NOT EXISTS hermes_settings JSONB DEFAULT '{}';
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE outreach_settings
    DROP COLUMN IF EXISTS hermes_settings;
  `);
}
