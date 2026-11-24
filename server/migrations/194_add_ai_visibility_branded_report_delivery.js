/**
 * Adds immutable Brand Toolkit snapshots to PDF records and durable,
 * owner-scoped delivery receipts for report emails.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE ai_visibility_reports
      ADD COLUMN IF NOT EXISTS branding_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_report_deliveries (
      id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES ai_visibility_reports(id) ON DELETE CASCADE,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_email VARCHAR(320) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'sending',
      idempotency_key VARCHAR(80) NOT NULL,
      provider_message_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_report_deliveries_user_intent_uq
      ON ai_visibility_report_deliveries(user_id, idempotency_key)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ai_visibility_report_deliveries_project_idx
      ON ai_visibility_report_deliveries(project_id, created_at DESC)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS ai_visibility_report_deliveries');
  await client.query('ALTER TABLE ai_visibility_reports DROP COLUMN IF EXISTS branding_snapshot');
}
