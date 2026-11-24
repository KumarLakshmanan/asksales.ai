/**
 * Repair Conversation Builder databases that were partially upgraded around
 * migrations 156/157. This migration is deliberately idempotent: it restores
 * the runtime columns and indexes without dropping user-owned conversation
 * data or attempting to replay any tool/provider operation.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_tool_approvals (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      request_id VARCHAR(255) NOT NULL,
      tool_name VARCHAR(255) NOT NULL,
      tool_args JSONB NOT NULL DEFAULT '{}'::jsonb,
      overrides JSONB,
      decision VARCHAR(16) NOT NULL,
      status VARCHAR(24) NOT NULL,
      execution_result JSONB,
      execution_error TEXT,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      lease_token VARCHAR(100),
      lease_expires_at TIMESTAMP,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE conversation_tool_approvals
      ADD COLUMN IF NOT EXISTS user_id INTEGER,
      ADD COLUMN IF NOT EXISTS thread_id INTEGER,
      ADD COLUMN IF NOT EXISTS request_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS tool_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS tool_args JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS overrides JSONB,
      ADD COLUMN IF NOT EXISTS decision VARCHAR(16),
      ADD COLUMN IF NOT EXISTS status VARCHAR(24),
      ADD COLUMN IF NOT EXISTS execution_result JSONB,
      ADD COLUMN IF NOT EXISTS execution_error TEXT,
      ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS lease_token VARCHAR(100),
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

    UPDATE conversation_tool_approvals
    SET
      request_id = COALESCE(NULLIF(request_id, ''), 'legacy-' || id::text),
      tool_name = COALESCE(NULLIF(tool_name, ''), 'legacy_unknown'),
      tool_args = COALESCE(tool_args, '{}'::jsonb),
      decision = CASE WHEN decision IN ('approve', 'reject') THEN decision ELSE 'approve' END,
      status = CASE
        WHEN status IN ('running', 'succeeded', 'failed', 'rejected') THEN status
        ELSE 'failed'
      END,
      execution_result = CASE
        WHEN status IN ('running', 'succeeded', 'failed', 'rejected') THEN execution_result
        ELSE COALESCE(execution_result, '{}'::jsonb) || jsonb_build_object(
          'ambiguous', true,
          'retrySafe', false,
          'reason', 'legacy_status_repaired'
        )
      END,
      execution_error = CASE
        WHEN status IN ('running', 'succeeded', 'failed', 'rejected') THEN execution_error
        ELSE COALESCE(execution_error, 'Legacy approval state requires manual reconciliation')
      END,
      attempt_count = GREATEST(COALESCE(attempt_count, 1), 1),
      created_at = COALESCE(created_at, NOW()),
      updated_at = COALESCE(updated_at, NOW());

    WITH duplicate_requests AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY user_id, thread_id, request_id, tool_name
        ORDER BY created_at ASC, id ASC
      ) AS duplicate_rank
      FROM conversation_tool_approvals
    )
    UPDATE conversation_tool_approvals approval
    SET request_id = LEFT(approval.request_id, 220) || '-legacy-dup-' || approval.id::text
    FROM duplicate_requests duplicate
    WHERE approval.id = duplicate.id AND duplicate.duplicate_rank > 1;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM conversation_tool_approvals
        WHERE user_id IS NULL OR thread_id IS NULL
      ) THEN
        RAISE EXCEPTION 'conversation_tool_approvals contains rows without tenant/thread ownership';
      END IF;
    END $$;

    ALTER TABLE conversation_tool_approvals
      ALTER COLUMN user_id SET NOT NULL,
      ALTER COLUMN thread_id SET NOT NULL,
      ALTER COLUMN request_id SET NOT NULL,
      ALTER COLUMN tool_name SET NOT NULL,
      ALTER COLUMN tool_args SET DEFAULT '{}'::jsonb,
      ALTER COLUMN tool_args SET NOT NULL,
      ALTER COLUMN decision SET NOT NULL,
      ALTER COLUMN status SET NOT NULL,
      ALTER COLUMN attempt_count SET DEFAULT 1,
      ALTER COLUMN attempt_count SET NOT NULL,
      ALTER COLUMN created_at SET DEFAULT NOW(),
      ALTER COLUMN created_at SET NOT NULL,
      ALTER COLUMN updated_at SET DEFAULT NOW(),
      ALTER COLUMN updated_at SET NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'conversation_tool_approvals'::regclass
          AND conname = 'conversation_tool_approvals_user_id_fkey'
      ) THEN
        ALTER TABLE conversation_tool_approvals
          ADD CONSTRAINT conversation_tool_approvals_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'conversation_tool_approvals'::regclass
          AND conname = 'conversation_tool_approvals_thread_id_fkey'
      ) THEN
        ALTER TABLE conversation_tool_approvals
          ADD CONSTRAINT conversation_tool_approvals_thread_id_fkey
          FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'conversation_tool_approvals'::regclass
          AND conname = 'conversation_tool_approvals_decision_check'
      ) THEN
        ALTER TABLE conversation_tool_approvals
          ADD CONSTRAINT conversation_tool_approvals_decision_check
          CHECK (decision IN ('approve', 'reject'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'conversation_tool_approvals'::regclass
          AND conname = 'conversation_tool_approvals_status_check'
      ) THEN
        ALTER TABLE conversation_tool_approvals
          ADD CONSTRAINT conversation_tool_approvals_status_check
          CHECK (status IN ('running', 'succeeded', 'failed', 'rejected'));
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS conversation_tool_approvals_request_uq
      ON conversation_tool_approvals(user_id, thread_id, request_id, tool_name);
    CREATE INDEX IF NOT EXISTS conversation_tool_approvals_thread_idx
      ON conversation_tool_approvals(user_id, thread_id, created_at);
    CREATE INDEX IF NOT EXISTS conversation_tool_approvals_lease_idx
      ON conversation_tool_approvals(status, lease_expires_at);

    ALTER TABLE widget_states
      ADD COLUMN IF NOT EXISTS execution_result JSONB,
      ADD COLUMN IF NOT EXISTS execution_error TEXT,
      ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS execution_completed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS execution_lease_token VARCHAR(100),
      ADD COLUMN IF NOT EXISTS execution_lease_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS execution_attempt_count INTEGER NOT NULL DEFAULT 0;

    UPDATE widget_states
    SET
      status = 'failed',
      execution_result = COALESCE(execution_result, '{}'::jsonb) || jsonb_build_object(
        'ambiguous', true,
        'retrySafe', false,
        'reason', 'legacy_submitted_status'
      ),
      execution_error = COALESCE(
        execution_error,
        'Legacy submitted state has no durable outcome and requires reconciliation'
      ),
      execution_completed_at = COALESCE(execution_completed_at, NOW()),
      execution_lease_token = NULL,
      execution_lease_expires_at = NULL,
      updated_at = NOW()
    WHERE status = 'submitted';

    CREATE INDEX IF NOT EXISTS widget_states_execution_lease_idx
      ON widget_states(status, execution_lease_expires_at);

    ALTER TABLE chat_tab_configs
      ADD COLUMN IF NOT EXISTS tab_data JSONB NOT NULL DEFAULT '{}'::jsonb;

    UPDATE chat_tab_configs
    SET
      tab_type = CASE tab_type
        WHEN 'lead-config' THEN 'leadconfig'
        WHEN 'leadInputs' THEN 'lead-inputs'
        WHEN 'contentstudio' THEN 'content-studio'
        WHEN 'content-media' THEN 'content-image'
        ELSE tab_type
      END,
      updated_at = NOW()
    WHERE tab_type IN ('lead-config', 'leadInputs', 'contentstudio', 'content-media');

    WITH ranked_active AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY thread_id
        ORDER BY tab_order ASC, updated_at DESC, id ASC
      ) AS active_rank
      FROM chat_tab_configs
      WHERE is_active = 1
    )
    UPDATE chat_tab_configs tabs
    SET is_active = 0, updated_at = NOW()
    FROM ranked_active active
    WHERE tabs.id = active.id AND active.active_rank > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS chat_tab_configs_one_active_per_thread_idx
      ON chat_tab_configs(thread_id)
      WHERE is_active = 1;
  `);
}

/**
 * Compatibility repairs are intentionally not reversed. Dropping recovered
 * columns or indexes could destroy conversation results created after `up`.
 */
export async function down(_client) {}
