/**
 * Adds an atomic delivery claim for ticket-closure review requests.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS review_request_delivery_status VARCHAR(20),
      ADD COLUMN IF NOT EXISTS review_request_delivery_error TEXT,
      ADD COLUMN IF NOT EXISTS review_request_started_at TIMESTAMP;

    UPDATE support_tickets
    SET review_request_delivery_status = 'sent'
    WHERE review_request_sent_at IS NOT NULL
      AND review_request_delivery_status IS NULL;

    ALTER TABLE support_tickets
      DROP CONSTRAINT IF EXISTS support_tickets_review_delivery_status_check;
    ALTER TABLE support_tickets
      ADD CONSTRAINT support_tickets_review_delivery_status_check
      CHECK (
        review_request_delivery_status IS NULL
        OR review_request_delivery_status IN ('sending', 'sent', 'failed')
      );

    CREATE INDEX IF NOT EXISTS support_tickets_review_delivery_status_idx
      ON support_tickets(review_request_delivery_status, review_request_started_at)
      WHERE review_request_delivery_status IN ('sending', 'failed');
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS support_tickets_review_delivery_status_idx;
    ALTER TABLE support_tickets
      DROP CONSTRAINT IF EXISTS support_tickets_review_delivery_status_check;
    ALTER TABLE support_tickets
      DROP COLUMN IF EXISTS review_request_delivery_status,
      DROP COLUMN IF EXISTS review_request_delivery_error,
      DROP COLUMN IF EXISTS review_request_started_at;
  `);
}
