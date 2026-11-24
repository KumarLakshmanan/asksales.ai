/**
 * Migration: create_crm_pipeline_automations
 * Creates crm_pipeline_automations and crm_automation_logs tables.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_pipeline_automations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      trigger_type VARCHAR(50) NOT NULL,
      trigger_config JSONB DEFAULT '{}'::jsonb,
      action VARCHAR(50) NOT NULL,
      action_config JSONB DEFAULT '{}'::jsonb,
      is_active BOOLEAN DEFAULT TRUE,
      priority INTEGER DEFAULT 0,
      condition JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_automation_logs (
      id SERIAL PRIMARY KEY,
      automation_id INTEGER NOT NULL REFERENCES crm_pipeline_automations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      action_taken VARCHAR(255),
      result VARCHAR(50) NOT NULL DEFAULT 'success',
      error_message TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      executed_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_pipeline_automations_user_id ON crm_pipeline_automations(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_pipeline_automations_is_active ON crm_pipeline_automations(is_active)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_automation_logs_automation_id ON crm_automation_logs(automation_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_automation_logs_user_id ON crm_automation_logs(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_automation_logs_executed_at ON crm_automation_logs(executed_at)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS crm_automation_logs CASCADE`);
  await client.query(`DROP TABLE IF EXISTS crm_pipeline_automations CASCADE`);
}
