/**
 * Migration: create_system_logs
 * Creates the system_logs table for storing application-level error, warning,
 * and info messages captured by the Pino logger DB stream.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id         SERIAL PRIMARY KEY,
      level      VARCHAR(20)  NOT NULL,
      message    TEXT         NOT NULL,
      source     VARCHAR(255),
      stack      TEXT,
      context    JSONB,
      created_at TIMESTAMP    NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_system_logs_level
      ON system_logs (level)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_system_logs_created_at
      ON system_logs (created_at DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_system_logs_source
      ON system_logs (source)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS system_logs`);
}
