/**
 * Migration: add_document_fields_to_proposal_templates
 * Adds document upload and parsed template storage fields for proposal templates.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE proposal_templates
      ADD COLUMN IF NOT EXISTS template_type VARCHAR(50) NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS source_file_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS source_mime_type VARCHAR(120),
      ADD COLUMN IF NOT EXISTS source_text TEXT,
      ADD COLUMN IF NOT EXISTS source_html TEXT,
      ADD COLUMN IF NOT EXISTS template_content JSONB NOT NULL DEFAULT '{"sections": [], "placeholders": [], "warnings": []}'::jsonb
  `);
  await client.query(`
    UPDATE proposal_templates
    SET template_type = 'legacy'
    WHERE template_type IS NULL OR template_type = ''
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE proposal_templates
      DROP COLUMN IF EXISTS template_content,
      DROP COLUMN IF EXISTS source_html,
      DROP COLUMN IF EXISTS source_text,
      DROP COLUMN IF EXISTS source_mime_type,
      DROP COLUMN IF EXISTS source_file_name,
      DROP COLUMN IF EXISTS template_type
  `);
}