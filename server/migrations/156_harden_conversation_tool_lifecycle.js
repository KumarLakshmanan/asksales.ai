/**
 * Make Conversation Builder approvals and widget executions durable and
 * idempotent. Approval request IDs are unique per tenant/thread/tool, while
 * widget execution state records the actual running/final outcome.
 */
export async function up(client) {
  // Record only objects this migration actually creates. A few legacy
  // installations already have one or more execution columns; the ownership
  // ledger makes a later rollback non-destructive for those installations.
  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_migration_156_ownership (
      object_name TEXT PRIMARY KEY
    );

    INSERT INTO conversation_migration_156_ownership(object_name)
    SELECT 'conversation_tool_approvals'
    WHERE to_regclass('public.conversation_tool_approvals') IS NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO conversation_migration_156_ownership(object_name)
    SELECT object_name
    FROM (VALUES
      ('conversation_tool_approvals.lease_token'),
      ('conversation_tool_approvals.lease_expires_at'),
      ('conversation_tool_approvals.attempt_count'),
      ('widget_states.execution_result'),
      ('widget_states.execution_error'),
      ('widget_states.execution_started_at'),
      ('widget_states.execution_completed_at'),
      ('widget_states.execution_lease_token'),
      ('widget_states.execution_lease_expires_at'),
      ('widget_states.execution_attempt_count')
    ) AS objects(object_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = split_part(objects.object_name, '.', 1)
        AND column_name = split_part(objects.object_name, '.', 2)
    )
    ON CONFLICT DO NOTHING;

    INSERT INTO conversation_migration_156_ownership(object_name)
    SELECT object_name
    FROM (VALUES
      ('index.conversation_tool_approvals_request_uq'),
      ('index.conversation_tool_approvals_thread_idx'),
      ('index.conversation_tool_approvals_lease_idx'),
      ('index.widget_states_execution_lease_idx')
    ) AS objects(object_name)
    WHERE to_regclass('public.' || split_part(objects.object_name, '.', 2)) IS NULL
    ON CONFLICT DO NOTHING;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_tool_approvals (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      request_id VARCHAR(255) NOT NULL,
      tool_name VARCHAR(255) NOT NULL,
      tool_args JSONB NOT NULL DEFAULT '{}',
      overrides JSONB,
      decision VARCHAR(16) NOT NULL CHECK (decision IN ('approve', 'reject')),
      status VARCHAR(24) NOT NULL
        CHECK (status IN ('running', 'succeeded', 'failed', 'rejected')),
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
      ADD COLUMN IF NOT EXISTS lease_token VARCHAR(100),
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1;

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

    CREATE INDEX IF NOT EXISTS widget_states_execution_lease_idx
      ON widget_states(status, execution_lease_expires_at);
  `);
}

export async function down(client) {
  await client.query(`
    DO $$
    DECLARE
      owned_index TEXT;
    BEGIN
      IF to_regclass('public.conversation_migration_156_ownership') IS NOT NULL THEN
        FOR owned_index IN
          SELECT split_part(object_name, '.', 2)
          FROM conversation_migration_156_ownership
          WHERE object_name LIKE 'index.%'
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS %I', owned_index);
        END LOOP;
      END IF;
    END $$;

    DO $$
    DECLARE
      owned_column TEXT;
    BEGIN
      IF to_regclass('public.conversation_migration_156_ownership') IS NOT NULL THEN
        FOR owned_column IN
          SELECT split_part(object_name, '.', 2)
          FROM conversation_migration_156_ownership
          WHERE object_name LIKE 'widget_states.%'
        LOOP
          EXECUTE format('ALTER TABLE widget_states DROP COLUMN IF EXISTS %I', owned_column);
        END LOOP;
      END IF;
    END $$;

    DO $$
    DECLARE
      owned_column TEXT;
    BEGIN
      IF to_regclass('public.conversation_tool_approvals') IS NOT NULL
        AND to_regclass('public.conversation_migration_156_ownership') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversation_migration_156_ownership
          WHERE object_name = 'conversation_tool_approvals'
        )
      THEN
        FOR owned_column IN
          SELECT split_part(object_name, '.', 2)
          FROM conversation_migration_156_ownership
          WHERE object_name LIKE 'conversation_tool_approvals.%'
        LOOP
          EXECUTE format(
            'ALTER TABLE conversation_tool_approvals DROP COLUMN IF EXISTS %I',
            owned_column
          );
        END LOOP;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF to_regclass('public.conversation_migration_156_ownership') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM conversation_migration_156_ownership
          WHERE object_name = 'conversation_tool_approvals'
        )
      THEN
        DROP TABLE IF EXISTS conversation_tool_approvals;
      END IF;
    END $$;

    DROP TABLE IF EXISTS conversation_migration_156_ownership;
  `);
}
