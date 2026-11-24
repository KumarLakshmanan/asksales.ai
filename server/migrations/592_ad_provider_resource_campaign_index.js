// The analytics sync selection joins ad_provider_resources on campaign_id and
// checks NOT EXISTS (campaign_id, resource_type = 'campaign') for every legacy
// campaign. The table only had (user_id, platform, idempotency_key) indexes,
// so each lookup scanned the table. Built CONCURRENTLY: no write lock.
export const transaction = false;

const name = 'ad_provider_resources_campaign_lookup_idx';

export async function up(client) {
  const invalid = await client.query(
    'SELECT 1 FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid', [name],
  );
  if (invalid.rows.length) await client.query(`DROP INDEX CONCURRENTLY ${name}`);
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ad_provider_resources (campaign_id, resource_type)`,
  );
}

// migrate.mjs runs every down inside one transaction, where CONCURRENTLY is refused.
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS ${name}`);
}
