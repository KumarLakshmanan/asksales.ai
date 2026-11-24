/** Comparable competitor windows and report-delivery inspection. */
export async function up(client) {
  await client.query(`
    ALTER TABLE social_competitor_snapshots ADD COLUMN IF NOT EXISTS metric_window_start TIMESTAMPTZ;
    ALTER TABLE social_competitor_snapshots ADD COLUMN IF NOT EXISTS metric_window_end TIMESTAMPTZ;
    ALTER TABLE social_competitor_snapshots DROP CONSTRAINT IF EXISTS social_competitor_snapshot_window_check;
    ALTER TABLE social_competitor_snapshots ADD CONSTRAINT social_competitor_snapshot_window_check
      CHECK(metric_window_start IS NULL OR metric_window_end IS NULL OR metric_window_start <= metric_window_end);
    CREATE INDEX IF NOT EXISTS social_competitor_snapshot_window_idx
      ON social_competitor_snapshots(user_id, competitor_id, metric_window_start, metric_window_end);
  `);
}
export async function down(client) {
  await client.query(`ALTER TABLE social_competitor_snapshots DROP CONSTRAINT IF EXISTS social_competitor_snapshot_window_check`);
  await client.query(`ALTER TABLE social_competitor_snapshots DROP COLUMN IF EXISTS metric_window_start, DROP COLUMN IF EXISTS metric_window_end`);
}
