/**
 * Immutable audit history for credit, provider, storage pricing, and storage
 * plan changes. Pricing mutations take effect immediately; effective_at records
 * the exact instant used by billing after the committed change.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pricing_change_audit (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(50) NOT NULL,
      record_id INTEGER,
      pricing_key VARCHAR(150),
      action VARCHAR(20) NOT NULL,
      admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      before_value JSONB,
      after_value JSONB,
      effective_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT pricing_change_audit_domain_check
        CHECK (domain IN ('credit_pricing', 'api_pricing', 'storage_pricing', 'storage_plan')),
      CONSTRAINT pricing_change_audit_action_check
        CHECK (action IN ('create', 'update', 'delete', 'seed'))
    );

    CREATE INDEX IF NOT EXISTS pricing_change_audit_domain_record_idx
      ON pricing_change_audit (domain, record_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS pricing_change_audit_created_idx
      ON pricing_change_audit (created_at DESC);
    CREATE INDEX IF NOT EXISTS pricing_change_audit_admin_idx
      ON pricing_change_audit (admin_id);
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS pricing_change_audit;`);
}
