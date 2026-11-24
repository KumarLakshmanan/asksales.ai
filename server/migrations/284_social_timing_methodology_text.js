/** Publishing guidance includes the ranking method and evidence limitations. */
export async function up(client) {
  await client.query('ALTER TABLE social_best_time_recommendations ALTER COLUMN methodology TYPE TEXT');
}

export async function down(client) {
  // PostgreSQL refuses this rollback if longer explanations exist, preserving
  // evidence instead of silently truncating the persisted methodology.
  await client.query('ALTER TABLE social_best_time_recommendations ALTER COLUMN methodology TYPE VARCHAR(80)');
}
