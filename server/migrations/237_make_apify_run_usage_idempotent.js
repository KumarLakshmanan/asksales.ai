/** Prevent one durable Apify run from being tracked or billed more than once. */
export async function up(client) {
  await client.query(`
    DELETE FROM apify_usages duplicate
    USING apify_usages canonical
    WHERE duplicate.user_id = canonical.user_id
      AND duplicate.run_id = canonical.run_id
      AND duplicate.action = canonical.action
      AND duplicate.run_id IS NOT NULL
      AND duplicate.action = 'run_actor'
      AND duplicate.id > canonical.id
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS apify_usages_user_run_action_uq
      ON apify_usages(user_id, run_id, action)
      WHERE run_id IS NOT NULL AND action = 'run_actor'
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_apify_run_deduction_uq
      ON wallet_transactions(user_id, reference_type, reference_id)
      WHERE type = 'deduction' AND reference_type = 'apify_run'
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS wallet_transactions_apify_run_deduction_uq');
  await client.query('DROP INDEX IF EXISTS apify_usages_user_run_action_uq');
}
