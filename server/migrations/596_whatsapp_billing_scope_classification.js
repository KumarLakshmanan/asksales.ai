// The WhatsApp billing rate cards, markets, billing accounts and reconciliation
// rows (migration 595) are platform-wide, not owned by one business. The
// startup schema guard refuses to run until every table is classified, so
// declare them as account-level (global) tables. Message charges are already
// business-scoped with row security in 595.
const GLOBAL_TABLES = [
  'whatsapp_billing_accounts',
  'whatsapp_billing_reconciliation',
  'whatsapp_rate_cards',
  'whatsapp_rate_markets',
];

export async function up(client) {
  for (const table of GLOBAL_TABLES) {
    await client.query('INSERT INTO business_scope_accounts(table_name) VALUES($1) ON CONFLICT DO NOTHING', [table]);
  }
}

export async function down(client) {
  await client.query('DELETE FROM business_scope_accounts WHERE table_name = ANY($1::text[])', [GLOBAL_TABLES]);
}
