const modules = [
  ['campaigns', 'Campaigns', 'Campaign conversations, planning, and execution.', 10],
  ['lead_generation', 'Lead Generation', 'Lead discovery, imports, scoring, and enrichment.', 20],
  ['content', 'Content Creator', 'Content templates, assets, brand toolkits, and calendar.', 30],
  ['performance_marketing', 'Performance Marketing', 'Advertising campaigns, publishing, and analytics.', 40],
  ['outreach', 'Outreach', 'Email, social, SMS, and WhatsApp outreach.', 50],
  ['crm', 'CRM', 'Contacts, pipeline, reminders, alerts, and automations.', 60],
  ['support', 'Support', 'Support tickets, teams, analytics, and operations.', 70],
  ['support_ai', 'Support AI', 'AI support chat, knowledge retrieval, reports, and embeds.', 80],
  ['proposals', 'Proposals', 'Proposal creation, templates, delivery, and analytics.', 90],
  ['knowledge_base', 'Knowledge Base', 'Documents, crawling, embeddings, and semantic retrieval.', 100],
  ['integrations', 'Integrations', 'User provider connections and channel configuration.', 110],
  ['billing', 'Wallet & Billing', 'Wallet balance, recharges, history, and usage.', 120],
  ['storage', 'Storage', 'Tenant files, quotas, plans, and storage usage.', 130],
];

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      id INTEGER PRIMARY KEY,
      maintenance_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      maintenance_message TEXT NOT NULL DEFAULT 'We are performing scheduled maintenance. Please try again shortly.',
      updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT platform_settings_singleton_check CHECK (id = 1)
    );

    CREATE TABLE IF NOT EXISTS platform_modules (
      module_key VARCHAR(80) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      description TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'available',
      status_message TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT platform_modules_status_check CHECK (status IN ('available', 'maintenance', 'disabled'))
    );

    CREATE TABLE IF NOT EXISTS user_module_access (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module_key VARCHAR(80) NOT NULL REFERENCES platform_modules(module_key) ON DELETE CASCADE,
      is_enabled BOOLEAN NOT NULL,
      updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT user_module_access_pk PRIMARY KEY (user_id, module_key)
    );

    CREATE TABLE IF NOT EXISTS platform_access_audit (
      id SERIAL PRIMARY KEY,
      target_type VARCHAR(30) NOT NULL,
      target_key VARCHAR(120) NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      before_value JSONB,
      after_value JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT platform_access_audit_target_check CHECK (target_type IN ('maintenance', 'module', 'user_modules'))
    );

    CREATE INDEX IF NOT EXISTS user_module_access_user_idx ON user_module_access (user_id);
    CREATE INDEX IF NOT EXISTS platform_access_audit_target_idx ON platform_access_audit (target_type, target_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS platform_access_audit_user_idx ON platform_access_audit (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS platform_access_audit_admin_idx ON platform_access_audit (admin_id);

    INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);

  for (const [key, name, description, sortOrder] of modules) {
    await client.query(
      `INSERT INTO platform_modules (module_key, name, description, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (module_key) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         sort_order = EXCLUDED.sort_order`,
      [key, name, description, sortOrder],
    );
  }
}

export async function down(client) {
  await client.query(`
    DROP TABLE IF EXISTS platform_access_audit;
    DROP TABLE IF EXISTS user_module_access;
    DROP TABLE IF EXISTS platform_modules;
    DROP TABLE IF EXISTS platform_settings;
  `);
}
