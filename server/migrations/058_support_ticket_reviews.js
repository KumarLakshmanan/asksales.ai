/**
 * Migration: support_ticket_reviews
 * Adds review/feedback columns to support_tickets table and creates a
 * dedicated support_ticket_reviews table for storing customer reviews.
 */

export async function up(client) {
  // Add review-related columns to support_tickets
  await client.query(`
    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS review_request_sent_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS rating INTEGER,
      ADD COLUMN IF NOT EXISTS review_comment TEXT,
      ADD COLUMN IF NOT EXISTS review_submitted_at TIMESTAMP
  `);

  // Create the support_ticket_reviews table for detailed review storage
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_ticket_reviews (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_ticket_reviews_ticket_id ON support_ticket_reviews(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_support_ticket_reviews_user_id ON support_ticket_reviews(user_id);
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS support_ticket_reviews`);
  await client.query(`
    ALTER TABLE support_tickets
      DROP COLUMN IF EXISTS closed_at,
      DROP COLUMN IF EXISTS review_request_sent_at,
      DROP COLUMN IF EXISTS rating,
      DROP COLUMN IF EXISTS review_comment,
      DROP COLUMN IF EXISTS review_submitted_at
  `);
}
