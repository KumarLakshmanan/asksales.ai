/**
 * Migration 108: Add secure customer delivery and acceptance fields to proposals.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE proposals
      ADD COLUMN IF NOT EXISTS recipient_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS recipient_email VARCHAR(320),
      ADD COLUMN IF NOT EXISTS public_token_hash VARCHAR(64),
      ADD COLUMN IF NOT EXISTS signed_by_name VARCHAR(255)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_public_token_hash
      ON proposals(public_token_hash)
      WHERE public_token_hash IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_proposals_recipient_email
      ON proposals(recipient_email)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_proposals_recipient_email`);
  await client.query(`DROP INDEX IF EXISTS idx_proposals_public_token_hash`);
  await client.query(`
    ALTER TABLE proposals
      DROP COLUMN IF EXISTS signed_by_name,
      DROP COLUMN IF EXISTS public_token_hash,
      DROP COLUMN IF EXISTS recipient_email,
      DROP COLUMN IF EXISTS recipient_name
  `);
}
