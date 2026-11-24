/** CTR is stored in percentage points (0–100), not a fractional ratio. */
export async function up(client) {
  await client.query('ALTER TABLE performance_metrics ALTER COLUMN ctr TYPE NUMERIC(9,6)');
}

export async function down(client) {
  // PostgreSQL refuses this atomically if any values no longer fit. Never clamp
  // or delete reporting facts merely to permit a rollback.
  await client.query('ALTER TABLE performance_metrics ALTER COLUMN ctr TYPE NUMERIC(5,4)');
}
