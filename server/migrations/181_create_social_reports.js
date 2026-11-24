/** Saved report definitions/exports and delivery ledger; delivery attempts are append-only. */
export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS social_saved_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name VARCHAR(160) NOT NULL, filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    schedule_cron VARCHAR(100), delivery_channel VARCHAR(24), delivery_target VARCHAR(320), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, name)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS social_report_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), report_id UUID NOT NULL REFERENCES social_saved_reports(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    format VARCHAR(12) NOT NULL CHECK(format IN ('json','csv')), snapshot_ids JSONB NOT NULL CHECK(jsonb_typeof(snapshot_ids) = 'array'), payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS social_report_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), report_id UUID NOT NULL REFERENCES social_saved_reports(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    export_id UUID REFERENCES social_report_exports(id) ON DELETE SET NULL, delivery_key VARCHAR(255) NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','skipped')), attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), error_code VARCHAR(64), error_message TEXT,
    UNIQUE(report_id, delivery_key)
  )`);
}
export async function down(client) { await client.query(`DROP TABLE IF EXISTS social_report_deliveries, social_report_exports, social_saved_reports`); }
