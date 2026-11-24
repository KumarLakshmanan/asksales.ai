/** Immutable provider-normalized analytics snapshots and derived best-time recommendations. */
export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS social_metric_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform VARCHAR(24) NOT NULL CHECK(platform IN ('facebook','instagram','youtube')), account_identifier VARCHAR(255) NOT NULL,
    metric_window_start TIMESTAMPTZ NOT NULL, metric_window_end TIMESTAMPTZ NOT NULL, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source VARCHAR(32) NOT NULL CHECK(source IN ('official_api','manual_import','provider_export')), source_snapshot_id VARCHAR(255) NOT NULL,
    metrics JSONB NOT NULL CHECK(jsonb_typeof(metrics) = 'object'), timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
    UNIQUE(user_id, platform, account_identifier, metric_window_start, metric_window_end, source, source_snapshot_id)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS social_metric_snapshot_account_idx ON social_metric_snapshots(user_id, platform, account_identifier, metric_window_end DESC)`);
  await client.query(`CREATE OR REPLACE FUNCTION prevent_social_metric_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'social metric snapshots are immutable'; END; $$`);
  await client.query(`DROP TRIGGER IF EXISTS social_metric_snapshots_immutable ON social_metric_snapshots`);
  await client.query(`CREATE TRIGGER social_metric_snapshots_immutable BEFORE UPDATE OR DELETE ON social_metric_snapshots FOR EACH ROW EXECUTE FUNCTION prevent_social_metric_snapshot_mutation()`);
  await client.query(`CREATE TABLE IF NOT EXISTS social_best_time_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform VARCHAR(24) NOT NULL, account_identifier VARCHAR(255) NOT NULL, timezone VARCHAR(80) NOT NULL,
    sample_size INTEGER NOT NULL CHECK(sample_size >= 0), confidence NUMERIC(5,4) NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    fallback_used BOOLEAN NOT NULL DEFAULT FALSE, methodology VARCHAR(80) NOT NULL, recommended_slots JSONB NOT NULL CHECK(jsonb_typeof(recommended_slots) = 'array'),
    source_snapshot_ids JSONB NOT NULL CHECK(jsonb_typeof(source_snapshot_ids) = 'array'), computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS social_best_time_user_idx ON social_best_time_recommendations(user_id, platform, account_identifier, computed_at DESC)`);
}
export async function down(client) { await client.query(`DROP TRIGGER IF EXISTS social_metric_snapshots_immutable ON social_metric_snapshots`); await client.query(`DROP FUNCTION IF EXISTS prevent_social_metric_snapshot_mutation()`); await client.query(`DROP TABLE IF EXISTS social_best_time_recommendations, social_metric_snapshots`); }
