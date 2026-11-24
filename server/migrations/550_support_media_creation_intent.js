// Additive parent-creation receipts. Existing galleries keep their behavior.
export async function up(client) {
  await client.query(`ALTER TABLE support_media_galleries
    ADD COLUMN IF NOT EXISTS creation_request_key varchar(100),
    ADD COLUMN IF NOT EXISTS creation_request_hash varchar(64),
    ADD COLUMN IF NOT EXISTS creation_actor_user_id integer;
    CREATE UNIQUE INDEX IF NOT EXISTS support_media_creation_intent_idx
      ON support_media_galleries(user_id,business_profile_id,creation_actor_user_id,creation_request_key)
      WHERE creation_request_key IS NOT NULL`);
}

export async function down(client) {
  const result = await client.query('SELECT 1 FROM support_media_galleries WHERE creation_request_key IS NOT NULL LIMIT 1');
  if (result.rows.length) throw new Error('Media creation identities must be preserved; use a reviewed forward migration.');
  await client.query(`DROP INDEX IF EXISTS support_media_creation_intent_idx;
    ALTER TABLE support_media_galleries DROP COLUMN IF EXISTS creation_request_key,
      DROP COLUMN IF EXISTS creation_request_hash,DROP COLUMN IF EXISTS creation_actor_user_id`);
}
