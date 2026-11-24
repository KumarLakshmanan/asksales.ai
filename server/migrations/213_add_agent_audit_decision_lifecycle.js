/** Make the decision audit durable before delivery/effects and finalizable afterward. */
export async function up(client) {
  await client.query(`
    ALTER TABLE agent_audit_logs
      ADD COLUMN IF NOT EXISTS decision_status VARCHAR(30) NOT NULL DEFAULT 'finalized',
      ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP
  `);
  await client.query(`
    UPDATE agent_audit_logs
    SET finalized_at = COALESCE(finalized_at, created_at), decision_status = 'finalized'
    WHERE finalized_at IS NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_audit_pending_decisions
    ON agent_audit_logs(decision_status, created_at)
    WHERE decision_status <> 'finalized'
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS idx_agent_audit_pending_decisions');
  await client.query(`
    ALTER TABLE agent_audit_logs
      DROP COLUMN IF EXISTS finalized_at,
      DROP COLUMN IF EXISTS decision_status
  `);
}
