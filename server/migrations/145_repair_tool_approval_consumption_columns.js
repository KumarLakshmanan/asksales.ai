/**
 * Repair databases that recorded migration 118 before its tool-approval
 * consumption columns were introduced.
 *
 * The column comments let down() remove only columns created by this repair.
 * Databases that already have the intended migration-118 schema are left
 * untouched in both directions.
 */

const REPAIR_MARKER = 'added by migration 145_repair_tool_approval_consumption_columns';

export async function up(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tool_approvals'
          AND column_name = 'consumed_at'
      ) THEN
        ALTER TABLE tool_approvals ADD COLUMN consumed_at TIMESTAMP;
        COMMENT ON COLUMN tool_approvals.consumed_at IS '${REPAIR_MARKER}';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tool_approvals'
          AND column_name = 'consumed_execution_id'
      ) THEN
        ALTER TABLE tool_approvals
          ADD COLUMN consumed_execution_id BIGINT
          REFERENCES support_tool_executions(id) ON DELETE SET NULL;
        COMMENT ON COLUMN tool_approvals.consumed_execution_id IS '${REPAIR_MARKER}';
      END IF;
    END $$;
  `);
}

export async function down(client) {
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'tool_approvals'::regclass
          AND attname = 'consumed_execution_id'
          AND NOT attisdropped
          AND col_description(attrelid, attnum) = '${REPAIR_MARKER}'
      ) THEN
        ALTER TABLE tool_approvals DROP COLUMN consumed_execution_id;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'tool_approvals'::regclass
          AND attname = 'consumed_at'
          AND NOT attisdropped
          AND col_description(attrelid, attnum) = '${REPAIR_MARKER}'
      ) THEN
        ALTER TABLE tool_approvals DROP COLUMN consumed_at;
      END IF;
    END $$;
  `);
}
