/** Retain legacy history for review. Never replay unbound, model-generated sends. */
export async function up(client) {
  // The custom runner wraps migrations in a transaction. System access is only
  // for this data repair; parent ownership triggers still verify every record.
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  await client.query(`
    UPDATE message_sequences SET is_active=false,updated_at=NOW()
      WHERE name LIKE 'Agent Follow-Up: %' AND is_active=true;
    UPDATE sequence_executions execution SET status='paused',next_scheduled_at=NULL,
      paused_at=COALESCE(paused_at,NOW()),updated_at=NOW(),
      metadata=COALESCE(execution.metadata,'{}'::jsonb) || jsonb_build_object(
        'pauseReason','legacy_follow_up_requires_review','retiredByMigration',318)
      FROM message_sequences sequence
      WHERE execution.sequence_id=sequence.id AND execution.user_id=sequence.user_id
        AND execution.business_profile_id=sequence.business_profile_id
        AND sequence.name LIKE 'Agent Follow-Up: %' AND execution.status IN ('active','failed');
    UPDATE outreach_jobs job SET status='cancelled',error='Legacy follow-up requires review; no automatic replay.',
      updated_at=NOW(),metadata=COALESCE(job.metadata,'{}'::jsonb) || '{"retiredByMigration":318,"needsReview":true}'::jsonb
      WHERE job.status IN ('pending','failed') AND EXISTS (
        SELECT 1 FROM sequence_executions execution JOIN message_sequences sequence ON sequence.id=execution.sequence_id
        WHERE job.metadata->>'sequenceExecutionId'=execution.id::text
          AND execution.user_id=job.user_id AND execution.business_profile_id=job.business_profile_id
          AND sequence.name LIKE 'Agent Follow-Up: %');
    ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS retirement_state varchar(30);
    ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS retired_at timestamp;
    UPDATE followup_sequences SET retirement_state='needs_review',retired_at=COALESCE(retired_at,NOW()),updated_at=NOW()
      WHERE completed=false AND retirement_state IS NULL;
  `);
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}

export async function down(client) {
  // Retirement is deliberately retained on rollback. Restoring old code must
  // not silently resume historical messages without fresh consent and account
  // verification. The additive review columns remain to preserve that history.
  await client.query('SELECT 1');
}
