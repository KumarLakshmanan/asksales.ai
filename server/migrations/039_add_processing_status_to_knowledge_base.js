/**
 * Migration: add_processing_status_to_knowledge_base
 * Adds processing_status column to knowledge_base for async file conversion lifecycle.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE knowledge_base
    ADD COLUMN IF NOT EXISTS processing_status VARCHAR(20) NOT NULL DEFAULT 'completed'
  `);

  await client.query(`
    UPDATE knowledge_base
    SET processing_status = CASE
      WHEN type = 'file' THEN 'queued'
      ELSE 'completed'
    END
    WHERE processing_status IS NULL OR processing_status = ''
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE knowledge_base
    DROP COLUMN IF EXISTS processing_status
  `);
}
