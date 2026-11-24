/**
 * Register Instagram organic analytics as a distinct App Review capability.
 * Existing status is deliberately not promoted to approved; an administrator
 * must record the state verified in Meta's App Dashboard.
 */
export async function up(client) {
  await client.query(`
    UPDATE admin_api_credentials
    SET config = jsonb_set(
      COALESCE(config, '{}'::jsonb),
      '{appReviewPermissions}',
      COALESCE(config->'appReviewPermissions', '{}'::jsonb)
        || '{"instagram_manage_insights":"not_requested"}'::jsonb,
      true
    ),
    updated_at = NOW()
    WHERE platform = 'meta_app'
      AND is_active = true
      AND NOT (COALESCE(config->'appReviewPermissions', '{}'::jsonb) ? 'instagram_manage_insights');
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE admin_api_credentials
    SET config = jsonb_set(
      COALESCE(config, '{}'::jsonb),
      '{appReviewPermissions}',
      COALESCE(config->'appReviewPermissions', '{}'::jsonb) - 'instagram_manage_insights',
      true
    ),
    updated_at = NOW()
    WHERE platform = 'meta_app' AND is_active = true;
  `);
}
