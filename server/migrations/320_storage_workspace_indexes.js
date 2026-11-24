// The workspace reuses the existing file metadata and quota accounting. Trash
// retains bytes as active storage rows until purge; no capacity is released early.
export async function up(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS storage_workspace_recent_idx ON storage_files
      (business_profile_id, user_id, created_at DESC, id DESC) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS storage_workspace_size_idx ON storage_files
      (business_profile_id, user_id, file_size_bytes DESC, id DESC) WHERE is_deleted = false;
    CREATE INDEX IF NOT EXISTS storage_workspace_trash_idx ON storage_files
      ((metadata #>> '{storageWorkspace,trashedAt}')) WHERE is_deleted = false
      AND metadata #>> '{storageWorkspace,trashedAt}' IS NOT NULL;
  `);
}
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS storage_workspace_recent_idx;
    DROP INDEX IF EXISTS storage_workspace_size_idx; DROP INDEX IF EXISTS storage_workspace_trash_idx;`);
}
