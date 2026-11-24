/**
 * Credit ledger reconciliation.
 *
 * 1. credit_event_logs.wallet_transaction_id links each usage row to its ledger
 *    row. A refund now also writes a negative "reversal" usage row (linked to the
 *    refund transaction), so usage reports net refunds the same way the wallet
 *    does. The unique index makes each reversal happen once.
 * 2. Backfill: link the usage rows of deductions that were already refunded and
 *    write their reversal rows. A deduction and its usage row were written in one
 *    transaction, so they share created_at; pairing uses that plus organization,
 *    user, reference and amount. Rows that cannot be paired are left as they are.
 * 3. Price rows that had no seed (so admins could not see or edit them):
 *    - Facebook, LinkedIn and X outreach, added turned OFF at 3 credits, so
 *      nothing changes for customers until an administrator turns them on;
 *    - AI demo parsing at 10 credits (what the code already charged);
 *    - the separate usage conversion rate, copied from the current recharge
 *      rate, so nothing changes until an administrator edits one of the two.
 *    Only added where pricing has been seeded (a recharge_rate row exists).
 * 4. ICP generation and knowledge-base Q&A rows are turned off, matching what
 *    was actually charged (nothing), now that the code reads those rows.
 *    Instagram outreach is turned off too, so all social DMs are free.
 */

const PRICES = [
  ['outreach_facebook', 'Facebook Outreach', 'Credits per Facebook message sent', 'outreach', '3', 'per message', 34, false],
  ['outreach_linkedin', 'LinkedIn Outreach', 'Credits per LinkedIn message sent', 'outreach', '3', 'per message', 35, false],
  ['outreach_twitter', 'X (Twitter) Outreach', 'Credits per X (Twitter) message sent', 'outreach', '3', 'per message', 36, false],
  ['ai_demo_parse', 'AI Demo Parsing', 'Credits per AI training demo parsed (minimum 10)', 'platform', '10', 'per demo', 80, true],
];

const REFUNDS = `
  SELECT r.id AS refund_id, o.id AS original_id
  FROM wallet_transactions r
  JOIN wallet_transactions o ON o.type = 'deduction' AND o.organization_id = r.organization_id AND o.id::text = r.reference_id
  WHERE r.type = 'refund' AND r.reference_type IN ('wallet_transaction', 'credit_reservation')`;

async function seedPrice(client, [key, name, description, category, credits, unit, sort, isActive]) {
  const inserted = await client.query(
    `INSERT INTO credit_pricing(event_key, name, description, category, credits_per_unit, unit_label, sort_order, is_active)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT(event_key) DO NOTHING RETURNING *`,
    [key, name, description, category, credits, unit, sort, isActive],
  );
  const row = inserted.rows[0];
  if (!row) return;
  const afterValue = {
    id: row.id, eventKey: row.event_key, name: row.name, category: row.category,
    creditsPerUnit: String(row.credits_per_unit), unitLabel: row.unit_label, isActive: row.is_active,
  };
  await client.query(
    `INSERT INTO pricing_change_audit(domain, record_id, pricing_key, action, after_value)
     VALUES('credit_pricing', $1, $2, 'seed', $3::jsonb)`,
    [row.id, row.event_key, JSON.stringify(afterValue)],
  );
}

export async function up(client) {
  // Usage rows are under business row security; work across all businesses as
  // the system (same pattern as migrations 318/319/571). The runner owns the transaction.
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  await client.query('ALTER TABLE credit_event_logs ADD COLUMN IF NOT EXISTS wallet_transaction_id integer');
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS credit_event_logs_wallet_transaction_uq
    ON credit_event_logs(wallet_transaction_id) WHERE wallet_transaction_id IS NOT NULL`);

  const recharge = await client.query(`SELECT credits_per_unit FROM credit_pricing WHERE event_key = 'recharge_rate'`);
  if (recharge.rows[0]) {
    for (const price of PRICES) await seedPrice(client, price);
    await seedPrice(client, ['usage_rate', 'Credits per ₹1 of AI usage',
      'Credits charged for each ₹1 of measured AI and provider cost (after margin)', 'recharge',
      String(recharge.rows[0].credits_per_unit), 'per ₹1 of usage', 1, true]);
  }

  // ICP generation and knowledge-base Q&A items were hard-coded to 0 credits
  // while their rows showed 5 and 1. The code now follows the row, so turn the
  // rows off to keep both free (their LLM tokens are already billed). Instagram
  // DMs are free by product decision, like Facebook, LinkedIn and X. An admin
  // can turn any of them on to charge a fixed fee.
  const disabled = await client.query(`UPDATE credit_pricing SET is_active = false, updated_at = now()
    WHERE event_key IN ('icp_generation', 'knowledge_base_item', 'outreach_instagram') AND is_active RETURNING id, event_key`);
  for (const row of disabled.rows) {
    await client.query(`INSERT INTO pricing_change_audit(domain, record_id, pricing_key, action, before_value, after_value)
      VALUES('credit_pricing', $1, $2, 'update', '{"isActive":true}'::jsonb, '{"isActive":false}'::jsonb)`, [row.id, row.event_key]);
  }

  // Legacy deployments may have immutability triggers on the ledger tables.
  await client.query('ALTER TABLE credit_event_logs DISABLE TRIGGER USER');
  await client.query(`
    WITH refunds AS (${REFUNDS}),
    originals AS (
      SELECT o.organization_id, o.created_at FROM wallet_transactions o JOIN refunds x ON x.original_id = o.id
    ),
    candidate_tx AS (
      SELECT t.id, t.organization_id, t.user_id, t.reference_type, t.reference_id, -t.amount AS credits, t.created_at,
        row_number() OVER (PARTITION BY t.organization_id, t.user_id, t.reference_type, t.reference_id, t.amount, t.created_at ORDER BY t.id) AS rn
      FROM wallet_transactions t
      WHERE t.type = 'deduction'
        AND EXISTS (SELECT 1 FROM originals o WHERE o.organization_id = t.organization_id AND o.created_at = t.created_at)
    ),
    candidate_logs AS (
      SELECT l.id, l.organization_id, l.user_id, l.reference_type, l.reference_id, l.credits_used, l.created_at,
        row_number() OVER (PARTITION BY l.organization_id, l.user_id, l.reference_type, l.reference_id, l.credits_used, l.created_at ORDER BY l.id) AS rn
      FROM credit_event_logs l
      WHERE l.wallet_transaction_id IS NULL AND l.credits_used > 0
        AND EXISTS (SELECT 1 FROM originals o WHERE o.organization_id = l.organization_id AND o.created_at = l.created_at)
    ),
    pairs AS (
      SELECT l.id AS log_id, t.id AS tx_id
      FROM candidate_tx t
      JOIN candidate_logs l ON l.organization_id = t.organization_id AND l.user_id = t.user_id
        AND l.reference_type IS NOT DISTINCT FROM t.reference_type AND l.reference_id IS NOT DISTINCT FROM t.reference_id
        AND l.credits_used = t.credits AND l.created_at = t.created_at AND l.rn = t.rn
      WHERE t.id IN (SELECT original_id FROM refunds)
    )
    UPDATE credit_event_logs l SET wallet_transaction_id = p.tx_id
    FROM pairs p
    WHERE l.id = p.log_id AND NOT EXISTS (SELECT 1 FROM credit_event_logs e WHERE e.wallet_transaction_id = p.tx_id)`);

  await client.query(`
    INSERT INTO credit_event_logs(business_profile_id, organization_id, user_id, event_key, credits_used, balance_after,
      description, service, reference_type, reference_id, api_provider, metadata, created_at, wallet_transaction_id)
    SELECT l.business_profile_id, l.organization_id, l.user_id, l.event_key, -r.amount, r.balance_after,
      r.description, l.service, l.reference_type, l.reference_id, l.api_provider,
      jsonb_strip_nulls(jsonb_build_object('reversal', true, 'reversesEventLogId', l.id, 'originalTransactionId', o.id,
        'refundTransactionId', r.id, 'purchaseCreditsPerInr', COALESCE(l.metadata->'purchaseCreditsPerInr', l.metadata->'_insights'->'pricing'->'creditsPerInr'))),
      r.created_at, r.id
    FROM wallet_transactions r
    JOIN wallet_transactions o ON o.type = 'deduction' AND o.organization_id = r.organization_id AND o.id::text = r.reference_id
    JOIN credit_event_logs l ON l.wallet_transaction_id = o.id
    WHERE r.type = 'refund' AND r.reference_type IN ('wallet_transaction', 'credit_reservation') AND r.amount > 0
      AND NOT EXISTS (SELECT 1 FROM credit_event_logs e WHERE e.wallet_transaction_id = r.id)`);
  await client.query('ALTER TABLE credit_event_logs ENABLE TRIGGER USER');
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}

export async function down(client) {
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  await client.query('ALTER TABLE credit_event_logs DISABLE TRIGGER USER');
  await client.query(`DELETE FROM credit_event_logs WHERE credits_used < 0 AND metadata->>'reversal' = 'true'`);
  await client.query('ALTER TABLE credit_event_logs ENABLE TRIGGER USER');
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
  await client.query('DROP INDEX IF EXISTS credit_event_logs_wallet_transaction_uq');
  await client.query('ALTER TABLE credit_event_logs DROP COLUMN IF EXISTS wallet_transaction_id');
  // Price rows are kept: removing them would make those actions free again.
}
