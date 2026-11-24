/** Global admin configuration. No customer data or credentials are copied. */
export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS assistant_model_catalog (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('openai','openrouter','gemini','vertex_ai','custom_ai')),
    model VARCHAR(250) NOT NULL CHECK (length(trim(model)) > 0),
    label VARCHAR(120) NOT NULL CHECK (length(trim(label)) > 0),
    description VARCHAR(500) NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true,
    display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 10000),
    credential_id INTEGER REFERENCES admin_api_credentials(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider,model)
  )`);
  // Global catalog metadata is readable in business requests; only an admin
  // system scope may change it, including outside the HTTP controller.
  await client.query(`ALTER TABLE assistant_model_catalog ENABLE ROW LEVEL SECURITY;
    ALTER TABLE assistant_model_catalog FORCE ROW LEVEL SECURITY;
    CREATE POLICY assistant_models_read ON assistant_model_catalog FOR SELECT USING (true);
    CREATE POLICY assistant_models_write ON assistant_model_catalog FOR ALL
      USING (current_setting('app.business_system',true)='on')
      WITH CHECK (current_setting('app.business_system',true)='on');
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime') THEN
      GRANT SELECT,INSERT,UPDATE ON assistant_model_catalog TO salesmarketing_business_runtime;
      GRANT USAGE,SELECT ON SEQUENCE assistant_model_catalog_id_seq TO salesmarketing_business_runtime;
    END IF; END $$`);
}
export async function down(client) {
  await client.query('DROP TABLE IF EXISTS assistant_model_catalog');
}
