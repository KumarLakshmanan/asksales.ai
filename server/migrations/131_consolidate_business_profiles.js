/**
 * Copy users from the retired singular `company_profiles` table into the
 * canonical multi-profile `company_settings` model when no canonical profile
 * exists. The source table remains intact for rollback/data compatibility.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE company_settings
      ADD COLUMN IF NOT EXISTS legacy_company_profile_id INTEGER;

    CREATE UNIQUE INDEX IF NOT EXISTS company_settings_legacy_profile_unique
      ON company_settings (legacy_company_profile_id)
      WHERE legacy_company_profile_id IS NOT NULL;

    DO $migration$
    BEGIN
      IF to_regclass('public.company_profiles') IS NOT NULL THEN
        INSERT INTO company_settings (
          user_id, name, profile_type, company_name, industry, website,
          company_size, established_year, phone, email, address, description,
          target_market, business_goals, target_regions, customer_type,
          key_buyer_roles, platforms, content_formats, visual_style,
          reference_accounts, preferred_channels, brand_tone, approval_mode,
          restrictions, linkedin_url, twitter_url, facebook_url, instagram_url,
          youtube_url, is_default, legacy_company_profile_id, created_at, updated_at
        )
        SELECT
          cp.user_id,
          cp.company_name,
          NULL,
          cp.company_name,
          cp.industry,
          cp.website,
          COALESCE(cp.company_size, cp.employees),
          cp.founded_year,
          cp.phone,
          cp.email,
          cp.address,
          cp.description,
          cp.primary_market,
          cp.business_goals::text,
          cp.target_regions::text,
          cp.customer_type,
          cp.key_buyer_roles::text,
          cp.platforms::text,
          cp.content_formats::text,
          cp.visual_style,
          cp.reference_accounts,
          cp.preferred_channels::text,
          cp.brand_tone,
          cp.approval_mode,
          cp.restrictions,
          cp.social_links ->> 'linkedin',
          cp.social_links ->> 'twitter',
          cp.social_links ->> 'facebook',
          cp.social_links ->> 'instagram',
          cp.social_links ->> 'youtube',
          true,
          cp.id,
          cp.created_at,
          cp.updated_at
        FROM company_profiles cp
        WHERE NOT EXISTS (
          SELECT 1 FROM company_settings cs WHERE cs.user_id = cp.user_id
        )
        ON CONFLICT DO NOTHING;
      END IF;
    END
    $migration$;
  `);
}

export async function down(client) {
  await client.query(`
    DELETE FROM company_settings WHERE legacy_company_profile_id IS NOT NULL;
    DROP INDEX IF EXISTS company_settings_legacy_profile_unique;
    ALTER TABLE company_settings DROP COLUMN IF EXISTS legacy_company_profile_id;
  `);
}
