/**
 * Migration: 0001_remove_business_fields_from_icp
 * Source: migrations/0001_remove_business_fields_from_icp.sql
 * Generated: 2026-03-06T08:18:40.586Z
 */

export async function up(client) {
    await client.query(`ALTER TABLE icp_profiles DROP COLUMN IF EXISTS company_website`);

    await client.query(`ALTER TABLE icp_profiles DROP COLUMN IF EXISTS company_start_date`);

    await client.query(`ALTER TABLE icp_profiles DROP COLUMN IF EXISTS company_age`);

    await client.query(`ALTER TABLE icp_profiles DROP COLUMN IF EXISTS company_growth_stage`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0001_remove_business_fields_from_icp)');
}
