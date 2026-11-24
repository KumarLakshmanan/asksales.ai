/**
 * Migration 088 — user_consents table (GDPR opt-out / data-export audit).
 * Tracks when a user opts out of marketing channels and records data-export requests.
 */
export const up = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_consents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      consent_type TEXT NOT NULL,
      granted BOOLEAN NOT NULL,
      reason TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS user_consents_user_id_idx ON user_consents (user_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS user_consents_type_granted_idx ON user_consents (consent_type, granted);`);
};

export const down = async (db) => {
  await db.query(`DROP TABLE IF EXISTS user_consents;`);
};
