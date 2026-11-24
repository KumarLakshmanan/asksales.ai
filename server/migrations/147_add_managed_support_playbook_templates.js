/**
 * Adds platform-managed support playbook templates and tenant inheritance.
 * Tenant copies remain managed until their owner edits them; customized copies
 * retain their source key but are excluded from future admin propagation.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_agent_templates (
      id SERIAL PRIMARY KEY,
      agent_type VARCHAR(50) NOT NULL UNIQUE,
      display_name VARCHAR(120) NOT NULL,
      description TEXT,
      system_prompt TEXT NOT NULL,
      tools_enabled JSONB NOT NULL DEFAULT '[]'::jsonb,
      escalation_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
      channel_scope JSONB NOT NULL DEFAULT '[]'::jsonb,
      priority INTEGER NOT NULL DEFAULT 10,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      updated_by_admin INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`ALTER TABLE ai_agent_configs ADD COLUMN IF NOT EXISTS template_version INTEGER`);
  await client.query(`ALTER TABLE ai_agent_configs ADD COLUMN IF NOT EXISTS template_mode VARCHAR(20) NOT NULL DEFAULT 'custom'`);
  await client.query(`ALTER TABLE ai_agent_configs DROP CONSTRAINT IF EXISTS ai_agent_configs_template_mode_check`);
  await client.query(`ALTER TABLE ai_agent_configs ADD CONSTRAINT ai_agent_configs_template_mode_check CHECK (template_mode IN ('managed', 'customized', 'custom'))`);
  await client.query(`
    UPDATE ai_agent_configs SET template_version = COALESCE((metadata->>'defaultProfileVersion')::integer, 1), template_mode = 'managed'
    WHERE metadata ? 'defaultProfileVersion' AND template_version IS NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_playbook_templates (
      id SERIAL PRIMARY KEY,
      template_key VARCHAR(120) NOT NULL UNIQUE,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      agent_type VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'published'
        CHECK (status IN ('published', 'archived')),
      graph JSONB NOT NULL,
      assignments JSONB NOT NULL DEFAULT '[]'::jsonb,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_by_admin INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      updated_by_admin INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_playbook_templates_status_agent
    ON support_playbook_templates(status, agent_type)
  `);

  await client.query(`ALTER TABLE support_playbooks ADD COLUMN IF NOT EXISTS template_key VARCHAR(120)`);
  await client.query(`ALTER TABLE support_playbooks ADD COLUMN IF NOT EXISTS template_version INTEGER`);
  await client.query(`ALTER TABLE support_playbooks ADD COLUMN IF NOT EXISTS template_mode VARCHAR(20) NOT NULL DEFAULT 'custom'`);
  await client.query(`
    ALTER TABLE support_playbooks DROP CONSTRAINT IF EXISTS support_playbooks_template_mode_check
  `);
  await client.query(`
    ALTER TABLE support_playbooks ADD CONSTRAINT support_playbooks_template_mode_check
    CHECK (template_mode IN ('managed', 'customized', 'custom'))
  `);
  await client.query(`
    UPDATE support_playbooks
    SET template_key = draft_graph->'metadata'->>'templateKey',
        template_version = COALESCE((draft_graph->'metadata'->>'templateVersion')::integer, 1),
        template_mode = 'managed'
    WHERE draft_graph->'metadata'->>'systemDefault' = 'true'
      AND draft_graph->'metadata'->>'templateKey' IS NOT NULL
      AND template_key IS NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_playbooks_user_template_uq
    ON support_playbooks(user_id, template_key)
    WHERE template_key IS NOT NULL
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS support_playbooks_user_template_uq`);
  await client.query(`ALTER TABLE support_playbooks DROP CONSTRAINT IF EXISTS support_playbooks_template_mode_check`);
  await client.query(`ALTER TABLE support_playbooks DROP COLUMN IF EXISTS template_mode`);
  await client.query(`ALTER TABLE support_playbooks DROP COLUMN IF EXISTS template_version`);
  await client.query(`ALTER TABLE support_playbooks DROP COLUMN IF EXISTS template_key`);
  await client.query(`DROP TABLE IF EXISTS support_playbook_templates`);
  await client.query(`ALTER TABLE ai_agent_configs DROP CONSTRAINT IF EXISTS ai_agent_configs_template_mode_check`);
  await client.query(`ALTER TABLE ai_agent_configs DROP COLUMN IF EXISTS template_mode`);
  await client.query(`ALTER TABLE ai_agent_configs DROP COLUMN IF EXISTS template_version`);
  await client.query(`DROP TABLE IF EXISTS support_agent_templates`);
}
