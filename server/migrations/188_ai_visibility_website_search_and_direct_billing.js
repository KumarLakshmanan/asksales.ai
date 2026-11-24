/**
 * Adds reusable arbitrary website searches and switches new AI Visibility
 * audits from maximum reservations to direct shared-wallet usage charges.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE ai_visibility_projects
      DROP CONSTRAINT IF EXISTS ai_visibility_projects_source_check
  `);
  await client.query(`
    ALTER TABLE ai_visibility_projects
      ADD CONSTRAINT ai_visibility_projects_source_check
      CHECK (source IN ('business_profile', 'website_search', 'legacy'))
  `);
  await client.query(`
    ALTER TABLE ai_visibility_audits
      ADD COLUMN IF NOT EXISTS billing_mode VARCHAR(16) NOT NULL DEFAULT 'reservation'
        CHECK (billing_mode IN ('reservation', 'direct')),
      ADD COLUMN IF NOT EXISTS initial_charge_transaction_id INTEGER
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_ai_visibility_usage_uq
      ON wallet_transactions(user_id, reference_type, reference_id)
      WHERE type = 'deduction' AND reference_type = 'ai_visibility_audit_usage'
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_projects_website_search_idx
      ON ai_visibility_projects(user_id, source, updated_at DESC)
      WHERE status = 'active'
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_projects_active_website_domain_uq
      ON ai_visibility_projects(user_id, domain)
      WHERE status = 'active' AND source = 'website_search'
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS ai_visibility_projects_active_website_domain_uq');
  await client.query('DROP INDEX IF EXISTS ai_visibility_projects_website_search_idx');
  await client.query('DROP INDEX IF EXISTS wallet_transactions_ai_visibility_usage_uq');
  await client.query('ALTER TABLE ai_visibility_audits DROP COLUMN IF EXISTS initial_charge_transaction_id');
  await client.query('ALTER TABLE ai_visibility_audits DROP COLUMN IF EXISTS billing_mode');
  await client.query('ALTER TABLE ai_visibility_projects DROP CONSTRAINT IF EXISTS ai_visibility_projects_source_check');
  await client.query("UPDATE ai_visibility_projects SET source = 'legacy' WHERE source = 'website_search'");
  await client.query(`ALTER TABLE ai_visibility_projects ADD CONSTRAINT ai_visibility_projects_source_check CHECK (source IN ('business_profile', 'legacy'))`);
}
