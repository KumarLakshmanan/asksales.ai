/**
 * PROD-01 — Remove @placeholder.lead synthetic data
 *
 * Leads scraped without a real email address were assigned synthetic emails
 * in the format `<uuid>@placeholder.lead`. These are not real contacts and
 * should be cleaned from production before they appear in user-facing lists.
 *
 * Strategy:
 * - Nullify the email so the lead record is preserved (name, company, source
 *   data are still valid) but the fake email is gone.
 * - Downstream code already guards against null/placeholder emails, so
 *   removing the value is safe.
 */

export async function up(client) {
  // Nullify placeholder emails — keeps lead records intact
  await client.query(`
    UPDATE leads
    SET email = NULL
    WHERE email LIKE '%@placeholder.lead'
  `);
}

export async function down(client) {
  // Irreversible — cannot recover the original placeholder values
  // (they were synthetic and contain no real information worth restoring)
}
