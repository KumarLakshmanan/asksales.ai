/**
 * Migration: create_crm_activities
 * Creates the crm_activities table for contact activity timeline.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_activities (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      subject VARCHAR(500),
      body TEXT,
      -- Originating source (for audit trail)
      outreach_conversation_id INTEGER REFERENCES outreach_conversations(id) ON DELETE SET NULL,
      outreach_message_id INTEGER REFERENCES outreach_messages(id) ON DELETE SET NULL,
      -- For tasks
      due_at TIMESTAMP,
      completed_at TIMESTAMP,
      priority VARCHAR(20) DEFAULT 'medium',
      -- Metadata
      metadata JSONB DEFAULT '{}'::jsonb,
      -- Timestamps
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activities_user_id ON crm_activities(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activities_contact_id ON crm_activities(contact_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activities_type ON crm_activities(type)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activities_created_at ON crm_activities(created_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activities_due_at ON crm_activities(due_at)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS crm_activities CASCADE`);
}
