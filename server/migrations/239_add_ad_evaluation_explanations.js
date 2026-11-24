/** Persists the human-readable, deterministic explanation shown on campaign pages. */
export async function up(client) {
  await client.query(`ALTER TABLE ad_performance_evaluations ADD COLUMN IF NOT EXISTS rationale TEXT`);
  await client.query(`ALTER TABLE ad_performance_evaluations ADD COLUMN IF NOT EXISTS expected_direction TEXT`);
  await client.query(`ALTER TABLE ad_performance_evaluations ADD COLUMN IF NOT EXISTS suggested_next_step TEXT`);
}

export async function down(client) {
  await client.query(`ALTER TABLE ad_performance_evaluations DROP COLUMN IF EXISTS suggested_next_step`);
  await client.query(`ALTER TABLE ad_performance_evaluations DROP COLUMN IF EXISTS expected_direction`);
  await client.query(`ALTER TABLE ad_performance_evaluations DROP COLUMN IF EXISTS rationale`);
}
