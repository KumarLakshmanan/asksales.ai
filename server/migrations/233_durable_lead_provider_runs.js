/** Durable lead-provider receipts used for restart reconciliation and retry safety. */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS lead_generation_provider_runs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      lead_input_id INTEGER REFERENCES lead_inputs(id) ON DELETE SET NULL,
      execution_id VARCHAR(255) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      platform VARCHAR(100) NOT NULL,
      workflow_id VARCHAR(255) NOT NULL,
      node_key VARCHAR(255) NOT NULL,
      actor_id VARCHAR(255) NOT NULL,
      actor_run_id VARCHAR(255),
      dataset_id VARCHAR(255),
      status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'syncing', 'succeeded', 'succeeded_empty', 'partial_success', 'failed', 'cancelled')),
      requested_lead_limit INTEGER CHECK (requested_lead_limit IS NULL OR requested_lead_limit > 0),
      fetched_count INTEGER NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
      accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
      persisted_count INTEGER NOT NULL DEFAULT 0 CHECK (persisted_count >= 0),
      duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
      rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
      provider_result JSONB,
      error TEXT,
      started_at TIMESTAMP,
      heartbeat_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lead_generation_provider_runs_idempotency_uq
      ON lead_generation_provider_runs(idempotency_key);
    CREATE INDEX IF NOT EXISTS lead_generation_provider_runs_execution_idx
      ON lead_generation_provider_runs(execution_id);
    CREATE INDEX IF NOT EXISTS lead_generation_provider_runs_thread_idx
      ON lead_generation_provider_runs(thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS lead_generation_provider_runs_status_heartbeat_idx
      ON lead_generation_provider_runs(status, heartbeat_at);
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS lead_generation_provider_runs');
}
