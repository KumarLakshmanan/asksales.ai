/**
 * Expire public support-review capabilities and enforce one review per ticket.
 *
 * Existing unconsumed review links receive a 30-day compatibility window from
 * the migration date. Duplicate historical rows are not silently discarded:
 * they must be reconciled before this migration can safely continue.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS review_token_expires_at TIMESTAMP;

    UPDATE support_tickets
    SET review_token_expires_at = NOW() + INTERVAL '30 days'
    WHERE review_token IS NOT NULL
      AND review_submitted_at IS NULL
      AND review_token_expires_at IS NULL;
  `);

  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM support_ticket_reviews
        GROUP BY ticket_id
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION
          'Duplicate support ticket reviews must be reconciled before migration 134 can continue';
      END IF;
    END $$;
  `);

  await client.query(`
    DROP INDEX IF EXISTS idx_support_ticket_reviews_ticket_id;
    CREATE UNIQUE INDEX IF NOT EXISTS support_ticket_reviews_ticket_id_uq
      ON support_ticket_reviews(ticket_id);
    CREATE INDEX IF NOT EXISTS support_tickets_review_token_expiry_idx
      ON support_tickets(review_token_expires_at)
      WHERE review_token IS NOT NULL AND review_submitted_at IS NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS support_tickets_review_token_expiry_idx;
    DROP INDEX IF EXISTS support_ticket_reviews_ticket_id_uq;
    CREATE INDEX IF NOT EXISTS idx_support_ticket_reviews_ticket_id
      ON support_ticket_reviews(ticket_id);
    ALTER TABLE support_tickets
      DROP COLUMN IF EXISTS review_token_expires_at;
  `);
}
