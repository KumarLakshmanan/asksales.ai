export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS external_content_enrichments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url_hash VARCHAR(64) NOT NULL,
      canonical_url TEXT NOT NULL,
      platform VARCHAR(32) NOT NULL DEFAULT 'website',
      status VARCHAR(24) NOT NULL CHECK (status IN ('resolved', 'unavailable')),
      resolution_source VARCHAR(32) NOT NULL CHECK (resolution_source IN ('post_cache', 'apify', 'crawler', 'unavailable')),
      actor_id VARCHAR(160),
      actor_run_id VARCHAR(160),
      normalized_data JSONB NOT NULL DEFAULT '{}',
      context TEXT,
      error_code VARCHAR(64),
      error_message TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS external_content_enrichments_tenant_url_uq
      ON external_content_enrichments(user_id, url_hash);
    CREATE INDEX IF NOT EXISTS external_content_enrichments_expires_idx
      ON external_content_enrichments(expires_at);
    CREATE INDEX IF NOT EXISTS external_content_enrichments_tenant_status_idx
      ON external_content_enrichments(user_id, status);
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS external_content_enrichments');
}
