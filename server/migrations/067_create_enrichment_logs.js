/**
 * Migration: create_enrichment_logs
 * Creates enrichment_runs and enrichment_steps tables for tracking
 * lead enrichment activity (Apify actor runs, LLM calls, handle discovery).
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS enrichment_runs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      lead_name VARCHAR(255),
      lead_email VARCHAR(255),
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      total_handles_processed INTEGER DEFAULT 0,
      total_iterations INTEGER DEFAULT 0,
      emails_found INTEGER DEFAULT 0,
      phones_found INTEGER DEFAULT 0,
      websites_found INTEGER DEFAULT 0,
      error_message TEXT,
      summary JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_enrichment_runs_user_id ON enrichment_runs(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_enrichment_runs_lead_id ON enrichment_runs(lead_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_enrichment_runs_status ON enrichment_runs(status)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS enrichment_steps (
      id SERIAL PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES enrichment_runs(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL DEFAULT 0,
      step_type VARCHAR(50) NOT NULL,
      platform VARCHAR(50),
      actor_id VARCHAR(255),
      sub_type VARCHAR(50),
      identifier VARCHAR(500),
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      input JSONB,
      output JSONB,
      items_count INTEGER DEFAULT 0,
      duration_ms INTEGER,
      error_message TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_enrichment_steps_run_id ON enrichment_steps(run_id)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS enrichment_steps`);
  await client.query(`DROP TABLE IF EXISTS enrichment_runs`);
}
