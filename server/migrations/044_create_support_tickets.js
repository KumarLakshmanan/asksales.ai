/**
 * Migration: create_support_tickets
 * Creates support_tickets and support_ticket_messages tables.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      outreach_conversation_id INTEGER REFERENCES outreach_conversations(id) ON DELETE SET NULL,
      ticket_number VARCHAR(50) NOT NULL UNIQUE,
      subject VARCHAR(500) NOT NULL,
      description TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'open',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      category VARCHAR(50) DEFAULT 'support',
      -- SLA tracking
      sla_deadline TIMESTAMP,
      resolved_at TIMESTAMP,
      response_time INTEGER,
      -- Assignment
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      -- Tracking
      total_messages INTEGER DEFAULT 0,
      unread_count INTEGER DEFAULT 0,
      tags JSONB DEFAULT '[]'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      -- Timestamps
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_ticket_messages (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      direction VARCHAR(20) NOT NULL DEFAULT 'outbound',
      content TEXT NOT NULL,
      is_internal BOOLEAN DEFAULT FALSE,
      attachments JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Indexes for support_tickets
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to ON support_tickets(assigned_to)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_contact_id ON support_tickets(contact_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at)`);

  // Indexes for support_ticket_messages
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket_id ON support_ticket_messages(ticket_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_created_at ON support_ticket_messages(created_at)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS support_ticket_messages CASCADE`);
  await client.query(`DROP TABLE IF EXISTS support_tickets CASCADE`);
}
