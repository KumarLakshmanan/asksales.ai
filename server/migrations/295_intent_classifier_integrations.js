export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS intent_classifier_credentials (
      id serial PRIMARY KEY,
      platform varchar(50) NOT NULL CHECK (platform IN ('openrouter', 'openai', 'gemini', 'vertex_ai', 'custom_ai')),
      name varchar(255) NOT NULL,
      api_key text NOT NULL,
      api_secret text,
      is_encrypted boolean NOT NULL DEFAULT true,
      is_active boolean NOT NULL DEFAULT true,
      priority varchar(20) NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low', 'fallback')),
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_used_at timestamp,
      usage_count integer NOT NULL DEFAULT 0,
      last_validated_at timestamp,
      validation_status varchar(20),
      validation_message text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS intent_classifier_credentials_active_priority_idx
      ON intent_classifier_credentials (is_active, priority);
    CREATE TABLE IF NOT EXISTS intent_classifier_credential_audit (
      id serial PRIMARY KEY,
      credential_id integer,
      platform varchar(50) NOT NULL,
      action varchar(20) NOT NULL,
      admin_id integer REFERENCES admins(id) ON DELETE SET NULL,
      changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
      validation_status varchar(20),
      message text,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS intent_classifier_credential_audit_credential_idx
      ON intent_classifier_credential_audit (credential_id, created_at);
    DROP TRIGGER IF EXISTS intent_classifier_credential_audit_append_only ON intent_classifier_credential_audit;
    CREATE TRIGGER intent_classifier_credential_audit_append_only
      BEFORE UPDATE OR DELETE ON intent_classifier_credential_audit
      FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_mutation();
  `);

  // Copy ciphertext unchanged: credentials remain encrypted, and the selected
  // classifier model is stored on its own record. Never migrate an inactive key.
  await client.query(`
    WITH copied AS (INSERT INTO intent_classifier_credentials
      (platform, name, api_key, api_secret, is_encrypted, is_active, priority, config,
       last_validated_at, validation_status, validation_message)
    SELECT c.platform, 'Migrated classifier: ' || c.name, c.api_key, c.api_secret,
      c.is_encrypted, true, c.priority,
      COALESCE(c.config, '{}'::jsonb) || jsonb_build_object('model', s.intent_classifier_model),
      c.last_validated_at, c.validation_status, c.validation_message
    FROM platform_settings s
    JOIN LATERAL (
      SELECT * FROM admin_api_credentials c
      WHERE c.is_active = true
      AND c.platform = CASE WHEN s.intent_classifier_provider = 'google'
          THEN 'gemini' ELSE s.intent_classifier_provider END
      ORDER BY CASE c.priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2
        WHEN 'low' THEN 3 ELSE 4 END, c.id
      LIMIT 1
    ) c ON true
    WHERE s.id = 1 AND s.intent_classifier_model IS NOT NULL AND c.is_encrypted = true
      AND NOT EXISTS (SELECT 1 FROM intent_classifier_credentials)
    RETURNING id, platform)
    INSERT INTO intent_classifier_credential_audit (credential_id, platform, action, changed_fields, message)
    SELECT id, platform, 'create', '["platform","model","priority"]'::jsonb,
      'Migrated from platform settings' FROM copied
  `);
  await client.query(`ALTER TABLE platform_settings
    DROP COLUMN IF EXISTS ai_provider, DROP COLUMN IF EXISTS ai_model,
    DROP COLUMN IF EXISTS intent_classifier_provider, DROP COLUMN IF EXISTS intent_classifier_model,
    DROP COLUMN IF EXISTS image_provider, DROP COLUMN IF EXISTS image_model,
    DROP COLUMN IF EXISTS video_provider, DROP COLUMN IF EXISTS video_model`);
}

export async function down(client) {
  await client.query(`ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS ai_provider varchar(50) NOT NULL DEFAULT 'google',
    ADD COLUMN IF NOT EXISTS ai_model text NOT NULL DEFAULT 'gemini-2.5-flash',
    ADD COLUMN IF NOT EXISTS intent_classifier_provider varchar(50) NOT NULL DEFAULT 'openrouter',
    ADD COLUMN IF NOT EXISTS intent_classifier_model text NOT NULL DEFAULT 'typesafe/jev-1.13',
    ADD COLUMN IF NOT EXISTS image_provider varchar(50) NOT NULL DEFAULT 'google',
    ADD COLUMN IF NOT EXISTS image_model text NOT NULL DEFAULT 'gemini-2.5-flash-image',
    ADD COLUMN IF NOT EXISTS video_provider varchar(50) NOT NULL DEFAULT 'google',
    ADD COLUMN IF NOT EXISTS video_model text NOT NULL DEFAULT 'veo-3.1-fast-generate-001'`);
  await client.query(`DROP TABLE IF EXISTS intent_classifier_credential_audit;
    DROP TABLE IF EXISTS intent_classifier_credentials`);
}
