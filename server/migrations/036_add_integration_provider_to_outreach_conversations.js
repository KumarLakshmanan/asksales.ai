/**
 * Migration: add_integration_provider_to_outreach_conversations
 * Adds integrationProvider column to track which email provider (resend/gmail)
 * started a conversation, ensuring replies always use the same provider.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE outreach_conversations
    ADD COLUMN IF NOT EXISTS integration_provider VARCHAR(50)
  `);

  // Backfill existing conversations: channel='gmail' → provider='gmail', channel='email' → provider='resend'
  await client.query(`
    UPDATE outreach_conversations
    SET integration_provider = CASE
      WHEN channel = 'gmail' THEN 'gmail'
      WHEN channel = 'email' THEN 'resend'
      ELSE NULL
    END
    WHERE integration_provider IS NULL AND channel IN ('email', 'gmail')
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE outreach_conversations
    DROP COLUMN IF EXISTS integration_provider
  `);
}
