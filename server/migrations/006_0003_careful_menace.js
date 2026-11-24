/**
 * Migration: 0003_careful_menace
 * Source: migrations/0003_careful_menace.sql
 * Generated: 2026-03-06T08:18:40.708Z
 */

export async function up(client) {
    await client.query(`ALTER TABLE "company_profiles" ADD COLUMN IF NOT EXISTS "name" varchar(255)`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0003_careful_menace)');
}
