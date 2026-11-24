export const transaction = false;

const indexes = [
  ['ad_analytics_sync_runs_backoff_lookup_idx',
    'ad_analytics_sync_runs (user_id, campaign_id, platform, status, completed_at DESC)'],
  ['crm_activities_pipeline_stage_lookup_idx',
    "crm_activities (user_id, contact_id, created_at DESC) WHERE type = 'pipeline_change'"],
];

export async function up(client) {
  for (const [name, definition] of indexes) {
    const invalid = await client.query(
      'SELECT 1 FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid', [name],
    );
    if (invalid.rows.length) await client.query(`DROP INDEX CONCURRENTLY ${name}`);
    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${definition}`);
  }
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS ${indexes.map(([name]) => name).join(', ')}`);
}
