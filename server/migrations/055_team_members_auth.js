/**
 * Migration: team_members_auth
 * Adds password_hash, is_active columns to team_members for support portal login.
 */

export async function up(client) {
  // Add password_hash for support member login
  await client.query(`
    ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)
  `);

  // Add is_active flag to enable/disable support members
  await client.query(`
    ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
  `);

  // Index for email lookups during login
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members(email)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_team_members_email`);
  await client.query(`ALTER TABLE team_members DROP COLUMN IF EXISTS is_active`);
  await client.query(`ALTER TABLE team_members DROP COLUMN IF EXISTS password_hash`);
}
