const IST = 'Asia/Kolkata';

export async function up(client) {
  await client.query(`ALTER TABLE users ALTER COLUMN timezone SET DEFAULT '${IST}'`);
  await client.query(`ALTER TABLE user_preferences ALTER COLUMN timezone SET DEFAULT '${IST}'`);
  await client.query(`ALTER TABLE outreach_campaigns ALTER COLUMN timezone SET DEFAULT '${IST}'`);
  await client.query(`ALTER TABLE hotel_properties ALTER COLUMN timezone SET DEFAULT '${IST}'`);
  await client.query(`ALTER TABLE crm_activity_reminders ALTER COLUMN timezone SET DEFAULT '${IST}'`);
  await client.query(`ALTER TABLE proposal_reminders ALTER COLUMN timezone SET DEFAULT '${IST}'`);

  await client.query(`UPDATE users SET timezone = '${IST}', updated_at = NOW() WHERE timezone IS NULL OR timezone IN ('UTC', 'Etc/UTC', 'India/Kolkata', 'Asia/Calcutta')`);
  await client.query(`UPDATE user_preferences SET timezone = '${IST}', updated_at = NOW() WHERE timezone IS NULL OR timezone IN ('UTC', 'Etc/UTC', 'India/Kolkata', 'Asia/Calcutta', 'America/New_York')`);
  await client.query(`UPDATE outreach_campaigns SET timezone = '${IST}', updated_at = NOW() WHERE timezone IS NULL OR timezone IN ('UTC', 'Etc/UTC', 'India/Kolkata', 'Asia/Calcutta')`);
  await client.query(`UPDATE hotel_properties SET timezone = '${IST}', updated_at = NOW() WHERE timezone IN ('UTC', 'Etc/UTC', 'India/Kolkata', 'Asia/Calcutta')`);
  await client.query(`UPDATE crm_activity_reminders SET timezone = '${IST}', updated_at = NOW() WHERE timezone IS NULL OR timezone IN ('UTC', 'Etc/UTC', 'India/Kolkata', 'Asia/Calcutta')`);
  await client.query(`UPDATE proposal_reminders SET timezone = '${IST}', updated_at = NOW() WHERE timezone IS NULL OR timezone IN ('UTC', 'Etc/UTC', 'India/Kolkata', 'Asia/Calcutta')`);
  await client.query(`UPDATE social_saved_reports
    SET schedule_timezone = '${IST}',
        schedule_definition = jsonb_set(schedule_definition, '{timezone}', to_jsonb('${IST}'::text), true),
        updated_at = NOW()
    WHERE schedule_definition IS NOT NULL
      AND schedule_timezone IN ('UTC', 'Etc/UTC', 'India/Kolkata', 'Asia/Calcutta')`);
}

export async function down(client) {
  await client.query('ALTER TABLE users ALTER COLUMN timezone DROP DEFAULT');
  await client.query("ALTER TABLE user_preferences ALTER COLUMN timezone SET DEFAULT 'America/New_York'");
  await client.query("ALTER TABLE outreach_campaigns ALTER COLUMN timezone SET DEFAULT 'UTC'");
  await client.query("ALTER TABLE hotel_properties ALTER COLUMN timezone SET DEFAULT 'UTC'");
  await client.query("ALTER TABLE crm_activity_reminders ALTER COLUMN timezone SET DEFAULT 'UTC'");
  await client.query("ALTER TABLE proposal_reminders ALTER COLUMN timezone SET DEFAULT 'UTC'");
}
