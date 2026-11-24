/**
 * Migration: create_crm_contacts
 * Creates the crm_contacts table for CRM pipeline management.
 * Contacts are auto-created when outreach is sent to a lead.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_contacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      -- Denormalized from lead (copied on creation)
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(100),
      company VARCHAR(255),
      role VARCHAR(255),
      linkedin_url VARCHAR(500),
      website VARCHAR(500),
      avatar_url VARCHAR(500),
      -- CRM-specific fields
      status VARCHAR(50) NOT NULL DEFAULT 'contacted',
      priority VARCHAR(20) DEFAULT 'medium',
      -- Sentiment tracking
      sentiment_score REAL,
      last_sentiment_analysis_at TIMESTAMP,
      -- ICP & Fit
      fit_score REAL,
      icp_tier VARCHAR(50),
      -- Assignment & tags
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      tags JSONB DEFAULT '[]'::jsonb,
      -- Activity counters
      total_outreach_sent INTEGER DEFAULT 0,
      total_replies INTEGER DEFAULT 0,
      total_meetings INTEGER DEFAULT 0,
      -- Key dates
      first_contacted_at TIMESTAMP,
      last_contacted_at TIMESTAMP,
      last_activity_at TIMESTAMP,
      next_follow_up_at TIMESTAMP,
      -- Deal value
      deal_value NUMERIC(12,2),
      currency VARCHAR(10) DEFAULT 'USD',
      -- Source tracking
      source VARCHAR(100),
      source_campaign_id INTEGER,
      -- Notes
      notes TEXT,
      -- Soft delete
      deleted_at TIMESTAMP,
      -- Timestamps
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_user_id ON crm_contacts(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_status ON crm_contacts(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_lead_id ON crm_contacts(lead_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_assigned_to ON crm_contacts(assigned_to)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_fit_score ON crm_contacts(fit_score)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_last_activity ON crm_contacts(last_activity_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_deleted_at ON crm_contacts(deleted_at)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS crm_contacts CASCADE`);
}
