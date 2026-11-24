/** Remove the retired Hermes feature after all application callers are gone. */
export async function up(client) {
  await client.query(`
    DROP TABLE IF EXISTS hermes_user_mediated_sessions;
    ALTER TABLE outreach_settings DROP COLUMN IF EXISTS hermes_settings;
    DELETE FROM system_integrations
    WHERE integration_id IN ('instagram_automation', 'linkedin_automation', 'twitter_automation');
  `);
}

export async function down(client) {
  // Removed session attestations and obsolete integration settings are not
  // reconstructed during rollback. Restoring the feature requires a new migration.
  await client.query('SELECT 1');
}
