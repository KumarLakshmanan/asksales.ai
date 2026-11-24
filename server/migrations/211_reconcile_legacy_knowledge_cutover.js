/**
 * Records the terminal migration outcome for every legacy knowledge row.
 *
 * original_user_id intentionally has no users FK: legacy rows can outlive a
 * deleted tenant and must be auditable without being reassigned or deleted.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_migration_reconciliations (
      id BIGSERIAL PRIMARY KEY,
      legacy_entry_id INTEGER NOT NULL UNIQUE,
      original_user_id INTEGER NOT NULL,
      document_id BIGINT REFERENCES knowledge_documents(id) ON DELETE SET NULL,
      version_id BIGINT REFERENCES knowledge_document_versions(id) ON DELETE SET NULL,
      outcome VARCHAR(30) NOT NULL
        CHECK (outcome IN (
          'reconciled', 'quarantined', 'failed', 'intentionally_excluded'
        )),
      reason VARCHAR(1000),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      reconciled_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_migration_reconciliations_outcome
      ON knowledge_migration_reconciliations(outcome, reconciled_at DESC)
  `);

  await client.query(`ALTER TABLE knowledge_migration_reconciliations ENABLE ROW LEVEL SECURITY`);
  await client.query(`ALTER TABLE knowledge_migration_reconciliations FORCE ROW LEVEL SECURITY`);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = current_schema()
          AND tablename = 'knowledge_migration_reconciliations'
          AND policyname = 'knowledge_migration_reconciliations_admin_only'
      ) THEN
        CREATE POLICY knowledge_migration_reconciliations_admin_only
          ON knowledge_migration_reconciliations
          USING (current_setting('app.knowledge_admin', true) = 'on')
          WITH CHECK (current_setting('app.knowledge_admin', true) = 'on');
      END IF;
    END $$
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS knowledge_migration_reconciliations CASCADE`);
}
