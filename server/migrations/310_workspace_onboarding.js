export async function up(client) {
  await client.query(`
    ALTER TABLE company_settings
      ADD COLUMN IF NOT EXISTS workspace_type varchar(50),
      ADD COLUMN IF NOT EXISTS timezone varchar(100),
      ADD COLUMN IF NOT EXISTS application_uses jsonb DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS setup_goal text,
      ADD COLUMN IF NOT EXISTS current_tools text,
      ADD COLUMN IF NOT EXISTS website_analysis jsonb;
    ALTER TABLE brand_toolkits
      ADD COLUMN IF NOT EXISTS image_assets jsonb DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS website_screenshot_url text,
      ADD COLUMN IF NOT EXISTS font_families jsonb,
      ADD COLUMN IF NOT EXISTS gradients jsonb;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE brand_toolkits DROP COLUMN IF EXISTS image_assets, DROP COLUMN IF EXISTS website_screenshot_url,
      DROP COLUMN IF EXISTS font_families, DROP COLUMN IF EXISTS gradients;
    ALTER TABLE company_settings
      DROP COLUMN IF EXISTS workspace_type, DROP COLUMN IF EXISTS timezone,
      DROP COLUMN IF EXISTS application_uses, DROP COLUMN IF EXISTS setup_goal,
      DROP COLUMN IF EXISTS current_tools, DROP COLUMN IF EXISTS website_analysis;
  `);
}
