/**
 * 079_add_failure_reason_to_outreach_messages
 *
 * Adds a free-text `failure_reason` column on `outreach_messages` so providers
 * (WhatsApp/Meta, SMS, etc.) can persist their error message when a send is
 * marked status='failed'. Surfaces actionable info in the UI.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE "outreach_messages"
    ADD COLUMN IF NOT EXISTS "failure_reason" text;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE "outreach_messages"
    DROP COLUMN IF EXISTS "failure_reason";
  `);
}
