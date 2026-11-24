/** Retain completed chats; only the current session owns the channel identity. */
export async function up(client) {
  await client.query(`ALTER TABLE outreach_conversations ADD COLUMN IF NOT EXISTS session_ended_at TIMESTAMP`);
  await client.query(`UPDATE outreach_conversations SET provider_account_id = metadata->>'phoneNumberId'
    WHERE channel='whatsapp' AND provider_account_id IS NULL AND metadata->>'phoneNumberId' IS NOT NULL`);
  await client.query(`UPDATE outreach_conversations SET session_ended_at = updated_at
    WHERE channel IN ('whatsapp','instagram','facebook') AND session_ended_at IS NULL
      AND (status IN ('closed','resolved') OR automation_mode IN ('closed','resolved'))`);
  await client.query(`ALTER TABLE outreach_conversations DROP CONSTRAINT IF EXISTS outreach_conversations_user_lead_channel_unique`);
  await client.query(`DROP INDEX IF EXISTS outreach_conversations_single_channel_uq`);
  await client.query(`DROP INDEX IF EXISTS outreach_conversations_meta_account_uq`);
  await client.query(`CREATE UNIQUE INDEX outreach_conversations_single_channel_uq
    ON outreach_conversations(user_id,lead_id,channel)
    WHERE channel NOT IN ('email','gmail','threads','whatsapp','facebook','instagram')`);
  await client.query(`CREATE UNIQUE INDEX outreach_conversations_social_session_uq
    ON outreach_conversations(user_id,lead_id,channel,COALESCE(provider_account_id,''))
    WHERE channel IN ('whatsapp','facebook','instagram') AND session_ended_at IS NULL`);
  await client.query(`UPDATE ai_agent_configs SET tools_enabled = COALESCE(tools_enabled, '[]'::jsonb) || '["get_customer_chat_history"]'::jsonb
    WHERE NOT (COALESCE(tools_enabled, '[]'::jsonb) @> '["get_customer_chat_history"]'::jsonb)`);
  await client.query(`UPDATE support_agent_templates SET tools_enabled = COALESCE(tools_enabled, '[]'::jsonb) || '["get_customer_chat_history"]'::jsonb
    WHERE NOT (COALESCE(tools_enabled, '[]'::jsonb) @> '["get_customer_chat_history"]'::jsonb)`);
}

export async function down() {
  throw new Error('Completed conversation sessions cannot be merged safely. Keep their history and roll forward.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
