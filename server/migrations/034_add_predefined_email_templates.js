/**
 * Migration: add_predefined_email_templates
 * Adds is_predefined flag and html_content column to content_templates.
 * Makes user_id nullable so admin-created predefined templates have no owner.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE content_templates
      ADD COLUMN IF NOT EXISTS is_predefined BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS html_content TEXT,
      ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
      ADD COLUMN IF NOT EXISTS description TEXT,
      ALTER COLUMN user_id DROP NOT NULL
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_content_templates_is_predefined
    ON content_templates (is_predefined)
    WHERE is_predefined = true
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS idx_content_templates_is_predefined
  `);

  await client.query(`
    ALTER TABLE content_templates
      DROP COLUMN IF EXISTS is_predefined,
      DROP COLUMN IF EXISTS html_content,
      DROP COLUMN IF EXISTS thumbnail_url,
      DROP COLUMN IF EXISTS description,
      ALTER COLUMN user_id SET NOT NULL
  `);
}
