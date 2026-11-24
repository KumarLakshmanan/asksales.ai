/**
 * Migration: 0004_nappy_steve_rogers
 * Source: migrations/0004_nappy_steve_rogers.sql
 * Generated: 2026-03-06T08:18:40.812Z
 */

export async function up(client) {
    await client.query(`ALTER TABLE "company_profiles" DROP COLUMN IF EXISTS "name"`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0004_nappy_steve_rogers)');
}
