// Additive recovery identity; original rows and existing RLS stay unchanged.
export async function up(client) {
  await client.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS creation_request_key varchar(100);
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_base_creation_request_idx
      ON knowledge_base(user_id,COALESCE(business_profile_id,0),creation_request_key)
      WHERE creation_request_key IS NOT NULL`);
}

export async function down(client) {
  const result = await client.query('SELECT 1 FROM knowledge_base WHERE creation_request_key IS NOT NULL LIMIT 1');
  if (result.rows.length) throw new Error('Knowledge recovery identities must be preserved; use a forward migration.');
  await client.query('DROP INDEX IF EXISTS knowledge_base_creation_request_idx; ALTER TABLE knowledge_base DROP COLUMN IF EXISTS creation_request_key');
}
