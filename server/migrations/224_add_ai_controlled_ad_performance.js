/**
 * AI-controlled ad performance foundation.
 *
 * Autonomy is deliberately opt-in twice: at the account and campaign level.
 * Evaluations and recommendations are immutable evidence; only consented pause
 * actions may reach providers in v1.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE ad_settings
      ALTER COLUMN autonomous_optimization_enabled SET DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS autonomy_mode VARCHAR(16) NOT NULL DEFAULT 'off',
      ADD COLUMN IF NOT EXISTS consent_policy_version VARCHAR(32) NOT NULL DEFAULT 'ads-pause-v1',
      ADD COLUMN IF NOT EXISTS consented_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS consented_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS notification_email VARCHAR(320),
      ADD COLUMN IF NOT EXISTS default_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMP
  `);
  await client.query(`
    UPDATE ad_settings
    SET autonomous_optimization_enabled = FALSE,
        autonomy_mode = 'off',
        consented_at = NULL,
        consented_by_user_id = NULL,
        updated_at = NOW()
  `);
  await client.query(`
    ALTER TABLE ad_settings DROP CONSTRAINT IF EXISTS ad_settings_autonomy_mode_check
  `);
  await client.query(`
    ALTER TABLE ad_settings ADD CONSTRAINT ad_settings_autonomy_mode_check
      CHECK (autonomy_mode IN ('off', 'shadow', 'advisory', 'live_pause'))
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_campaign_autonomy_policies (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
      consent_policy_version VARCHAR(32) NOT NULL DEFAULT 'ads-pause-v1',
      consented_at TIMESTAMP,
      consented_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoked_at TIMESTAMP,
      manual_hold_until TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id, user_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_campaign_autonomy_policy_owner_idx
      ON ad_campaign_autonomy_policies(user_id, enabled, updated_at DESC)
  `);
  await client.query(`
    INSERT INTO ad_campaign_autonomy_policies (
      campaign_id, user_id, enabled, thresholds, consent_policy_version, revoked_at
    )
    SELECT campaign.id, campaign.user_id, FALSE, '{}'::jsonb, 'ads-pause-v1', NOW()
    FROM performance_ad_campaigns campaign
    ON CONFLICT (campaign_id, user_id) DO NOTHING
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION create_default_ad_campaign_autonomy_policy()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO ad_campaign_autonomy_policies (
        campaign_id, user_id, enabled, thresholds, consent_policy_version, revoked_at
      ) VALUES (NEW.id, NEW.user_id, FALSE, '{}'::jsonb, 'ads-pause-v1', NOW())
      ON CONFLICT (campaign_id, user_id) DO NOTHING;
      RETURN NEW;
    END;
    $$
  `);
  await client.query(`DROP TRIGGER IF EXISTS performance_ad_campaigns_default_autonomy_policy ON performance_ad_campaigns`);
  await client.query(`
    CREATE TRIGGER performance_ad_campaigns_default_autonomy_policy
      AFTER INSERT ON performance_ad_campaigns
      FOR EACH ROW EXECUTE FUNCTION create_default_ad_campaign_autonomy_policy()
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_account_autonomy_events (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      autonomy_mode VARCHAR(16) NOT NULL CHECK (autonomy_mode IN ('off', 'shadow', 'advisory', 'live_pause')),
      enabled BOOLEAN NOT NULL,
      consent_policy_version VARCHAR(32) NOT NULL,
      consented_at TIMESTAMP,
      revoked_at TIMESTAMP,
      thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
      notification_destination TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_target_automation_holds (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('campaign', 'ad_set', 'ad_group', 'ad')),
      target_key VARCHAR(200) NOT NULL,
      hold_until TIMESTAMP NOT NULL,
      reason TEXT NOT NULL,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id, user_id, platform, target_type, target_key)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_unit_metrics (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('ad_set', 'ad_group', 'ad')),
      target_key VARCHAR(200) NOT NULL,
      parent_target_key VARCHAR(200),
      provider_resource TEXT NOT NULL,
      date DATE NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
      clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
      spend NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (spend >= 0),
      reach INTEGER NOT NULL DEFAULT 0 CHECK (reach >= 0),
      conversions NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (conversions >= 0),
      conversion_value NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (conversion_value >= 0),
      engagements INTEGER NOT NULL DEFAULT 0 CHECK (engagements >= 0),
      installs NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (installs >= 0),
      provider_status VARCHAR(64),
      provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id, platform, target_type, target_key, date)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_unit_metrics_evaluation_idx
      ON ad_unit_metrics(user_id, campaign_id, target_type, target_key, date DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_performance_evaluations (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('campaign', 'ad_set', 'ad_group', 'ad')),
      target_key VARCHAR(200) NOT NULL,
      objective VARCHAR(32) NOT NULL,
      window_start DATE NOT NULL,
      window_end DATE NOT NULL,
      metrics_snapshot JSONB NOT NULL,
      metrics_updated_at TIMESTAMP,
      baseline_source VARCHAR(32) NOT NULL,
      baseline_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      comparable_campaign_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      rule_results JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence NUMERIC(5, 4) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
      state VARCHAR(32) NOT NULL CHECK (state IN ('learning', 'healthy', 'watch', 'recommendation', 'ai_paused', 'manual_hold', 'insufficient_data')),
      hypothetical_action VARCHAR(32),
      evaluation_key VARCHAR(240) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, evaluation_key)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_performance_evaluations_campaign_idx
      ON ad_performance_evaluations(user_id, campaign_id, created_at DESC)
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION prevent_ad_performance_evaluation_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ad performance evaluations are immutable';
    END;
    $$
  `);
  await client.query(`DROP TRIGGER IF EXISTS ad_performance_evaluations_immutable ON ad_performance_evaluations`);
  await client.query(`
    CREATE TRIGGER ad_performance_evaluations_immutable
      BEFORE UPDATE OR DELETE ON ad_performance_evaluations
      FOR EACH ROW EXECUTE FUNCTION prevent_ad_performance_evaluation_mutation()
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_recommendations (
      id BIGSERIAL PRIMARY KEY,
      evaluation_id BIGINT NOT NULL REFERENCES ad_performance_evaluations(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('campaign', 'ad_set', 'ad_group', 'ad')),
      target_key VARCHAR(200) NOT NULL,
      category VARCHAR(32) NOT NULL CHECK (category IN ('creative', 'audience', 'landing_page', 'budget', 'placement', 'tracking')),
      title TEXT NOT NULL,
      rationale TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      expected_direction TEXT NOT NULL,
      suggested_next_step TEXT NOT NULL,
      confidence NUMERIC(5, 4) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
      status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed', 'superseded')),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(evaluation_id, category)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_recommendations_campaign_idx
      ON ad_recommendations(user_id, campaign_id, status, created_at DESC)
  `);

  await client.query(`
    ALTER TABLE ad_action_queue
      ADD COLUMN IF NOT EXISTS evaluation_id BIGINT REFERENCES ad_performance_evaluations(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS target_type VARCHAR(16) NOT NULL DEFAULT 'campaign',
      ADD COLUMN IF NOT EXISTS target_key VARCHAR(200) NOT NULL DEFAULT 'campaign',
      ADD COLUMN IF NOT EXISTS target_resource TEXT,
      ADD COLUMN IF NOT EXISTS consent_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS policy_version VARCHAR(32)
  `);
  await client.query(`
    ALTER TABLE ad_performance_evaluations
      ADD COLUMN IF NOT EXISTS actual_action_id BIGINT REFERENCES ad_action_queue(id) ON DELETE SET NULL
  `);
  await client.query(`
    ALTER TABLE ad_action_queue DROP CONSTRAINT IF EXISTS ad_action_queue_target_type_check
  `);
  await client.query(`
    ALTER TABLE ad_action_queue ADD CONSTRAINT ad_action_queue_target_type_check
      CHECK (target_type IN ('campaign', 'ad_set', 'ad_group', 'ad'))
  `);
  await client.query(`
    UPDATE ad_action_queue
    SET status = 'cancelled',
        last_error = 'Cancelled during ads-pause-v1 migration: this autonomous action now requires user approval.',
        completed_at = NOW(), updated_at = NOW()
    WHERE status IN ('pending', 'processing')
      AND (
        (action_type IN ('resume', 'reallocate', 'create_replacement')
          AND COALESCE(payload->>'actorType', '') <> 'user')
        OR (action_type = 'pause'
          AND evaluation_id IS NULL
          AND rationale NOT ILIKE '%lifetime%cap%')
      )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_action_notification_deliveries (
      id BIGSERIAL PRIMARY KEY,
      action_id BIGINT NOT NULL REFERENCES ad_action_queue(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel VARCHAR(16) NOT NULL CHECK (channel IN ('in_app', 'email')),
      destination TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      available_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_error TEXT,
      delivered_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(action_id, channel)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_action_notification_delivery_idx
      ON ad_action_notification_deliveries(status, available_at, id)
  `);
}

export async function down(client) {
  await client.query(`DROP TRIGGER IF EXISTS performance_ad_campaigns_default_autonomy_policy ON performance_ad_campaigns`);
  await client.query(`DROP FUNCTION IF EXISTS create_default_ad_campaign_autonomy_policy()`);
  await client.query(`DROP TABLE IF EXISTS ad_action_notification_deliveries`);
  await client.query(`ALTER TABLE ad_action_queue DROP COLUMN IF EXISTS policy_version`);
  await client.query(`ALTER TABLE ad_action_queue DROP COLUMN IF EXISTS consent_snapshot`);
  await client.query(`ALTER TABLE ad_action_queue DROP COLUMN IF EXISTS target_resource`);
  await client.query(`ALTER TABLE ad_action_queue DROP COLUMN IF EXISTS target_key`);
  await client.query(`ALTER TABLE ad_action_queue DROP COLUMN IF EXISTS target_type`);
  await client.query(`ALTER TABLE ad_action_queue DROP COLUMN IF EXISTS evaluation_id`);
  await client.query(`DROP TABLE IF EXISTS ad_recommendations`);
  await client.query(`DROP TRIGGER IF EXISTS ad_performance_evaluations_immutable ON ad_performance_evaluations`);
  await client.query(`DROP TABLE IF EXISTS ad_performance_evaluations`);
  await client.query(`DROP FUNCTION IF EXISTS prevent_ad_performance_evaluation_mutation()`);
  await client.query(`DROP TABLE IF EXISTS ad_unit_metrics`);
  await client.query(`DROP TABLE IF EXISTS ad_target_automation_holds`);
  await client.query(`DROP TABLE IF EXISTS ad_account_autonomy_events`);
  await client.query(`DROP TABLE IF EXISTS ad_campaign_autonomy_policies`);
  await client.query(`ALTER TABLE ad_settings DROP COLUMN IF EXISTS last_evaluated_at`);
  await client.query(`ALTER TABLE ad_settings DROP COLUMN IF EXISTS default_thresholds`);
  await client.query(`ALTER TABLE ad_settings DROP COLUMN IF EXISTS notification_email`);
  await client.query(`ALTER TABLE ad_settings DROP COLUMN IF EXISTS consented_by_user_id`);
  await client.query(`ALTER TABLE ad_settings DROP COLUMN IF EXISTS consented_at`);
  await client.query(`ALTER TABLE ad_settings DROP COLUMN IF EXISTS consent_policy_version`);
  await client.query(`ALTER TABLE ad_settings DROP COLUMN IF EXISTS autonomy_mode`);
  await client.query(`ALTER TABLE ad_settings ALTER COLUMN autonomous_optimization_enabled SET DEFAULT TRUE`);
}
