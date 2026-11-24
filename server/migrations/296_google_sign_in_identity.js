export async function up(db) {
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub varchar(255);
    ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users (google_sub)
      WHERE google_sub IS NOT NULL;
  `);
}

export async function down(db) {
  await db.query(`DROP INDEX IF EXISTS users_google_sub_unique;
    UPDATE users SET password = '!' || md5(random()::text) WHERE password IS NULL;
    ALTER TABLE users ALTER COLUMN password SET NOT NULL;
    ALTER TABLE users DROP COLUMN IF EXISTS google_sub;`);
}
