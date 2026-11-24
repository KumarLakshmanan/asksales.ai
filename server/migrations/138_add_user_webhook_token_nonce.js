/**
 * Adds an optional per-user nonce so webhook credentials can be rotated while
 * preserving every existing deterministic token until its owner rotates it.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS webhook_token_nonce TEXT;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS webhook_token_nonce;
  `);
}
