/**
 * Migration: add_threadid_resolution_to_gemini_usages
 * Adds threadId and resolution columns to gemini_usages table for better logging.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE gemini_usages
      ADD COLUMN IF NOT EXISTS thread_id INTEGER,
      ADD COLUMN IF NOT EXISTS resolution VARCHAR(50)
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE gemini_usages
      DROP COLUMN IF EXISTS thread_id,
      DROP COLUMN IF EXISTS resolution
  `);
}
