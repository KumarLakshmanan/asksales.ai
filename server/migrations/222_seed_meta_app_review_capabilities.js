/**
 * Persist the App Review state observed for the production AskSales.ai app.
 * User-token scopes remain separate and are refreshed from Meta after OAuth.
 */
export async function up(client) {
  await client.query(`
    UPDATE admin_api_credentials
    SET config = jsonb_set(
      jsonb_set(COALESCE(config, '{}'::jsonb), '{directInstagramLoginEnabled}', 'false'::jsonb, true),
      '{appReviewPermissions}',
      '{
        "instagram_basic":"approved",
        "pages_show_list":"rejected",
        "pages_manage_metadata":"rejected",
        "pages_read_engagement":"rejected",
        "pages_messaging":"rejected",
        "pages_manage_posts":"rejected",
        "instagram_manage_messages":"rejected",
        "instagram_manage_comments":"rejected",
        "instagram_content_publish":"rejected",
        "ads_read":"rejected",
        "ads_management":"rejected",
        "whatsapp_business_messaging":"approved",
        "whatsapp_business_management":"approved"
      }'::jsonb,
      true
    ),
    updated_at = NOW()
    WHERE platform = 'meta_app' AND is_active = true;
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE admin_api_credentials
    SET config = (COALESCE(config, '{}'::jsonb) - 'appReviewPermissions' - 'directInstagramLoginEnabled'),
        updated_at = NOW()
    WHERE platform = 'meta_app' AND is_active = true;
  `);
}
