/**
 * Migration: 0002_add_profile_type_to_company_settings
 * Source: migrations/0002_add_profile_type_to_company_settings.sql
 * Generated: 2026-03-06T08:18:40.644Z
 */

export async function up(client) {
    await client.query(`ALTER TABLE company_settings DROP COLUMN IF EXISTS business_type`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0002_add_profile_type_to_company_settings)');
}
