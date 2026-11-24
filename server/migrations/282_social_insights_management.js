export async function up(client) {
  await client.query(`ALTER TABLE social_competitors
    ADD COLUMN IF NOT EXISTS last_refresh_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_refreshed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_refresh_status VARCHAR(24),
    ADD COLUMN IF NOT EXISTS last_refresh_error TEXT`);
  await client.query(`ALTER TABLE social_saved_reports ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE`);
  // Existing scheduled reports must advance their original duration instead of
  // silently repeating an old fixed window. Keep one-off reports unchanged.
  await client.query(`UPDATE social_saved_reports SET filters=(filters-'start'-'end') || jsonb_build_object(
    'relativeDays', LEAST(366,GREATEST(1,CASE WHEN filters->>'start' IS NOT NULL AND filters->>'end' IS NOT NULL THEN CEIL(EXTRACT(EPOCH FROM ((filters->>'end')::timestamptz-(filters->>'start')::timestamptz))/86400)::int ELSE 30 END)),
    'timezone', COALESCE(schedule_timezone,'UTC'))
    WHERE (schedule_cron IS NOT NULL OR schedule_definition IS NOT NULL) AND NOT (filters ? 'relativeDays')`);
  await client.query(`CREATE INDEX IF NOT EXISTS social_listening_account_time_idx ON social_listening_events(user_id,platform,(metadata->>'credentialId'),occurred_at DESC,id DESC)`);
}
export async function down(client) {
  await client.query(`ALTER TABLE social_competitors DROP COLUMN IF EXISTS last_refresh_attempt_at,DROP COLUMN IF EXISTS last_refreshed_at,DROP COLUMN IF EXISTS last_refresh_status,DROP COLUMN IF EXISTS last_refresh_error`);
  await client.query('DROP INDEX IF EXISTS social_listening_account_time_idx');
  await client.query('ALTER TABLE social_saved_reports DROP COLUMN IF EXISTS paused');
}
