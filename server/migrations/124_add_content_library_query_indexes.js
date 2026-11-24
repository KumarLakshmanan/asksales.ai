/**
 * Migration 124: Cover the user-scoped content library filters used by the
 * client without loading and filtering an entire account in application code.
 */

export async function up(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_assets_user_updated_idx
    ON content_assets(user_id, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_assets_user_type_updated_idx
    ON content_assets(user_id, type, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_assets_user_thread_updated_idx
    ON content_assets(user_id, thread_id, updated_at DESC)
    WHERE thread_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_templates_user_type_updated_idx
    ON content_templates(user_id, type, updated_at DESC)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS content_templates_user_type_updated_idx`);
  await client.query(`DROP INDEX IF EXISTS content_assets_user_thread_updated_idx`);
  await client.query(`DROP INDEX IF EXISTS content_assets_user_type_updated_idx`);
  await client.query(`DROP INDEX IF EXISTS content_assets_user_updated_idx`);
}
