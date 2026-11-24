/**
 * Harden the Support Agent privacy, approval, delivery, and widget lifecycle.
 *
 * This migration is additive. Existing rows remain readable while the runtime
 * starts writing the stronger identities and lifecycle fields.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE support_chat_sessions
      ADD COLUMN IF NOT EXISTS automation_mode VARCHAR(24) NOT NULL DEFAULT 'ai_active',
      ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMP
  `);
  await client.query(`
    ALTER TABLE handoff_queue
      ADD COLUMN IF NOT EXISTS resolution VARCHAR(40)
  `);

  await client.query(`
    ALTER TABLE support_chat_messages
      ADD COLUMN IF NOT EXISTS privacy_vault_id BIGINT REFERENCES support_privacy_vault(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS processing_status VARCHAR(24) NOT NULL DEFAULT 'completed',
      ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS processing_expires_at TIMESTAMP
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_chat_messages_processing
    ON support_chat_messages(processing_status, processing_expires_at)
  `);

  await client.query(`
    ALTER TABLE support_privacy_vault
      ADD COLUMN IF NOT EXISTS entity_type VARCHAR(40),
      ADD COLUMN IF NOT EXISTS entity_id BIGINT
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_privacy_vault_entity
    ON support_privacy_vault(user_id, entity_type, entity_id)
  `);

  await client.query(`
    ALTER TABLE tool_approvals
      ADD COLUMN IF NOT EXISTS argument_digest VARCHAR(96),
      ADD COLUMN IF NOT EXISTS resume_payload JSONB,
      ADD COLUMN IF NOT EXISTS resume_status VARCHAR(32) NOT NULL DEFAULT 'not_required',
      ADD COLUMN IF NOT EXISTS resume_attempt_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS resume_available_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS resume_error TEXT
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_resume
    ON tool_approvals(resume_status, resume_available_at)
    WHERE resume_status IN ('ready', 'running', 'failed')
  `);

  await client.query(`
    ALTER TABLE support_tool_executions
      ADD COLUMN IF NOT EXISTS argument_digest VARCHAR(96),
      ADD COLUMN IF NOT EXISTS approval_id INTEGER REFERENCES tool_approvals(id) ON DELETE SET NULL
  `);

  await client.query(`
    ALTER TABLE support_delivery_outbox
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_delivery_retry
    ON support_delivery_outbox(status, next_attempt_at, lease_expires_at)
    WHERE status IN ('pending', 'failed', 'sending')
  `);

  await client.query(`
    ALTER TABLE agent_audit_logs
      ADD COLUMN IF NOT EXISTS provider_name VARCHAR(50),
      ADD COLUMN IF NOT EXISTS provider_model VARCHAR(120),
      ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(40),
      ADD COLUMN IF NOT EXISTS delivery_deferred BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255)
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE agent_audit_logs DROP COLUMN IF EXISTS provider_message_id, DROP COLUMN IF EXISTS delivery_deferred, DROP COLUMN IF EXISTS delivery_status, DROP COLUMN IF EXISTS provider_model, DROP COLUMN IF EXISTS provider_name`);
  await client.query(`DROP INDEX IF EXISTS idx_support_delivery_retry`);
  await client.query(`ALTER TABLE support_delivery_outbox DROP COLUMN IF EXISTS lease_expires_at, DROP COLUMN IF EXISTS max_attempts, DROP COLUMN IF EXISTS next_attempt_at`);
  await client.query(`ALTER TABLE support_tool_executions DROP COLUMN IF EXISTS approval_id, DROP COLUMN IF EXISTS argument_digest`);
  await client.query(`DROP INDEX IF EXISTS idx_tool_approvals_resume`);
  await client.query(`ALTER TABLE tool_approvals DROP COLUMN IF EXISTS resume_error, DROP COLUMN IF EXISTS resumed_at, DROP COLUMN IF EXISTS resume_available_at, DROP COLUMN IF EXISTS resume_attempt_count, DROP COLUMN IF EXISTS resume_status, DROP COLUMN IF EXISTS resume_payload, DROP COLUMN IF EXISTS argument_digest`);
  await client.query(`DROP INDEX IF EXISTS idx_support_privacy_vault_entity`);
  await client.query(`ALTER TABLE support_privacy_vault DROP COLUMN IF EXISTS entity_id, DROP COLUMN IF EXISTS entity_type`);
  await client.query(`DROP INDEX IF EXISTS idx_support_chat_messages_processing`);
  await client.query(`ALTER TABLE support_chat_messages DROP COLUMN IF EXISTS processing_expires_at, DROP COLUMN IF EXISTS processing_started_at, DROP COLUMN IF EXISTS processing_status, DROP COLUMN IF EXISTS privacy_vault_id`);
  await client.query(`ALTER TABLE handoff_queue DROP COLUMN IF EXISTS resolution`);
  await client.query(`ALTER TABLE support_chat_sessions DROP COLUMN IF EXISTS opted_out_at, DROP COLUMN IF EXISTS automation_mode`);
}
