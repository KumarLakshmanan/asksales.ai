/**
 * Consolidated autonomous Meta + Google Ads workflow.
 *
 * Financial invariants are enforced in PostgreSQL as well as in application
 * code. Provider mutations remain disabled per tenant until an operator
 * explicitly enables them after the staging checklist has been completed.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_settings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      default_lifetime_budget NUMERIC(12, 2) NOT NULL DEFAULT 100.00
        CHECK (default_lifetime_budget > 0),
      currency VARCHAR(3) NOT NULL DEFAULT 'USD'
        CHECK (currency ~ '^[A-Z]{3}$'),
      locations JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(locations) = 'array'),
      autonomous_optimization_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      live_provider_mutations_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      analytics_sync_minutes INTEGER NOT NULL DEFAULT 15
        CHECK (analytics_sync_minutes BETWEEN 5 AND 1440),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id)
    )
  `);

  await client.query(`
    ALTER TABLE performance_ad_campaigns
      ADD COLUMN IF NOT EXISTS objective_source VARCHAR(32),
      ADD COLUMN IF NOT EXISTS objective_rationale TEXT,
      ADD COLUMN IF NOT EXISTS landing_page_url TEXT,
      ADD COLUMN IF NOT EXISTS locations JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS local_status VARCHAR(32) NOT NULL DEFAULT 'draft',
      ADD COLUMN IF NOT EXISTS provider_status VARCHAR(64),
      ADD COLUMN IF NOT EXISTS validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(160),
      ADD COLUMN IF NOT EXISTS content_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS auto_activate BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS last_provider_error TEXT
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS performance_ad_campaigns_user_idempotency_uq
      ON performance_ad_campaigns(user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_campaign_allocations (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      child_type VARCHAR(16) NOT NULL CHECK (child_type IN ('ad_set', 'ad_group')),
      child_key VARCHAR(160) NOT NULL,
      provider_resource_name TEXT,
      allocated_amount NUMERIC(12, 2) NOT NULL CHECK (allocated_amount >= 0),
      spent_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id, platform, child_key),
      CHECK (spent_amount <= allocated_amount)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_campaign_allocations_owner_idx
      ON ad_campaign_allocations(user_id, campaign_id)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_allocation_metrics (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      allocation_id INTEGER NOT NULL REFERENCES ad_campaign_allocations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      date DATE NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
      clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
      spend NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (spend >= 0),
      conversions NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (conversions >= 0),
      conversion_value NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (conversion_value >= 0),
      provider_status VARCHAR(64),
      provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(allocation_id, date)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_allocation_metrics_campaign_idx
      ON ad_allocation_metrics(user_id, campaign_id, date DESC)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_analytics_sync_runs (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      date_start DATE NOT NULL,
      date_stop DATE NOT NULL,
      status VARCHAR(16) NOT NULL CHECK (status IN ('succeeded', 'failed')),
      metrics_ingested INTEGER NOT NULL DEFAULT 0 CHECK (metrics_ingested >= 0),
      error TEXT,
      completed_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_analytics_sync_runs_campaign_idx
      ON ad_analytics_sync_runs(user_id, campaign_id, completed_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_provider_resources (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      resource_type VARCHAR(32) NOT NULL,
      local_key VARCHAR(160) NOT NULL,
      provider_resource_id TEXT,
      provider_resource_name TEXT,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      cleanup_status VARCHAR(32),
      idempotency_key VARCHAR(200) NOT NULL,
      error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, platform, idempotency_key)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_action_queue (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('meta', 'google')),
      action_type VARCHAR(32) NOT NULL CHECK (
        action_type IN (
          'publish', 'activate', 'pause', 'resume', 'reallocate',
          'create_replacement', 'sync_analytics', 'cleanup'
        )
      ),
      idempotency_key VARCHAR(200) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      metrics_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      rationale TEXT NOT NULL,
      budget_impact NUMERIC(12, 2) NOT NULL DEFAULT 0,
      status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
      available_at TIMESTAMP NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMP,
      locked_by VARCHAR(160),
      provider_outcome JSONB,
      last_error TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      UNIQUE(user_id, idempotency_key)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_action_queue_claim_idx
      ON ad_action_queue(status, available_at, id)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_action_audit (
      id BIGSERIAL PRIMARY KEY,
      action_id BIGINT REFERENCES ad_action_queue(id) ON DELETE SET NULL,
      campaign_id INTEGER NOT NULL REFERENCES performance_ad_campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_type VARCHAR(24) NOT NULL CHECK (actor_type IN ('user', 'ai', 'system', 'provider')),
      action_type VARCHAR(32) NOT NULL,
      rationale TEXT NOT NULL,
      metrics_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      budget_before NUMERIC(12, 2),
      budget_after NUMERIC(12, 2),
      provider_outcome JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ad_action_audit_campaign_idx
      ON ad_action_audit(user_id, campaign_id, created_at DESC)
  `);

  await client.query(`
    ALTER TABLE performance_metrics
      ADD COLUMN IF NOT EXISTS source_scope VARCHAR(24) NOT NULL DEFAULT 'managed',
      ADD COLUMN IF NOT EXISTS sync_status VARCHAR(24) NOT NULL DEFAULT 'succeeded',
      ADD COLUMN IF NOT EXISTS sync_error TEXT,
      ADD COLUMN IF NOT EXISTS provider_status VARCHAR(64)
  `);
  await client.query(`DROP INDEX IF EXISTS performance_metrics_daily_unique`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS performance_metrics_campaign_platform_daily_uq
      ON performance_metrics(campaign_id, platform, date)
      WHERE hour IS NULL
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS performance_metrics_campaign_platform_daily_uq`);
  await client.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY campaign_id, date
        ORDER BY updated_at DESC NULLS LAST, id DESC
      ) AS row_number
      FROM performance_metrics WHERE hour IS NULL
    )
    DELETE FROM performance_metrics metrics
    USING ranked
    WHERE metrics.id = ranked.id AND ranked.row_number > 1
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS performance_metrics_daily_unique
      ON performance_metrics(campaign_id, date)
      WHERE hour IS NULL
  `);
  await client.query(`ALTER TABLE performance_metrics DROP COLUMN IF EXISTS provider_status`);
  await client.query(`ALTER TABLE performance_metrics DROP COLUMN IF EXISTS sync_error`);
  await client.query(`ALTER TABLE performance_metrics DROP COLUMN IF EXISTS sync_status`);
  await client.query(`ALTER TABLE performance_metrics DROP COLUMN IF EXISTS source_scope`);
  await client.query(`DROP TABLE IF EXISTS ad_action_audit`);
  await client.query(`DROP TABLE IF EXISTS ad_action_queue`);
  await client.query(`DROP TABLE IF EXISTS ad_provider_resources`);
  await client.query(`DROP TABLE IF EXISTS ad_analytics_sync_runs`);
  await client.query(`DROP TABLE IF EXISTS ad_allocation_metrics`);
  await client.query(`DROP TABLE IF EXISTS ad_campaign_allocations`);
  await client.query(`DROP INDEX IF EXISTS performance_ad_campaigns_user_idempotency_uq`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS last_provider_error`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS auto_activate`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS content_context`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS idempotency_key`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS validation_errors`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS provider_status`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS local_status`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS locations`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS landing_page_url`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS objective_rationale`);
  await client.query(`ALTER TABLE performance_ad_campaigns DROP COLUMN IF EXISTS objective_source`);
  await client.query(`DROP TABLE IF EXISTS ad_settings`);
}
