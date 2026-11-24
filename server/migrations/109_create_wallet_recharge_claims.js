/**
 * Migration 109: Immutable payment claim ledger for replay-safe wallet recharges.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS wallet_recharge_claims (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payment_provider VARCHAR(50) NOT NULL DEFAULT 'razorpay',
      payment_id VARCHAR(255) NOT NULL,
      payment_order_id VARCHAR(255) NOT NULL,
      amount_paid NUMERIC(12,2) NOT NULL,
      currency VARCHAR(10) NOT NULL,
      recharge_rate NUMERIC(12,4) NOT NULL,
      credits_added NUMERIC(12,2) NOT NULL,
      transaction_id INTEGER REFERENCES wallet_transactions(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_recharge_claims_payment_id_uq
      ON wallet_recharge_claims(payment_provider, payment_id)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_recharge_claims_order_id_uq
      ON wallet_recharge_claims(payment_provider, payment_order_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS wallet_recharge_claims_user_created_idx
      ON wallet_recharge_claims(user_id, created_at)
  `);

  // Seed the ledger from historical recharge transactions so old payments
  // cannot be replayed after this migration is deployed.
  await client.query(`
    INSERT INTO wallet_recharge_claims (
      user_id, payment_provider, payment_id, payment_order_id, amount_paid,
      currency, recharge_rate, credits_added, transaction_id, created_at
    )
    SELECT DISTINCT ON (payment_provider, payment_order_id)
      user_id,
      COALESCE(payment_provider, 'razorpay'),
      payment_id,
      payment_order_id,
      amount_paid,
      COALESCE(currency, 'INR'),
      CASE WHEN amount_paid > 0 THEN amount / amount_paid ELSE 0 END,
      amount,
      id,
      created_at
    FROM wallet_transactions
    WHERE type = 'recharge'
      AND payment_id IS NOT NULL
      AND payment_order_id IS NOT NULL
      AND amount_paid IS NOT NULL
    ORDER BY payment_provider, payment_order_id, created_at ASC
    ON CONFLICT DO NOTHING
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS wallet_recharge_claims`);
}
