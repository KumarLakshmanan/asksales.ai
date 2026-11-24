/**
 * Migration 099: AI Agent Configurations
 *
 * Creates the ai_agent_configs table to configure and store various AI agents
 * for outreach (hotel sales, tech support, etc.).
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_agent_configs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_type VARCHAR(50) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT false,
      display_name VARCHAR(120),
      description TEXT,
      system_prompt TEXT,
      tools_enabled JSONB DEFAULT '[]'::jsonb,
      escalation_rules JSONB DEFAULT '{}'::jsonb,
      model_override VARCHAR(50),
      channel_scope JSONB DEFAULT '[]'::jsonb,
      priority INTEGER DEFAULT 10,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, agent_type)
    )
  `);
  
  await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_agent_configs_user_id ON ai_agent_configs(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_agent_configs_type ON ai_agent_configs(agent_type)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS ai_agent_configs`);
}
