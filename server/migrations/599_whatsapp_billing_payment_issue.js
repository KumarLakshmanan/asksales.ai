// Meta refuses messages on a WABA whose credit line has a payment problem
// (error 131042). Record it on the billing account so admins see which
// accounts are affected, and so the alert is not repeated for every message.
export async function up(client) {
  await client.query(`
    ALTER TABLE whatsapp_billing_accounts
      ADD COLUMN IF NOT EXISTS payment_issue_at timestamptz,
      ADD COLUMN IF NOT EXISTS payment_issue_detail text
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE whatsapp_billing_accounts
      DROP COLUMN IF EXISTS payment_issue_at,
      DROP COLUMN IF EXISTS payment_issue_detail
  `);
}
