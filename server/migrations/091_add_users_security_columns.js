/**
 * Migration 091 — users table security columns
 * Phase 5.14 / MODEL-009: account-lockout / soft-delete / password-rotation
 * tracking. Nullable so the migration is non-blocking on existing rows.
 */
export const up = async (db) => {
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP WITH TIME ZONE;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP WITH TIME ZONE;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;`);
  await db.query(`CREATE INDEX IF NOT EXISTS users_deleted_at_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;`);
  await db.query(`CREATE INDEX IF NOT EXISTS users_locked_until_idx ON users (locked_until) WHERE locked_until IS NOT NULL;`);
};

export const down = async (db) => {
  await db.query(`DROP INDEX IF EXISTS users_locked_until_idx;`);
  await db.query(`DROP INDEX IF EXISTS users_deleted_at_idx;`);
  await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;`);
  await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at;`);
  await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS locked_until;`);
  await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS failed_login_attempts;`);
  await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;`);
};
