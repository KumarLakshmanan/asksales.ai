/**
 * Migration: add_lead_score_icp_score
 * Adds lead_score and icp_score integer columns to the leads table.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS lead_score INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS icp_score INTEGER DEFAULT 0
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE leads
      DROP COLUMN IF EXISTS lead_score,
      DROP COLUMN IF EXISTS icp_score
  `);
}
