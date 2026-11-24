export async function up(client) {
  await client.query(`
    WITH warning_totals AS (
      SELECT
        audit_id,
        COUNT(*) FILTER (WHERE status = 'warning')::integer AS warning_count
      FROM ai_visibility_audit_stages
      GROUP BY audit_id
    )
    UPDATE ai_visibility_audits AS audit
    SET
      warning_count = warning_totals.warning_count,
      status = CASE
        WHEN warning_totals.warning_count > 0 THEN 'completed_with_warnings'
        ELSE 'completed'
      END,
      updated_at = NOW()
    FROM warning_totals
    WHERE audit.id = warning_totals.audit_id
      AND audit.status IN ('completed', 'completed_with_warnings')
      AND (
        audit.warning_count IS DISTINCT FROM warning_totals.warning_count
        OR audit.status IS DISTINCT FROM CASE
          WHEN warning_totals.warning_count > 0 THEN 'completed_with_warnings'
          ELSE 'completed'
        END
      )
  `);
}

export async function down() {
  // Historical warning summaries cannot be restored reliably after reconciliation.
}
