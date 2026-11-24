/**
 * Point untouched legacy browser-automation integration defaults at Hermes,
 * the authoritative multi-platform automation service. User-customized
 * endpoints are deliberately preserved.
 */

export async function up(client) {
  await client.query(`
    UPDATE system_integrations
    SET automation_settings = jsonb_set(
          jsonb_set(COALESCE(automation_settings, '{}'::jsonb), '{botUrl}', '"http://hermes"'::jsonb),
          '{botPort}', '7880'::jsonb
        ),
        updated_at = NOW()
    WHERE integration_id = 'instagram_automation'
      AND automation_settings->>'botUrl' = 'http://localhost'
      AND automation_settings->>'botPort' = '7860'
  `);

  await client.query(`
    UPDATE system_integrations
    SET automation_settings = jsonb_set(
          jsonb_set(COALESCE(automation_settings, '{}'::jsonb), '{botUrl}', '"http://hermes"'::jsonb),
          '{botPort}', '7880'::jsonb
        ),
        updated_at = NOW()
    WHERE integration_id = 'linkedin_automation'
      AND automation_settings->>'botUrl' = 'http://localhost'
      AND automation_settings->>'botPort' = '7870'
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE system_integrations
    SET automation_settings = jsonb_set(
          jsonb_set(COALESCE(automation_settings, '{}'::jsonb), '{botUrl}', '"http://localhost"'::jsonb),
          '{botPort}', '7860'::jsonb
        ),
        updated_at = NOW()
    WHERE integration_id = 'instagram_automation'
      AND automation_settings->>'botUrl' = 'http://hermes'
      AND automation_settings->>'botPort' = '7880'
  `);

  await client.query(`
    UPDATE system_integrations
    SET automation_settings = jsonb_set(
          jsonb_set(COALESCE(automation_settings, '{}'::jsonb), '{botUrl}', '"http://localhost"'::jsonb),
          '{botPort}', '7870'::jsonb
        ),
        updated_at = NOW()
    WHERE integration_id = 'linkedin_automation'
      AND automation_settings->>'botUrl' = 'http://hermes'
      AND automation_settings->>'botPort' = '7880'
  `);
}
