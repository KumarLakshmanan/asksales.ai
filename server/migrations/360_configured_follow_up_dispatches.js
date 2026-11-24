/** Additive outbox metadata on the existing scoped SMS receipt table. */
export async function up(client) {
  await client.query(`ALTER TABLE sent_messages ADD COLUMN IF NOT EXISTS follow_up_dispatches jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS sent_messages_pending_follow_up_dispatch_idx ON sent_messages(business_profile_id,user_id,id)
      WHERE follow_up_dispatches <> '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS outreach_messages_pending_configured_follow_up_idx ON outreach_messages(business_profile_id,user_id,id)
      WHERE metadata->'configuredFollowUpDispatch'->>'state'='pending';`);
}
export async function down(client) {
  // Do not silently discard pending or held delivery intents on rollback.
  const pending = await client.query(`SELECT 1 FROM sent_messages message
    CROSS JOIN LATERAL jsonb_each(message.follow_up_dispatches) entry WHERE entry.value->>'state' IN ('pending','review_required') LIMIT 1`);
  if (pending.rows.length)
    throw new Error("Reconcile pending configured follow-ups before rollback.");
  await client.query(`DROP INDEX IF EXISTS sent_messages_pending_follow_up_dispatch_idx;
    DROP INDEX IF EXISTS outreach_messages_pending_configured_follow_up_idx;
    ALTER TABLE sent_messages DROP COLUMN IF EXISTS follow_up_dispatches;`);
}
