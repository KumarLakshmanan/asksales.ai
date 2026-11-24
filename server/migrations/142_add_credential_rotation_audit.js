export async function up(client) {
  await client.query(`
    ALTER TABLE admin_api_credentials
      ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS validation_status VARCHAR(20),
      ADD COLUMN IF NOT EXISTS validation_message TEXT,
      ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS rotated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;

    DO $$ BEGIN
      ALTER TABLE admin_api_credentials ADD CONSTRAINT admin_api_credentials_validation_status_check
        CHECK (validation_status IS NULL OR validation_status IN ('valid', 'invalid', 'manual_required'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE IF NOT EXISTS admin_credential_audit (
      id SERIAL PRIMARY KEY,
      credential_id INTEGER REFERENCES admin_api_credentials(id) ON DELETE SET NULL,
      platform VARCHAR(50) NOT NULL,
      action VARCHAR(20) NOT NULL,
      admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      validation_status VARCHAR(20),
      message TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT admin_credential_audit_action_check CHECK (action IN ('create', 'update', 'rotate', 'activate', 'deactivate', 'validate', 'delete')),
      CONSTRAINT admin_credential_audit_validation_check CHECK (validation_status IS NULL OR validation_status IN ('valid', 'invalid', 'manual_required'))
    );

    CREATE INDEX IF NOT EXISTS admin_credential_audit_credential_idx ON admin_credential_audit (credential_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_credential_audit_platform_idx ON admin_credential_audit (platform, created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_credential_audit_admin_idx ON admin_credential_audit (admin_id);
  `);
}

export async function down(client) {
  await client.query(`
    DROP TABLE IF EXISTS admin_credential_audit;
    ALTER TABLE admin_api_credentials
      DROP CONSTRAINT IF EXISTS admin_api_credentials_validation_status_check,
      DROP COLUMN IF EXISTS rotated_by,
      DROP COLUMN IF EXISTS rotated_at,
      DROP COLUMN IF EXISTS validation_message,
      DROP COLUMN IF EXISTS validation_status,
      DROP COLUMN IF EXISTS last_validated_at;
  `);
}
