/**
 * Migration: add_lead_source_tracking
 * Adds sourcePostId (FK to posts) and engagementType columns to leads table
 * for tracking which post a lead came from and what interaction triggered it.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS source_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS engagement_type VARCHAR(100);

    CREATE INDEX IF NOT EXISTS leads_source_post_id_idx ON leads(source_post_id);
    CREATE INDEX IF NOT EXISTS leads_engagement_type_idx ON leads(engagement_type);
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS leads_engagement_type_idx;
    DROP INDEX IF EXISTS leads_source_post_id_idx;
    ALTER TABLE leads
      DROP COLUMN IF EXISTS engagement_type,
      DROP COLUMN IF EXISTS source_post_id;
  `);
}
