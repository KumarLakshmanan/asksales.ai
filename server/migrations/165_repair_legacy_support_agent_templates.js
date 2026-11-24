/**
 * Attach legacy starter agent rows to the managed-template system.
 *
 * The predicate intentionally targets only pre-template starter rows that have
 * already received the mandatory-control marker and still have an empty tool
 * set. Owner prompts, enabled state, demonstrations, and policies are retained.
 * Repaired rows are marked customized so a future admin propagation cannot
 * overwrite those retained owner fields without an explicit reset.
 */
export async function up(client) {
  await client.query(`
    WITH candidates AS (
      SELECT
        config.id,
        config.user_id,
        template.version AS template_version,
        template.tools_enabled,
        template.channel_scope,
        template.priority,
        to_jsonb(config) AS before_state
      FROM ai_agent_configs config
      JOIN support_agent_templates template
        ON template.agent_type = config.agent_type
      WHERE config.template_mode = 'custom'
        AND config.template_version IS NULL
        AND COALESCE(config.tools_enabled, '[]'::jsonb) = '[]'::jsonb
        AND config.model_override IS NULL
        AND config.metadata->>'mandatoryControlProfileVersion' = '1'
    ), repaired AS (
      UPDATE ai_agent_configs config
      SET tools_enabled = candidates.tools_enabled,
          channel_scope = candidates.channel_scope,
          priority = candidates.priority,
          template_version = candidates.template_version,
          template_mode = 'customized',
          updated_at = NOW()
      FROM candidates
      WHERE config.id = candidates.id
      RETURNING config.*, candidates.before_state
    )
    INSERT INTO support_admin_audit_logs (
      user_id, actor_type, action, entity_type, entity_id,
      before_state, after_state, metadata
    )
    SELECT
      repaired.user_id,
      'system',
      'agent_config.legacy_template_repaired',
      'ai_agent_config',
      repaired.id::text,
      repaired.before_state,
      to_jsonb(repaired) - 'before_state',
      jsonb_build_object(
        'agentType', repaired.agent_type,
        'templateVersion', repaired.template_version,
        'migration', '165_repair_legacy_support_agent_templates'
      )
    FROM repaired
  `);
}

export async function down(client) {
  // This is a provenance/data repair. Reverting it could silently disable
  // runtime tools again, so rollback only removes the migration audit marker.
  await client.query(`
    DELETE FROM support_admin_audit_logs
    WHERE action = 'agent_config.legacy_template_repaired'
      AND metadata->>'migration' = '165_repair_legacy_support_agent_templates'
  `);
}
