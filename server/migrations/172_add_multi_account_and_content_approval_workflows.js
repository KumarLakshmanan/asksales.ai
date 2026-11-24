/** Multi-account selection and durable workspace content approvals. */
export async function up(client) {
  await client.query(`ALTER TABLE channel_credentials ADD COLUMN IF NOT EXISTS is_selected BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`
    WITH ranked AS (
      SELECT id, row_number() OVER (PARTITION BY user_id, platform ORDER BY is_active DESC, updated_at DESC NULLS LAST, id DESC) AS rank
      FROM channel_credentials
    ) UPDATE channel_credentials credential SET is_selected = (ranked.rank = 1) FROM ranked WHERE credential.id = ranked.id
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS channel_credentials_one_selected_per_platform_uq ON channel_credentials(user_id, platform) WHERE is_selected = TRUE`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS channel_credentials_account_uq ON channel_credentials(user_id, platform, account_identifier) WHERE account_identifier IS NOT NULL`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS content_approval_workflows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL, description TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(owner_user_id, name)
    )
  `);
  // A tenant needs one deterministic publish-approval policy. Preserve the
  // most recently changed workflow if an older database has several active
  // rows, then make the invariant durable at the database boundary.
  await client.query(`
    WITH ranked AS (
      SELECT id, row_number() OVER (PARTITION BY owner_user_id ORDER BY updated_at DESC, created_at DESC, id DESC) AS rank
      FROM content_approval_workflows
      WHERE is_active = TRUE
    )
    UPDATE content_approval_workflows workflow
    SET is_active = FALSE, updated_at = NOW()
    FROM ranked
    WHERE workflow.id = ranked.id AND ranked.rank > 1
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS content_approval_one_active_workflow_uq ON content_approval_workflows(owner_user_id) WHERE is_active = TRUE`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS content_approval_stages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id UUID NOT NULL REFERENCES content_approval_workflows(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position > 0), name VARCHAR(160) NOT NULL, required BOOLEAN NOT NULL DEFAULT TRUE,
      reminder_after_hours INTEGER CHECK(reminder_after_hours IS NULL OR reminder_after_hours > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(workflow_id, position)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS content_approval_stage_approvers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), stage_id UUID NOT NULL REFERENCES content_approval_stages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, role VARCHAR(50), display_name VARCHAR(160),
      CHECK (user_id IS NOT NULL OR NULLIF(role, '') IS NOT NULL), UNIQUE(stage_id, user_id), UNIQUE(stage_id, role)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS content_approval_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL REFERENCES content_approval_workflows(id) ON DELETE RESTRICT, asset_id INTEGER NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
      asset_version INTEGER NOT NULL CHECK(asset_version > 0), status VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','superseded')),
      current_stage_position INTEGER NOT NULL DEFAULT 1, submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL, submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ,
      reminder_sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS content_approval_requests_owner_status_idx ON content_approval_requests(owner_user_id, status, updated_at DESC)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS content_approval_request_live_asset_uq ON content_approval_requests(owner_user_id, asset_id) WHERE status = 'pending'`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS content_approval_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), request_id UUID NOT NULL REFERENCES content_approval_requests(id) ON DELETE CASCADE,
      stage_id UUID NOT NULL REFERENCES content_approval_stages(id) ON DELETE RESTRICT, actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      decision VARCHAR(16) NOT NULL CHECK(decision IN ('approved','rejected','skipped')), comment TEXT, rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK(decision <> 'rejected' OR NULLIF(rejection_reason, '') IS NOT NULL)
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS content_approval_decision_once_uq ON content_approval_decisions(request_id, stage_id, actor_user_id)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS content_approval_audit_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id UUID NOT NULL REFERENCES content_approval_requests(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      event_type VARCHAR(64) NOT NULL, event_data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS content_approval_audit_request_idx ON content_approval_audit_events(request_id, id)`);
  await client.query(`CREATE OR REPLACE FUNCTION prevent_content_approval_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'content approval audit events are immutable'; END; $$`);
  await client.query(`DROP TRIGGER IF EXISTS content_approval_audit_immutable ON content_approval_audit_events`);
  await client.query(`CREATE TRIGGER content_approval_audit_immutable BEFORE UPDATE OR DELETE ON content_approval_audit_events FOR EACH ROW EXECUTE FUNCTION prevent_content_approval_audit_mutation()`);
}
export async function down(client) {
  await client.query(`DROP TRIGGER IF EXISTS content_approval_audit_immutable ON content_approval_audit_events`);
  await client.query(`DROP FUNCTION IF EXISTS prevent_content_approval_audit_mutation()`);
  await client.query(`DROP TABLE IF EXISTS content_approval_audit_events, content_approval_decisions, content_approval_requests, content_approval_stage_approvers, content_approval_stages, content_approval_workflows`);
  await client.query(`DROP INDEX IF EXISTS content_approval_one_active_workflow_uq, channel_credentials_one_selected_per_platform_uq, channel_credentials_account_uq`);
  await client.query(`ALTER TABLE channel_credentials DROP COLUMN IF EXISTS is_selected`);
}
