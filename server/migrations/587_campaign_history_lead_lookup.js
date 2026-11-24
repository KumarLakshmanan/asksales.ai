// A stored key lets PostgreSQL index the legacy thread link before RLS filters
// the rows. Longer values cannot equal a positive integer thread ID.
export async function up(client) {
  await client.query(`
    ALTER TABLE leads ADD COLUMN legacy_campaign_thread_key text GENERATED ALWAYS AS (
      CASE WHEN length(campaign_data->>'threadId') BETWEEN 1 AND 10
        THEN campaign_data->>'threadId' END
    ) STORED;
    CREATE INDEX leads_active_legacy_campaign_thread_idx ON leads
      (business_profile_id, user_id, legacy_campaign_thread_key)
      WHERE deleted_at IS NULL AND legacy_campaign_thread_key IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE leads DROP COLUMN legacy_campaign_thread_key`);
}
