/**
 * Migration 118: Canonical support orchestration primitives.
 *
 * Adds versioned playbooks, a restricted PII vault, an idempotent delivery
 * outbox, and the state required to join AI handoffs to the existing support
 * portal without replacing current conversation or ticket records.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_privacy_vault (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER,
      message_id INTEGER REFERENCES outreach_messages(id) ON DELETE SET NULL,
      channel VARCHAR(20) NOT NULL,
      provider_message_id VARCHAR(255),
      ciphertext TEXT NOT NULL,
      iv VARCHAR(64) NOT NULL,
      auth_tag VARCHAR(64) NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      pii_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_privacy_vault_user_expiry ON support_privacy_vault(user_id, expires_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_privacy_vault_conversation ON support_privacy_vault(user_id, conversation_id)`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_privacy_vault_provider_message_uq
    ON support_privacy_vault(user_id, channel, provider_message_id)
    WHERE provider_message_id IS NOT NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_privacy_access_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vault_id BIGINT REFERENCES support_privacy_vault(id) ON DELETE SET NULL,
      handoff_id INTEGER REFERENCES handoff_queue(id) ON DELETE SET NULL,
      message_id INTEGER REFERENCES outreach_messages(id) ON DELETE SET NULL,
      member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
      action VARCHAR(40) NOT NULL DEFAULT 'reveal',
      reason VARCHAR(240),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_privacy_access_owner_created ON support_privacy_access_logs(user_id, created_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_privacy_access_vault ON support_privacy_access_logs(vault_id)`);
  await client.query(`
    CREATE OR REPLACE FUNCTION reject_support_privacy_access_log_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF pg_trigger_depth() > 1 THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'support_privacy_access_logs is append-only';
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS support_privacy_access_logs_append_only ON support_privacy_access_logs;
    CREATE TRIGGER support_privacy_access_logs_append_only
    BEFORE UPDATE OR DELETE ON support_privacy_access_logs
    FOR EACH ROW EXECUTE FUNCTION reject_support_privacy_access_log_mutation()
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_playbooks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      draft_graph JSONB NOT NULL DEFAULT '{"entryNodeId":"start","nodes":[{"id":"start","type":"trigger","data":{}}],"edges":[]}'::jsonb,
      active_version INTEGER,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, name)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_playbooks_user_status ON support_playbooks(user_id, status)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_playbook_versions (
      id SERIAL PRIMARY KEY,
      playbook_id INTEGER NOT NULL REFERENCES support_playbooks(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      graph JSONB NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      published_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(playbook_id, version)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_playbook_assignments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      playbook_id INTEGER NOT NULL REFERENCES support_playbooks(id) ON DELETE CASCADE,
      channel VARCHAR(20),
      intent VARCHAR(80),
      agent_type VARCHAR(50),
      priority INTEGER NOT NULL DEFAULT 100,
      traffic_percent INTEGER NOT NULL DEFAULT 100 CHECK (traffic_percent BETWEEN 0 AND 100),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_playbook_assignments_match ON support_playbook_assignments(user_id, enabled, channel, intent, priority)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_playbook_runs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL,
      playbook_id INTEGER NOT NULL REFERENCES support_playbooks(id) ON DELETE CASCADE,
      playbook_version INTEGER NOT NULL,
      variant VARCHAR(80),
      current_node_id VARCHAR(120),
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      compliance_score REAL,
      completed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, conversation_id, playbook_id)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_playbook_runs_conversation ON support_playbook_runs(user_id, conversation_id, status)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_delivery_outbox (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL,
      channel VARCHAR(20) NOT NULL,
      decision_key VARCHAR(255) NOT NULL UNIQUE,
      inbound_provider_message_id VARCHAR(255),
      playbook_run_id BIGINT REFERENCES support_playbook_runs(id) ON DELETE SET NULL,
      response_version INTEGER NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      payload JSONB NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      provider_message_id VARCHAR(255),
      last_error TEXT,
      available_at TIMESTAMP NOT NULL DEFAULT NOW(),
      sending_at TIMESTAMP,
      sent_at TIMESTAMP,
      reconciled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reconciled_at TIMESTAMP,
      reconciliation_note TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_delivery_outbox_pending ON support_delivery_outbox(status, available_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_delivery_outbox_conversation ON support_delivery_outbox(user_id, conversation_id)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_tool_executions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL,
      tool_name VARCHAR(120) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL UNIQUE,
      risk_level VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      args JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB,
      error TEXT,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tool_executions_conversation ON support_tool_executions(user_id, conversation_id, created_at)`);
  await client.query(`
    ALTER TABLE tool_approvals
      ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS consumed_execution_id BIGINT REFERENCES support_tool_executions(id) ON DELETE SET NULL
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_tool_approvals_support_lookup ON tool_approvals(user_id, thread_id, tool_name, status, expires_at)`);

  await client.query(`
    ALTER TABLE outreach_messages
      ADD COLUMN IF NOT EXISTS redacted_content TEXT,
      ADD COLUMN IF NOT EXISTS privacy_vault_id BIGINT REFERENCES support_privacy_vault(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS delivery_action_id BIGINT REFERENCES support_delivery_outbox(id) ON DELETE SET NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_delivery_action_uq
    ON outreach_messages(delivery_action_id)
    WHERE delivery_action_id IS NOT NULL
  `);
  await client.query(`
    ALTER TABLE outreach_conversations
      ADD COLUMN IF NOT EXISTS automation_mode VARCHAR(24) NOT NULL DEFAULT 'ai_active'
  `);
  await client.query(`
    ALTER TABLE handoff_queue
      ADD COLUMN IF NOT EXISTS support_ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES support_teams(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS assigned_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_handoff_queue_team_status ON handoff_queue(team_id, status, priority)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_handoff_queue_assigned_member ON handoff_queue(assigned_member_id, status)`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS handoff_queue_one_open_per_conversation_uq
    ON handoff_queue(user_id, conversation_id)
    WHERE status IN ('waiting', 'assigned', 'in_progress')
  `);
  await client.query(`
    ALTER TABLE agent_audit_logs
      ADD COLUMN IF NOT EXISTS playbook_id INTEGER REFERENCES support_playbooks(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS playbook_version INTEGER,
      ADD COLUMN IF NOT EXISTS playbook_node_id VARCHAR(120),
      ADD COLUMN IF NOT EXISTS pii_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS delivery_action_id BIGINT REFERENCES support_delivery_outbox(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS trace JSONB NOT NULL DEFAULT '{}'::jsonb
  `);
  await client.query(`
    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS assigned_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_member ON support_tickets(assigned_member_id, status)`);
  await client.query(`
    ALTER TABLE support_chat_sessions
      ADD COLUMN IF NOT EXISTS public_token VARCHAR(96),
      ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMP
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS support_chat_sessions_public_token_uq ON support_chat_sessions(public_token) WHERE public_token IS NOT NULL`);
  await client.query(`
    ALTER TABLE support_ticket_messages
      ADD COLUMN IF NOT EXISTS delivery_action_id BIGINT REFERENCES support_delivery_outbox(id) ON DELETE SET NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_ticket_messages_delivery_action_uq
    ON support_ticket_messages(delivery_action_id)
    WHERE delivery_action_id IS NOT NULL
  `);
  // Preserve the existing default general-agent behavior for the newly unified
  // widget/public-comment channel without broadening deliberately custom scopes.
  await client.query(`
    UPDATE ai_agent_configs
    SET channel_scope = channel_scope || '["web"]'::jsonb,
        metadata = COALESCE(metadata, '{}'::jsonb) || '{"migration118AddedWebScope":true}'::jsonb,
        updated_at = NOW()
    WHERE agent_type = 'general_service'
      AND enabled = TRUE
      AND channel_scope @> '["email","whatsapp","instagram","facebook"]'::jsonb
      AND NOT channel_scope @> '["web"]'::jsonb
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE ai_agent_configs
    SET channel_scope = COALESCE((
          SELECT jsonb_agg(value)
          FROM jsonb_array_elements(channel_scope) value
          WHERE value <> '"web"'::jsonb
        ), '[]'::jsonb),
        metadata = COALESCE(metadata, '{}'::jsonb) - 'migration118AddedWebScope',
        updated_at = NOW()
    WHERE metadata->>'migration118AddedWebScope' = 'true'
  `);
  await client.query(`DROP INDEX IF EXISTS support_chat_sessions_public_token_uq`);
  await client.query(`ALTER TABLE support_chat_sessions DROP COLUMN IF EXISTS session_expires_at, DROP COLUMN IF EXISTS public_token`);
  await client.query(`DROP INDEX IF EXISTS support_ticket_messages_delivery_action_uq`);
  await client.query(`ALTER TABLE support_ticket_messages DROP COLUMN IF EXISTS delivery_action_id`);
  await client.query(`DROP INDEX IF EXISTS idx_support_tickets_assigned_member`);
  await client.query(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS assigned_member_id`);
  await client.query(`
    ALTER TABLE agent_audit_logs
      DROP COLUMN IF EXISTS trace,
      DROP COLUMN IF EXISTS delivery_action_id,
      DROP COLUMN IF EXISTS pii_types,
      DROP COLUMN IF EXISTS playbook_node_id,
      DROP COLUMN IF EXISTS playbook_version,
      DROP COLUMN IF EXISTS playbook_id
  `);
  await client.query(`DROP INDEX IF EXISTS handoff_queue_one_open_per_conversation_uq`);
  await client.query(`DROP INDEX IF EXISTS idx_handoff_queue_assigned_member`);
  await client.query(`DROP INDEX IF EXISTS idx_handoff_queue_team_status`);
  await client.query(`
    ALTER TABLE handoff_queue
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS last_customer_message_at,
      DROP COLUMN IF EXISTS accepted_at,
      DROP COLUMN IF EXISTS assigned_member_id,
      DROP COLUMN IF EXISTS team_id,
      DROP COLUMN IF EXISTS support_ticket_id
  `);
  await client.query(`ALTER TABLE outreach_conversations DROP COLUMN IF EXISTS automation_mode`);
  await client.query(`DROP INDEX IF EXISTS idx_tool_approvals_support_lookup`);
  await client.query(`ALTER TABLE tool_approvals DROP COLUMN IF EXISTS consumed_execution_id, DROP COLUMN IF EXISTS consumed_at`);
  await client.query(`
    ALTER TABLE outreach_messages
      DROP COLUMN IF EXISTS delivery_action_id,
      DROP COLUMN IF EXISTS privacy_vault_id,
      DROP COLUMN IF EXISTS redacted_content
  `);
  await client.query(`DROP TABLE IF EXISTS support_privacy_access_logs`);
  await client.query(`DROP FUNCTION IF EXISTS reject_support_privacy_access_log_mutation()`);
  await client.query(`DROP TABLE IF EXISTS support_delivery_outbox`);
  await client.query(`DROP TABLE IF EXISTS support_tool_executions`);
  await client.query(`DROP TABLE IF EXISTS support_playbook_runs`);
  await client.query(`DROP TABLE IF EXISTS support_playbook_assignments`);
  await client.query(`DROP TABLE IF EXISTS support_playbook_versions`);
  await client.query(`DROP TABLE IF EXISTS support_playbooks`);
  await client.query(`DROP TABLE IF EXISTS support_privacy_vault`);
}
