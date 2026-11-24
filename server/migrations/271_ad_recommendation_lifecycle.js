/** User workflow states are separate from provider delivery and pause consent. */
export async function up(client) {
  await client.query(`
    ALTER TABLE ad_recommendations DROP CONSTRAINT IF EXISTS ad_recommendations_status_check;
    ALTER TABLE ad_recommendations ADD CONSTRAINT ad_recommendations_status_check CHECK(status IN ('open','accepted','dismissed','snoozed','implemented','outcome_measured','superseded'));
    ALTER TABLE ad_recommendations ADD COLUMN IF NOT EXISTS dismiss_reason TEXT,
      ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS accepted_evidence JSONB,
      ADD COLUMN IF NOT EXISTS implemented_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS implementation_note TEXT,
      ADD COLUMN IF NOT EXISTS implementation_baseline JSONB,
      ADD COLUMN IF NOT EXISTS outcome JSONB,
      ADD COLUMN IF NOT EXISTS outcome_measured_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS ad_recommendation_events (
      id BIGSERIAL PRIMARY KEY,
      recommendation_id BIGINT NOT NULL REFERENCES ad_recommendations(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_type VARCHAR(16) NOT NULL CHECK(actor_type IN ('user','system')),
      from_status VARCHAR(16) NOT NULL, to_status VARCHAR(16) NOT NULL,
      note TEXT, evidence JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ad_recommendation_events_history ON ad_recommendation_events(user_id,campaign_id,recommendation_id,created_at);
    CREATE INDEX IF NOT EXISTS ad_recommendations_snooze_due ON ad_recommendations(snoozed_until) WHERE status='snoozed';
  `);
  const runtimeRole = process.env.DB_RUNTIME_USER;
  if(runtimeRole) {
    const role=`"${runtimeRole.replaceAll('"','""')}"`;
    await client.query(`GRANT SELECT,INSERT ON ad_recommendation_events TO ${role}`);
    await client.query(`GRANT USAGE,SELECT ON SEQUENCE ad_recommendation_events_id_seq TO ${role}`);
  }
}
export async function down(client) {
  await client.query('DROP TABLE IF EXISTS ad_recommendation_events');
  // Preserve lifecycle evidence and states when rolling back application code.
}
