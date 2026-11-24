export async function up(client) {
  await client.query(
    'ALTER TABLE sent_messages ADD COLUMN IF NOT EXISTS reply_context JSONB',
  );
  // Old queued responses predate campaign/account provenance and must be reviewed,
  // never replayed automatically after deployment.
  await client.query(`
    SELECT set_config('app.business_system','on',true);
    UPDATE support_delivery_outbox SET status='cancelled',next_attempt_at=NULL,lease_expires_at=NULL,
      last_error='Email reply context changed; regenerate and review the response.',updated_at=NOW()
    WHERE channel='email' AND status IN ('pending','failed','drafted')
      AND payload->'metadata'->>'dispatchKind' IN
        ('email_smart_reply','pipeline_message','pipeline_choice','assistant_follow_up');
    UPDATE outreach_assistant_follow_up_schedules s SET status='cancelled',version=version+1,
      cancellation_reason='Email reply context changed; review this conversation.',updated_at=NOW()
    FROM outreach_conversations c WHERE c.id=s.conversation_id AND c.user_id=s.user_id
      AND c.channel IN ('email','gmail') AND s.status IN ('active','queued');
  `);
}

export async function down(client) {
  await client.query(
    'ALTER TABLE sent_messages DROP COLUMN IF EXISTS reply_context',
  );
}
