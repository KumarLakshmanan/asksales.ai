// One gallery row per generated media file. Rows without a generationKey
// (every existing row) are outside the partial index, so building it cannot
// fail on historical duplicates and changes no data. Reverse: drop the index.
// Publishing copies have publish_platform set and are excluded, so a clone that
// still carried the key could never make a publish transaction fail.
export const transaction = false;

const name = 'content_assets_generation_key_uidx';

export async function up(client) {
  const invalid = await client.query(
    'SELECT 1 FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid', [name],
  );
  if (invalid.rows.length) await client.query(`DROP INDEX CONCURRENTLY ${name}`);
  await client.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${name}
    ON content_assets (user_id, type, (metadata->>'generationKey'))
    WHERE metadata ? 'generationKey' AND publish_platform IS NULL`);
}

export async function down(client) {
  // The rollback runner wraps the batch in a transaction.
  await client.query(`DROP INDEX IF EXISTS ${name}`);
}
