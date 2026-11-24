/**
 * Establish the account-level support-agent invariant and make playbook
 * ownership explicit. Existing content is retained; inactive content simply
 * becomes dormant until its agent is selected again.
 */
export async function up(client) {
  await client.query(`ALTER TABLE support_playbooks ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50)`);

  // Normalize the effective agent deterministically before the partial unique
  // index is added. Existing enabled configurations win by priority then id;
  // accounts without one prefer general_service.
  await client.query(`
    WITH ranked AS (
      SELECT id, user_id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY CASE WHEN enabled THEN 0 ELSE 1 END,
                   CASE WHEN enabled THEN 0 ELSE CASE WHEN agent_type = 'general_service' THEN 0 ELSE 1 END END,
                   priority NULLS LAST,
                   id
        ) AS rn
      FROM ai_agent_configs
    ), changed AS (
      SELECT config.id, config.user_id, config.agent_type, ranked.rn, to_jsonb(config) AS before_state
      FROM ai_agent_configs config
      JOIN ranked ON ranked.id = config.id
      WHERE config.enabled IS DISTINCT FROM (ranked.rn = 1)
    ), normalized AS (
      UPDATE ai_agent_configs config
      SET enabled = (changed.rn = 1), updated_at = NOW()
      FROM changed
      WHERE config.id = changed.id
      RETURNING config.*, changed.before_state
    )
    INSERT INTO support_admin_audit_logs (
      user_id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata
    )
    SELECT user_id, 'system', 'agent_config.active_agent_normalized', 'ai_agent_config', id::text,
      before_state, to_jsonb(normalized) - 'before_state',
      jsonb_build_object('agentType', agent_type, 'migration', '187_enforce_single_active_support_agent')
    FROM normalized
  `);

  // Ownership provenance is resolved from immutable templates first, then the
  // saved graph, then an unambiguous historic assignment, and finally the
  // normalized active agent (or general service for legacy orphan rows).
  await client.query(`
    UPDATE support_playbooks p
    SET agent_type = COALESCE(
      (SELECT t.agent_type FROM support_playbook_templates t WHERE t.template_key = p.template_key),
      NULLIF(p.draft_graph->'metadata'->>'agentType', ''),
      (SELECT MIN(a.agent_type) FROM support_playbook_assignments a
        WHERE a.playbook_id = p.id AND a.agent_type IS NOT NULL
        HAVING COUNT(DISTINCT a.agent_type) = 1),
      (SELECT c.agent_type FROM ai_agent_configs c WHERE c.user_id = p.user_id AND c.enabled = TRUE LIMIT 1),
      'general_service'
    ), updated_at = NOW()
  `);
  await client.query(`UPDATE support_playbooks SET agent_type = 'general_service' WHERE agent_type IS NULL OR agent_type = ''`);
  await client.query(`ALTER TABLE support_playbooks ALTER COLUMN agent_type SET NOT NULL`);
  await client.query(`
    UPDATE support_playbooks
    SET draft_graph = jsonb_set(
      COALESCE(draft_graph, '{}'::jsonb),
      '{metadata}',
      COALESCE(draft_graph->'metadata', '{}'::jsonb) || jsonb_build_object('agentType', agent_type),
      true
    )
  `);
  await client.query(`
    UPDATE support_playbook_versions version
    SET graph = jsonb_set(
      COALESCE(version.graph, '{}'::jsonb),
      '{metadata}',
      COALESCE(version.graph->'metadata', '{}'::jsonb) || jsonb_build_object('agentType', playbook.agent_type),
      true
    )
    FROM support_playbooks playbook
    WHERE playbook.id = version.playbook_id
  `);

  // Legacy cross-agent assignments are retained for auditability but cannot
  // route traffic after ownership becomes explicit.
  await client.query(`
    WITH changed AS (
      SELECT a.id, a.user_id, a.playbook_id, to_jsonb(a) AS before_state
      FROM support_playbook_assignments a
      JOIN support_playbooks p ON p.id = a.playbook_id
      WHERE a.enabled = TRUE AND a.agent_type IS DISTINCT FROM p.agent_type
    ), disabled AS (
      UPDATE support_playbook_assignments a
      SET enabled = FALSE, updated_at = NOW()
      FROM changed
      WHERE a.id = changed.id
      RETURNING a.*, changed.before_state
    )
    INSERT INTO support_admin_audit_logs (
      user_id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata
    )
    SELECT user_id, 'system', 'playbook_assignment.cross_agent_disabled', 'support_playbook_assignment', id::text,
      before_state, to_jsonb(disabled) - 'before_state',
      jsonb_build_object('playbookId', playbook_id, 'migration', '187_enforce_single_active_support_agent')
    FROM disabled
  `);

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_configs_one_enabled_per_user ON ai_agent_configs(user_id) WHERE enabled = TRUE`);
  await client.query(`ALTER TABLE support_playbooks DROP CONSTRAINT IF EXISTS support_playbooks_user_id_name_unique`);
  await client.query(`DROP INDEX IF EXISTS support_playbooks_user_id_name_index`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS support_playbooks_user_agent_name_uq ON support_playbooks(user_id, agent_type, name)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_playbooks_user_agent_status ON support_playbooks(user_id, agent_type, status)`);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_support_playbooks_user_agent_status`);
  await client.query(`DROP INDEX IF EXISTS support_playbooks_user_agent_name_uq`);
  await client.query(`DROP INDEX IF EXISTS ai_agent_configs_one_enabled_per_user`);
  await client.query(`ALTER TABLE support_playbooks DROP COLUMN IF EXISTS agent_type`);
}
