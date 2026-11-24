/**
 * Migration: create_proposals
 * Creates proposals, proposal_line_items, and proposal_templates tables.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS proposals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      outreach_conversation_id INTEGER REFERENCES outreach_conversations(id) ON DELETE SET NULL,
      chat_thread_id INTEGER REFERENCES chat_threads(id) ON DELETE SET NULL,
      proposal_number VARCHAR(50) NOT NULL UNIQUE,
      title VARCHAR(500) NOT NULL,
      cover_note TEXT,
      -- Pricing
      currency VARCHAR(10) DEFAULT 'USD',
      subtotal NUMERIC(12,2) DEFAULT 0,
      discount_type VARCHAR(20),
      discount_value NUMERIC(12,2) DEFAULT 0,
      tax_rate NUMERIC(5,2) DEFAULT 0,
      total NUMERIC(12,2) DEFAULT 0,
      -- Generated from KB + profile
      business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      knowledge_base_sections JSONB DEFAULT '[]'::jsonb,
      ai_generated_summary TEXT,
      -- Status tracking
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      valid_until TIMESTAMP,
      sent_at TIMESTAMP,
      viewed_at TIMESTAMP,
      accepted_at TIMESTAMP,
      rejected_at TIMESTAMP,
      rejection_reason TEXT,
      -- Signature
      signature_required BOOLEAN DEFAULT FALSE,
      signed_at TIMESTAMP,
      show_terms_and_conditions BOOLEAN DEFAULT FALSE,
      terms_and_conditions TEXT,
      -- Metadata
      metadata JSONB DEFAULT '{}'::jsonb,
      -- Timestamps
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS proposal_line_items (
      id SERIAL PRIMARY KEY,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      name VARCHAR(500) NOT NULL,
      description TEXT,
      quantity NUMERIC(10,2) DEFAULT 1,
      unit_price NUMERIC(12,2) DEFAULT 0,
      unit VARCHAR(50) DEFAULT 'unit',
      discount NUMERIC(12,2) DEFAULT 0,
      total NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS proposal_templates (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      is_default BOOLEAN DEFAULT FALSE,
      cover_note TEXT,
      line_items JSONB DEFAULT '[]'::jsonb,
      terms_and_conditions TEXT,
      include_knowledge_base BOOLEAN DEFAULT TRUE,
      include_business_profile BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposals_user_id ON proposals(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposals_contact_id ON proposals(contact_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposals_valid_until ON proposals(valid_until)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposals_chat_thread_id ON proposals(chat_thread_id)`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_line_items_proposal_id ON proposal_line_items(proposal_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_templates_user_id ON proposal_templates(user_id)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS proposal_line_items CASCADE`);
  await client.query(`DROP TABLE IF EXISTS proposal_templates CASCADE`);
  await client.query(`DROP TABLE IF EXISTS proposals CASCADE`);
}
