/**
 * Make Gemini the standard text provider when it is configured and retire the
 * removed Perplexity integration. Historical AI Visibility prompt rows remain
 * untouched so completed reports continue to render.
 */
const AUDIT_KEY = 'migration_242_gemini_primary';

export async function up(client) {
  await client.query(`
    ALTER TABLE platform_settings
      ALTER COLUMN ai_provider SET DEFAULT 'google',
      ALTER COLUMN ai_model SET DEFAULT 'gemini-2.5-flash';

    INSERT INTO platform_access_audit (target_type, target_key, before_value, after_value)
    SELECT
      'ai_settings',
      '${AUDIT_KEY}',
      jsonb_build_object('aiProvider', ai_provider, 'aiModel', ai_model),
      jsonb_build_object('aiProvider', 'google', 'aiModel', 'gemini-2.5-flash')
    FROM platform_settings
    WHERE id = 1
      AND EXISTS (
        SELECT 1
        FROM admin_api_credentials
        WHERE platform = 'gemini' AND is_active IS TRUE
      )
      AND NOT EXISTS (
        SELECT 1 FROM platform_access_audit
        WHERE target_type = 'ai_settings' AND target_key = '${AUDIT_KEY}'
      );

    UPDATE platform_settings
    SET ai_provider = 'google',
        ai_model = 'gemini-2.5-flash',
        updated_at = NOW()
    WHERE id = 1
      AND EXISTS (
        SELECT 1
        FROM admin_api_credentials
        WHERE platform = 'gemini' AND is_active IS TRUE
      );

    UPDATE admin_api_credentials
    SET is_active = FALSE,
        deactivation_reason = 'provider_removed',
        deactivated_at = COALESCE(deactivated_at, NOW()),
        updated_at = NOW()
    WHERE platform = 'perplexity' AND is_active IS TRUE;

    UPDATE admin_api_credentials
    SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{model}', '"anthropic/claude-sonnet-4.6"'::jsonb),
        updated_at = NOW()
    WHERE platform = 'openrouter'
      AND is_active IS TRUE
      AND NULLIF(BTRIM(COALESCE(config->>'model', '')), '') IS NULL
      AND NULLIF(BTRIM(COALESCE(config->>'selectedModel', '')), '') IS NULL;

  `);
}

export async function down(client) {
  const { rows } = await client.query(`
    SELECT before_value
    FROM platform_access_audit
    WHERE target_type = 'ai_settings' AND target_key = $1
    ORDER BY id DESC
    LIMIT 1
  `, [AUDIT_KEY]);
  const previous = rows[0]?.before_value;
  if (previous?.aiProvider && previous?.aiModel) {
    await client.query(`
      UPDATE platform_settings
      SET ai_provider = $1, ai_model = $2, updated_at = NOW()
      WHERE id = 1 AND ai_provider = 'google' AND ai_model = 'gemini-2.5-flash'
    `, [previous.aiProvider, previous.aiModel]);
  }
  await client.query(`
    ALTER TABLE platform_settings
      ALTER COLUMN ai_provider SET DEFAULT 'openai',
      ALTER COLUMN ai_model SET DEFAULT 'gpt-4o-mini';

    UPDATE admin_api_credentials
    SET is_active = TRUE,
        deactivation_reason = NULL,
        deactivated_at = NULL,
        updated_at = NOW()
    WHERE platform = 'perplexity' AND deactivation_reason = 'provider_removed';

    DELETE FROM platform_access_audit
    WHERE target_type = 'ai_settings' AND target_key = '${AUDIT_KEY}';
  `);
}
