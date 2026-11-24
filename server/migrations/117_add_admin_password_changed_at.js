/** Invalidate existing admin sessions after a password reset. */
export async function up(client) {
  await client.query(`
    ALTER TABLE admins
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP
  `);
  await client.query(`
    ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE admins
    DROP COLUMN IF EXISTS password_changed_at
  `);
  await client.query(`
    ALTER TABLE team_members
    DROP COLUMN IF EXISTS password_changed_at
  `);
}
