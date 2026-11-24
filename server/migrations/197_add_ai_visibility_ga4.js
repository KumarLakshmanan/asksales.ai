/**
 * Project-scoped Google Analytics 4 connections and immutable attribution snapshots.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_ga4_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      credential_id INTEGER REFERENCES api_credentials(id) ON DELETE SET NULL,
      selected_property TEXT,
      available_properties JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(24) NOT NULL DEFAULT 'property_required',
      last_synced_at TIMESTAMPTZ,
      last_sync_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_ga4_connections_project_uq
      ON ai_visibility_ga4_connections(project_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_ga4_connections_user_idx
      ON ai_visibility_ga4_connections(user_id, updated_at DESC)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_ga4_snapshots (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      connection_id INTEGER NOT NULL REFERENCES ai_visibility_ga4_connections(id) ON DELETE CASCADE,
      property_resource TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      row_count INTEGER NOT NULL,
      input_fingerprint VARCHAR(64) NOT NULL,
      total_sessions NUMERIC(16, 4) NOT NULL DEFAULT 0,
      total_users NUMERIC(16, 4) NOT NULL DEFAULT 0,
      total_key_events NUMERIC(16, 4) NOT NULL DEFAULT 0,
      engagement_rate NUMERIC(10, 8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_ga4_snapshots_project_idx
      ON ai_visibility_ga4_snapshots(project_id, created_at DESC)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_ga4_snapshots_fingerprint_uq
      ON ai_visibility_ga4_snapshots(project_id, input_fingerprint)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_ga4_attribution_rows (
      id SERIAL PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES ai_visibility_ga4_snapshots(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      landing_page TEXT NOT NULL,
      channel_group VARCHAR(255) NOT NULL,
      sessions NUMERIC(16, 4) NOT NULL,
      total_users NUMERIC(16, 4) NOT NULL,
      key_events NUMERIC(16, 4) NOT NULL,
      engagement_rate NUMERIC(10, 8) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_ga4_rows_snapshot_idx
      ON ai_visibility_ga4_attribution_rows(snapshot_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_ga4_rows_project_idx
      ON ai_visibility_ga4_attribution_rows(project_id, sessions DESC)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS ai_visibility_ga4_attribution_rows');
  await client.query('DROP TABLE IF EXISTS ai_visibility_ga4_snapshots');
  await client.query('DROP TABLE IF EXISTS ai_visibility_ga4_connections');
}
