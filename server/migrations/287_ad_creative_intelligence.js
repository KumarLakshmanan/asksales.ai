/** Immutable owner-scoped research snapshots and reviewable creative suggestions. */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_creative_research_runs (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id UUID NOT NULL, input_hash TEXT NOT NULL, input JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','partial','empty','coverage_unavailable','permission_required','provider_error','failed')),
      "references" JSONB NOT NULL DEFAULT '[]', message TEXT,
      cache_key TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,request_id), UNIQUE(id,user_id)
    );
    CREATE INDEX IF NOT EXISTS ad_creative_research_cache_idx ON ad_creative_research_runs(user_id,cache_key,expires_at DESC);
    CREATE TABLE IF NOT EXISTS ad_creative_briefs (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id UUID NOT NULL, input_hash TEXT NOT NULL, input JSONB NOT NULL,
      context JSONB NOT NULL DEFAULT '{}', evidence JSONB NOT NULL DEFAULT '[]', concepts JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed')),
      selected_concept_id TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      schema_version INTEGER NOT NULL DEFAULT 1, prompt_version TEXT NOT NULL DEFAULT 'creative-brief-v1',
      message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,request_id), UNIQUE(id,user_id)
    );
    CREATE INDEX IF NOT EXISTS ad_creative_briefs_owner_idx ON ad_creative_briefs(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS ad_creative_brief_assets (
      brief_id INTEGER NOT NULL, user_id INTEGER NOT NULL, brief_revision INTEGER NOT NULL,
      concept_id TEXT NOT NULL, content_asset_id INTEGER NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(brief_id,content_asset_id),
      FOREIGN KEY(brief_id,user_id) REFERENCES ad_creative_briefs(id,user_id) ON DELETE CASCADE
    );
  `);
}
export async function down(client) {
  await client.query(
    "DROP TABLE IF EXISTS ad_creative_brief_assets; DROP TABLE IF EXISTS ad_creative_briefs; DROP TABLE IF EXISTS ad_creative_research_runs;",
  );
}
