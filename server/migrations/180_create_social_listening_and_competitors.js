/** Public-source listening and competitor snapshots. No private/scraped-source payloads are accepted. */
export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS social_listening_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform VARCHAR(24) NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL, public_url TEXT, author_handle VARCHAR(255), body TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
    sentiment VARCHAR(16) NOT NULL DEFAULT 'unknown' CHECK(sentiment IN ('positive','neutral','negative','mixed','unknown')), sentiment_score NUMERIC(5,4), metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source VARCHAR(32) NOT NULL CHECK(source IN ('official_api','public_export')), ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, platform, provider_event_id)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS social_listening_events_user_time_idx ON social_listening_events(user_id, platform, occurred_at DESC)`);
  await client.query(`CREATE TABLE IF NOT EXISTS social_competitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform VARCHAR(24) NOT NULL,
    public_handle VARCHAR(255) NOT NULL, display_name VARCHAR(255), public_url TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, platform, public_handle)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS social_competitor_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), competitor_id UUID NOT NULL REFERENCES social_competitors(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source VARCHAR(32) NOT NULL CHECK(source IN ('official_api','public_export')),
    metrics JSONB NOT NULL CHECK(jsonb_typeof(metrics) = 'object'), source_url TEXT NOT NULL
  )`);
}
export async function down(client) { await client.query(`DROP TABLE IF EXISTS social_competitor_snapshots, social_competitors, social_listening_events`); }
