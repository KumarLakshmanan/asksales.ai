// The CRM board, My work and Reports derive each contact's stage history from
// crm_activities rows of type 'pipeline_change' (stage_changes, visits and the
// flow query). The table only had single-column indexes, so each lookup by
// user and contact scanned the whole activity log. A partial index covers the
// lookup and stays small because it holds only pipeline changes.
// Built CONCURRENTLY: no write lock on crm_activities.
export const transaction = false;

const name = 'crm_activities_pipeline_change_contact_idx';

export async function up(client) {
  const invalid = await client.query(
    'SELECT 1 FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid', [name],
  );
  if (invalid.rows.length) await client.query(`DROP INDEX CONCURRENTLY ${name}`);
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
       ON crm_activities (user_id, contact_id, created_at)
       WHERE type = 'pipeline_change'`,
  );
}

// migrate.mjs runs every down inside one transaction, where CONCURRENTLY is refused.
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS ${name}`);
}
