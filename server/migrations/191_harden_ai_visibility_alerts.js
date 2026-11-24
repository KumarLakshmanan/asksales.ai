/**
 * Makes per-audit alert detection retry-safe. The alert stage can be retried
 * after a worker restart without duplicating customer-facing alerts.
 */
export async function up(client) {
  await client.query(`
    DELETE FROM ai_visibility_alerts duplicate
    USING ai_visibility_alerts keeper
    WHERE duplicate.audit_id IS NOT NULL
      AND duplicate.audit_id = keeper.audit_id
      AND duplicate.type = keeper.type
      AND duplicate.id > keeper.id
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_visibility_alerts_audit_type_uq
      ON ai_visibility_alerts(audit_id, type)
      WHERE audit_id IS NOT NULL
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS ai_visibility_alerts_audit_type_uq');
}
