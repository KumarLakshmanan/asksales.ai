/** Durable Threads discovery, synchronization, normalized events, and lead identity. */
export async function up(client) {
  await client.query(`ALTER TABLE social_publish_attempts DROP CONSTRAINT IF EXISTS social_publish_attempts_platform_check`);
  await client.query(`ALTER TABLE social_publish_attempts ADD CONSTRAINT social_publish_attempts_platform_check
    CHECK (platform IN ('instagram','facebook','threads','youtube'))`);
  await client.query(`ALTER TABLE social_metric_snapshots DROP CONSTRAINT IF EXISTS social_metric_snapshots_platform_check`);
  await client.query(`ALTER TABLE social_metric_snapshots ADD CONSTRAINT social_metric_snapshots_platform_check
    CHECK (platform IN ('facebook','instagram','threads','youtube'))`);
  await client.query(`ALTER TABLE provider_verification_runs DROP CONSTRAINT IF EXISTS provider_verification_runs_platform_check`);
  await client.query(`ALTER TABLE provider_verification_runs ADD CONSTRAINT provider_verification_runs_platform_check
    CHECK (platform IN ('facebook','instagram','threads','whatsapp','meta_ads','youtube','gmail','resend'))`);
  await client.query(`ALTER TABLE provider_canary_runs DROP CONSTRAINT IF EXISTS provider_canary_runs_platform_check`);
  await client.query(`ALTER TABLE provider_canary_runs ADD CONSTRAINT provider_canary_runs_platform_check
    CHECK (platform IN ('facebook','instagram','threads','whatsapp','youtube','gmail','resend'))`);
  await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS threads_handle VARCHAR(255)`);
  await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS threads_url TEXT`);
  await client.query(`ALTER TABLE social_metric_snapshots ADD COLUMN IF NOT EXISTS dimensions JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await client.query(`CREATE INDEX IF NOT EXISTS leads_threads_handle_idx ON leads(user_id, threads_handle)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS leads_threads_provider_identity_uq
    ON leads(user_id, platform_type, profile_id)
    WHERE user_id IS NOT NULL AND platform_type='threads' AND profile_id IS NOT NULL AND deleted_at IS NULL`);

  await client.query(`CREATE TABLE IF NOT EXISTS threads_monitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id INTEGER NOT NULL REFERENCES channel_credentials(id) ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL CHECK(kind IN ('keyword','tag','profile')),
    query VARCHAR(255) NOT NULL,
    search_type VARCHAR(16) NOT NULL DEFAULT 'RECENT' CHECK(search_type IN ('TOP','RECENT')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, credential_id, kind, query)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS threads_monitors_due_idx ON threads_monitors(user_id, is_active, updated_at)`);

  await client.query(`CREATE TABLE IF NOT EXISTS threads_sync_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id INTEGER NOT NULL REFERENCES channel_credentials(id) ON DELETE CASCADE,
    monitor_id UUID REFERENCES threads_monitors(id) ON DELETE CASCADE,
    feed_kind VARCHAR(32) NOT NULL CHECK(feed_kind IN ('mentions','owned_posts','replies','pending_replies','keyword','tag','profile')),
    feed_key VARCHAR(255) NOT NULL DEFAULT '',
    cursor TEXT,
    last_success_at TIMESTAMPTZ,
    next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_error_code VARCHAR(100),
    last_error_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, credential_id, feed_kind, feed_key)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS threads_sync_states_due_idx ON threads_sync_states(next_poll_at, failure_count)`);

  await client.query(`CREATE TABLE IF NOT EXISTS social_provider_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id INTEGER NOT NULL REFERENCES channel_credentials(id) ON DELETE CASCADE,
    platform VARCHAR(24) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL,
    provider_root_id VARCHAR(255),
    author_id VARCHAR(255),
    author_handle VARCHAR(255),
    normalized_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source VARCHAR(16) NOT NULL CHECK(source IN ('poll','webhook')),
    occurred_at TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, credential_id, event_type, provider_event_id)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS social_provider_events_threads_inbox_idx
    ON social_provider_events(user_id, platform, event_type, occurred_at DESC)`);

  await client.query(`DROP INDEX IF EXISTS outreach_conversations_single_channel_uq`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversations_single_channel_uq
    ON outreach_conversations(user_id, lead_id, channel)
    WHERE channel NOT IN ('email','gmail','threads')`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversations_threads_root_uq
    ON outreach_conversations(user_id, lead_id, channel, external_thread_id)
    WHERE channel='threads' AND external_thread_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_threads_provider_uq
    ON outreach_messages(user_id, provider_message_id)
    WHERE user_id IS NOT NULL AND provider_message_id IS NOT NULL AND message_type='threads_public'`);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS outreach_messages_threads_provider_uq`);
  await client.query(`DROP INDEX IF EXISTS outreach_conversations_threads_root_uq`);
  await client.query(`DROP INDEX IF EXISTS outreach_conversations_single_channel_uq`);
  await client.query(`CREATE UNIQUE INDEX outreach_conversations_single_channel_uq
    ON outreach_conversations(user_id, lead_id, channel) WHERE channel NOT IN ('email','gmail')`);
  await client.query(`DROP TABLE IF EXISTS social_provider_events, threads_sync_states, threads_monitors`);
  await client.query(`DROP INDEX IF EXISTS leads_threads_provider_identity_uq`);
  await client.query(`DROP INDEX IF EXISTS leads_threads_handle_idx`);
  await client.query(`ALTER TABLE leads DROP COLUMN IF EXISTS threads_url, DROP COLUMN IF EXISTS threads_handle`);
  await client.query(`ALTER TABLE social_metric_snapshots DROP COLUMN IF EXISTS dimensions`);
  await client.query(`DELETE FROM social_publish_attempts WHERE platform='threads'`);
  await client.query(`ALTER TABLE social_publish_attempts DROP CONSTRAINT IF EXISTS social_publish_attempts_platform_check`);
  await client.query(`ALTER TABLE social_publish_attempts ADD CONSTRAINT social_publish_attempts_platform_check
    CHECK (platform IN ('instagram','facebook','youtube'))`);
  await client.query(`DELETE FROM social_metric_snapshots WHERE platform='threads'`);
  await client.query(`ALTER TABLE social_metric_snapshots DROP CONSTRAINT IF EXISTS social_metric_snapshots_platform_check`);
  await client.query(`ALTER TABLE social_metric_snapshots ADD CONSTRAINT social_metric_snapshots_platform_check
    CHECK (platform IN ('facebook','instagram','youtube'))`);
  await client.query(`DELETE FROM provider_verification_runs WHERE platform='threads'`);
  await client.query(`ALTER TABLE provider_verification_runs DROP CONSTRAINT IF EXISTS provider_verification_runs_platform_check`);
  await client.query(`ALTER TABLE provider_verification_runs ADD CONSTRAINT provider_verification_runs_platform_check
    CHECK (platform IN ('facebook','instagram','whatsapp','meta_ads','youtube','gmail','resend'))`);
  await client.query(`DELETE FROM provider_canary_runs WHERE platform='threads'`);
  await client.query(`ALTER TABLE provider_canary_runs DROP CONSTRAINT IF EXISTS provider_canary_runs_platform_check`);
  await client.query(`ALTER TABLE provider_canary_runs ADD CONSTRAINT provider_canary_runs_platform_check
    CHECK (platform IN ('facebook','instagram','whatsapp','youtube','gmail','resend'))`);
}
