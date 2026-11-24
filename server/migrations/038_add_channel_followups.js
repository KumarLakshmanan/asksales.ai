/**
 * Migration: add_channel_followups
 * Adds channelFollowUps JSONB column to outreach_settings table
 * for storing per-channel follow-up configurations (email, sms, instagram, facebook, twitter, linkedin)
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE outreach_settings 
    ADD COLUMN IF NOT EXISTS channel_follow_ups JSONB DEFAULT '{}'::jsonb
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE outreach_settings 
    DROP COLUMN IF EXISTS channel_follow_ups
  `);
}
