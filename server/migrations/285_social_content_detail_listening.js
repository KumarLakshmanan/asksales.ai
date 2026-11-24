export async function up(client) {
  await client.query(`ALTER TABLE social_content_items
    ADD COLUMN IF NOT EXISTS provider_media_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS media_url TEXT,
    ADD COLUMN IF NOT EXISTS media_type VARCHAR(40),
    ADD COLUMN IF NOT EXISTS media_children JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS listening_attempted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS listening_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS listening_after TEXT`);
  await client.query(
    `ALTER TABLE social_content_syncs ADD COLUMN IF NOT EXISTS discovery_state JSONB NOT NULL DEFAULT '{}'::jsonb`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS social_content_media_alias_idx ON social_content_items(credential_id,provider_media_id) WHERE provider_media_id IS NOT NULL`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS social_content_listening_queue_idx ON social_content_items(credential_id,listening_attempted_at NULLS FIRST) WHERE content_type <> 'story'`,
  );
}
export async function down(client) {
  await client.query(
    "ALTER TABLE social_content_syncs DROP COLUMN IF EXISTS discovery_state",
  );
  await client.query("DROP INDEX IF EXISTS social_content_listening_queue_idx");
  await client.query("DROP INDEX IF EXISTS social_content_media_alias_idx");
  await client.query(
    `ALTER TABLE social_content_items DROP COLUMN IF EXISTS provider_media_id,DROP COLUMN IF EXISTS media_url,DROP COLUMN IF EXISTS media_type,DROP COLUMN IF EXISTS media_children,DROP COLUMN IF EXISTS listening_attempted_at,DROP COLUMN IF EXISTS listening_completed_at,DROP COLUMN IF EXISTS listening_after`,
  );
}
