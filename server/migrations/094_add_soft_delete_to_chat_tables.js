/**
 * Migration: add_soft_delete_to_chat_tables
 *
 * Adds `deleted_at` and `deleted_by` columns to chat_messages and chat_threads
 * to support GDPR-compliant soft deletion. All existing SELECT queries should
 * filter on `WHERE deleted_at IS NULL` after this migration.
 *
 * Phase 1: Schema-only. A separate admin job or cron will hard-delete records
 * past the retention period.
 */

export async function up(client) {
  // ── chat_messages ──────────────────────────────────────────────────
  await client.query(`
    ALTER TABLE chat_messages
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS deleted_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_deleted_at
      ON chat_messages(deleted_at) WHERE deleted_at IS NULL
  `);

  // ── chat_threads ───────────────────────────────────────────────────
  await client.query(`
    ALTER TABLE chat_threads
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS deleted_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_threads_deleted_at
      ON chat_threads(deleted_at) WHERE deleted_at IS NULL
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_chat_messages_deleted_at`);
  await client.query(`ALTER TABLE chat_messages DROP COLUMN IF EXISTS deleted_at`);
  await client.query(`ALTER TABLE chat_messages DROP COLUMN IF EXISTS deleted_by`);

  await client.query(`DROP INDEX IF EXISTS idx_chat_threads_deleted_at`);
  await client.query(`ALTER TABLE chat_threads DROP COLUMN IF EXISTS deleted_at`);
  await client.query(`ALTER TABLE chat_threads DROP COLUMN IF EXISTS deleted_by`);
}
