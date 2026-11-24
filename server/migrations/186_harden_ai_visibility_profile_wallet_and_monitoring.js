/**
 * Makes AI Visibility a Business Profile-backed module, records immutable
 * audit inputs, and replaces the historical fixed reservation pricing keys
 * with component-based temporary holds for new audits.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE ai_visibility_projects
      ADD COLUMN IF NOT EXISTS source VARCHAR(24) NOT NULL DEFAULT 'legacy'
        CHECK (source IN ('business_profile', 'legacy'))
  `);
  await client.query(`
    ALTER TABLE ai_visibility_audits
      ADD COLUMN IF NOT EXISTS input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS monitoring_period_key VARCHAR(16)
  `);

  // Safe, exact-domain backfill: only link rows where one and only one owned
  // profile has the same normalized HTTP(S) origin.
  await client.query(`
    WITH candidates AS (
      SELECT project.id AS project_id, MIN(profile.id) AS profile_id
      FROM ai_visibility_projects project
      JOIN company_settings profile
        ON profile.user_id = project.user_id
       AND profile.website IS NOT NULL
       AND lower(regexp_replace(regexp_replace(trim(profile.website), '/+$', ''), '^https?://', '')) =
           lower(regexp_replace(regexp_replace(trim(project.domain), '/+$', ''), '^https?://', ''))
      WHERE project.business_profile_id IS NULL
      GROUP BY project.id
      HAVING COUNT(*) = 1
    )
    UPDATE ai_visibility_projects project
       SET business_profile_id = candidates.profile_id,
           source = 'business_profile',
           updated_at = NOW()
      FROM candidates
     WHERE project.id = candidates.project_id
  `);

  // Existing duplicate linked projects are retained as legacy projects so the
  // unique index never deletes customer audits or artifacts.
  await client.query(`
    WITH duplicates AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY user_id, business_profile_id
        ORDER BY updated_at DESC, id DESC
      ) AS position
      FROM ai_visibility_projects
      WHERE status = 'active' AND business_profile_id IS NOT NULL
    )
    UPDATE ai_visibility_projects project
       SET business_profile_id = NULL,
           source = 'legacy',
           updated_at = NOW()
      FROM duplicates
     WHERE project.id = duplicates.id AND duplicates.position > 1
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_projects_active_profile_uq
      ON ai_visibility_projects(user_id, business_profile_id)
      WHERE status = 'active' AND business_profile_id IS NOT NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_audits_monitoring_period_uq
      ON ai_visibility_audits(project_id, monitoring_period_key)
      WHERE trigger = 'monitoring' AND monitoring_period_key IS NOT NULL
  `);

  await client.query(`
    INSERT INTO credit_pricing (event_key, name, description, category, credits_per_unit, unit_label, is_active, sort_order, metadata)
    VALUES
      ('ai_visibility_audit_base', 'AI Visibility audit base', 'Base cost used only in a calculated temporary audit hold.', 'ai_visibility', 5, 'per audit', TRUE, 700, '{"reservationComponent":true}'::jsonb),
      ('ai_visibility_monitoring_base', 'AI Visibility monitoring base', 'Base cost used only in a calculated temporary monitoring hold.', 'ai_visibility', 5, 'per monitoring audit', TRUE, 701, '{"reservationComponent":true}'::jsonb)
    ON CONFLICT (event_key) DO NOTHING
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS ai_visibility_audits_monitoring_period_uq');
  await client.query('DROP INDEX IF EXISTS ai_visibility_projects_active_profile_uq');
  await client.query("DELETE FROM credit_pricing WHERE event_key IN ('ai_visibility_audit_base', 'ai_visibility_monitoring_base')");
  await client.query('ALTER TABLE ai_visibility_audits DROP COLUMN IF EXISTS monitoring_period_key');
  await client.query('ALTER TABLE ai_visibility_audits DROP COLUMN IF EXISTS input_snapshot');
  await client.query('ALTER TABLE ai_visibility_projects DROP COLUMN IF EXISTS source');
}
