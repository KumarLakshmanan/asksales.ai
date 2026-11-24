export async function up(client) {
  await client.query(`
    DELETE FROM wallet_transactions duplicate
    USING wallet_transactions canonical
    WHERE duplicate.type = 'refund'
      AND duplicate.reference_type = 'wallet_transaction'
      AND duplicate.user_id = canonical.user_id
      AND duplicate.reference_type = canonical.reference_type
      AND duplicate.reference_id = canonical.reference_id
      AND duplicate.id > canonical.id
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_outreach_refund_uq
    ON wallet_transactions (user_id, reference_type, reference_id)
    WHERE type = 'refund' AND reference_type = 'wallet_transaction'
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS wallet_transactions_outreach_refund_uq');
}
