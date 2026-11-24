/** Distinguish new transactional preparations from legacy/possibly sent occurrences. */
export async function up(client) {
  await client.query(`ALTER TABLE social_report_deliveries
    ADD COLUMN IF NOT EXISTS preparation_version SMALLINT NOT NULL DEFAULT 0 CHECK (preparation_version IN (0,1)),
    ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS generation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (generation_attempts >= 0)`);
  // No historical replay/backfill. Version 0 remains conservative, including
  // writes by an older worker during a rolling upgrade. Only new code sets 1.
}
export async function down(client) {
  await client.query(`ALTER TABLE social_report_deliveries
    DROP COLUMN IF EXISTS generation_attempts,
    DROP COLUMN IF EXISTS dispatch_started_at,
    DROP COLUMN IF EXISTS preparation_version`);
}
