/**
 * Add bounded proposal review links and enforce one default proposal template
 * per tenant. Existing active links receive a 90-day compatibility window.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE proposals
      ADD COLUMN IF NOT EXISTS public_token_expires_at TIMESTAMP
  `);
  await client.query(`
    UPDATE proposals
    SET public_token_expires_at = COALESCE(sent_at, updated_at, NOW()) + INTERVAL '90 days'
    WHERE public_token_hash IS NOT NULL
      AND public_token_expires_at IS NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_proposals_public_token_expires_at
      ON proposals(public_token_expires_at)
      WHERE public_token_hash IS NOT NULL
  `);

  await client.query(`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (PARTITION BY user_id ORDER BY updated_at DESC, id DESC) AS position
      FROM proposal_templates
      WHERE is_default = TRUE
    )
    UPDATE proposal_templates
    SET is_default = FALSE,
        updated_at = NOW()
    WHERE id IN (SELECT id FROM ranked WHERE position > 1)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_templates_one_default_per_user
      ON proposal_templates(user_id)
      WHERE is_default = TRUE
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_proposal_templates_one_default_per_user`);
  await client.query(`DROP INDEX IF EXISTS idx_proposals_public_token_expires_at`);
  await client.query(`ALTER TABLE proposals DROP COLUMN IF EXISTS public_token_expires_at`);
}
