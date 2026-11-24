/**
 * Prevent concurrent custom-key uploads from creating multiple live records.
 */
export async function up(client) {
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS storage_files_user_requested_key_unique
      ON storage_files (user_id, (metadata->>'requestedStorageKey'))
      WHERE is_deleted = false AND metadata->>'requestedStorageKey' IS NOT NULL;

    CREATE INDEX IF NOT EXISTS storage_files_pending_cleanup_idx
      ON storage_files (updated_at)
      WHERE jsonb_typeof(metadata->'pendingCleanupKeys') = 'array';
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS storage_files_pending_cleanup_idx;
    DROP INDEX IF EXISTS storage_files_user_requested_key_unique;
  `);
}
