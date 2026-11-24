/**
 * Migration: add_lookup_indexes
 * Phase 3.5: Backfill lookup indexes declared in Drizzle schemas on production tables.
 * Each CREATE INDEX is idempotent (IF NOT EXISTS).
 */
export async function up(client) {
  // users
  await client.query(`CREATE INDEX IF NOT EXISTS users_verification_token_idx ON users (verification_token);`);
  await client.query(`CREATE INDEX IF NOT EXISTS users_reset_password_token_idx ON users (reset_password_token);`);

  // outreachCampaigns
  await client.query(`CREATE INDEX IF NOT EXISTS outreach_campaigns_user_id_idx ON outreach_campaigns (user_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS outreach_campaigns_status_idx ON outreach_campaigns (status);`);
  await client.query(`CREATE INDEX IF NOT EXISTS outreach_campaigns_user_status_idx ON outreach_campaigns (user_id, status);`);

  // outreachJobs
  await client.query(`CREATE INDEX IF NOT EXISTS outreach_jobs_status_scheduled_for_idx ON outreach_jobs (status, scheduled_for);`);
  await client.query(`CREATE INDEX IF NOT EXISTS outreach_jobs_campaign_id_idx ON outreach_jobs (campaign_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS outreach_jobs_lead_id_idx ON outreach_jobs (lead_id);`);

  // notifications
  await client.query(`CREATE INDEX IF NOT EXISTS notifications_user_read_idx ON notifications (user_id, read);`);
  await client.query(`CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at);`);

  // chatMessages
  await client.query(`CREATE INDEX IF NOT EXISTS chat_messages_thread_created_at_idx ON chat_messages (thread_id, created_at);`);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS users_verification_token_idx;`);
  await client.query(`DROP INDEX IF EXISTS users_reset_password_token_idx;`);
  await client.query(`DROP INDEX IF EXISTS outreach_campaigns_user_id_idx;`);
  await client.query(`DROP INDEX IF EXISTS outreach_campaigns_status_idx;`);
  await client.query(`DROP INDEX IF EXISTS outreach_campaigns_user_status_idx;`);
  await client.query(`DROP INDEX IF EXISTS outreach_jobs_status_scheduled_for_idx;`);
  await client.query(`DROP INDEX IF EXISTS outreach_jobs_campaign_id_idx;`);
  await client.query(`DROP INDEX IF EXISTS outreach_jobs_lead_id_idx;`);
  await client.query(`DROP INDEX IF EXISTS notifications_user_read_idx;`);
  await client.query(`DROP INDEX IF EXISTS notifications_user_created_idx;`);
  await client.query(`DROP INDEX IF EXISTS chat_messages_thread_created_at_idx;`);
}
