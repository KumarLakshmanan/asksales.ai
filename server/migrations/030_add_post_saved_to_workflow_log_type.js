/**
 * Migration: add_post_saved_to_workflow_log_type
 * Add 'post_saved' value to the workflow_log_type enum.
 */

export async function up(client) {
  await client.query(`
    ALTER TYPE workflow_log_type ADD VALUE IF NOT EXISTS 'post_saved'
  `);
}

export async function down(client) {
  // PostgreSQL does not support removing enum values directly.
  // This is a no-op for safety.
}
