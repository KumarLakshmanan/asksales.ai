/** Serialize resource revisions within each durable conversation workflow run. */
export async function up(client) {
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS lead_strategy_selections_run_revision_uq
      ON lead_strategy_selections(run_id, revision)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS lead_input_sets_run_revision_uq
      ON lead_input_sets(run_id, revision)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS lead_selection_snapshots_run_revision_uq
      ON lead_selection_snapshots(run_id, revision)
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS lead_selection_snapshots_run_revision_uq');
  await client.query('DROP INDEX IF EXISTS lead_input_sets_run_revision_uq');
  await client.query('DROP INDEX IF EXISTS lead_strategy_selections_run_revision_uq');
}
