/** Bring early P2 deployments to the immutable/idempotent snapshot contract. */
export async function up(client) {
  await client.query(`UPDATE social_metric_snapshots SET source_snapshot_id = 'legacy:' || id::text WHERE source_snapshot_id IS NULL`);
  await client.query(`ALTER TABLE social_metric_snapshots ALTER COLUMN source_snapshot_id SET NOT NULL`);
  await client.query(`CREATE OR REPLACE FUNCTION prevent_social_metric_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'social metric snapshots are immutable'; END; $$`);
  await client.query(`DROP TRIGGER IF EXISTS social_metric_snapshots_immutable ON social_metric_snapshots`);
  await client.query(`CREATE TRIGGER social_metric_snapshots_immutable BEFORE UPDATE OR DELETE ON social_metric_snapshots FOR EACH ROW EXECUTE FUNCTION prevent_social_metric_snapshot_mutation()`);
}
export async function down(client) {
  await client.query(`DROP TRIGGER IF EXISTS social_metric_snapshots_immutable ON social_metric_snapshots`);
  await client.query(`ALTER TABLE social_metric_snapshots ALTER COLUMN source_snapshot_id DROP NOT NULL`);
}
