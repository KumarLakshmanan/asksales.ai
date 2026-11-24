/**
 * Migration 104: Create sub_agent_configs table
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sub_agent_configs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      main_agent_type TEXT NOT NULL,
      sub_agent_id TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      model_override TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, main_agent_type, sub_agent_id)
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_user_id ON sub_agent_configs(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_lookup ON sub_agent_configs(user_id, main_agent_type)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS sub_agent_configs`);
}
