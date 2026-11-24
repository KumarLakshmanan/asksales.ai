/**
 * Project-scoped Google Search Console connections and immutable query/page snapshots.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_gsc_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      credential_id INTEGER REFERENCES api_credentials(id) ON DELETE SET NULL,
      selected_property TEXT,
      permission_level VARCHAR(32),
      available_properties JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(24) NOT NULL DEFAULT 'connected',
      last_synced_at TIMESTAMPTZ,
      last_sync_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_gsc_connections_project_uq
      ON ai_visibility_gsc_connections(project_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_gsc_connections_user_idx
      ON ai_visibility_gsc_connections(user_id, updated_at DESC)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_gsc_snapshots (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      connection_id INTEGER NOT NULL REFERENCES ai_visibility_gsc_connections(id) ON DELETE CASCADE,
      property_uri TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      row_count INTEGER NOT NULL,
      input_fingerprint VARCHAR(64) NOT NULL,
      response_aggregation_type VARCHAR(32),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_gsc_snapshots_project_idx
      ON ai_visibility_gsc_snapshots(project_id, created_at DESC)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_gsc_query_pages (
      id SERIAL PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES ai_visibility_gsc_snapshots(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      page TEXT NOT NULL,
      clicks NUMERIC(14, 4) NOT NULL,
      impressions NUMERIC(14, 4) NOT NULL,
      ctr NUMERIC(10, 8) NOT NULL,
      position NUMERIC(10, 4) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_gsc_query_pages_snapshot_idx
      ON ai_visibility_gsc_query_pages(snapshot_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_gsc_query_pages_project_idx
      ON ai_visibility_gsc_query_pages(project_id, impressions DESC)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS ai_visibility_gsc_query_pages');
  await client.query('DROP TABLE IF EXISTS ai_visibility_gsc_snapshots');
  await client.query('DROP TABLE IF EXISTS ai_visibility_gsc_connections');
}
