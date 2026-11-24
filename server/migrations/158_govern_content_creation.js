/**
 * Content Creation governance and provenance.
 *
 * Adds tenant ownership to legacy previews, explicit approval/version state to
 * business and brand inputs, immutable context snapshots on generated content,
 * and append-only template revision history.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE brand_toolkits
      ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
        CHECK (version > 0)
  `);
  await client.query(`
    UPDATE brand_toolkits
    SET is_approved = TRUE,
        approved_at = COALESCE(approved_at, updated_at, created_at, NOW())
    WHERE is_active = TRUE AND (is_default = TRUE OR is_approved = FALSE)
  `);

  await client.query(`
    ALTER TABLE company_settings
      ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
        CHECK (version > 0)
  `);
  await client.query(`
    UPDATE company_settings
    SET approved_at = COALESCE(approved_at, updated_at, created_at, NOW())
    WHERE is_approved = TRUE
  `);
  await client.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY user_id
        ORDER BY is_default DESC, updated_at DESC NULLS LAST, id DESC
      ) AS row_number
      FROM company_settings
    )
    UPDATE company_settings profile
    SET is_default = (ranked.row_number = 1)
    FROM ranked
    WHERE profile.id = ranked.id
      AND profile.is_default IS DISTINCT FROM (ranked.row_number = 1)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS company_settings_one_default_per_user_uq
      ON company_settings(user_id)
      WHERE is_default = TRUE
  `);

  await client.query(`
    ALTER TABLE content_templates
      ADD COLUMN IF NOT EXISTS business_profile_id INTEGER
        REFERENCES company_settings(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
        CHECK (version > 0),
      ADD COLUMN IF NOT EXISTS brand_context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(brand_context_snapshot) = 'object')
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS content_template_versions (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES content_templates(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version > 0),
      snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS content_template_versions_template_version_uq
      ON content_template_versions(template_id, version)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_template_versions_user_created_idx
      ON content_template_versions(user_id, created_at DESC)
  `);
  await client.query(`
    UPDATE content_templates
    SET type = 'social_message',
        category = COALESCE(category, CASE type
          WHEN 'linkedin_dm' THEN 'linkedin'
          WHEN 'twitter_dm' THEN 'twitter'
          WHEN 'instagram_dm' THEN 'instagram'
          WHEN 'facebook_dm' THEN 'facebook'
          ELSE category
        END)
    WHERE type IN ('linkedin_dm', 'twitter_dm', 'instagram_dm', 'facebook_dm')
  `);
  await client.query(`
    INSERT INTO content_template_versions (
      template_id, user_id, version, snapshot, created_by, created_at
    )
    SELECT
      id,
      user_id,
      version,
      jsonb_build_object(
        'name', name,
        'type', type,
        'subject', subject,
        'content', content,
        'htmlContent', html_content,
        'variables', COALESCE(variables, '[]'::jsonb),
        'category', category,
        'tags', COALESCE(tags, '[]'::jsonb),
        'description', description,
        'brandToolkitId', brand_toolkit_id,
        'businessProfileId', business_profile_id,
        'brandContextSnapshot', brand_context_snapshot,
        'isApproved', is_approved
      ),
      user_id,
      COALESCE(updated_at, created_at, NOW())
    FROM content_templates
    ON CONFLICT (template_id, version) DO NOTHING
  `);

  await client.query(`
    ALTER TABLE content_assets
      ADD COLUMN IF NOT EXISTS business_profile_id INTEGER
        REFERENCES company_settings(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS brand_toolkit_id INTEGER
        REFERENCES brand_toolkits(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS source_template_id INTEGER
        REFERENCES content_templates(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS source_template_version INTEGER,
      ADD COLUMN IF NOT EXISTS brand_context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(brand_context_snapshot) = 'object'),
      ADD COLUMN IF NOT EXISTS validation_snapshot JSONB,
      ADD COLUMN IF NOT EXISTS approval_status VARCHAR(24) NOT NULL DEFAULT 'draft',
      ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
        CHECK (version > 0)
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_assets_approval_status_check'
      ) THEN
        ALTER TABLE content_assets
          ADD CONSTRAINT content_assets_approval_status_check
          CHECK (approval_status IN ('draft', 'approved', 'rejected'));
      END IF;
    END $$;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_assets_user_approval_idx
      ON content_assets(user_id, approval_status, updated_at DESC)
  `);

  await client.query(`
    ALTER TABLE content_asset_previews
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
  `);
  await client.query(`
    UPDATE content_asset_previews preview
    SET user_id = lead.user_id
    FROM leads lead
    WHERE preview.lead_id = lead.id AND preview.user_id IS NULL
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_asset_previews_user_required'
      ) THEN
        ALTER TABLE content_asset_previews
          ADD CONSTRAINT content_asset_previews_user_required
          CHECK (user_id IS NOT NULL) NOT VALID;
      END IF;
    END $$;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_asset_previews_user_id_idx
      ON content_asset_previews(user_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS content_asset_previews_user_lead_idx
      ON content_asset_previews(user_id, lead_id)
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS content_asset_previews_user_lead_idx`);
  await client.query(`DROP INDEX IF EXISTS content_asset_previews_user_id_idx`);
  await client.query(`ALTER TABLE content_asset_previews DROP CONSTRAINT IF EXISTS content_asset_previews_user_required`);
  await client.query(`ALTER TABLE content_asset_previews DROP COLUMN IF EXISTS user_id`);

  await client.query(`DROP INDEX IF EXISTS content_assets_user_approval_idx`);
  await client.query(`ALTER TABLE content_assets DROP CONSTRAINT IF EXISTS content_assets_approval_status_check`);
  await client.query(`
    ALTER TABLE content_assets
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS approved_at,
      DROP COLUMN IF EXISTS approved_by,
      DROP COLUMN IF EXISTS approval_status,
      DROP COLUMN IF EXISTS validation_snapshot,
      DROP COLUMN IF EXISTS brand_context_snapshot,
      DROP COLUMN IF EXISTS source_template_version,
      DROP COLUMN IF EXISTS source_template_id,
      DROP COLUMN IF EXISTS brand_toolkit_id,
      DROP COLUMN IF EXISTS business_profile_id
  `);

  await client.query(`DROP TABLE IF EXISTS content_template_versions`);
  await client.query(`
    ALTER TABLE content_templates
      DROP COLUMN IF EXISTS brand_context_snapshot,
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS business_profile_id
  `);
  await client.query(`
    ALTER TABLE company_settings
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS approved_at,
      DROP COLUMN IF EXISTS approved_by,
      DROP COLUMN IF EXISTS is_approved
  `);
  await client.query(`DROP INDEX IF EXISTS company_settings_one_default_per_user_uq`);
  await client.query(`
    ALTER TABLE brand_toolkits
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS approved_at,
      DROP COLUMN IF EXISTS approved_by,
      DROP COLUMN IF EXISTS is_approved
  `);
}
