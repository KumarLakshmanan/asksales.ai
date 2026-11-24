/**
 * Durable state for the conversational campaign workflow.
 *
 * This deliberately uses the existing run/action string identifiers so active
 * conversations can be migrated from chat_threads.metadata without changing
 * their correlation IDs.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE icp_profiles
      ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS approved_revision INTEGER
  `);

  await client.query(`
    UPDATE icp_profiles
    SET approved_revision = revision
    WHERE approved = TRUE AND approved_revision IS NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_workflow_runs (
      id VARCHAR(100) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      workflow_type VARCHAR(50) NOT NULL DEFAULT 'campaign',
      stage VARCHAR(64) NOT NULL DEFAULT 'icp_draft',
      status VARCHAR(32) NOT NULL DEFAULT 'running',
      original_request TEXT,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      CONSTRAINT conversation_workflow_runs_status_check CHECK (status IN (
        'awaiting_input', 'awaiting_approval', 'running', 'queued',
        'partial_success', 'succeeded', 'succeeded_empty', 'failed',
        'cancelled', 'gated', 'timed_out'
      )),
      CONSTRAINT conversation_workflow_runs_version_check CHECK (version > 0)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS conversation_workflow_runs_thread_idx
      ON conversation_workflow_runs(user_id, thread_id, updated_at DESC)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_workflow_runs_active_thread_uq
      ON conversation_workflow_runs(user_id, thread_id)
      WHERE status IN ('awaiting_input', 'awaiting_approval', 'running', 'queued')
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_workflow_actions (
      id VARCHAR(160) PRIMARY KEY,
      run_id VARCHAR(100) NOT NULL REFERENCES conversation_workflow_runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      action_type VARCHAR(100) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'awaiting_input',
      idempotency_key VARCHAR(200),
      resource_type VARCHAR(80),
      resource_id VARCHAR(160),
      resource_revision INTEGER,
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      output JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      CONSTRAINT conversation_workflow_actions_status_check CHECK (status IN (
        'awaiting_input', 'awaiting_approval', 'running', 'queued',
        'partial_success', 'succeeded', 'succeeded_empty', 'failed',
        'cancelled', 'gated', 'timed_out'
      )),
      CONSTRAINT conversation_workflow_actions_revision_check CHECK (
        resource_revision IS NULL OR resource_revision > 0
      )
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS conversation_workflow_actions_run_idx
      ON conversation_workflow_actions(run_id, created_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS conversation_workflow_actions_thread_idx
      ON conversation_workflow_actions(user_id, thread_id, updated_at DESC)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_workflow_actions_idempotency_uq
      ON conversation_workflow_actions(run_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);

  await client.query(`
    ALTER TABLE conversation_tool_approvals
      ADD COLUMN IF NOT EXISTS run_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS action_id VARCHAR(160),
      ADD COLUMN IF NOT EXISTS resource_type VARCHAR(80),
      ADD COLUMN IF NOT EXISTS resource_id VARCHAR(160),
      ADD COLUMN IF NOT EXISTS resource_revision INTEGER
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS conversation_tool_approvals_run_action_idx
      ON conversation_tool_approvals(user_id, thread_id, run_id, action_id)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS lead_strategy_selections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id VARCHAR(100) NOT NULL REFERENCES conversation_workflow_runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1,
      status VARCHAR(24) NOT NULL DEFAULT 'draft',
      platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
      workflow_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      selection JSONB NOT NULL DEFAULT '{}'::jsonb,
      confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT lead_strategy_selections_status_check CHECK (status IN ('draft', 'confirmed', 'superseded')),
      CONSTRAINT lead_strategy_selections_revision_check CHECK (revision > 0)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS lead_strategy_selections_run_idx
      ON lead_strategy_selections(run_id, revision DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS lead_input_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id VARCHAR(100) NOT NULL REFERENCES conversation_workflow_runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      strategy_selection_id UUID REFERENCES lead_strategy_selections(id) ON DELETE SET NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      status VARCHAR(24) NOT NULL DEFAULT 'draft',
      input_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
      workflow_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT lead_input_sets_status_check CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'superseded')),
      CONSTRAINT lead_input_sets_revision_check CHECK (revision > 0)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS lead_input_sets_run_idx
      ON lead_input_sets(run_id, revision DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS lead_selection_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id VARCHAR(100) NOT NULL REFERENCES conversation_workflow_runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1,
      status VARCHAR(24) NOT NULL DEFAULT 'draft',
      lead_ids JSONB NOT NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT lead_selection_snapshots_status_check CHECK (status IN ('draft', 'approved', 'superseded')),
      CONSTRAINT lead_selection_snapshots_nonempty_check CHECK (jsonb_array_length(lead_ids) > 0),
      CONSTRAINT lead_selection_snapshots_revision_check CHECK (revision > 0)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS lead_selection_snapshots_run_idx
      ON lead_selection_snapshots(run_id, revision DESC)
  `);

  // Preserve existing workflow snapshots. They remain marked for recovery until
  // a new deterministic transition advances them.
  await client.query(`
    INSERT INTO conversation_workflow_runs (
      id, user_id, thread_id, stage, status, original_request, context,
      created_at, updated_at, completed_at
    )
    SELECT
      COALESCE(NULLIF(metadata #>> '{workflowRun,runId}', ''), gen_random_uuid()::text),
      user_id,
      id,
      'legacy_recovery',
      CASE
        WHEN metadata #>> '{workflowRun,status}' IN (
          'awaiting_input', 'awaiting_approval', 'running', 'queued',
          'partial_success', 'succeeded', 'succeeded_empty', 'failed',
          'cancelled', 'gated', 'timed_out'
        ) THEN metadata #>> '{workflowRun,status}'
        ELSE 'timed_out'
      END,
      NULLIF(metadata ->> 'pipelineRequest', ''),
      jsonb_build_object(
        'legacyRun', COALESCE(metadata -> 'workflowRun', '{}'::jsonb),
        'agentPipeline', COALESCE(metadata -> 'agentPipeline', '[]'::jsonb),
        'agentPipelineIndex', COALESCE(metadata -> 'agentPipelineIndex', '0'::jsonb)
      ),
      COALESCE(
        CASE WHEN metadata #>> '{workflowRun,startedAt}' ~ '^\\d{4}-\\d{2}-\\d{2}[T ]'
          THEN (metadata #>> '{workflowRun,startedAt}')::timestamptz END,
        created_at
      ),
      COALESCE(
        CASE WHEN metadata #>> '{workflowRun,updatedAt}' ~ '^\\d{4}-\\d{2}-\\d{2}[T ]'
          THEN (metadata #>> '{workflowRun,updatedAt}')::timestamptz END,
        updated_at
      ),
      CASE
        WHEN metadata #>> '{workflowRun,status}' IN ('partial_success', 'succeeded', 'succeeded_empty', 'failed', 'cancelled', 'gated', 'timed_out')
        THEN COALESCE(
          CASE WHEN metadata #>> '{workflowRun,completedAt}' ~ '^\\d{4}-\\d{2}-\\d{2}[T ]'
            THEN (metadata #>> '{workflowRun,completedAt}')::timestamptz END,
          updated_at
        )
        ELSE NULL
      END
    FROM chat_threads
    WHERE metadata ? 'workflowRun'
    ON CONFLICT (id) DO NOTHING
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS lead_selection_snapshots');
  await client.query('DROP TABLE IF EXISTS lead_input_sets');
  await client.query('DROP TABLE IF EXISTS lead_strategy_selections');
  await client.query('DROP TABLE IF EXISTS conversation_workflow_actions');
  await client.query('DROP TABLE IF EXISTS conversation_workflow_runs');
  await client.query('DROP INDEX IF EXISTS conversation_tool_approvals_run_action_idx');
  await client.query(`
    ALTER TABLE conversation_tool_approvals
      DROP COLUMN IF EXISTS resource_revision,
      DROP COLUMN IF EXISTS resource_id,
      DROP COLUMN IF EXISTS resource_type,
      DROP COLUMN IF EXISTS action_id,
      DROP COLUMN IF EXISTS run_id
  `);
  await client.query(`
    ALTER TABLE icp_profiles
      DROP COLUMN IF EXISTS approved_revision,
      DROP COLUMN IF EXISTS revision
  `);
}
