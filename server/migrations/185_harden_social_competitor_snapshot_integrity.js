/** Backfill and lock existing P2 competitor observations as immutable source citations. */
export async function up(client) {
  await client.query(`ALTER TABLE social_competitor_snapshots ADD COLUMN IF NOT EXISTS source_snapshot_id VARCHAR(255)`);
  await client.query(`UPDATE social_competitor_snapshots SET source_snapshot_id = 'legacy:' || id::text WHERE source_snapshot_id IS NULL`);
  await client.query(`ALTER TABLE social_competitor_snapshots ALTER COLUMN source_snapshot_id SET NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS social_competitor_snapshot_source_uq ON social_competitor_snapshots(competitor_id, source, source_snapshot_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS social_competitor_snapshot_tenant_idx ON social_competitor_snapshots(user_id, competitor_id, captured_at DESC)`);
  await client.query(`CREATE OR REPLACE FUNCTION prevent_social_competitor_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'social competitor snapshots are immutable'; END; $$`);
  await client.query(`DROP TRIGGER IF EXISTS social_competitor_snapshots_immutable ON social_competitor_snapshots`);
  await client.query(`CREATE TRIGGER social_competitor_snapshots_immutable BEFORE UPDATE OR DELETE ON social_competitor_snapshots FOR EACH ROW EXECUTE FUNCTION prevent_social_competitor_snapshot_mutation()`);
}
export async function down(client) {
  await client.query(`DROP TRIGGER IF EXISTS social_competitor_snapshots_immutable ON social_competitor_snapshots`);
  await client.query(`DROP FUNCTION IF EXISTS prevent_social_competitor_snapshot_mutation()`);
  await client.query(`DROP INDEX IF EXISTS social_competitor_snapshot_source_uq, social_competitor_snapshot_tenant_idx`);
  await client.query(`ALTER TABLE social_competitor_snapshots DROP COLUMN IF EXISTS source_snapshot_id`);
}
