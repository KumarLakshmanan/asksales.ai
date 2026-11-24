/** Preserve old receipts and jobs; never replay unreviewed campaign deliveries. */
export async function up(client) {
  const previous=await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  await client.query(`
    UPDATE outreach_jobs job SET updated_at=NOW(),
      metadata=COALESCE(job.metadata,'{}'::jsonb) || '{"manualReviewRequired":true,"accountReviewRequired":true,"retiredByMigration":319}'::jsonb
      WHERE job.channel IN ('email','sms') AND job.status IN ('pending','failed')
        AND COALESCE(job.metadata->'deliveryReview'->>'version','') <> '1';
    UPDATE outreach_campaigns campaign SET status='paused',is_active=false,updated_at=NOW(),
      settings=COALESCE(campaign.settings,'{}'::jsonb) || jsonb_build_object(
        'accountReviewRequired',true,'pauseReason','historical_campaign_requires_review','retiredByMigration',319)
      WHERE campaign.campaign_type IN ('email','sms','mixed','both')
        AND campaign.status NOT IN ('completed','cancelled')
        AND EXISTS(SELECT 1 FROM outreach_jobs job WHERE job.campaign_id=campaign.id
          AND job.user_id=campaign.user_id AND job.business_profile_id=campaign.business_profile_id
          AND job.metadata->>'accountReviewRequired'='true' AND job.status IN ('pending','failed'));
  `);
  await client.query("SELECT set_config('app.business_system',$1,true)",[previous.rows[0]?.value || 'off']);
}
export async function down(client) {
  // Removing the pause would replay old messages without a new review.
  await client.query('SELECT 1');
}
