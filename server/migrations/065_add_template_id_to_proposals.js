/**
 * Migration: add_template_id_to_proposals
 * Links proposals to their document template for PDF generation.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE proposals
      ADD COLUMN IF NOT EXISTS template_id INTEGER REFERENCES proposal_templates(id) ON DELETE SET NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_proposals_template_id ON proposals(template_id)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_proposals_template_id`);
  await client.query(`ALTER TABLE proposals DROP COLUMN IF EXISTS template_id`);
}
