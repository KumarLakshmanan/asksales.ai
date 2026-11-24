const SUPPORTED_CHANNELS = [
  'email', 'whatsapp', 'instagram', 'instagram_comment',
  'facebook', 'facebook_comment', 'web',
];
const SUPPORTED_INTENTS = [
  'greeting', 'faq', 'availability_inquiry', 'pricing_question', 'booking_request',
  'negotiation', 'modify_booking', 'cancel_booking', 'complaint', 'refund_request',
  'support_request', 'speak_to_human', 'smalltalk', 'clarify', 'other',
  'payment_inquiry', 'ticket_status', 'lead_qualification', 'sales_inquiry',
  'purchase_intent', 'demo_request',
];
const SUPPORTED_AGENTS = [
  'hotel_sales', 'tech_support', 'lead_qualifier', 'customer_success', 'general_service',
];

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) || rule.type !== 'rate_limit') return rule;
  const config = rule.config && typeof rule.config === 'object' && !Array.isArray(rule.config)
    ? rule.config
    : {};
  const limit = positiveInteger(config.limit ?? config.maxRequests ?? config.maxMessages, 60);
  const windowSeconds = positiveInteger(
    config.windowSeconds,
    positiveInteger(config.windowMinutes, 1) * 60,
  );
  return {
    ...rule,
    config: {
      limit: Math.min(limit, 10_000),
      windowSeconds: Math.min(Math.max(windowSeconds, 10), 86_400),
      action: config.action === 'escalate' ? 'escalate' : 'block',
    },
  };
}

function normalizePolicy(value) {
  if (Array.isArray(value)) return value.map(normalizeRule);
  if (value && typeof value === 'object' && Array.isArray(value.rules)) {
    return { ...value, rules: value.rules.map(normalizeRule) };
  }
  return value;
}

async function normalizePolicyTable(client, tableName) {
  const result = await client.query(`SELECT id, escalation_rules FROM ${tableName}`);
  for (const row of result.rows) {
    const normalized = normalizePolicy(row.escalation_rules);
    if (JSON.stringify(normalized) !== JSON.stringify(row.escalation_rules)) {
      await client.query(
        `UPDATE ${tableName} SET escalation_rules = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(normalized), row.id],
      );
    }
  }
}

/**
 * Establishes the v2 Support AI governance contract without choosing tenant
 * behavior on their behalf. Invalid assignments are disabled, not rewritten;
 * agent enablement is never inferred from a managed playbook assignment.
 */
export async function up(client) {
  await normalizePolicyTable(client, 'ai_agent_configs');
  await normalizePolicyTable(client, 'support_agent_templates');
  await client.query(`
    UPDATE ai_agent_configs
    SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'rateLimitPerMinute')
        || '{"rateLimitPolicyVersion":2}'::jsonb,
        updated_at = NOW()
    WHERE metadata ? 'rateLimitPerMinute'
  `);
  await client.query(`
    UPDATE support_agent_templates
    SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'rateLimitPerMinute')
        || '{"rateLimitPolicyVersion":2}'::jsonb,
        updated_at = NOW()
    WHERE metadata ? 'rateLimitPerMinute'
  `);

  // Migration 150 marked only agent rows it enabled automatically. Restore
  // those rows to opt-in and remove the one-time marker; explicit owner choices
  // and every unmarked row remain untouched.
  await client.query(`
    UPDATE ai_agent_configs
    SET enabled = FALSE,
        metadata = COALESCE(metadata, '{}'::jsonb) - 'managedAssignmentAlignmentVersion',
        updated_at = NOW()
    WHERE metadata->>'managedAssignmentAlignmentVersion' = '1'
  `);

  await client.query(`
    UPDATE support_playbook_assignments
    SET enabled = FALSE, updated_at = NOW()
    WHERE (channel IS NOT NULL AND NOT (channel = ANY($1::text[])))
       OR (intent IS NOT NULL AND NOT (intent = ANY($2::text[])))
       OR agent_type IS NULL
       OR NOT (agent_type = ANY($3::text[]))
  `, [SUPPORTED_CHANNELS, SUPPORTED_INTENTS, SUPPORTED_AGENTS]);

  await client.query(`ALTER TABLE support_playbook_runs ADD COLUMN IF NOT EXISTS run_sequence INTEGER`);
  await client.query(`UPDATE support_playbook_runs SET run_sequence = 1 WHERE run_sequence IS NULL`);
  await client.query(`ALTER TABLE support_playbook_runs ALTER COLUMN run_sequence SET DEFAULT 1`);
  await client.query(`ALTER TABLE support_playbook_runs ALTER COLUMN run_sequence SET NOT NULL`);
  await client.query(`
    ALTER TABLE support_playbook_runs
    DROP CONSTRAINT IF EXISTS support_playbook_runs_user_id_conversation_id_playbook_id_key
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_playbook_runs_sequence_uq
    ON support_playbook_runs(user_id, conversation_id, playbook_id, run_sequence)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_playbook_runs_active_conversation_uq
    ON support_playbook_runs(user_id, conversation_id)
    WHERE status = 'active'
  `);

  await client.query(`
    ALTER TABLE support_tool_executions
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS reconciled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(40),
      ADD COLUMN IF NOT EXISTS reconciliation_note TEXT
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_tool_executions_reconciliation
    ON support_tool_executions(user_id, status, last_attempt_at)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_support_tool_executions_reconciliation`);
  await client.query(`DROP INDEX IF EXISTS support_playbook_runs_active_conversation_uq`);
  await client.query(`DROP INDEX IF EXISTS support_playbook_runs_sequence_uq`);
  // Data normalization and tenant opt-in restoration are intentionally not
  // reversed. Dropping columns would discard run/reconciliation history.
}
