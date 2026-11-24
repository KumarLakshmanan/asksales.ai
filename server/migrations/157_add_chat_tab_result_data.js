/**
 * Persist the structured result payload associated with Conversation Builder tabs.
 * This allows generated analytics/content previews to survive thread resume.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_migration_157_ownership (
      object_name TEXT PRIMARY KEY
    );

    INSERT INTO conversation_migration_157_ownership(object_name)
    SELECT 'chat_tab_configs.tab_data'
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chat_tab_configs'
        AND column_name = 'tab_data'
    )
    ON CONFLICT DO NOTHING;

    INSERT INTO conversation_migration_157_ownership(object_name)
    SELECT 'chat_tab_configs_one_active_per_thread_idx'
    WHERE to_regclass('public.chat_tab_configs_one_active_per_thread_idx') IS NULL
    ON CONFLICT DO NOTHING;
  `);
  await client.query(`
    ALTER TABLE chat_tab_configs
    ADD COLUMN IF NOT EXISTS tab_data JSONB NOT NULL DEFAULT '{}'::jsonb
  `);
  // Normalize persisted aliases before clients load them. In particular,
  // lead-config otherwise reopens as an unrelated/default panel.
  await client.query(`
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
    WHERE tab_type IN ('lead-config', 'leadInputs', 'contentstudio', 'content-media')
  `);
  await client.query(`
    WITH ranked_active AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY thread_id
        ORDER BY tab_order ASC, updated_at DESC, id ASC
      ) AS active_rank
      FROM chat_tab_configs
      WHERE is_active = 1
    )
    UPDATE chat_tab_configs AS tabs
    SET is_active = 0
    FROM ranked_active
    WHERE tabs.id = ranked_active.id
      AND ranked_active.active_rank > 1
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_tab_configs_one_active_per_thread_idx
    ON chat_tab_configs(thread_id)
    WHERE is_active = 1
  `);
}

export async function down(client) {
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('public.conversation_migration_157_ownership') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM conversation_migration_157_ownership
          WHERE object_name = 'chat_tab_configs_one_active_per_thread_idx'
        )
      THEN
        DROP INDEX IF EXISTS chat_tab_configs_one_active_per_thread_idx;
      END IF;

      IF to_regclass('public.conversation_migration_157_ownership') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM conversation_migration_157_ownership
          WHERE object_name = 'chat_tab_configs.tab_data'
        )
      THEN
        ALTER TABLE chat_tab_configs DROP COLUMN IF EXISTS tab_data;
      END IF;
    END $$;

    DROP TABLE IF EXISTS conversation_migration_157_ownership
  `);
}
