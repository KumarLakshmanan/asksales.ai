/** Preserve receiving identity; ambiguous legacy threads remain unbound. */
export async function up(client) {
  await client.query(`ALTER TABLE outreach_conversations ADD COLUMN IF NOT EXISTS provider_account_id VARCHAR(255)`);
  await client.query(`UPDATE outreach_conversations c SET provider_account_id = binding.account_id
    FROM (SELECT conversation_id, MIN(provider_account_id) AS account_id FROM outreach_messages
      WHERE provider_account_id IS NOT NULL AND provider_account_id NOT LIKE 'user-mediated:%'
      GROUP BY conversation_id HAVING COUNT(DISTINCT provider_account_id) = 1) binding
    WHERE c.id = binding.conversation_id AND c.channel IN ('facebook', 'instagram') AND c.provider_account_id IS NULL`);
  await client.query(`DROP INDEX IF EXISTS outreach_conversations_single_channel_uq`);
  await client.query(`CREATE UNIQUE INDEX outreach_conversations_single_channel_uq ON outreach_conversations(user_id, lead_id, channel)
    WHERE channel NOT IN ('email', 'gmail', 'threads', 'facebook', 'instagram')`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversations_meta_account_uq
    ON outreach_conversations(user_id, lead_id, channel, COALESCE(provider_account_id, '')) WHERE channel IN ('facebook', 'instagram')`);
}
export async function down() {
  throw new Error('Account-bound conversations cannot be merged safely by rollback.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
