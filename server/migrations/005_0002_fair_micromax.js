/**
 * Migration: 0002_fair_micromax
 * Source: migrations/0002_fair_micromax.sql
 * Generated: 2026-03-06T08:18:40.700Z
 */

export async function up(client) {
    await client.query(`ALTER TABLE "leads" ALTER COLUMN "email" DROP NOT NULL`);

    await client.query(`ALTER TABLE "channel_credentials" ADD COLUMN IF NOT EXISTS "deactivation_reason" text`);

    await client.query(`ALTER TABLE "channel_credentials" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0002_fair_micromax)');
}
