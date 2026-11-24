/**
 * Migration: create_email_senders
 * Unified email sender accounts table supporting multiple Resend domains and Gmail OAuth accounts per user.
 * Replaces the single-active-provider model with a multi-sender model.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS email_senders (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      type            VARCHAR(20) NOT NULL CHECK (type IN ('resend', 'gmail')),
      label           VARCHAR(255) NOT NULL,
      email           VARCHAR(255) NOT NULL,
      display_name    VARCHAR(255),
      is_default      BOOLEAN NOT NULL DEFAULT FALSE,
      is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
      resend_domain_id INTEGER,
      credential_id    INTEGER,
      config          JSONB DEFAULT '{}',
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Enforce one default per user
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_senders_user_default
      ON email_senders (user_id)
      WHERE is_default = TRUE
  `);

  // Fast lookup by user
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_email_senders_user
      ON email_senders (user_id)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS email_senders`);
}
