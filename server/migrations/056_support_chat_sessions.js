/**
 * Migration: support_chat_sessions
 * Creates tables for support member chat sessions and messages (RAG-based support assistant).
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_chat_sessions (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
      title VARCHAR(255),
      summary TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_chat_sessions_member ON support_chat_sessions(member_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_chat_sessions_ticket ON support_chat_sessions(ticket_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_chat_sessions_created ON support_chat_sessions(created_at)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_chat_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES support_chat_sessions(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      sources JSONB DEFAULT '[]',
      confidence REAL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_chat_messages_session ON support_chat_messages(session_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_chat_messages_created ON support_chat_messages(created_at)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS support_chat_messages`);
  await client.query(`DROP TABLE IF EXISTS support_chat_sessions`);
}
