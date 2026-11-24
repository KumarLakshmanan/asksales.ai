/**
 * Migration: support_teams_and_pipeline_status
 * Creates support_teams and team_members tables, adds team_id to support_tickets,
 * and adds pipeline_status to crm_contacts for CRM deal pipeline tracking.
 */

export async function up(client) {
  // 1. Create support_teams table
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_teams (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      color VARCHAR(20) DEFAULT '#6366f1',
      icon VARCHAR(50) DEFAULT 'users',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_teams_user_id ON support_teams(user_id)`);

  // 2. Create team_members table
  await client.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES support_teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(50) NOT NULL DEFAULT 'member',
      name VARCHAR(255),
      email VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_unique ON team_members(team_id, user_id)`);

  // 3. Add team_id column to support_tickets
  await client.query(`
    ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES support_teams(id) ON DELETE SET NULL
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_team_id ON support_tickets(team_id)`);

  // 4. Add pipeline_status to crm_contacts for deal stage tracking
  await client.query(`
    ALTER TABLE crm_contacts
    ADD COLUMN IF NOT EXISTS pipeline_status VARCHAR(50) DEFAULT 'new'
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_pipeline_status ON crm_contacts(pipeline_status)`);

  // 5. Add last_sentiment_status to crm_contacts to track AI-driven status changes
  await client.query(`
    ALTER TABLE crm_contacts
    ADD COLUMN IF NOT EXISTS last_sentiment_status VARCHAR(50)
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE crm_contacts DROP COLUMN IF EXISTS last_sentiment_status`);
  await client.query(`ALTER TABLE crm_contacts DROP COLUMN IF EXISTS pipeline_status`);
  await client.query(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS team_id`);
  await client.query(`DROP TABLE IF EXISTS team_members CASCADE`);
  await client.query(`DROP TABLE IF EXISTS support_teams CASCADE`);
}
