// Which outreach batch a WhatsApp message charge belongs to, so wallet
// reports can show WhatsApp spend per outreach instead of one row per message.
// Filled when Meta's delivery report settles the charge; NULL for support
// replies and other messages that are not part of an outreach batch.
export async function up(client) {
  await client.query(`
    ALTER TABLE whatsapp_message_charges ADD COLUMN IF NOT EXISTS outreach_batch_id uuid;
    CREATE INDEX IF NOT EXISTS whatsapp_message_charges_batch_idx
      ON whatsapp_message_charges(business_profile_id, outreach_batch_id) WHERE outreach_batch_id IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS whatsapp_message_charges_batch_idx;
    ALTER TABLE whatsapp_message_charges DROP COLUMN IF EXISTS outreach_batch_id;
  `);
}
