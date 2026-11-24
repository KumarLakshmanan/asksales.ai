export async function up(client) {
  await client.query(`
    ALTER TABLE social_saved_reports
      ADD COLUMN IF NOT EXISTS schedule_definition JSONB,
      ADD COLUMN IF NOT EXISTS schedule_timezone VARCHAR(80)
  `);
  await client.query(`
    ALTER TABLE social_saved_reports DROP CONSTRAINT IF EXISTS social_saved_reports_schedule_definition_check
  `);
  await client.query(`
    ALTER TABLE social_saved_reports ADD CONSTRAINT social_saved_reports_schedule_definition_check
      CHECK (
        schedule_definition IS NULL OR
        (schedule_definition->>'frequency' IN ('daily', 'weekly', 'monthly') AND schedule_timezone IS NOT NULL)
      )
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE social_saved_reports
      DROP CONSTRAINT IF EXISTS social_saved_reports_schedule_definition_check,
      DROP COLUMN IF EXISTS schedule_timezone,
      DROP COLUMN IF EXISTS schedule_definition
  `);
}
