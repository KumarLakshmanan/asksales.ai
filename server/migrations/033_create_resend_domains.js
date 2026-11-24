/**
 * Migration: create_resend_domains
 * Store custom email domains registered via Resend API for outreach sending/receiving.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS resend_domains (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resend_domain_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'not_started',
      region VARCHAR(50) DEFAULT 'us-east-1',
      dns_records JSONB DEFAULT '[]',
      open_tracking BOOLEAN DEFAULT false,
      click_tracking BOOLEAN DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, name)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_resend_domains_user_id ON resend_domains(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_resend_domains_status ON resend_domains(status)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS resend_domains`);
}
