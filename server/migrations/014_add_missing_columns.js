/**
 * Migration: add_missing_columns
 * Source: migrations/add_missing_columns.sql
 * Generated: 2026-03-06T08:18:41.156Z
 */

export async function up(client) {
    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS company_size varchar(50)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS business_goals jsonb`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS primary_market varchar(100)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS target_regions jsonb`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS customer_type varchar(100)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS key_buyer_roles jsonb`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS primary_color varchar(7)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS secondary_color varchar(7)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS accent_color varchar(7)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS platforms jsonb`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS content_formats jsonb`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS visual_style varchar(100)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS reference_accounts text`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS preferred_channels jsonb`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS brand_tone varchar(100)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS approval_mode varchar(100)`);

    await client.query(`ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS restrictions text`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS platforms text`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS content_formats text`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS visual_style varchar(100)`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS reference_accounts text`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS business_goals text`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS target_regions text`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS customer_type varchar(100)`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS key_buyer_roles text`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS preferred_channels text`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS brand_tone varchar(100)`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS approval_mode varchar(100)`);

    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS restrictions text`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for add_missing_columns)');
}
