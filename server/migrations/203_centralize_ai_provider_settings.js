/**
 * Centralize provider/model defaults in the singleton platform settings row.
 * Legacy per-user ai_settings rows are intentionally retained for rollback/data
 * preservation, but the application no longer reads provider choices from them.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE platform_settings
      ADD COLUMN IF NOT EXISTS ai_provider VARCHAR(50) NOT NULL DEFAULT 'openai',
      ADD COLUMN IF NOT EXISTS ai_model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      ADD COLUMN IF NOT EXISTS image_provider VARCHAR(50) NOT NULL DEFAULT 'google',
      ADD COLUMN IF NOT EXISTS image_model TEXT NOT NULL DEFAULT 'gemini-2.5-flash-image',
      ADD COLUMN IF NOT EXISTS video_provider VARCHAR(50) NOT NULL DEFAULT 'google',
      ADD COLUMN IF NOT EXISTS video_model TEXT NOT NULL DEFAULT 'veo-3.1-fast-generate-001';

    INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    ALTER TABLE platform_access_audit
      DROP CONSTRAINT IF EXISTS platform_access_audit_target_check;
    ALTER TABLE platform_access_audit
      ADD CONSTRAINT platform_access_audit_target_check
      CHECK (target_type IN ('maintenance', 'module', 'user_modules', 'ai_settings'));
  `);
}

export async function down(client) {
  await client.query(`
    DELETE FROM platform_access_audit WHERE target_type = 'ai_settings';

    ALTER TABLE platform_access_audit
      DROP CONSTRAINT IF EXISTS platform_access_audit_target_check;
    ALTER TABLE platform_access_audit
      ADD CONSTRAINT platform_access_audit_target_check
      CHECK (target_type IN ('maintenance', 'module', 'user_modules'));

    ALTER TABLE platform_settings
      DROP COLUMN IF EXISTS video_model,
      DROP COLUMN IF EXISTS video_provider,
      DROP COLUMN IF EXISTS image_model,
      DROP COLUMN IF EXISTS image_provider,
      DROP COLUMN IF EXISTS ai_model,
      DROP COLUMN IF EXISTS ai_provider;
  `);
}
