/** Legacy unsent intent has no reviewed assistant receipt. Hold it permanently
 * for owner review; setup or runtime changes must never replay it automatically.
 * Delivered and provider-started/uncertain work retain their reconciliation state. */
export async function up(client) {
  // Match historical-hold migrations 318/319. The runner owns the transaction.
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  await client.query(`
    UPDATE outreach_jobs SET status='setup_required',is_dead_letter=false,
      error='ASSISTANT_SETUP_REQUIRED: Review the exact account assistant before requeueing this unsent message.',
      metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('assistantSetupRequired',true,'manualReviewRequired',true),updated_at=NOW()
    WHERE status='pending' AND external_message_id IS NULL
      AND COALESCE(metadata->>'manualReviewRequired','false')<>'true'
      AND COALESCE(metadata->>'providerCallStarted','false')='false'
      AND metadata->'deliveryReview'->'assistant' IS NULL;

    UPDATE outreach_messages SET status='setup_required',
      error_message='ASSISTANT_SETUP_REQUIRED: Review the original account assistant and queue a new reviewed delivery.',
      metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('assistantSetupRequired',true),updated_at=NOW()
    WHERE direction='outbound' AND status IN ('pending','queued','scheduled')
      AND COALESCE(provider_call_state,'not_started')='not_started' AND COALESCE(manual_review_required,false)=false
      AND provider_message_id IS NULL AND external_message_id IS NULL
      AND metadata->'assistant' IS NULL AND metadata->'customerDeliveryAssistant' IS NULL;

    UPDATE support_delivery_outbox SET status='setup_required',next_attempt_at=NULL,lease_expires_at=NULL,
      last_error='ASSISTANT_SETUP_REQUIRED: Review the original account assignment before preparing a new delivery.',updated_at=NOW()
    WHERE status IN ('pending','drafted','failed') AND attempt_count=0 AND provider_message_id IS NULL
      AND payload->'metadata'->'assistant' IS NULL AND payload->'metadata'->'customerDeliveryAssistant' IS NULL;
  `);
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}
export async function down(client) {
  // Held delivery requires an explicit new review. Rollback cannot authorize replay.
  await client.query('SELECT 1');
}
